export const ISSUE_KINDS = [
  "ambiguous_reference",
  "undefined_term",
  "missing_target",
  "missing_context",
  "missing_acceptance_criteria",
  "contradiction",
  "critical_typo",
  "numeric_or_unit_ambiguity",
  "temporal_ambiguity",
  "context_mismatch",
  "english_semantic_risk",
  "english_polish",
] as const;

export type IssueKind = (typeof ISSUE_KINDS)[number];
export type IssueSeverity = "info" | "warning" | "critical";
export type AuditDecision = "pass" | "warn" | "block";
export type AuditMode = "disabled" | "advisory" | "strict" | "dev";
export type EnglishMode = "off" | "semantic-only" | "polish";

export interface AuditSubject {
  schemaVersion: "1";
  text: string;
  source: "interactive" | "rpc" | "extension";
  streamingBehavior?: "steer" | "followUp";
  imageCount: number;
  englishMode: EnglishMode;
}

export interface AuditIssue {
  id: string;
  kind: IssueKind;
  severity: IssueSeverity;
  confidence: number;
  materiality: number;
  quote?: string;
  explanation: string;
  plausibleInterpretations?: string[];
  clarificationQuestion?: string;
  suggestedReplacement?: string;
}

export interface EnglishChange {
  original: string;
  replacement: string;
  reason: string;
}

export interface AuditReport {
  schemaVersion: "1";
  intentSummary: string;
  issues: AuditIssue[];
  revisedPrompt?: string;
  englishChanges?: EnglishChange[];
  auditorConfidence: number;
  recommendedDecision?: AuditDecision;
}

export interface AuditUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  attempts: number;
}

export type AuditEngineOutcome =
  | { kind: "report"; report: AuditReport; usage?: AuditUsage; rawResponses?: string[] }
  | {
      kind: "needs-more-context";
      requirements: import("./context/capabilities.ts").ContextRequirement[];
      reason: string;
    };

export interface PolicyRecommendation {
  action: "continue" | "review" | "block";
  allowOverride: boolean;
  requireExplicitEdit: boolean;
  reasonCodes: string[];
}

export interface HostPolicyDecision extends PolicyRecommendation {
  failureMode: "fail-open" | "fail-closed";
  maxReaudits: number;
  maxContextExpansions: number;
}

export interface RoutingContext {
  mode: AuditMode;
  runtimeMode: "tui" | "rpc" | "json" | "print";
  projectTrusted: boolean;
  deterministicFeatures: Record<string, boolean | number>;
  modelSupportsImages: boolean;
}
