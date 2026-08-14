import {
  ISSUE_KINDS,
  type AuditIssue,
  type AuditReport,
  type EnglishMode,
  type IssueKind,
  type IssueSeverity,
} from "../domain.ts";

const SEVERITIES = new Set<IssueSeverity>(["info", "warning", "critical"]);
const DECISIONS = new Set(["pass", "warn", "block"]);
const ISSUE_KIND_SET = new Set<IssueKind>(ISSUE_KINDS);

const ROOT_KEYS = new Set([
  "schemaVersion",
  "intentSummary",
  "issues",
  "revisedPrompt",
  "englishChanges",
  "auditorConfidence",
  "recommendedDecision",
]);
const ISSUE_KEYS = new Set([
  "id",
  "kind",
  "severity",
  "confidence",
  "materiality",
  "quote",
  "explanation",
  "plausibleInterpretations",
  "clarificationQuestion",
  "suggestedReplacement",
]);
const CHANGE_KEYS = new Set(["original", "replacement", "reason"]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    (allowEmpty || value.trim().length > 0)
  );
}

function validScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateOptionalString(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
  errors: string[],
): void {
  if (value[key] !== undefined && !validString(value[key], maxLength)) {
    errors.push(`${key} must be a non-empty string of at most ${maxLength} characters`);
  }
}

function validateIssue(value: unknown, index: number, errors: string[]): value is AuditIssue {
  const prefix = `issues[${index}]`;
  if (!isObject(value)) {
    errors.push(`${prefix} must be an object`);
    return false;
  }
  if (!hasOnlyKeys(value, ISSUE_KEYS)) errors.push(`${prefix} contains unknown fields`);
  if (!validString(value.id, 80)) errors.push(`${prefix}.id is invalid`);
  if (typeof value.kind !== "string" || !ISSUE_KIND_SET.has(value.kind as IssueKind)) {
    errors.push(`${prefix}.kind is invalid`);
  }
  if (typeof value.severity !== "string" || !SEVERITIES.has(value.severity as IssueSeverity)) {
    errors.push(`${prefix}.severity is invalid`);
  }
  if (!validScore(value.confidence)) errors.push(`${prefix}.confidence must be between 0 and 1`);
  if (!validScore(value.materiality)) errors.push(`${prefix}.materiality must be between 0 and 1`);
  if (!validString(value.explanation, 800)) errors.push(`${prefix}.explanation is invalid`);
  validateOptionalString(value, "quote", 500, errors);
  validateOptionalString(value, "clarificationQuestion", 800, errors);
  validateOptionalString(value, "suggestedReplacement", 2_000, errors);
  if (value.plausibleInterpretations !== undefined) {
    if (
      !Array.isArray(value.plausibleInterpretations) ||
      value.plausibleInterpretations.length > 4 ||
      !value.plausibleInterpretations.every((item) => validString(item, 500))
    ) {
      errors.push(`${prefix}.plausibleInterpretations is invalid`);
    }
  }
  return true;
}

export class AuditSchemaError extends Error {
  constructor(readonly validationErrors: string[]) {
    super(`Invalid audit response: ${validationErrors.join("; ")}`);
    this.name = "AuditSchemaError";
  }
}

export function validateAuditReport(value: unknown, englishMode: EnglishMode): AuditReport {
  const errors: string[] = [];
  if (!isObject(value)) throw new AuditSchemaError(["root must be an object"]);
  if (!hasOnlyKeys(value, ROOT_KEYS)) errors.push("root contains unknown fields");
  if (value.schemaVersion !== "1") errors.push('schemaVersion must be "1"');
  if (!validString(value.intentSummary, 800)) errors.push("intentSummary is invalid");
  if (!Array.isArray(value.issues) || value.issues.length > 12) {
    errors.push("issues must be an array with at most 12 entries");
  } else {
    value.issues.forEach((issue, index) => validateIssue(issue, index, errors));
    const ids = value.issues
      .filter(isObject)
      .map((issue) => issue.id)
      .filter((id): id is string => typeof id === "string");
    if (new Set(ids).size !== ids.length) errors.push("issue ids must be unique");
    if (
      englishMode !== "polish" &&
      value.issues.some((issue) => isObject(issue) && issue.kind === "english_polish")
    ) {
      errors.push("english_polish findings require polish mode");
    }
  }
  if (!validScore(value.auditorConfidence)) errors.push("auditorConfidence must be between 0 and 1");
  validateOptionalString(value, "revisedPrompt", 30_000, errors);
  if (
    value.recommendedDecision !== undefined &&
    (typeof value.recommendedDecision !== "string" || !DECISIONS.has(value.recommendedDecision))
  ) {
    errors.push("recommendedDecision is invalid");
  }
  if (value.englishChanges !== undefined) {
    if (!Array.isArray(value.englishChanges) || value.englishChanges.length > 20) {
      errors.push("englishChanges must be an array with at most 20 entries");
    } else {
      value.englishChanges.forEach((change, index) => {
        if (!isObject(change) || !hasOnlyKeys(change, CHANGE_KEYS)) {
          errors.push(`englishChanges[${index}] must contain only the documented fields`);
          return;
        }
        if (!validString(change.original, 1_000)) errors.push(`englishChanges[${index}].original is invalid`);
        if (!validString(change.replacement, 1_000)) {
          errors.push(`englishChanges[${index}].replacement is invalid`);
        }
        if (!validString(change.reason, 500)) errors.push(`englishChanges[${index}].reason is invalid`);
      });
    }
    if (englishMode === "off") errors.push("englishChanges are forbidden in off mode");
  }

  if (errors.length > 0) throw new AuditSchemaError(errors);
  return value as unknown as AuditReport;
}

export function parseAuditReportJson(text: string, englishMode: EnglishMode): AuditReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new AuditSchemaError([message]);
  }
  return validateAuditReport(parsed, englishMode);
}
