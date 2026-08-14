import type { AuditorConfig } from "./config.ts";
import type { AuditSubject, RoutingContext } from "./domain.ts";

export interface EngineRoute {
  auditEngineId: "frontier-combined";
  policyEngineId: "frontier-combined";
  auditorModel?: string;
  reason: string;
}

export function selectEngineRoute(
  _subject: AuditSubject,
  _runtime: RoutingContext,
  config: AuditorConfig,
): EngineRoute {
  return {
    auditEngineId: config.auditEngine,
    policyEngineId: config.policyEngine,
    auditorModel: config.auditorModel,
    reason: "frontier-backed MVP route",
  };
}
