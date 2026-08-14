import { test } from "@jest/globals";
import assert from "node:assert/strict";
import { createConfig } from "../src/prompt-audit/config.ts";
import {
  createAuditEntry,
  createDevAuditEntry,
  createExperimentEntry,
} from "../src/prompt-audit/storage.ts";

test("audit records hash prompts and omit raw prompt/context text", async () => {
  const raw = "private prompt text that must not be logged";
  const entry = await createAuditEntry({
    subject: {
      schemaVersion: "1",
      text: raw,
      source: "interactive",
      imageCount: 0,
      englishMode: "semantic-only",
    },
    config: createConfig(),
    engine: { id: "frontier-combined", version: "1.0.0" },
    userAction: "passed",
    auditLatencyMs: 12,
    reaudits: 0,
  });
  assert.equal(entry.promptHash.length, 64);
  assert.equal(JSON.stringify(entry).includes(raw), false);
});

test("dev records preserve raw preference data with an explicit privacy marker", () => {
  const report = {
    schemaVersion: "1",
    intentSummary: "Clarify the target.",
    issues: [],
    auditorConfidence: 0.9,
    recommendedDecision: "pass",
  };
  const entry = createDevAuditEntry({
    captureMode: "dev",
    submissionId: "submission-1",
    attempt: 1,
    initialText: "Fix it",
    subject: {
      schemaVersion: "1",
      text: "Fix src/parser.ts",
      source: "interactive",
      imageCount: 0,
      englishMode: "semantic-only",
    },
    images: [],
    auditor: {
      engineId: "frontier-combined",
      engineVersion: "1.0.0",
      provider: "test-provider",
      modelId: "frontier-test",
    },
    auditorResponses: [JSON.stringify(report)],
    report,
    userSelection: { kind: "forwarded", submittedText: "edited" },
    auditLatencyMs: 4,
  });

  assert.equal(entry.privacy, "raw-opt-in");
  assert.equal(entry.captureMode, "dev");
  assert.equal(entry.initialInput.text, "Fix it");
  assert.equal(entry.auditedInput, "Fix src/parser.ts");
  assert.equal(entry.auditorResponses[0], JSON.stringify(report));
  assert.deepEqual(entry.userSelection, { kind: "forwarded", submittedText: "edited" });
});

test("experiment records pair sibling target responses and mark shared side effects", () => {
  const entry = createExperimentEntry({
    experimentId: "experiment-1",
    auditSubmissionId: "submission-1",
    commonContextEntryId: "entry-1",
    target: { provider: "test-provider", modelId: "frontier-test" },
    images: [],
    contextIsolation: "pi-session-branches",
    externalSideEffectsIsolated: false,
    alternatives: {
      initial: { text: "Update it", origin: "initial-input" },
      candidate: {
        text: "Update src/parser.ts and run its tests.",
        origin: "auditor-revision",
      },
    },
    selectedAlternative: "candidate",
    executionOrder: ["initial", "candidate"],
    runs: [
      {
        alternative: "initial",
        finalText: "A",
        assistantMessages: [{ role: "assistant", content: "A" }],
      },
      {
        alternative: "candidate",
        finalText: "B",
        assistantMessages: [{ role: "assistant", content: "B" }],
      },
    ],
  });

  assert.equal(entry.datasetVersion, "prompt-audit-experiment-v1");
  assert.equal(entry.externalSideEffectsIsolated, false);
  assert.deepEqual(entry.executionOrder, ["initial", "candidate"]);
  assert.equal(entry.runs.length, 2);
});
