import type { AuditSubject } from "../../domain.ts";
import type { ContextRequirement, EngineContextProfile } from "../capabilities.ts";

const BASE_REQUIREMENTS: ContextRequirement[] = [
  {
    capability: "prompt.raw",
    audience: "both",
    strength: "required",
    preferredRepresentations: ["exact-text"],
    reason: "The submitted prompt is the audit subject.",
  },
  {
    capability: "prompt.metadata",
    audience: "both",
    strength: "required",
    preferredRepresentations: ["structured-v1"],
    maxTokens: 160,
    reason: "Source and delivery metadata affect intervention behavior.",
  },
  {
    capability: "conversation.recent",
    audience: "audit",
    strength: "preferred",
    preferredRepresentations: ["exchanges-v1"],
    maxItems: 12,
    maxTokens: 4_500,
    reason: "Recent turns can resolve references in the prompt.",
  },
  {
    capability: "conversation.compaction-summary",
    audience: "audit",
    strength: "optional",
    preferredRepresentations: ["summary-text"],
    maxItems: 1,
    maxTokens: 1_500,
    reason: "A compaction summary can preserve older active-branch context.",
  },
  {
    capability: "agent.system-prompt-digest",
    audience: "audit",
    strength: "preferred",
    preferredRepresentations: ["bounded-digest-v1"],
    maxTokens: 1_800,
    reason: "Agent responsibilities and constraints change what is materially ambiguous.",
  },
  {
    capability: "agent.active-tools",
    audience: "audit",
    strength: "preferred",
    preferredRepresentations: ["names-and-descriptions-v1"],
    maxTokens: 1_200,
    reason: "Available actions help assess whether missing details are cheaply discoverable.",
  },
  {
    capability: "agent.model-identity",
    audience: "audit",
    strength: "preferred",
    preferredRepresentations: ["provider-model-v1"],
    maxTokens: 80,
    reason: "The target model identity is relevant execution context.",
  },
  {
    capability: "runtime.working-directory",
    audience: "audit",
    strength: "preferred",
    preferredRepresentations: ["normalized-path"],
    maxTokens: 100,
    reason: "The working directory can resolve path and artifact references.",
  },
  {
    capability: "runtime.mode",
    audience: "both",
    strength: "required",
    preferredRepresentations: ["structured-v1"],
    maxTokens: 100,
    reason: "UI and streaming mode constrain safe interventions.",
  },
  {
    capability: "user.audit-policy",
    audience: "policy",
    strength: "required",
    preferredRepresentations: ["thresholds-v1"],
    maxTokens: 240,
    reason: "The policy engine needs local intervention limits.",
  },
  {
    capability: "user.english-mode",
    audience: "policy",
    strength: "required",
    preferredRepresentations: ["mode-v1"],
    maxTokens: 40,
    reason: "Language polishing must happen only when requested.",
  },
  {
    capability: "risk.deterministic-features",
    audience: "policy",
    strength: "optional",
    preferredRepresentations: ["features-v1"],
    maxTokens: 180,
    reason: "Cheap risk signals can support deterministic enforcement.",
  },
];

export function frontierV1Profile(
  subject: AuditSubject,
  options: { includeNamedProjectContext?: boolean } = {},
): EngineContextProfile {
  const requirements = [...BASE_REQUIREMENTS];

  if (subject.imageCount > 0) {
    requirements.push({
      capability: "prompt.images",
      audience: "audit",
      strength: "preferred",
      preferredRepresentations: ["original-images", "image-metadata-v1"],
      maxItems: subject.imageCount,
      maxTokens: Math.min(4_000, subject.imageCount * 1_000),
      reason: "Submission images may resolve visual references.",
    });
  }

  if (options.includeNamedProjectContext) {
    requirements.push({
      capability: "project.named-context",
      audience: "audit",
      strength: "optional",
      preferredRepresentations: ["configured-digest-v1"],
      maxTokens: 1_500,
      reason: "Explicitly configured trusted project context may resolve named artifacts.",
    });
  }

  return {
    id: "frontier-v1",
    schemaVersion: "1",
    requirements,
    supportsIncrementalExpansion: false,
  };
}
