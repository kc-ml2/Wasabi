export const CONTEXT_CAPABILITIES = [
  "prompt.raw",
  "prompt.metadata",
  "prompt.images",
  "prompt.image-metadata",
  "conversation.recent",
  "conversation.compaction-summary",
  "agent.system-prompt-digest",
  "agent.system-prompt-full",
  "agent.active-tools",
  "agent.model-identity",
  "runtime.working-directory",
  "runtime.mode",
  "project.named-context",
  "user.audit-policy",
  "user.english-mode",
  "risk.deterministic-features",
] as const;

export type ContextCapability = (typeof CONTEXT_CAPABILITIES)[number];
export type ContextAudience = "audit" | "policy" | "both";
export type RequirementStrength = "required" | "preferred" | "optional";
export type ContextSensitivity = "low" | "personal" | "project" | "secret";
export type ProviderLocality = "local" | "cloud";

export interface ContextRequirement {
  capability: ContextCapability;
  audience: ContextAudience;
  strength: RequirementStrength;
  preferredRepresentations?: string[];
  maxItems?: number;
  maxTokens?: number;
  reason: string;
}

export interface EngineContextProfile {
  id: string;
  schemaVersion: "1";
  requirements: ContextRequirement[];
  supportsIncrementalExpansion: boolean;
}

export interface ContextSection<T = unknown> {
  capability: ContextCapability;
  representation: string;
  audience: ContextAudience;
  provenance: string;
  providerLocality: ProviderLocality;
  sensitivity: ContextSensitivity;
  content: T;
  estimatedTokens: number;
  truncated: boolean;
}

export type ContextOmissionReason =
  | "unavailable"
  | "privacy-policy"
  | "untrusted-project"
  | "token-budget"
  | "latency-budget"
  | "unsupported-representation"
  | "materialization-error";

export interface ContextOmission {
  capability: ContextCapability;
  audience: ContextAudience;
  requestedBy: string[];
  strength: RequirementStrength;
  reason: ContextOmissionReason;
}

export interface ContextEnvelope {
  schemaVersion: "1";
  audience: "audit" | "policy";
  profileId: string;
  sections: ContextSection[];
  omissions: ContextOmission[];
}

export interface ContextSectionManifest {
  capability: ContextCapability;
  representation: string;
  audience: ContextAudience;
  provenance: string;
  providerLocality: ProviderLocality;
  sensitivity: ContextSensitivity;
  estimatedTokens: number;
  truncated: boolean;
}

export interface ContextDowngrade {
  capability: ContextCapability;
  requestedRepresentation: string;
  grantedRepresentation: string;
}

export interface ContextManifest {
  schemaVersion: "1";
  auditProfileId: string;
  policyProfileId: string;
  requestedCapabilities: ContextCapability[];
  grantedCapabilities: ContextCapability[];
  downgradedCapabilities: ContextDowngrade[];
  omittedCapabilities: ContextOmission[];
  sections: ContextSectionManifest[];
  estimatedTokens: number;
  materializationLatencyMs: number;
  providerLocality: ProviderLocality;
  projectTrustRequired: boolean;
  projectTrusted: boolean;
}

export interface MaterializedContextBundle {
  audit: ContextEnvelope;
  policy: ContextEnvelope;
  manifest: ContextManifest;
  requiredOmissions: ContextOmission[];
}

export interface MaterializedSourceValue {
  content: unknown;
  estimatedTokens: number;
  truncated: boolean;
}

export interface ContextSource {
  capability: ContextCapability;
  available: boolean;
  provenance: string;
  sensitivity: ContextSensitivity;
  estimatedTokens: number;
  supportedRepresentations: string[];
  requiresProjectTrust: boolean;
  performsIO: boolean;
  truncatable: boolean;
  materialize(representation: string, maxTokens: number): Promise<MaterializedSourceValue>;
}

export interface ContextGovernance {
  maxInputTokens: number;
  maxMaterializationMs: number;
  allowCloudProjectContext: boolean;
  allowCloudImages: boolean;
  requireTrustedProject: boolean;
  projectTrusted: boolean;
  providerLocality: ProviderLocality;
}

export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.max(1, Math.ceil(text.length / 4));
}
