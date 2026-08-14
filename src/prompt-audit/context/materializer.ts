import type { AuditorConfig } from "../config.ts";
import type { AuditSubject } from "../domain.ts";
import {
  estimateTokens,
  type ContextSource,
  type MaterializedSourceValue,
} from "./capabilities.ts";

export interface SubmissionImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ConversationExcerpt {
  role: "user" | "assistant";
  text: string;
}

export interface ActiveToolSummary {
  name: string;
  description: string;
}

export interface MvpMaterializationInput {
  subject: AuditSubject;
  images: SubmissionImage[];
  conversation: ConversationExcerpt[];
  compactionSummary?: string;
  systemPrompt?: string;
  systemPromptDigest?: string;
  activeTools: ActiveToolSummary[];
  targetModel?: { provider: string; modelId: string };
  workingDirectory: string;
  runtime: {
    mode: "tui" | "rpc" | "json" | "print";
    state: "idle" | "steer" | "follow-up";
  };
  config: AuditorConfig;
  deterministicFeatures: Record<string, boolean | number>;
  modelSupportsImages: boolean;
  namedProjectContext?: string;
}

function truncateText(text: string, maxTokens: number, keepEnd = false): MaterializedSourceValue {
  const maxChars = Math.max(0, maxTokens * 4);
  if (text.length <= maxChars) {
    return { content: text, estimatedTokens: estimateTokens(text), truncated: false };
  }
  const marker = "[truncated]";
  const available = Math.max(0, maxChars - marker.length - 1);
  const content = keepEnd
    ? `${marker}\n${text.slice(-available)}`
    : `${text.slice(0, available)}\n${marker}`;
  return { content, estimatedTokens: estimateTokens(content), truncated: true };
}

function fixedSource(
  source: Omit<ContextSource, "materialize"> & { value: unknown },
): ContextSource {
  return {
    ...source,
    materialize: async (_representation, maxTokens) => {
      if (typeof source.value === "string" && source.truncatable) {
        return truncateText(source.value, maxTokens);
      }
      return {
        content: source.value,
        estimatedTokens: source.estimatedTokens,
        truncated: false,
      };
    },
  };
}

function conversationSource(conversation: ConversationExcerpt[]): ContextSource {
  return {
    capability: "conversation.recent",
    available: conversation.length > 0,
    provenance: "active branch via sessionManager.buildContextEntries()",
    sensitivity: "personal",
    estimatedTokens: estimateTokens(conversation),
    supportedRepresentations: ["exchanges-v1"],
    requiresProjectTrust: false,
    performsIO: false,
    truncatable: true,
    materialize: async (_representation, maxTokens) => {
      const kept = conversation.slice(-12);
      let textTruncated = false;
      while (kept.length > 1 && estimateTokens(kept) > maxTokens) kept.shift();
      if (estimateTokens(kept) > maxTokens) {
        const last = kept[0];
        const truncated = truncateText(last.text, Math.max(1, maxTokens - 20), true);
        kept[0] = { ...last, text: String(truncated.content) };
        textTruncated = truncated.truncated;
      }
      return {
        content: kept,
        estimatedTokens: estimateTokens(kept),
        truncated: kept.length < conversation.length || textTruncated,
      };
    },
  };
}

function toolsSource(tools: ActiveToolSummary[]): ContextSource {
  return {
    capability: "agent.active-tools",
    available: true,
    provenance: "pi.getActiveTools()/pi.getAllTools()",
    sensitivity: "low",
    estimatedTokens: estimateTokens(tools),
    supportedRepresentations: ["names-and-descriptions-v1"],
    requiresProjectTrust: false,
    performsIO: false,
    truncatable: true,
    materialize: async (_representation, maxTokens) => {
      const kept = tools.map((tool) => ({ ...tool, description: tool.description.slice(0, 240) }));
      while (kept.length > 1 && estimateTokens(kept) > maxTokens) kept.pop();
      return {
        content: kept,
        estimatedTokens: estimateTokens(kept),
        truncated: kept.length < tools.length,
      };
    },
  };
}

