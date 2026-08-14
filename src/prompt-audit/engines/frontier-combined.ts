import type { AuditorConfig } from "../config.ts";
import type {
  AuditEngineOutcome,
  AuditReport,
  AuditSubject,
  AuditUsage,
  PolicyRecommendation,
  RoutingContext,
} from "../domain.ts";
import type {
  ContextEnvelope,
  ContextSection,
  EngineContextProfile,
  MaterializedContextBundle,
} from "../context/capabilities.ts";
import { frontierV1Profile } from "../context/profiles/frontier-v1.ts";
import { recommendPolicy } from "../host-policy.ts";
import {
  FRONTIER_AUDITOR_SYSTEM_PROMPT,
  FRONTIER_REPAIR_SYSTEM_PROMPT,
} from "../prompts/frontier-auditor-system.ts";
import type { AuditEngine } from "./audit-engine.ts";
import { AuditSchemaError, parseAuditReportJson } from "./audit-schema.ts";
import type { PolicyEngine } from "./policy-engine.ts";

export interface FrontierImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface FrontierTextContent {
  type: "text";
  text: string;
}

export interface FrontierCompletionRequest {
  systemPrompt: string;
  content: (FrontierTextContent | FrontierImageContent)[];
  signal: AbortSignal;
  maxOutputTokens: number;
}

export interface FrontierCompletionResult {
  text: string;
  stopReason: "stop" | "length" | "error" | "aborted" | string;
  errorMessage?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export type FrontierComplete = (
  request: FrontierCompletionRequest,
) => Promise<FrontierCompletionResult>;

export interface FrontierCombinedOptions {
  complete: FrontierComplete;
  timeoutMs: number;
  maxOutputTokens: number;
  maxInputTokens?: number;
}

function sectionKey(section: ContextSection): string {
  return `${section.capability}:${section.representation}`;
}

function isImage(value: unknown): value is FrontierImageContent {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "image" &&
    typeof record.data === "string" &&
    typeof record.mimeType === "string"
  );
}

function serializeBundle(
  subject: AuditSubject,
  bundle: Pick<MaterializedContextBundle, "audit" | "policy" | "manifest">,
): (FrontierTextContent | FrontierImageContent)[] {
  const seen = new Set<string>();
  const textSections: string[] = [];
  const images: FrontierImageContent[] = [];
  const sections = [...bundle.audit.sections, ...bundle.policy.sections];

  for (const section of sections) {
    const key = sectionKey(section);
    if (seen.has(key)) continue;
    seen.add(key);
    if (section.capability === "prompt.raw") continue;

    if (section.capability === "prompt.images" && section.representation === "original-images") {
      if (Array.isArray(section.content)) images.push(...section.content.filter(isImage));
      textSections.push(
        `[UNTRUSTED CONTEXT: prompt.images; representation=original-images; count=${images.length}]`,
      );
      continue;
    }

    const serialized = JSON.stringify(section.content);
    textSections.push(
      `[BEGIN UNTRUSTED CONTEXT ${section.capability}; representation=${section.representation}; characters=${serialized.length}]\n${serialized}\n[END UNTRUSTED CONTEXT ${section.capability}]`,
    );
  }

  const subjectJson = JSON.stringify({
    schemaVersion: subject.schemaVersion,
    text: subject.text,
    source: subject.source,
    streamingBehavior: subject.streamingBehavior ?? null,
    imageCount: subject.imageCount,
    englishMode: subject.englishMode,
  });
  const manifestJson = JSON.stringify({
    profile: bundle.manifest.auditProfileId,
    granted: bundle.manifest.grantedCapabilities,
    omitted: bundle.manifest.omittedCapabilities.map((item) => ({
      capability: item.capability,
      reason: item.reason,
    })),
  });

  return [
    {
      type: "text",
      text: [
        `[BEGIN UNTRUSTED AUDIT SUBJECT; characters=${subject.text.length}]`,
        subjectJson,
        "[END UNTRUSTED AUDIT SUBJECT]",
        "",
        ...textSections,
        "",
        `[CONTEXT MANIFEST] ${manifestJson}`,
        "Audit this subject now and return only the required JSON object.",
      ].join("\n"),
    },
    ...images,
  ];
}

function emptyPolicyEnvelope(profileId: string): ContextEnvelope {
  return { schemaVersion: "1", audience: "policy", profileId, sections: [], omissions: [] };
}

function emptyManifest(profileId: string): MaterializedContextBundle["manifest"] {
  return {
    schemaVersion: "1",
    auditProfileId: profileId,
    policyProfileId: profileId,
    requestedCapabilities: [],
    grantedCapabilities: [],
    downgradedCapabilities: [],
    omittedCapabilities: [],
    sections: [],
    estimatedTokens: 0,
    materializationLatencyMs: 0,
    providerLocality: "cloud",
    projectTrustRequired: false,
    projectTrusted: false,
  };
}

