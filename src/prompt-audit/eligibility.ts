import type { AuditMode } from "./domain.ts";

export interface EligibilityInput {
  text: string;
  source: "interactive" | "rpc" | "extension";
  streamingBehavior?: "steer" | "followUp";
  mode: AuditMode;
  bypassNext: boolean;
  steerPolicy: "heuristic-only" | "full";
  followUpPolicy: "full" | "bypass";
}

export type EligibilityResult =
  | { audit: true }
  | {
      audit: false;
      reason:
        | "disabled"
        | "extension-source"
        | "explicit-bypass"
        | "empty"
        | "template-or-command"
        | "steer-latency"
        | "follow-up-bypassed";
      consumeBypass?: boolean;
    };

export function checkEligibility(input: EligibilityInput): EligibilityResult {
  if (input.source === "extension") return { audit: false, reason: "extension-source" };
  if (input.mode === "disabled") return { audit: false, reason: "disabled" };
  if (input.bypassNext) {
    return { audit: false, reason: "explicit-bypass", consumeBypass: true };
  }
  if (!input.text.trim()) return { audit: false, reason: "empty" };
  if (input.text.trimStart().startsWith("/")) {
    return { audit: false, reason: "template-or-command" };
  }
  if (input.streamingBehavior === "steer" && input.steerPolicy !== "full") {
    return { audit: false, reason: "steer-latency" };
  }
  if (input.streamingBehavior === "followUp" && input.followUpPolicy === "bypass") {
    return { audit: false, reason: "follow-up-bypassed" };
  }
  return { audit: true };
}

export function detectDeterministicFeatures(text: string): Record<string, boolean | number> {
  const vagueReferences = text.match(/\b(?:it|this|that|these|those|the previous one)\b/gi)?.length ?? 0;
  const pathMentions = text.match(/(?:^|\s)(?:\.{0,2}\/|~\/|[A-Za-z]:\\)[^\s]+/g)?.length ?? 0;
  const numericMentions = text.match(/\b\d+(?:\.\d+)?(?:\s?(?:ms|s|m|h|kb|mb|gb|%))?\b/gi)?.length ?? 0;
  return {
    vagueReferences,
    pathMentions,
    numericMentions,
    mentionsDestructiveAction: /\b(?:delete|drop|erase|overwrite|remove|reset)\b/i.test(text),
    containsNegation: /\b(?:not|never|without|except)\b/i.test(text),
  };
}
