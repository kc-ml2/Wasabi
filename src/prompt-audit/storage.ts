import type { AuditorConfig } from "./config.ts";
import type { ContextManifest } from "./context/capabilities.ts";
import type { AuditReport, AuditSubject, AuditUsage, HostPolicyDecision } from "./domain.ts";

export type AuditUserAction =
  | "passed"
  | "applied-revision"
  | "edited-and-reaudited"
  | "edited"
  | "overrode"
  | "cancelled"
  | "headless-forwarded"
  | "failure-opened"
  | "failure-closed";

export interface PromptAuditEntry {
  schemaVersion: "1";
  timestamp: string;
  promptHash?: string;
  promptCharacters: number;
  source: AuditSubject["source"];
  streamingBehavior?: AuditSubject["streamingBehavior"];
  imageCount: number;
  englishMode: AuditSubject["englishMode"];
  auditEngine: { id: string; version: string };
  policyEngine: { id: string; version: string };
  contextManifest?: ContextManifest;
  findings?: Array<{
    kind: string;
    severity: string;
    confidence: number;
    materiality: number;
  }>;
  decision?: Pick<
    HostPolicyDecision,
    "action" | "allowOverride" | "requireExplicitEdit" | "reasonCodes"
  >;
  userAction: AuditUserAction;
  auditLatencyMs: number;
  usage?: AuditUsage;
  reaudits: number;
  error?: { kind: string };
}

export interface PromptAuditDevImage {
  mimeType: string;
  encodedBytes: number;
}

export type PromptAuditDevSelection =
  | { kind: "forwarded"; submittedText: "initial" | "edited" }
  | { kind: "apply-suggested"; submittedText: string }
  | { kind: "edit"; submittedText: string; reaudited: boolean }
  | { kind: "send-original" }
  | { kind: "cancel" }
  | { kind: "headless-forward" };

export interface PromptAuditDevEntry {
  schemaVersion: "1";
  datasetVersion: "prompt-audit-rl-v1";
  privacy: "raw-opt-in";
  captureMode: "dev" | "experiment";
  timestamp: string;
  submissionId: string;
  attempt: number;
  initialInput: {
    text: string;
    source: AuditSubject["source"];
    streamingBehavior?: AuditSubject["streamingBehavior"];
    images: PromptAuditDevImage[];
  };
  auditedInput: string;
  englishMode: AuditSubject["englishMode"];
  auditor: {
    engineId: string;
    engineVersion: string;
    provider: string;
    modelId: string;
  };
  contextManifest?: ContextManifest;
  auditorResponses: string[];
  normalizedReport: AuditReport;
  userSelection: PromptAuditDevSelection;
  usage?: AuditUsage;
  auditLatencyMs: number;
}

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface AuditEntryInput {
  subject: AuditSubject;
  config: AuditorConfig;
  engine: { id: string; version: string };
  manifest?: ContextManifest;
  report?: AuditReport;
  decision?: HostPolicyDecision;
  userAction: AuditUserAction;
  auditLatencyMs: number;
  usage?: AuditUsage;
  reaudits: number;
  error?: unknown;
}

export interface DevAuditEntryInput {
  captureMode: PromptAuditDevEntry["captureMode"];
  submissionId: string;
  attempt: number;
  initialText: string;
  subject: AuditSubject;
  images: PromptAuditDevImage[];
  auditor: PromptAuditDevEntry["auditor"];
  manifest?: ContextManifest;
  auditorResponses: string[];
  report: AuditReport;
  userSelection: PromptAuditDevSelection;
  usage?: AuditUsage;
  auditLatencyMs: number;
}

export function createDevAuditEntry(input: DevAuditEntryInput): PromptAuditDevEntry {
  return {
    schemaVersion: "1",
    datasetVersion: "prompt-audit-rl-v1",
    privacy: "raw-opt-in",
    captureMode: input.captureMode,
    timestamp: new Date().toISOString(),
    submissionId: input.submissionId,
    attempt: input.attempt,
    initialInput: {
      text: input.initialText,
      source: input.subject.source,
      streamingBehavior: input.subject.streamingBehavior,
      images: input.images,
    },
    auditedInput: input.subject.text,
    englishMode: input.subject.englishMode,
    auditor: input.auditor,
    contextManifest: input.manifest,
    auditorResponses: input.auditorResponses,
    normalizedReport: input.report,
    userSelection: input.userSelection,
    usage: input.usage,
    auditLatencyMs: input.auditLatencyMs,
  };
}

export type PromptAuditExperimentAlternative = "initial" | "candidate";

export interface PromptAuditExperimentEntry {
  schemaVersion: "1";
  datasetVersion: "prompt-audit-experiment-v1";
  privacy: "raw-opt-in";
  timestamp: string;
  experimentId: string;
  auditSubmissionId: string;
  commonContextEntryId: string;
  target: { provider: string; modelId: string };
  images: PromptAuditDevImage[];
  contextIsolation: "pi-session-branches";
  externalSideEffectsIsolated: false;
  alternatives: {
    initial: { text: string; origin: "initial-input" };
    candidate: { text: string; origin: "auditor-revision" | "user-edit" };
  };
  selectedAlternative: PromptAuditExperimentAlternative;
  executionOrder: [PromptAuditExperimentAlternative, PromptAuditExperimentAlternative];
  runs: Array<{
    alternative: PromptAuditExperimentAlternative;
    branchLeafId?: string;
    finalText: string;
    assistantMessages: unknown[];
  }>;
}

export interface ExperimentEntryInput
  extends Omit<PromptAuditExperimentEntry, "schemaVersion" | "datasetVersion" | "privacy" | "timestamp"> {}

export function createExperimentEntry(input: ExperimentEntryInput): PromptAuditExperimentEntry {
  return {
    schemaVersion: "1",
    datasetVersion: "prompt-audit-experiment-v1",
    privacy: "raw-opt-in",
    timestamp: new Date().toISOString(),
    ...input,
  };
}

export async function createAuditEntry(input: AuditEntryInput): Promise<PromptAuditEntry> {
  const promptHash = input.config.logging.storeHashes ? await sha256(input.subject.text) : undefined;
  const entry: PromptAuditEntry = {
    schemaVersion: "1",
    timestamp: new Date().toISOString(),
    promptHash,
    promptCharacters: input.subject.text.length,
    source: input.subject.source,
    streamingBehavior: input.subject.streamingBehavior,
    imageCount: input.subject.imageCount,
    englishMode: input.subject.englishMode,
    auditEngine: input.engine,
    policyEngine: input.engine,
    contextManifest: input.config.logging.storeContextManifest ? input.manifest : undefined,
    findings: input.report?.issues.map((issue) => ({
      kind: issue.kind,
      severity: issue.severity,
      confidence: issue.confidence,
      materiality: issue.materiality,
    })),
    decision: input.decision
      ? {
          action: input.decision.action,
          allowOverride: input.decision.allowOverride,
          requireExplicitEdit: input.decision.requireExplicitEdit,
          reasonCodes: input.decision.reasonCodes,
        }
      : undefined,
    userAction: input.userAction,
    auditLatencyMs: input.auditLatencyMs,
    usage: input.config.logging.storeUsage ? input.usage : undefined,
    reaudits: input.reaudits,
    error: input.error
      ? { kind: input.error instanceof Error ? input.error.name : "UnknownAuditError" }
      : undefined,
  };
  return entry;
}