function addUsage(target: AuditUsage, result: FrontierCompletionResult): void {
  target.inputTokens = (target.inputTokens ?? 0) + (result.usage?.input ?? 0);
  target.outputTokens = (target.outputTokens ?? 0) + (result.usage?.output ?? 0);
  target.cacheReadTokens = (target.cacheReadTokens ?? 0) + (result.usage?.cacheRead ?? 0);
  target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + (result.usage?.cacheWrite ?? 0);
}

function estimateRequestTokens(request: FrontierCompletionRequest): number {
  const systemTokens = Math.ceil(request.systemPrompt.length / 4);
  const contentTokens = request.content.reduce(
    (total, part) => total + (part.type === "text" ? Math.ceil(part.text.length / 4) : 1_000),
    0,
  );
  return systemTokens + contentTokens;
}

export class AuditTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Prompt audit timed out after ${timeoutMs}ms`);
    this.name = "AuditTimeoutError";
  }
}

export class FrontierCombinedEngine implements AuditEngine, PolicyEngine {
  readonly id = "frontier-combined";
  readonly version = "1.0.0";

  constructor(private readonly options: FrontierCombinedOptions) {}

  contextProfile(subject: AuditSubject, _runtime: RoutingContext): EngineContextProfile {
    return frontierV1Profile(subject);
  }

  async audit(
    input: { subject: AuditSubject; context: ContextEnvelope },
    signal?: AbortSignal,
  ): Promise<AuditEngineOutcome> {
    return this.auditCombined(
      {
        subject: input.subject,
        bundle: {
          audit: input.context,
          policy: emptyPolicyEnvelope(input.context.profileId),
          manifest: emptyManifest(input.context.profileId),
        },
      },
      signal,
    );
  }

  async auditCombined(
    input: {
      subject: AuditSubject;
      bundle: Pick<MaterializedContextBundle, "audit" | "policy" | "manifest">;
    },
    signal?: AbortSignal,
  ): Promise<AuditEngineOutcome> {
    const timeoutController = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const usage: AuditUsage = { attempts: 0 };
    const originalContent = serializeBundle(input.subject, input.bundle);
    let lastError: AuditSchemaError | undefined;
    let malformedOutput = "";
    const rawResponses: string[] = [];

    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          timeoutController.abort();
          reject(new AuditTimeoutError(this.options.timeoutMs));
        }, this.options.timeoutMs);
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        usage.attempts += 1;
        const request: FrontierCompletionRequest =
          attempt === 0
            ? {
                systemPrompt: FRONTIER_AUDITOR_SYSTEM_PROMPT,
                content: originalContent,
                signal: combinedSignal,
                maxOutputTokens: this.options.maxOutputTokens,
              }
            : {
                systemPrompt: FRONTIER_REPAIR_SYSTEM_PROMPT,
                content: [
                  {
                    type: "text",
                    text: [
                      "The previous response failed validation.",
                      `Validation errors: ${lastError?.validationErrors.join("; ")}`,
                      "Return a repaired object with the documented AuditReport fields.",
                      "[BEGIN UNTRUSTED MALFORMED RESPONSE]",
                      malformedOutput.slice(0, 12_000),
                      "[END UNTRUSTED MALFORMED RESPONSE]",
                    ].join("\n"),
                  },
                ],
                signal: combinedSignal,
                maxOutputTokens: this.options.maxOutputTokens,
              };

        if (estimateRequestTokens(request) > (this.options.maxInputTokens ?? Number.POSITIVE_INFINITY)) {
          throw new Error(
            `Materialized audit request exceeds the ${this.options.maxInputTokens} token input limit`,
          );
        }

        const result = await Promise.race([this.options.complete(request), timeoutPromise]);
        addUsage(usage, result);
        if (result.stopReason === "aborted") throw new Error("Prompt audit was aborted");
        if (result.stopReason === "error") {
          throw new Error(result.errorMessage || "Auditor model returned an error");
        }
        malformedOutput = result.text;
        rawResponses.push(result.text);
        try {
          const report = parseAuditReportJson(result.text, input.subject.englishMode);
          return { kind: "report", report, usage, rawResponses };
        } catch (error) {
          if (!(error instanceof AuditSchemaError)) throw error;
          lastError = error;
        }
      }
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }

    throw lastError ?? new AuditSchemaError(["auditor returned no valid report"]);
  }

  async decide(input: {
    subject: AuditSubject;
    findings: AuditReport;
    context: ContextEnvelope;
    hostPolicy: AuditorConfig;
  }): Promise<PolicyRecommendation> {
    return recommendPolicy(input.findings);
  }
}
