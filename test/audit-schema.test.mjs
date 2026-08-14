import { test } from "@jest/globals";
import assert from "node:assert/strict";
import { AuditSchemaError, parseAuditReportJson } from "../src/prompt-audit/engines/audit-schema.ts";

const clear = {
  schemaVersion: "1",
  intentSummary: "Run the test suite.",
  issues: [],
  auditorConfidence: 0.96,
  recommendedDecision: "pass",
};

test("valid reports parse and trailing prose is rejected", () => {
  assert.deepEqual(parseAuditReportJson(JSON.stringify(clear), "semantic-only"), clear);
  assert.throws(
    () => parseAuditReportJson(`${JSON.stringify(clear)}\nDone`, "semantic-only"),
    AuditSchemaError,
  );
});

test("enums, scores, field lengths, and unknown fields are validated", () => {
  assert.throws(
    () =>
      parseAuditReportJson(
        JSON.stringify({ ...clear, auditorConfidence: 2, extra: true }),
        "semantic-only",
      ),
    /auditorConfidence|unknown fields/,
  );
});

test("polish findings are accepted only in explicit polish mode", () => {
  const polish = {
    ...clear,
    issues: [
      {
        id: "e1",
        kind: "english_polish",
        severity: "info",
        confidence: 0.9,
        materiality: 0.1,
        explanation: "Improve wording.",
      },
    ],
    recommendedDecision: "warn",
  };
  assert.throws(() => parseAuditReportJson(JSON.stringify(polish), "semantic-only"));
  assert.equal(parseAuditReportJson(JSON.stringify(polish), "polish").issues.length, 1);
});
