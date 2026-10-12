import type { AuditMode } from "./domain.ts";

export interface AuditorConfig {
  mode: AuditMode;
  auditEngine: "frontier-combined";
  policyEngine: "frontier-combined";
  auditorModel?: string;
  englishMode: "on-request";
  contextProfile: "frontier-v1";
  contextGovernance: {
    maxInputTokens: number;
    maxMaterializationMs: number;
    allowCloudProjectContext: boolean;
    allowCloudImages: boolean;
    requireTrustedProject: boolean;
  };
  streaming: {
    steer: "heuristic-only" | "full";
    followUp: "full" | "bypass";
  };
  failurePolicy: {
    interactive: "fail-open-with-warning" | "fail-closed";
    headless: "fail-open" | "fail-closed";
  };
  limits: {
    maxReaudits: number;
    maxContextExpansions: number;
    auditTimeoutMs: number;
    maxOutputTokens: number;
  };
  logging: {
    enabled: boolean;
    storePromptText: false;
    storeContextText: false;
    storeHashes: boolean;
    storeUsage: boolean;
    storeContextManifest: boolean;
  };
}

export const DEFAULT_CONFIG: Readonly<AuditorConfig> = {
  mode: "advisory",
  auditEngine: "frontier-combined",
  policyEngine: "frontier-combined",
  englishMode: "on-request",
  contextProfile: "frontier-v1",
  contextGovernance: {
    maxInputTokens: 12_000,
    maxMaterializationMs: 500,
    allowCloudProjectContext: false,
    allowCloudImages: true,
    requireTrustedProject: true,
  },
  streaming: {
    steer: "heuristic-only",
    followUp: "full",
  },
  failurePolicy: {
    interactive: "fail-open-with-warning",
    headless: "fail-open",
  },
  limits: {
    maxReaudits: 1,
    maxContextExpansions: 0,
    auditTimeoutMs: 15_000,
    maxOutputTokens: 1_200,
  },
  logging: {
    enabled: true,
    storePromptText: false,
    storeContextText: false,
    storeHashes: true,
    storeUsage: true,
    storeContextManifest: true,
  },
};

export function createConfig(overrides: Partial<AuditorConfig> = {}): AuditorConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    contextGovernance: {
      ...DEFAULT_CONFIG.contextGovernance,
      ...overrides.contextGovernance,
    },
    streaming: { ...DEFAULT_CONFIG.streaming, ...overrides.streaming },
    failurePolicy: { ...DEFAULT_CONFIG.failurePolicy, ...overrides.failurePolicy },
    limits: { ...DEFAULT_CONFIG.limits, ...overrides.limits },
    logging: { ...DEFAULT_CONFIG.logging, ...overrides.logging },
  };
}

export function parseAuditorModelRef(ref: string): { provider: string; modelId: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}
