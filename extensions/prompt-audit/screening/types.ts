export const DETECTOR_IDS = [
  "unresolved_reference", "missing_user_choice", "conflicting_instructions",
  "consequential_wording", "missing_evidence", "unsupported_capability",
] as const;
export type DetectorId = typeof DETECTOR_IDS[number];
export type AuditAction = "PASS" | "OBSERVE" | "APPLY_SKILL" | "ASK" | "PROMOTE";
export type Mode = "off" | "shadow" | "review";

export interface Config {
  mode: Mode;
  jev: { url: string; model: string; apiKeyEnv: string; timeoutMs: number };
  rewrite: { baseUrl: string; model: string; apiKeyEnv: string; timeoutMs: number; maxTokens: number };
  context: { recentMessages: number; maxContextChars: number; maxPromptChars: number; includeConversation: boolean; includeSystemPrompt: boolean; includeCwd: boolean };
  policy: { askThreshold: number; observeThreshold: number; uncertaintyLow: number; uncertaintyHigh: number; failure: "open" | "closed"; headless: "pass" | "block" };
  approvedConventions: string[];
}

export interface ContextInput {
  prompt: string;
  recentMessages?: { role: string; text: string }[];
  summary?: string;
  systemPrompt?: string;
  tools?: { name: string; description: string }[];
  model?: string;
  cwd?: string;
  imageCount?: number;
  source?: string;
  streamingBehavior?: string;
}

export interface Envelope {
  profile: "jev-screen-v1";
  prompt: string;
  recentMessages: { role: string; text: string }[];
  summary?: string;
  systemPrompt?: string;
  tools: { name: string; description: string }[];
  model?: string;
  cwd?: string;
  approvedConventions: string[];
  runtime: { source: string; streamingBehavior?: string; imageCount: number };
  coverage: { truncated: string[]; omitted: string[]; contextChars: number; promptChars: number; imagesInspected: false };
  provenance: Record<string, string>;
}

export interface Screening {
  probabilities: Record<DetectorId, number>;
  model: string;
  latencyMs: number;
  usage?: { input_tokens: number; output_tokens: number };
}
export interface Decision {
  action: AuditAction;
  reasons: DetectorId[];
  uncertain: DetectorId[];
  reviewRequired: boolean;
  note: string;
}
export interface AuditResult { envelope: Envelope; screening: Screening; decision: Decision }
export interface RewriteProposal {
  explanation: string;
  question: string | null;
  suggestedClarification: string | null;
  rewrittenPrompt: string | null;
  assumptions: string[];
}
export type RewriteTask = "clarify" | "rewrite" | "english";
export interface Providers {
  screen(envelope: Envelope, config: Config, signal?: AbortSignal): Promise<Screening>;
  rewrite(envelope: Envelope, config: Config, task: RewriteTask, decision?: Decision): Promise<RewriteProposal>;
}
