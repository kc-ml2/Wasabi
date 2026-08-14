import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AuditReport, HostPolicyDecision } from "./domain.ts";

export const REVIEW_CHOICES = {
  apply: "Apply suggested revision",
  edit: "Edit suggested revision",
  original: "Send original anyway",
  cancel: "Cancel submission",
} as const;

export type ReviewResult =
  | { action: "apply"; text: string }
  | { action: "edit"; text: string }
  | { action: "original" }
  | { action: "cancel" };

function compact(text: string, maxLength = 180): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, maxLength - 1)}…`;
}

function conciseFindings(report: AuditReport): string {
  const findings = report.issues.slice(0, 4).map((issue, index) => {
    const question = issue.clarificationQuestion
      ? ` Question: ${compact(issue.clarificationQuestion)}`
      : "";
    return `${index + 1}. ${compact(issue.explanation)}${question}`;
  });
  if (report.issues.length > findings.length) {
    findings.push(`…and ${report.issues.length - findings.length} more finding(s).`);
  }
  return findings.join("\n");
}

function revisionFallback(originalText: string, revisedPrompt: string): string {
  return [
    "Suggested language revision:",
    `- ${JSON.stringify(compact(originalText, 260))}`,
    `+ ${JSON.stringify(compact(revisedPrompt, 260))}`,
    "  Reason: The auditor proposed a revision but did not return structured change details.",
  ].join("\n");
}

export function formatEnglishChanges(originalText: string, report: AuditReport): string {
  const changes = report.englishChanges ?? [];
  if (changes.length > 0) {
    const rendered = changes.slice(0, 6).flatMap((change) => [
      `- ${JSON.stringify(compact(change.original))}`,
      `+ ${JSON.stringify(compact(change.replacement))}`,
      `  Reason: ${compact(change.reason, 240)}`,
    ]);
    if (changes.length > 6) rendered.push(`…and ${changes.length - 6} more language change(s).`);
    return [`Language changes (${changes.length}):`, ...rendered].join("\n");
  }
  if (report.revisedPrompt && report.revisedPrompt !== originalText) {
    return revisionFallback(originalText, report.revisedPrompt);
  }
  return "";
}

export async function reviewPrompt(
  originalText: string,
  report: AuditReport,
  decision: HostPolicyDecision,
  ui: ExtensionUIContext,
): Promise<ReviewResult> {
  const options: string[] = [];
  if (report.revisedPrompt && !decision.requireExplicitEdit) options.push(REVIEW_CHOICES.apply);
  options.push(REVIEW_CHOICES.edit);
  if (decision.allowOverride) options.push(REVIEW_CHOICES.original);
  options.push(REVIEW_CHOICES.cancel);

  const level = decision.action === "block" ? "Prompt needs clarification" : "Prompt audit warning";
  const findings = conciseFindings(report);
  const languageChanges = formatEnglishChanges(originalText, report);
  const details = [findings, languageChanges].filter(Boolean).join("\n\n");
  const selected = await ui.select(
    `${level}${details ? `\n\n${details}` : ""}\n\nChoose how to proceed:`,
    options,
  );

  if (selected === REVIEW_CHOICES.apply && report.revisedPrompt) {
    return { action: "apply", text: report.revisedPrompt };
  }
  if (selected === REVIEW_CHOICES.edit) {
    const edited = await ui.editor("Edit prompt before sending", report.revisedPrompt ?? originalText);
    if (edited === undefined) return { action: "cancel" };
    const text = edited.trim();
    if (!text) {
      ui.notify("An empty prompt was not submitted.", "warning");
      return { action: "cancel" };
    }
    return { action: "edit", text };
  }
  if (selected === REVIEW_CHOICES.original) return { action: "original" };
  return { action: "cancel" };
}
