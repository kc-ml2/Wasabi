import { test } from "@jest/globals";
import assert from "node:assert/strict";
import { checkEligibility, detectDeterministicFeatures } from "../src/prompt-audit/eligibility.ts";

const base = {
  text: "Implement the parser",
  source: "interactive",
  mode: "advisory",
  bypassNext: false,
  steerPolicy: "heuristic-only",
  followUpPolicy: "full",
};

test("ordinary and short direct prompts remain eligible", () => {
  assert.deepEqual(checkEligibility(base), { audit: true });
  assert.deepEqual(checkEligibility({ ...base, text: "fix it" }), { audit: true });
});

test("extension messages, commands, bypasses, and steering are excluded", () => {
  assert.equal(checkEligibility({ ...base, source: "extension" }).audit, false);
  assert.equal(checkEligibility({ ...base, text: "/skill:review" }).audit, false);
  assert.deepEqual(checkEligibility({ ...base, bypassNext: true }), {
    audit: false,
    reason: "explicit-bypass",
    consumeBypass: true,
  });
  assert.equal(checkEligibility({ ...base, streamingBehavior: "steer" }).audit, false);
  assert.deepEqual(checkEligibility({ ...base, streamingBehavior: "followUp" }), { audit: true });
});

test("deterministic features are local metadata, not intervention decisions", () => {
  const features = detectDeterministicFeatures("Delete it after 30 ms from ./tmp.txt");
  assert.equal(features.vagueReferences, 1);
  assert.equal(features.numericMentions, 1);
  assert.equal(features.pathMentions, 1);
  assert.equal(features.mentionsDestructiveAction, true);
});
