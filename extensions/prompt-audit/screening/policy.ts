import { DETECTOR_IDS, type Config, type Decision, type Envelope, type Screening } from "./types.ts";

/** Probabilities are presence estimates, not severity or calibrated task success. */
export function decide(screening: Screening, envelope: Envelope, config: Config): Decision {
  const p = screening.probabilities;
  const threshold = config.policy.askThreshold;
  const uncertain = DETECTOR_IDS.filter(id => p[id] >= config.policy.uncertaintyLow && p[id] <= config.policy.uncertaintyHigh);
  const owned = (["missing_user_choice", "conflicting_instructions", "consequential_wording"] as const).filter(id => p[id] >= threshold);
  const evidence = p.missing_evidence >= config.policy.observeThreshold;
  const unsupported = p.unsupported_capability >= threshold;
  const unresolved = p.unresolved_reference >= threshold;
  // Missing context and unseen images are auditor limitations, not proof that the user omitted information.
  const incomplete = envelope.coverage.truncated.some(name => ["recentMessages", "summary", "approvedConventions", "systemPrompt"].includes(name)) || envelope.coverage.omitted.includes("recentMessages") || envelope.runtime.imageCount > 0;
  if (incomplete && (owned.length || unresolved)) return {
    action: "PROMOTE", reasons: [...owned, ...(unresolved ? ["unresolved_reference" as const] : [])], uncertain,
    reviewRequired: false, note: "The auditor lacks relevant context; a stronger review with that context is optional. Forward unchanged.",
  };
  if (owned.length) return { action: "ASK", reasons: owned, uncertain, reviewRequired: true, note: "A material user decision, conflict, or wording issue may need clarification." };
  if (unsupported && !envelope.coverage.truncated.includes("tools")) return { action: "ASK", reasons: ["unsupported_capability"], uncertain, reviewRequired: true, note: "The request may depend on an unavailable capability. Review the intended alternative." };
  if (unresolved) return { action: "ASK", reasons: ["unresolved_reference"], uncertain, reviewRequired: true, note: "The intended reference appears unresolved by the supplied conversation." };
  if (evidence) return { action: "OBSERVE", reasons: ["missing_evidence"], uncertain, reviewRequired: false, note: "The target agent can obtain evidence within its existing permissions; the auditor grants none." };
  if (uncertain.length || unsupported) return { action: "PROMOTE", reasons: unsupported ? ["unsupported_capability"] : [], uncertain, reviewRequired: false, note: "The auditor is uncertain or has incomplete context. Forward unchanged; stronger review is optional." };
  return { action: "PASS", reasons: [], uncertain, reviewRequired: false, note: "No detected material issue exceeds the review threshold." };
}
