import { test } from "@jest/globals";
import assert from "node:assert/strict";
import { createConfig } from "../src/prompt-audit/config.ts";
import { enforceHostPolicy, recommendPolicy } from "../src/prompt-audit/host-policy.ts";

const report = (issues, recommendedDecision = "pass") => ({
  schemaVersion: "1",
  intentSummary: "Test",
  issues,
  auditorConfidence: 0.9,
  recommendedDecision,
});
const issue = (overrides = {}) => ({
  id: "i1",
  kind: "ambiguous_reference",
  severity: "warning",
  confidence: 0.9,
  materiality: 0.8,
  explanation: "The referent is unclear.",
  ...overrides,
});

test("clear findings pass even if an unsupported model recommendation asks to warn", () => {
  const findings = report([], "warn");
  const decision = enforceHostPolicy(recommendPolicy(findings), findings, createConfig(), true);
  assert.equal(decision.action, "continue");
});

test("material warnings review and critical issues block", () => {
  assert.equal(recommendPolicy(report([issue()])).action, "review");
  assert.equal(recommendPolicy(report([issue({ severity: "critical" })])).action, "block");
});

test("strict mode prevents overriding a block", () => {
  const findings = report([issue({ severity: "critical" })]);
  const config = createConfig({ mode: "strict" });
  const decision = enforceHostPolicy(recommendPolicy(findings), findings, config, true);
  assert.equal(decision.action, "block");
  assert.equal(decision.allowOverride, false);
  assert.equal(decision.requireExplicitEdit, true);
});

test("explicit English changes trigger review even without a taxonomy issue", () => {
  const findings = { ...report([]), englishChanges: [{ original: "is", replacement: "are", reason: "agreement" }], revisedPrompt: "They are ready.", recommendedDecision: "warn" };
  const recommendation = recommendPolicy(findings);
  const decision = enforceHostPolicy(recommendation, findings, createConfig(), true);
  assert.equal(decision.action, "review");
  assert.deepEqual(decision.reasonCodes, ["english_polish"]);
});
