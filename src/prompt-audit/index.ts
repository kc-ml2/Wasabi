import type {
  AgentEndEvent,
  BeforeProviderHeadersEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createConfig, parseAuditorModelRef, type AuditorConfig } from "./config.ts";
import { createMvpContextSources, createSystemPromptDigest } from "./context/materializer.ts";
import { planContext } from "./context/planner.ts";
import type { AuditMode, AuditSubject, EnglishMode, RoutingContext } from "./domain.ts";
import { FrontierCombinedEngine } from "./engines/frontier-combined.ts";
import { checkEligibility, detectDeterministicFeatures } from "./eligibility.ts";
import { enforceHostPolicy, failureAction } from "./host-policy.ts";
import { selectEngineRoute } from "./routing.ts";
import {
  createAuditEntry,
  createDevAuditEntry,
  createExperimentEntry,
  type AuditEntryInput,
  type AuditUserAction,
  type DevAuditEntryInput,
  type ExperimentEntryInput,
  type PromptAuditExperimentAlternative,
  type PromptAuditDevImage,
  type PromptAuditDevSelection,
} from "./storage.ts";
import { reviewPrompt } from "./ui.ts";
import { liteLLMSessionHeaders } from "../litellm-session.ts";

const SETTINGS_ENTRY_TYPE = "prompt-audit-settings";

type PersistentAuditMode = Exclude<AuditMode, "dev">;

interface RuntimeState {
  mode: AuditMode;
  persistentMode: PersistentAuditMode;
  englishMode: "off" | "semantic-only" | "polish-always";
  polishNext: boolean;
  bypassNext: boolean;
  experimentNext: boolean;
  experimentActive: boolean;
}

interface PendingExperiment {
  experimentId: string;
  auditSubmissionId: string;
  commonContextEntryId: string;
  target: { provider: string; modelId: string };
  images: NonNullable<InputEvent["images"]>;
  imageMetadata: PromptAuditDevImage[];
  alternatives: ExperimentEntryInput["alternatives"];
  selectedAlternative: PromptAuditExperimentAlternative;
  executionOrder: [PromptAuditExperimentAlternative, PromptAuditExperimentAlternative];
  runningAlternative: PromptAuditExperimentAlternative;
  phase: "first-running" | "continuation-queued" | "second-running";
  responses: Partial<
    Record<
      PromptAuditExperimentAlternative,
      { branchLeafId?: string; finalText: string; assistantMessages: unknown[] }
    >
  >;
}

type PiModel = NonNullable<ExtensionContext["model"]>;

function restoreSettings(state: RuntimeState, entries: SessionEntry[]): void {
  state.mode = "disabled";
  state.persistentMode = "disabled";
  state.englishMode = "semantic-only";

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== SETTINGS_ENTRY_TYPE) continue;
    const data = entry.data as {
      schemaVersion?: unknown;
      mode?: unknown;
      englishMode?: unknown;
    } | undefined;
    if (
      data?.schemaVersion !== "1" ||
      (data.mode !== "disabled" && data.mode !== "advisory" && data.mode !== "strict") ||
      (data.englishMode !== "off" &&
        data.englishMode !== "semantic-only" &&
        data.englishMode !== "polish-always")
    ) {
      continue;
    }
    state.mode = data.mode;
    state.persistentMode = data.mode;
    state.englishMode = data.englishMode;
    return;
  }
}

function persistSettings(pi: ExtensionAPI, state: RuntimeState): void {
  pi.appendEntry(SETTINGS_ENTRY_TYPE, {
    schemaVersion: "1",
    mode: state.persistentMode,
    englishMode: state.englishMode,
  });
}

class AuditorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditorUnavailableError";
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        Boolean(part) &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function extractConversation(entries: SessionEntry[]): Array<{ role: "user" | "assistant"; text: string }> {
  const conversation: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = extractText(message.content).trim();
    if (text) conversation.push({ role: message.role, text });
  }
  return conversation.slice(-12);
}

function extractCompactionSummary(entries: SessionEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "compaction" || entry.type === "branch_summary") return entry.summary;
  }
  return undefined;
}

