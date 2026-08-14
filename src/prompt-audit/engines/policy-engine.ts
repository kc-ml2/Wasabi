import type {
  AuditReport,
  AuditSubject,
  PolicyRecommendation,
  RoutingContext,
} from "../domain.ts";
import type { AuditorConfig } from "../config.ts";
import type { ContextEnvelope, EngineContextProfile } from "../context/capabilities.ts";

export interface PolicyEngine {
  readonly id: string;
  readonly version: string;

  contextProfile(subject: AuditSubject, runtime: RoutingContext): EngineContextProfile;

  decide(
    input: {
      subject: AuditSubject;
      findings: AuditReport;
      context: ContextEnvelope;
      hostPolicy: AuditorConfig;
    },
    signal?: AbortSignal,
  ): Promise<PolicyRecommendation>;
}
