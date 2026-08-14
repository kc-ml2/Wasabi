import { test } from "@jest/globals";
import assert from "node:assert/strict";
import {
  AuditTimeoutError,
  FrontierCombinedEngine,
} from "../src/prompt-audit/engines/frontier-combined.ts";

const subject = {
  schemaVersion: "1",
  text: "Run npm test",
  source: "interactive",
  imageCount: 0,
  englishMode: "semantic-only",
};
const envelope = (audience) => ({
  schemaVersion: "1",
  audience,
  profileId: "frontier-v1",
  sections: [],
  omissions: [],
});
const bundle = {
  audit: envelope("audit"),
  policy: envelope("policy"),
  manifest: {
    schemaVersion: "1",
    auditProfileId: "frontier-v1",
    policyProfileId: "frontier-v1",
    requestedCapabilities: [],
    grantedCapabilities: [],
    downgradedCapabilities: [],
    omittedCapabilities: [],
    sections: [],
    estimatedTokens: 0,
    materializationLatencyMs: 0,
    providerLocality: "cloud",
    projectTrustRequired: false,
    projectTrusted: true,
  },
};
const valid = JSON.stringify({
  schemaVersion: "1",
  intentSummary: "Run tests.",
  issues: [],
  auditorConfidence: 0.95,
  recommendedDecision: "pass",
});

test("one malformed response is repaired once", async () => {
  const calls = [];
  const engine = new FrontierCombinedEngine({
    timeoutMs: 1_000,
    maxOutputTokens: 1_200,
    complete: async (request) => {
      calls.push(request);
      return { text: calls.length === 1 ? "not json" : valid, stopReason: "stop", usage: { input: 2, output: 3 } };
    },
  });
  const outcome = await engine.auditCombined({ subject, bundle });
  assert.equal(outcome.kind, "report");
  assert.equal(outcome.usage.attempts, 2);
  assert.equal(outcome.usage.inputTokens, 4);
  assert.deepEqual(outcome.rawResponses, ["not json", valid]);
  assert.equal(calls[1].systemPrompt.includes("Repair"), true);
});

test("a second malformed response fails instead of guessing fields", async () => {
  const engine = new FrontierCombinedEngine({
    timeoutMs: 1_000,
    maxOutputTokens: 1_200,
    complete: async () => ({ text: "{}", stopReason: "stop" }),
  });
  await assert.rejects(() => engine.auditCombined({ subject, bundle }), /Invalid audit response/);
});

test("timeout aborts and rejects the frontier call", async () => {
  const engine = new FrontierCombinedEngine({
    timeoutMs: 15,
    maxOutputTokens: 1_200,
    complete: async () => new Promise(() => {}),
  });
  await assert.rejects(() => engine.auditCombined({ subject, bundle }), AuditTimeoutError);
});

test("caller cancellation propagates to the model completion", async () => {
  const controller = new AbortController();
  controller.abort();
  let observedAbortedSignal = false;
  const engine = new FrontierCombinedEngine({
    timeoutMs: 1_000,
    maxOutputTokens: 1_200,
    complete: async (request) => {
      observedAbortedSignal = request.signal.aborted;
      throw new Error("cancelled");
    },
  });
  await assert.rejects(() => engine.auditCombined({ subject, bundle }, controller.signal), /cancelled/);
  assert.equal(observedAbortedSignal, true);
});
