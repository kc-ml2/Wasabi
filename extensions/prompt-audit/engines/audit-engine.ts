import type { AuditEngineOutcome, AuditSubject, RoutingContext } from "../domain.ts";
import type { ContextEnvelope, EngineContextProfile } from "../context/capabilities.ts";

export interface AuditEngine {
  readonly id: string;
  readonly version: string;

  contextProfile(subject: AuditSubject, runtime: RoutingContext): EngineContextProfile;

  audit(
    input: { subject: AuditSubject; context: ContextEnvelope },
    signal?: AbortSignal,
  ): Promise<AuditEngineOutcome>;
}