function resolveAuditorModel(
  ctx: ExtensionContext,
  requestedModel: string | undefined,
): PiModel {
  let model: PiModel | undefined;
  if (requestedModel) {
    const parsed = parseAuditorModelRef(requestedModel);
    if (!parsed) {
      throw new AuditorUnavailableError(
        `Invalid auditor model ${JSON.stringify(requestedModel)}; expected provider/model`,
      );
    }
    model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
    if (!model) throw new AuditorUnavailableError(`Auditor model ${requestedModel} was not found`);
  } else {
    model = ctx.model;
    if (!model) throw new AuditorUnavailableError("No target or auditor model is selected");
  }
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new AuditorUnavailableError(`No authentication is configured for ${model.provider}/${model.id}`);
  }
  return model;
}

function modelIsLocal(model: PiModel): boolean {
  try {
    const host = new URL(model.baseUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function effectiveEnglishMode(state: RuntimeState): EnglishMode {
  if (state.polishNext || state.englishMode === "polish-always") return "polish";
  return state.englishMode;
}

function buildSubject(event: InputEvent, text: string, englishMode: EnglishMode): AuditSubject {
  return {
    schemaVersion: "1",
    text,
    source: event.source,
    streamingBehavior: event.streamingBehavior,
    imageCount: event.images?.length ?? 0,
    englishMode,
  };
}

function devImageMetadata(images: InputEvent["images"]): PromptAuditDevImage[] {
  return (images ?? []).map((image) => ({
    mimeType: image.mimeType,
    encodedBytes: new TextEncoder().encode(image.data).byteLength,
  }));
}

function formatStatus(state: RuntimeState, auditorModel?: string): string {
  const english = state.polishNext ? "polish next" : state.englishMode.replace("-always", " always");
  return [
    `mode: ${state.mode}`,
    `English: ${english}`,
    `bypass next: ${state.bypassNext ? "yes" : "no"}`,
    `experiment next: ${state.experimentNext ? "yes" : "no"}`,
    `experiment active: ${state.experimentActive ? "yes" : "no"}`,
    `auditor model: ${auditorModel || "current target model"}`,
    "context profile: frontier-v1",
  ].join("\n");
}

function registerCommands(
  pi: ExtensionAPI,
  state: RuntimeState,
  continueExperiment: (id: string, ctx: ExtensionCommandContext) => Promise<void>,
): void {
  pi.registerCommand("audit", {
    description: "Control prompt auditing: on, off, strict, dev, experiment, or bypass-next",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      const continuationPrefix = "__continue-experiment ";
      if (value.startsWith(continuationPrefix)) {
        await continueExperiment(value.slice(continuationPrefix.length), ctx);
        return;
      }
      if (!value || value === "status") {
        const flag = pi.getFlag("audit-model");
        ctx.ui.notify(formatStatus(state, typeof flag === "string" ? flag : undefined), "info");
        return;
      }
      if (state.experimentActive) {
        ctx.ui.notify("An audit experiment is already running.", "warning");
        return;
      }
      if (value === "experiment") {
        state.experimentNext = true;
        ctx.ui.notify(
          "One-shot audit experiment armed. The next eligible prompt will store the raw input, auditor output, selection, and both target-agent responses, then run the target agent twice on sibling session branches: the non-selected input first, then your selected input. This doubles model/tool execution; conversation context is isolated, but filesystem and other external side effects are shared.",
          "warning",
        );
        return;
      }
      if (value === "on") state.mode = state.persistentMode = "advisory";
      else if (value === "off") state.mode = state.persistentMode = "disabled";
      else if (value === "strict") state.mode = state.persistentMode = "strict";
      else if (value === "dev") state.mode = "dev";
      else if (value === "bypass-next") state.bypassNext = true;
      else {
        ctx.ui.notify("Usage: /audit on|off|strict|dev|experiment|bypass-next|status", "warning");
        return;
      }
      if (value === "on" || value === "off" || value === "strict" || value === "dev") {
        state.experimentNext = false;
      }
      if (value === "on" || value === "off" || value === "strict") persistSettings(pi, state);
      if (value === "dev") {
        ctx.ui.notify(
          "Dev audit mode enabled. Raw prompt text, auditor responses, and selected or edited text will be stored in this Pi session and may contain secrets. Run /audit on to stop raw dataset capture.",
          "warning",
        );
        return;
      }
      ctx.ui.notify(`Prompt auditor updated: ${value}`, "info");
    },
  });

  pi.registerCommand("audit-english", {
    description: "Control English assistance: next, semantic, always, or off",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (state.experimentActive) {
        ctx.ui.notify("English audit settings cannot change during an experiment.", "warning");
        return;
      }
      if (value === "next") state.polishNext = true;
      else if (value === "semantic") {
        state.englishMode = "semantic-only";
        state.polishNext = false;
      } else if (value === "always") {
        state.englishMode = "polish-always";
        state.polishNext = false;
      } else if (value === "off") {
        state.englishMode = "off";
        state.polishNext = false;
      } else {
        ctx.ui.notify("Usage: /audit-english next|semantic|always|off", "warning");
        return;
      }
      if (value !== "next") persistSettings(pi, state);
      ctx.ui.notify(`English audit mode updated: ${value}`, "info");
    },
  });

  pi.registerCommand("audit-status", {
    description: "Show the effective prompt-auditor state",
    handler: async (_args, ctx) => {
      const flag = pi.getFlag("audit-model");
      ctx.ui.notify(formatStatus(state, typeof flag === "string" ? flag : undefined), "info");
    },
  });
}

async function safeRecord(pi: ExtensionAPI, config: AuditorConfig, input: AuditEntryInput): Promise<void> {
  if (!config.logging.enabled) return;
  try {
    pi.appendEntry("prompt-audit", await createAuditEntry(input));
  } catch {
    // Metrics must never interfere with prompt delivery.
  }
}

async function safeRecordDev(pi: ExtensionAPI, input: DevAuditEntryInput): Promise<boolean> {
  try {
    pi.appendEntry("prompt-audit-dev", createDevAuditEntry(input));
    return true;
  } catch {
    // Dataset logging must never interfere with prompt delivery.
    return false;
  }
}

function safeRecordExperiment(pi: ExtensionAPI, input: ExperimentEntryInput): boolean {
  try {
    pi.appendEntry("prompt-audit-experiment", createExperimentEntry(input));
    return true;
  } catch {
    return false;
  }
}

function captureAssistantMessages(event: AgentEndEvent): unknown[] {
  return event.messages
    .filter(
      (message) =>
        Boolean(message) && typeof message === "object" && "role" in message && message.role === "assistant",
    )
    .map((message) => structuredClone(message));
}

function finalAssistantText(messages: unknown[]): string {
  const message = messages.at(-1);
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        Boolean(part) &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function runtimeContext(
  event: InputEvent,
  ctx: ExtensionContext,
  config: AuditorConfig,
  modelSupportsImages: boolean,
  features: Record<string, boolean | number>,
): RoutingContext {
  return {
    mode: config.mode,
    runtimeMode: ctx.mode,
    projectTrusted: ctx.isProjectTrusted(),
    deterministicFeatures: features,
    modelSupportsImages,
  };
}

export default function promptAudit(pi: ExtensionAPI): void {
  pi.registerFlag("audit-model", {
    description: "Frontier auditor model as provider/model (defaults to the target model)",
    type: "string",
    default: "",
  });

  const state: RuntimeState = {
    mode: "disabled",
    persistentMode: "disabled",
    englishMode: "semantic-only",
    polishNext: false,
    bypassNext: false,
    experimentNext: false,
    experimentActive: false,
  };
  let activeExperiment: PendingExperiment | undefined;
  let continuationTimer: ReturnType<typeof setTimeout> | undefined;

  const continueExperiment = async (id: string, ctx: ExtensionCommandContext) => {
    const experiment = activeExperiment;
    if (
      !experiment ||
      experiment.phase !== "continuation-queued" ||
      id !== experiment.experimentId
    ) {
      if (ctx.hasUI) ctx.ui.notify("No matching audit experiment is waiting.", "warning");
      return;
    }

    try {
      const navigation = await ctx.navigateTree(experiment.commonContextEntryId);
      if (navigation.cancelled) throw new Error("session tree navigation was cancelled");

      const secondAlternative = experiment.executionOrder[1];
      experiment.runningAlternative = secondAlternative;
      experiment.phase = "second-running";
      const second = experiment.alternatives[secondAlternative];
      const content = experiment.images.length > 0
        ? [{ type: "text" as const, text: second.text }, ...experiment.images]
        : second.text;
      if (ctx.hasUI) {
        ctx.ui.notify(
          `First experiment branch finished. Running the selected ${secondAlternative} input on its sibling branch.`,
          "info",
        );
      }
      pi.sendUserMessage(content);
    } catch (error) {
      activeExperiment = undefined;
      state.experimentActive = false;
      if (ctx.hasUI) {
        const message = error instanceof Error ? error.message : "unknown navigation error";
        ctx.ui.notify(`Audit experiment stopped before the second branch: ${message}`, "warning");
      }
    }
  };
  registerCommands(pi, state, continueExperiment);

  const restoreBranchSettings = (ctx: ExtensionContext) => {
    restoreSettings(state, ctx.sessionManager.getBranch());
    state.polishNext = false;
    state.bypassNext = false;
    state.experimentNext = false;
  };
  pi.on("session_start", (_event, ctx) => restoreBranchSettings(ctx));
  pi.on("session_tree", (_event, ctx) => {
    if (!state.experimentActive) restoreBranchSettings(ctx);
  });

  pi.on("input", async (event, ctx): Promise<InputEventResult> => {
    if (state.experimentActive && event.source !== "extension") {
      if (ctx.hasUI) {
        ctx.ui.notify(
          "The two-branch audit experiment is still running. Submit the next prompt after its comparison is stored.",
          "warning",
        );
      }
      return { action: "handled" };
    }

    const experimentRequested = state.experimentNext;
    const modelFlag = pi.getFlag("audit-model");
    const config = createConfig({
      mode: experimentRequested ? "dev" : state.mode,
      auditorModel: typeof modelFlag === "string" && modelFlag.trim() ? modelFlag.trim() : undefined,
    });
    const eligibility = checkEligibility({
      text: event.text,
      source: event.source,
      streamingBehavior: event.streamingBehavior,
      mode: config.mode,
      bypassNext: state.bypassNext,
      steerPolicy: config.streaming.steer,
      followUpPolicy: config.streaming.followUp,
    });
    if (!eligibility.audit) {
      if (eligibility.consumeBypass) state.bypassNext = false;
      return { action: "continue" };
    }
    if (experimentRequested) state.experimentNext = false;

    const englishMode = effectiveEnglishMode(state);
    if (state.polishNext) state.polishNext = false;
    const originalText = event.text;
    let text = originalText;
    let reaudits = 0;
    const submissionId = globalThis.crypto.randomUUID();
    const images = devImageMetadata(event.images);
    const engineIdentity = { id: "frontier-combined", version: "1.0.0" };
    const requestStarted = performance.now();
    let experimentDevLoggingSucceeded = true;

    const finishWithExperiment = (
      fallback: InputEventResult,
      candidateText: string | undefined,
      candidateOrigin: "auditor-revision" | "user-edit",
      selectedAlternative: PromptAuditExperimentAlternative,
    ): InputEventResult => {
      if (!experimentRequested) return fallback;

      const candidate = candidateText?.trim();
      const commonContextEntryId = ctx.sessionManager.getLeafId();
      const targetModel = ctx.model;
      if (!experimentDevLoggingSucceeded) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Audit experiment skipped because its raw dev record could not be stored. The one-shot experiment has been disarmed.",
            "warning",
          );
        }
        return fallback;
      }
      if (
        !commonContextEntryId ||
        !targetModel ||
        !candidate ||
        candidate === originalText
      ) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Audit experiment skipped because two distinct prompt alternatives were not available. The one-shot experiment has been disarmed.",
            "warning",
          );
        }
        return fallback;
      }

      const executionOrder: [
        PromptAuditExperimentAlternative,
        PromptAuditExperimentAlternative,
      ] = selectedAlternative === "initial"
        ? ["candidate", "initial"]
        : ["initial", "candidate"];
      activeExperiment = {
        experimentId: globalThis.crypto.randomUUID(),
        auditSubmissionId: submissionId,
        commonContextEntryId,
        target: { provider: targetModel.provider, modelId: targetModel.id },
        images: [...(event.images ?? [])],
        imageMetadata: images,
        alternatives: {
          initial: { text: originalText, origin: "initial-input" },
          candidate: { text: candidate, origin: candidateOrigin },
        },
        selectedAlternative,
        executionOrder,
        runningAlternative: executionOrder[0],
        phase: "first-running",
        responses: {},
      };
      state.experimentActive = true;
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Audit experiment started. Running the non-selected ${executionOrder[0]} input first; the selected ${executionOrder[1]} input will run on the final active branch.`,
          "info",
        );
      }

      const firstText = activeExperiment.alternatives[executionOrder[0]].text;
      return firstText === originalText
        ? { action: "continue" }
        : { action: "transform", text: firstText, images: event.images };
    };

    if (ctx.hasUI) ctx.ui.setStatus("wasabi-audit", "Auditing prompt…");
    try {
      while (true) {
        const subject = buildSubject(event, text, englishMode);
        const features = detectDeterministicFeatures(text);
        const auditorModel = resolveAuditorModel(ctx, config.auditorModel);
        const runtime = runtimeContext(
          event,
          ctx,
          config,
          auditorModel.input.includes("image"),
          features,
        );
        const route = selectEngineRoute(subject, runtime, config);
        if (route.auditEngineId !== "frontier-combined") {
          throw new AuditorUnavailableError(`Unsupported audit engine ${route.auditEngineId}`);
        }

        const engine = new FrontierCombinedEngine({
          timeoutMs: config.limits.auditTimeoutMs,
          maxOutputTokens: config.limits.maxOutputTokens,
          maxInputTokens: config.contextGovernance.maxInputTokens,
          complete: async (request) => {
            const response = await ctx.modelRegistry.complete(
              auditorModel,
              {
                systemPrompt: request.systemPrompt,
                messages: [{ role: "user", content: request.content, timestamp: Date.now() }],
              },
              {
                signal: request.signal,
                maxTokens: request.maxOutputTokens,
                cacheRetention: "none",
                sessionId: ctx.sessionManager.getSessionId(),
                transformHeaders: (headers: BeforeProviderHeadersEvent["headers"]) => ({
                  ...headers,
                  ...liteLLMSessionHeaders(
                    auditorModel.provider,
                    ctx.sessionManager.getSessionId(),
                  ),
                }),
              },
            );
            return {
              text: response.content
                .filter((part): part is { type: "text"; text: string } => part.type === "text")
                .map((part) => part.text)
                .join("\n"),
              stopReason: response.stopReason,
              errorMessage: response.errorMessage,
              usage: response.usage,
            };
          },
        });

        const profile = engine.contextProfile(subject, runtime);
        const entries = ctx.sessionManager.buildContextEntries();
        const allTools = pi.getAllTools();
        const activeNames = new Set(pi.getActiveTools());
        const systemPrompt = ctx.getSystemPrompt();
        const sources = createMvpContextSources({
          subject,
          images: event.images ?? [],
          conversation: extractConversation(entries),
          compactionSummary: extractCompactionSummary(entries),
          systemPrompt,
          systemPromptDigest: createSystemPromptDigest(systemPrompt),
          activeTools: allTools
            .filter((tool) => activeNames.has(tool.name))
            .map((tool) => ({ name: tool.name, description: tool.description })),
          targetModel: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
          workingDirectory: ctx.cwd,
          runtime: {
            mode: ctx.mode,
            state: event.streamingBehavior === "steer"
              ? "steer"
              : event.streamingBehavior === "followUp"
                ? "follow-up"
                : "idle",
          },
          config,
          deterministicFeatures: features,
          modelSupportsImages: auditorModel.input.includes("image"),
        });
        const bundle = await planContext({
          auditProfile: profile,
          policyProfile: profile,
          sources,
          governance: {
            ...config.contextGovernance,
            maxInputTokens: Math.max(1, config.contextGovernance.maxInputTokens - 2_200),
            projectTrusted: ctx.isProjectTrusted(),
            providerLocality: modelIsLocal(auditorModel) ? "local" : "cloud",
          },
        });
        if (bundle.requiredOmissions.length > 0) {
          throw new AuditorUnavailableError(
            `Required audit context was unavailable: ${bundle.requiredOmissions
              .map((item) => `${item.capability} (${item.reason})`)
              .join(", ")}`,
          );
        }

        const auditStarted = performance.now();
        const outcome = await engine.auditCombined({ subject, bundle }, ctx.signal);
        const auditLatencyMs = Math.max(0, performance.now() - auditStarted);
        if (outcome.kind !== "report") {
          throw new AuditorUnavailableError("The MVP does not permit dynamic context expansion");
        }
        const recommendation = await engine.decide({
          subject,
          findings: outcome.report,
          context: bundle.policy,
          hostPolicy: config,
        });
        const decision = enforceHostPolicy(recommendation, outcome.report, config, ctx.hasUI);

        const record = async (
          userAction: AuditUserAction,
          userSelection: PromptAuditDevSelection,
        ) => {
          await safeRecord(pi, config, {
            subject,
            config,
            engine: engineIdentity,
            manifest: bundle.manifest,
            report: outcome.report,
            decision,
            userAction,
            auditLatencyMs,
            usage: outcome.usage,
            reaudits,
          });
          if (config.mode === "dev") {
            const devStored = await safeRecordDev(pi, {
              captureMode: experimentRequested ? "experiment" : "dev",
              submissionId,
              attempt: reaudits,
              initialText: originalText,
              subject,
              images,
              auditor: {
                engineId: engineIdentity.id,
                engineVersion: engineIdentity.version,
                provider: auditorModel.provider,
                modelId: auditorModel.id,
              },
              manifest: bundle.manifest,
              auditorResponses: outcome.rawResponses ?? [],
              report: outcome.report,
              userSelection,
              usage: outcome.usage,
              auditLatencyMs,
            });
            if (experimentRequested && !devStored) experimentDevLoggingSucceeded = false;
          }
        };

        if (decision.action === "continue") {
          await record("passed", {
            kind: "forwarded",
            submittedText: text === originalText ? "initial" : "edited",
          });
          const fallback: InputEventResult = text === originalText
            ? { action: "continue" }
            : { action: "transform", text, images: event.images };
          return finishWithExperiment(
            fallback,
            text === originalText ? outcome.report.revisedPrompt : text,
            text === originalText ? "auditor-revision" : "user-edit",
            text === originalText ? "initial" : "candidate",
          );
        }

        if (!ctx.hasUI) {
          await record("headless-forwarded", { kind: "headless-forward" });
          return finishWithExperiment(
            { action: "continue" },
            outcome.report.revisedPrompt,
            "auditor-revision",
            "initial",
          );
        }

        const review = await reviewPrompt(originalText, outcome.report, decision, ctx.ui);
        if (review.action === "apply") {
          await record("applied-revision", {
            kind: "apply-suggested",
            submittedText: review.text,
          });
          return finishWithExperiment(
            { action: "transform", text: review.text, images: event.images },
            review.text,
            "auditor-revision",
            "candidate",
          );
        }
        if (review.action === "original") {
          await record("overrode", { kind: "send-original" });
          return finishWithExperiment(
            { action: "continue" },
            outcome.report.revisedPrompt,
            "auditor-revision",
            "initial",
          );
        }
        if (review.action === "cancel") {
          await record("cancelled", { kind: "cancel" });
          return { action: "handled" };
        }

        if (reaudits < decision.maxReaudits) {
          await record("edited-and-reaudited", {
            kind: "edit",
            submittedText: review.text,
            reaudited: true,
          });
          text = review.text;
          reaudits += 1;
          continue;
        }
        await record("edited", {
          kind: "edit",
          submittedText: review.text,
          reaudited: false,
        });
        return finishWithExperiment(
          { action: "transform", text: review.text, images: event.images },
          review.text,
          "user-edit",
          "candidate",
        );
      }
    } catch (error) {
      const subject = buildSubject(event, text, englishMode);
      const action = failureAction(config, ctx.hasUI);
      await safeRecord(pi, config, {
        subject,
        config,
        engine: engineIdentity,
        userAction: action === "continue" ? "failure-opened" : "failure-closed",
        auditLatencyMs: Math.max(0, performance.now() - requestStarted),
        reaudits,
        error,
      });
      if (ctx.hasUI) {
        const message = error instanceof Error ? error.message : "Unknown auditor error";
        ctx.ui.notify(
          action === "continue"
            ? `Prompt audit unavailable; sending the original prompt. ${message}`
            : `Prompt audit unavailable; submission stopped. ${message}`,
          "warning",
        );
      }
      return { action };
    } finally {
      if (ctx.hasUI) ctx.ui.setStatus("wasabi-audit", undefined);
    }
  });

  pi.on("agent_end", (event, ctx) => {
    const experiment = activeExperiment;
    if (!experiment || experiment.phase === "continuation-queued") return;
    const assistantMessages = captureAssistantMessages(event);
    experiment.responses[experiment.runningAlternative] = {
      branchLeafId: ctx.sessionManager.getLeafId() ?? undefined,
      finalText: finalAssistantText(assistantMessages),
      assistantMessages,
    };
  });

  pi.on("agent_settled", (_event, ctx) => {
    const experiment = activeExperiment;
    if (!experiment) return;

    if (experiment.phase === "first-running") {
      const firstAlternative = experiment.executionOrder[0];
      experiment.responses[firstAlternative] ??= {
        branchLeafId: ctx.sessionManager.getLeafId() ?? undefined,
        finalText: "",
        assistantMessages: [],
      };
      experiment.phase = "continuation-queued";
      continuationTimer = setTimeout(() => {
        continuationTimer = undefined;
        if (activeExperiment !== experiment || experiment.phase !== "continuation-queued") return;
        pi.sendUserMessage(`/audit __continue-experiment ${experiment.experimentId}`, {
          expandPromptTemplates: true,
        });
      }, 0);
      return;
    }

    if (experiment.phase !== "second-running") return;
    const secondAlternative = experiment.executionOrder[1];
    experiment.responses[secondAlternative] ??= {
      branchLeafId: ctx.sessionManager.getLeafId() ?? undefined,
      finalText: "",
      assistantMessages: [],
    };
    const stored = safeRecordExperiment(pi, {
      experimentId: experiment.experimentId,
      auditSubmissionId: experiment.auditSubmissionId,
      commonContextEntryId: experiment.commonContextEntryId,
      target: experiment.target,
      images: experiment.imageMetadata,
      contextIsolation: "pi-session-branches",
      externalSideEffectsIsolated: false,
      alternatives: experiment.alternatives,
      selectedAlternative: experiment.selectedAlternative,
      executionOrder: experiment.executionOrder,
      runs: (["initial", "candidate"] as const).map((alternative) => ({
        alternative,
        branchLeafId: experiment.responses[alternative]?.branchLeafId,
        finalText: experiment.responses[alternative]?.finalText ?? "",
        assistantMessages: experiment.responses[alternative]?.assistantMessages ?? [],
      })),
    });
    activeExperiment = undefined;
    state.experimentActive = false;
    if (ctx.hasUI) {
      ctx.ui.notify(
        stored
          ? "Audit experiment complete. Both target-agent responses were stored; the selected-input branch is active."
          : "Audit experiment completed, but its comparison record could not be stored.",
        stored ? "info" : "warning",
      );
    }
  });

  pi.on("session_shutdown", () => {
    if (continuationTimer !== undefined) clearTimeout(continuationTimer);
    continuationTimer = undefined;
    activeExperiment = undefined;
    state.experimentActive = false;
  });
}
