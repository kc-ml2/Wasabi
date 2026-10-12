import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { audit } from "./engine.ts";
import { loadConfig } from "./config.ts";
import { screen } from "./jev.ts";
import type { AuditResult, Config, ContextInput, Decision, Screening } from "./types.ts";

export interface ScreeningOverrides {
  loadScreeningConfig?: () => Config;
  screen?: typeof screen;
}

/** Additive, content-free metadata for the existing Wasabi session records. */
export interface ScreeningMetadata {
  profile: "jev-screen-v1";
  policyVersion: "jev-policy-v1";
  status: "completed" | "failed";
  route: "pass" | "review" | "english" | "dev" | "experiment" | "fallback";
  model?: string;
  action?: Decision["action"];
  probabilities?: Screening["probabilities"];
  reasons?: Decision["reasons"];
  uncertain?: Decision["uncertain"];
  thresholds?: Pick<Config["policy"], "askThreshold" | "observeThreshold" | "uncertaintyLow" | "uncertaintyHigh">;
  latencyMs: number;
  usage?: Screening["usage"];
  coverage?: AuditResult["envelope"]["coverage"] & { imageCount: number };
  fallbackReason?: "screening-unavailable";
  reviewer?: { provider: string; modelId: string };
  reviewLatencyMs?: number;
}

export function screeningStatus(overrides: ScreeningOverrides): string {
  try {
    const config = (overrides.loadScreeningConfig ?? loadConfig)();
    return `JEV model: ${config.jev.model}; key (${config.jev.apiKeyEnv}): ${process.env[config.jev.apiKeyEnv]?.trim() ? "available" : "missing"}`;
  } catch {
    return "JEV configuration: invalid (Pi reviewer fallback)";
  }
}

/** Bounded evidence for the reviewer, kept out of normal session metadata. */
export interface ScreeningReviewContext {
  decision: Decision;
  probabilities: Screening["probabilities"];
  coverage: AuditResult["envelope"]["coverage"];
  approvedConventions: string[];
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((part: unknown) => {
    if (!part || typeof part !== "object") return [];
    const block = part as { type?: unknown; text?: unknown };
    return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
}

export async function screenInput(
  event: InputEvent, ctx: ExtensionContext, pi: ExtensionAPI,
  signal: AbortSignal, overrides: ScreeningOverrides,
): Promise<{ result: AuditResult; metadata: ScreeningMetadata }> {
  const config = (overrides.loadScreeningConfig ?? loadConfig)();
  const messages: NonNullable<ContextInput["recentMessages"]> = [];
  let summary: string | undefined;
  if (config.context.includeConversation) {
    for (const entry of ctx.sessionManager.buildContextEntries()) {
      if (entry.type === "compaction" || entry.type === "branch_summary") summary = entry.summary;
      if (entry.type !== "message") continue;
      if (entry.message.role !== "user" && entry.message.role !== "assistant") continue;
      const text = textContent(entry.message.content);
      if (text) messages.push({ role: entry.message.role, text });
    }
  }
  const active = new Set(pi.getActiveTools());
  const result = await audit({
    prompt: event.text, recentMessages: messages, summary,
    tools: pi.getAllTools().filter(tool => active.has(tool.name)).map(({ name, description }) => ({ name, description })),
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    systemPrompt: config.context.includeSystemPrompt ? ctx.getSystemPrompt() : undefined,
    cwd: config.context.includeCwd ? ctx.cwd : undefined,
    imageCount: event.images?.length ?? 0, source: event.source, streamingBehavior: event.streamingBehavior,
  }, config, { screen: overrides.screen ?? screen }, signal);
  const { askThreshold, observeThreshold, uncertaintyLow, uncertaintyHigh } = config.policy;
  return {
    result,
    metadata: {
      profile: "jev-screen-v1", policyVersion: "jev-policy-v1", status: "completed",
      route: result.decision.reviewRequired ? "review" : "pass",
      model: result.screening.model, action: result.decision.action,
      probabilities: result.screening.probabilities, reasons: result.decision.reasons,
      uncertain: result.decision.uncertain,
      thresholds: { askThreshold, observeThreshold, uncertaintyLow, uncertaintyHigh },
      latencyMs: result.screening.latencyMs, usage: result.screening.usage,
      coverage: { ...result.envelope.coverage, imageCount: result.envelope.runtime.imageCount },
    },
  };
}
