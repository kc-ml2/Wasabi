import type { AuditorConfig } from "./config.ts";
import type {
  AuditIssue,
  AuditReport,
  HostPolicyDecision,
  PolicyRecommendation,
} from "./domain.ts";

const qualifiesForReview = (issue: AuditIssue): boolean =>
  (issue.confidence >= 0.55 && issue.materiality >= 0.5 && issue.severity !== "info") ||
  (issue.kind === "english_polish" && issue.confidence >= 0.7);

const qualifiesForBlock = (issue: AuditIssue): boolean =>
  issue.severity === "critical" && issue.confidence >= 0.65 && issue.materiality >= 0.7;

export function recommendPolicy(report: AuditReport): PolicyRecommendation {
  const blocking = report.issues.filter(qualifiesForBlock);
  const reviewable = report.issues.filter(qualifiesForReview);
  const hasEnglishChanges = (report.englishChanges?.length ?? 0) > 0;
  const hasProposedChange =
    hasEnglishChanges || Boolean(report.revisedPrompt && report.recommendedDecision !== "pass");

  if (blocking.length > 0 || (report.recommendedDecision === "block" && reviewable.length > 0)) {
    return {
      action: "block",
      allowOverride: true,
      requireExplicitEdit: true,
      reasonCodes: [...new Set(blocking.concat(reviewable).map((issue) => issue.kind))],
    };
  }

  if (
    reviewable.length > 0 ||
    hasProposedChange ||
    (report.recommendedDecision === "warn" && report.issues.length > 0)
  ) {
    return {
      action: "review",
      allowOverride: true,
      requireExplicitEdit: false,
      reasonCodes: [
        ...new Set([
          ...reviewable.map((issue) => issue.kind),
          ...(hasEnglishChanges ? ["english_polish"] : []),
        ]),
      ],
    };
  }

  return {
    action: "continue",
    allowOverride: true,
    requireExplicitEdit: false,
    reasonCodes: [],
  };
}

export function enforceHostPolicy(
  recommendation: PolicyRecommendation,
  report: AuditReport,
  config: AuditorConfig,
  hasUI: boolean,
): HostPolicyDecision {
  let action = recommendation.action;
  const hasQualifyingIssue =
    report.issues.some(qualifiesForReview) ||
    (report.englishChanges?.length ?? 0) > 0 ||
    Boolean(report.revisedPrompt && report.recommendedDecision !== "pass");

  if (!hasQualifyingIssue) action = "continue";
  if (report.issues.some(qualifiesForBlock)) action = "block";

  const failureMode = hasUI
    ? config.failurePolicy.interactive === "fail-closed"
      ? "fail-closed"
      : "fail-open"
    : config.failurePolicy.headless;

  return {
    ...recommendation,
    action,
    allowOverride: action !== "block" || config.mode !== "strict",
    requireExplicitEdit: action === "block",
    failureMode,
    maxReaudits: config.limits.maxReaudits,
    maxContextExpansions: config.limits.maxContextExpansions,
  };
}

export function failureAction(config: AuditorConfig, hasUI: boolean): "continue" | "handled" {
  if (hasUI) {
    return config.failurePolicy.interactive === "fail-closed" ? "handled" : "continue";
  }
  return config.failurePolicy.headless === "fail-closed" ? "handled" : "continue";
}