function imagesSource(input: MvpMaterializationInput): ContextSource {
  const metadata = input.images.map((image) => ({
    mimeType: image.mimeType,
    encodedBytes: image.data.length,
  }));
  const supportedRepresentations = input.modelSupportsImages
    ? ["original-images", "image-metadata-v1"]
    : ["image-metadata-v1"];
  return {
    capability: "prompt.images",
    available: input.images.length > 0,
    provenance: "input event attachments",
    sensitivity: "personal",
    estimatedTokens: input.modelSupportsImages
      ? Math.max(1, input.images.length * 1_000)
      : estimateTokens(metadata),
    supportedRepresentations,
    requiresProjectTrust: false,
    performsIO: false,
    truncatable: true,
    materialize: async (representation, maxTokens) => {
      if (representation === "image-metadata-v1") {
        return { content: metadata, estimatedTokens: estimateTokens(metadata), truncated: false };
      }
      const maxImages = Math.max(1, Math.floor(maxTokens / 1_000));
      const content = input.images.slice(0, maxImages);
      return {
        content,
        estimatedTokens: content.length * 1_000,
        truncated: content.length < input.images.length,
      };
    },
  };
}

export function createMvpContextSources(input: MvpMaterializationInput): ContextSource[] {
  const promptTokens = estimateTokens(input.subject.text);
  const metadata = {
    source: input.subject.source,
    streamingBehavior: input.subject.streamingBehavior ?? null,
    imageCount: input.subject.imageCount,
    characterCount: input.subject.text.length,
  };
  const policy = {
    mode: input.config.mode === "dev" ? "advisory" : input.config.mode,
    destructiveSensitivity: "high",
    maxReaudits: input.config.limits.maxReaudits,
    maxContextExpansions: input.config.limits.maxContextExpansions,
  };

  return [
    fixedSource({
      capability: "prompt.raw",
      available: true,
      provenance: "input event text",
      sensitivity: "personal",
      estimatedTokens: promptTokens,
      supportedRepresentations: ["exact-text"],
      requiresProjectTrust: false,
      performsIO: false,
      truncatable: false,
      value: input.subject.text,
    }),
    fixedSource({
      capability: "prompt.metadata",
      available: true,
      provenance: "input event metadata",
      sensitivity: "low",
      estimatedTokens: estimateTokens(metadata),
      supportedRepresentations: ["structured-v1"],
      requiresProjectTrust: false,
      performsIO: false,
      truncatable: false,
      value: metadata,
    }),
    imagesSource(input),
    fixedSource({
      capability: "prompt.image-metadata",
      available: input.images.length > 0,
      provenance: "input event attachment metadata",
      sensitivity: "personal",
      estimatedTokens: estimateTokens(
        input.images.map((image) => ({ mimeType: image.mimeType, encodedBytes: image.data.length })),
      ),
      supportedRepresentations: ["image-metadata-v1"],
      requiresProjectTrust: false,
      performsIO: false,
      truncatable: false,
      value: input.images.map((image) => ({
        mimeType: image.mimeType,
        encodedBytes: image.data.length,
      })),
    }),
    conversationSource(input.conversation),
    fixedSource({
      capability: "conversation.compaction-summary",
      available: Boolean(input.compactionSummary),
      provenance: "latest active-branch compaction or branch summary",
      sensitivity: "personal",
      estimatedTokens: estimateTokens(input.compactionSummary ?? ""),
      supportedRepresentations: ["summary-text"],
      requiresProjectTrust: false,
      performsIO: false,
      truncatable: true,
      value: input.compactionSummary ?? "",
    }),
    fixedSource({
      capability: "agent.system-prompt-digest",
      available: Boolean(input.systemPromptDigest),
      provenance: "bounded digest of ctx.getSystemPrompt()",
      sensitivity: "project",
      estimatedTokens: estimateTokens(input.systemPromptDigest ?? ""),
      supportedRepresentations: ["bounded-digest-v1"],
      requiresProjectTrust: true,
      performsIO: false,
      truncatable: true,
      value: input.systemPromptDigest ?? "",
    }),
    fixedSource({
      capability: "agent.system-prompt-full",
      available: Boolean(input.systemPrompt),
      provenance: "ctx.getSystemPrompt()",
      sensitivity: "secret",
      estimatedTokens: estimateTokens(input.systemPrompt ?? ""),
      supportedRepresentations: ["exact-text"],
      requiresProjectTrust: true,
      performsIO: false,
      truncatable: true,
      value: input.systemPrompt ?? "",
    }),
    toolsSource(input.activeTools),
    fixedSource({
      capability: "agent.model-identity",
      available: Boolean(input.targetModel),
      provenance: "ctx.model",
      sensitivity: "low",
      estimatedTokens: estimateTokens(input.targetModel ?? {}),
      supportedRepresentations: ["provider-model-v1"],
      requiresProjectTrust: false,
      performsIO: false,
      truncatable: false,
      value: input.targetModel ?? {},
    }),
    fixedSource({
      capability: "runtime.working-directory",
      available: true,
      provenance: "ctx.cwd",
      sensitivity: "project",
      estimatedTokens: estimateTokens(input.workingDirectory),
      supportedRepresentations: ["normalized-path"],
      requiresProjectTrust: true,
      performsIO: false,
      truncatable: true,
      value: input.workingDirectory,
    }),
    fixedSource({
      capability: "runtime.mode",
      available: true,
      provenance: "extension context and input event",
      sensitivity: "low",
      estimatedTokens: estimateTokens(input.runtime),
      supportedRepresentations: ["structured-v1"],
      requiresProjectTrust: false,
      performsIO: false,
      truncatable: false,
      value: input.runtime,
    }),
    fixedSource({
      capability: "user.audit-policy",
      available: true,
      provenance: "effective Wasabi configuration",
      sensitivity: "low",
      estimatedTokens: estimateTokens(policy),
      supportedRepresentations: ["thresholds-v1"],
      requiresProjectTrust: false,
      performsIO: false,
      truncatable: false,
      value: policy,
    }),
    fixedSource({
      capability: "user.english-mode",
      available: true,
      provenance: "Wasabi session state",
      sensitivity: "low",
      estimatedTokens: estimateTokens(input.subject.englishMode),
      supportedRepresentations: ["mode-v1"],
      requiresProjectTrust: false,
      performsIO: false,
      truncatable: false,
      value: input.subject.englishMode,
    }),
    fixedSource({
      capability: "risk.deterministic-features",
      available: true,
      provenance: "local high-speed feature extraction",
      sensitivity: "low",
      estimatedTokens: estimateTokens(input.deterministicFeatures),
      supportedRepresentations: ["features-v1"],
      requiresProjectTrust: false,
      performsIO: false,
      truncatable: false,
      value: input.deterministicFeatures,
    }),
    fixedSource({
      capability: "project.named-context",
      available: Boolean(input.namedProjectContext),
      provenance: "explicit named project context",
      sensitivity: "project",
      estimatedTokens: estimateTokens(input.namedProjectContext ?? ""),
      supportedRepresentations: ["configured-digest-v1"],
      requiresProjectTrust: true,
      performsIO: false,
      truncatable: true,
      value: input.namedProjectContext ?? "",
    }),
  ];
}

export function createSystemPromptDigest(systemPrompt: string, maxTokens = 1_800): string {
  const lines = systemPrompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const headings = lines.filter((line) => /^(?:#{1,6}\s|[A-Z][A-Z\s_-]{3,}:?$)/.test(line));
  const selected = [...lines.slice(0, 24), ...headings.slice(0, 40)];
  const deduplicated = [...new Set(selected)].join("\n");
  return String(truncateText(deduplicated, maxTokens).content);
}
