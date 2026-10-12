import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@jest/globals";
import { DEFAULT_CONFIG, loadConfig, parseConfig } from "../screening/config.ts";
import { buildEnvelope } from "../screening/context.ts";
import { audit } from "../screening/engine.ts";
import { decide } from "../screening/policy.ts";
import { DETECTOR_IDS, type Config, type DetectorId, type Providers, type Screening } from "../screening/types.ts";
import { percentile, readFixtures, validateFixture } from "../scripts/evaluate.ts";

function scores(overrides: Partial<Record<DetectorId, number>> = {}): Screening {
  return {
    probabilities: { ...Object.fromEntries(DETECTOR_IDS.map(id => [id, 0.01])), ...overrides } as Record<DetectorId, number>,
    model: "fixture-screen", latencyMs: 1,
  };
}
function decision(overrides: Partial<Record<DetectorId, number>>, config = parseConfig({})) {
  return decide(scores(overrides), buildEnvelope({ prompt: "A synthetic test prompt." }, config), config);
}

test("configuration defaults are independent and a partial section retains other defaults", () => {
  const first = parseConfig({ jev: { timeoutMs: 800 } });
  const second = parseConfig({});
  assert.equal(first.jev.timeoutMs, 800);
  assert.equal(first.jev.model, DEFAULT_CONFIG.jev.model);
  first.approvedConventions.push("Keep an explicit preference.");
  first.context.recentMessages = 0;
  assert.equal(second.approvedConventions.length, 0);
  assert.equal(second.context.recentMessages, DEFAULT_CONFIG.context.recentMessages);
});

test("configuration rejects unknown fields, including inherited object names", () => {
  for (const value of [
    { unknown: true }, { jev: { unknown: true } },
    JSON.parse('{"constructor":{}}'), JSON.parse('{"__proto__":{"mode":"off"}}'),
    JSON.parse('{"policy":{"constructor":0}}'), JSON.parse('{"jev":{"__proto__":{}}}'),
  ]) assert.throws(() => parseConfig(value), /Unknown configuration field/);
});

test("configuration rejects invalid types, numeric budgets, and policy intervals", () => {
  const invalid = [
    null, [], { mode: "automatic" }, { jev: [] },
    { jev: { timeoutMs: 49 } }, { jev: { timeoutMs: Infinity } }, { jev: { model: " " } },
    { rewrite: { maxTokens: 127 } }, { rewrite: { maxTokens: 8193 } },
    { context: { recentMessages: -1 } }, { context: { recentMessages: 33 } },
    { context: { recentMessages: 1.5 } }, { context: { maxContextChars: 64001 } },
    { context: { maxPromptChars: 0 } }, { context: { includeConversation: "false" } },
    { policy: { askThreshold: NaN } }, { policy: { observeThreshold: 1.01 } },
    { policy: { uncertaintyLow: 0.7, uncertaintyHigh: 0.6 } },
    { policy: { uncertaintyHigh: 0.9, askThreshold: 0.85 } },
    { policy: { failure: "silent" } }, { policy: { headless: "rewrite" } },
    { approvedConventions: [null] }, { approvedConventions: Array(17).fill("x") },
    { approvedConventions: ["x".repeat(2001)] },
  ];
  for (const value of invalid) assert.throws(() => parseConfig(value));
});

test("provider URLs cannot embed credentials or non-HTTP transports", () => {
  for (const url of ["file:///tmp/config", "ftp://example.invalid", "https://user:secret@example.invalid", "https://example.invalid?token=secret", "https://example.invalid#secret", "invalid"]) {
    assert.throws(() => parseConfig({ jev: { url } }));
    assert.throws(() => parseConfig({ rewrite: { baseUrl: url } }));
  }
  assert.throws(() => parseConfig({ jev: { apiKeyEnv: "KEY-WITH-DASH" } }));
  assert.equal(parseConfig({ rewrite: { baseUrl: "http://127.0.0.1:8000/v1" } }).rewrite.baseUrl, "http://127.0.0.1:8000/v1");
});

test("explicit configuration files are validated and failures do not disclose contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-audit-config-"));
  const old = process.env.PI_PROMPT_AUDITOR_CONFIG;
  const path = join(dir, "config.json");
  process.env.PI_PROMPT_AUDITOR_CONFIG = path;
  try {
    assert.throws(loadConfig, /Cannot read/);
    writeFileSync(path, '{"mode":"review","context":{"recentMessages":0}}');
    assert.equal(loadConfig().mode, "review");
    assert.equal(loadConfig().context.recentMessages, 0);
    writeFileSync(path, "sensitive-fixture-value: broken json");
    assert.throws(loadConfig, error => error instanceof Error && /not valid JSON/.test(error.message) && !error.message.includes("sensitive-fixture-value"));
    writeFileSync(path, " ".repeat(65537));
    assert.throws(loadConfig, /exceeds/);
  } finally {
    if (old === undefined) delete process.env.PI_PROMPT_AUDITOR_CONFIG;
    else process.env.PI_PROMPT_AUDITOR_CONFIG = old;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the subject prompt is preserved byte for byte and overflow is rejected, never truncated", () => {
  const prompt = "  이전 선택을 유지해.\nFix only `x == null`; keep \"\ud83c\udf36\ufe0f\".\n";
  const config = parseConfig({ context: { maxPromptChars: prompt.length, maxContextChars: 0 } });
  const envelope = buildEnvelope({ prompt }, config);
  assert.equal(envelope.prompt, prompt);
  assert.equal(Buffer.compare(Buffer.from(envelope.prompt), Buffer.from(prompt)), 0);
  assert.equal(envelope.coverage.promptChars, prompt.length);
  assert.throws(() => buildEnvelope({ prompt: prompt + "!" }, config), /not truncated/);
});

test("context keeps recent conversation in chronological order and excludes tool output roles", () => {
  const envelope = buildEnvelope({
    prompt: "Use that choice.",
    recentMessages: [
      { role: "user", text: "oldest" }, { role: "tool", text: "untrusted tool output" },
      { role: "assistant", text: "two" }, { role: "user", text: "three" },
      { role: "assistant", text: "four" },
    ],
  }, parseConfig({ context: { recentMessages: 3 } }));
  assert.deepEqual(envelope.recentMessages.map(message => message.text), ["two", "three", "four"]);
  assert.ok(envelope.coverage.truncated.includes("olderConversation"));
  assert.ok(!envelope.coverage.truncated.includes("recentMessages"));
  assert.ok(envelope.coverage.omitted.includes("toolResults"));
});

test("normal history windowing does not permanently disable review in long sessions", () => {
  const config = parseConfig({});
  const envelope = buildEnvelope({ prompt: "Keep the output empty and write three lines into it.", recentMessages: Array.from({ length: 10 }, (_, i) => ({ role: "user", text: `Completed unrelated step ${i}.` })) }, config);
  const screening = { probabilities: Object.fromEntries(DETECTOR_IDS.map(id => [id, id === "conflicting_instructions" ? 0.99 : 0.01])) as Screening["probabilities"], model: "fixture", latencyMs: 1 };
  assert.equal(decide(screening, envelope, config).action, "ASK");
});

test("context budget is enforced across conventions, summaries, tools, and conversation", () => {
  const config = parseConfig({ context: { maxContextChars: 160 }, approvedConventions: ["c".repeat(30)] });
  const envelope = buildEnvelope({
    prompt: "Do the next step.", summary: "s".repeat(30),
    tools: [{ name: "read", description: "d".repeat(40) }],
    recentMessages: [{ role: "user", text: "older".repeat(100) }, { role: "assistant", text: "latest".repeat(100) }],
  }, config);
  const contents = [...envelope.approvedConventions, envelope.summary ?? "", ...envelope.tools.flatMap(tool => [tool.name, tool.description]), ...envelope.recentMessages.map(message => message.text)];
  assert.equal(contents.join("").length, 160);
  assert.equal(envelope.coverage.contextChars, 160);
  assert.ok(envelope.coverage.truncated.includes("recentMessages"));
  assert.equal(envelope.recentMessages.length, 1);
  assert.ok(envelope.recentMessages[0].text.startsWith("latest"));
});

test("recent user corrections survive when conventions and metadata would exhaust the budget", () => {
  const correction = "Actually, use JSON instead of CSV.";
  const config = parseConfig({ context: { maxContextChars: 200 }, approvedConventions: ["convention ".repeat(50)] });
  const envelope = buildEnvelope({
    prompt: "Proceed with the chosen format.",
    summary: "Earlier the user selected CSV. ".repeat(50),
    recentMessages: [{ role: "user", text: correction }],
    tools: [{ name: "read", description: "Workspace inspection tool. ".repeat(20) }],
  }, config);
  assert.equal(envelope.recentMessages.at(-1)?.text, correction);
  assert.ok(envelope.coverage.contextChars <= 200);
});

test("system prompt, cwd, and conversation obey explicit inclusion settings", () => {
  const input = { prompt: "Current request", summary: "Prior summary", systemPrompt: "Internal system text", cwd: "/synthetic/private", recentMessages: [{ role: "user", text: "Prior user text" }] };
  const defaultEnvelope = buildEnvelope(input, parseConfig({}));
  assert.equal(defaultEnvelope.systemPrompt, undefined);
  assert.equal(defaultEnvelope.cwd, undefined);
  const restricted = buildEnvelope(input, parseConfig({ context: { includeConversation: false } }));
  assert.equal(restricted.summary, undefined);
  assert.deepEqual(restricted.recentMessages, []);
  assert.ok(restricted.coverage.omitted.includes("recentMessages"));
  const explicit = buildEnvelope(input, parseConfig({ context: { includeSystemPrompt: true, includeCwd: true } }));
  assert.equal(explicit.systemPrompt, input.systemPrompt);
  assert.equal(explicit.cwd, input.cwd);
});

test("compaction summaries and their provenance survive the envelope", () => {
  const summary = "The user chose CSV output and a 10 MiB input limit.";
  const envelope = buildEnvelope({ prompt: "Implement the chosen format.", summary }, parseConfig({}));
  assert.equal(envelope.summary, summary);
  assert.match(envelope.provenance.summary, /compaction-summary-untrusted/);
  assert.equal(decide(scores(), envelope, parseConfig({})).action, "PASS");
});

test("low scores pass without rewriting, while model uncertainty alone never asks the user", () => {
  assert.equal(decision({}).action, "PASS");
  for (const id of DETECTOR_IDS) {
    for (const probability of [0.35, 0.5, 0.65]) {
      const result = decision({ [id]: probability });
      assert.equal(result.action, "PROMOTE", `${id} at ${probability}`);
      assert.equal(result.reviewRequired, false);
      assert.ok(result.uncertain.includes(id));
    }
  }
});

test("human decisions and contradictions require review at the configured threshold", () => {
  for (const id of ["missing_user_choice", "conflicting_instructions", "consequential_wording"] as const) {
    const result = decision({ [id]: 0.85 });
    assert.equal(result.action, "ASK");
    assert.equal(result.reviewRequired, true);
    assert.deepEqual(result.reasons, [id]);
    assert.notEqual(decision({ [id]: 0.849 }).action, "ASK");
  }
});

test("discoverable evidence creates observation work, not a human clarification", () => {
  const result = decision({ missing_evidence: 0.95 });
  assert.equal(result.action, "OBSERVE");
  assert.equal(result.reviewRequired, false);
  assert.deepEqual(result.reasons, ["missing_evidence"]);
  assert.equal(decision({ missing_evidence: 0.95, unresolved_reference: 0.95 }).action, "ASK");
  assert.equal(decision({ missing_evidence: 0.95, missing_user_choice: 0.95 }).action, "ASK");
});

test("discoverable evidence cannot hide an independent unresolved human choice", () => {
  const config = parseConfig({});
  const envelope = buildEnvelope({
    prompt: "Read the benchmark CSV, then implement my chosen speed-or-accuracy policy. I have not recorded which policy I chose.",
    tools: [{ name: "read", description: "Read local CSV files." }],
  }, config);
  const result = decide(scores({ missing_evidence: 0.99, unresolved_reference: 0.99 }), envelope, config);
  assert.equal(result.action, "ASK");
  assert.equal(result.reviewRequired, true);
  assert.ok(result.reasons.includes("unresolved_reference"));
});

test("known unsupported capability requires review but unknown capability is not asserted", () => {
  assert.equal(decision({ unsupported_capability: 0.9 }).action, "ASK");
  assert.equal(decision({ unsupported_capability: 0.5 }).action, "PROMOTE");
});

test("an unresolved reference with complete supplied history can ask for its target", () => {
  const result = decision({ unresolved_reference: 0.95 });
  assert.equal(result.action, "ASK");
  assert.deepEqual(result.reasons, ["unresolved_reference"]);
});

test("truncated compaction context promotes a reference decision without blaming the user", () => {
  const config = parseConfig({ context: { maxContextChars: 20 } });
  const envelope = buildEnvelope({ prompt: "Use that format.", summary: "A lengthy earlier discussion specified the target format as CSV." }, config);
  assert.ok(envelope.coverage.truncated.includes("summary"));
  const result = decide(scores({ unresolved_reference: 0.99 }), envelope, config);
  assert.equal(result.action, "PROMOTE");
  assert.equal(result.reviewRequired, false);
});

test("deliberately omitted history is an auditor limitation, not a missing user reference", () => {
  for (const context of [{ includeConversation: false }, { recentMessages: 0 }]) {
    const config = parseConfig({ context });
    const envelope = buildEnvelope({ prompt: "Implement that.", recentMessages: [{ role: "user", text: "By that, I mean export as CSV." }] }, config);
    const result = decide(scores({ unresolved_reference: 0.99 }), envelope, config);
    assert.equal(result.action, "PROMOTE");
    assert.equal(result.reviewRequired, false);
  }
});

test("missing conversation coverage suppresses confident wording, choice, and conflict interruptions", () => {
  const config = parseConfig({ context: { includeConversation: false } });
  const envelope = buildEnvelope({
    prompt: "Use the agreed setting.",
    recentMessages: [{ role: "user", text: "We have already agreed to prioritize accuracy over speed." }],
  }, config);
  for (const id of ["consequential_wording", "missing_user_choice", "conflicting_instructions"] as const) {
    const result = decide(scores({ [id]: 0.99 }), envelope, config);
    assert.equal(result.action, "PROMOTE", id);
    assert.equal(result.reviewRequired, false);
  }
});

test("known unavailable capabilities can still require a choice when only conversation is omitted", () => {
  const config = parseConfig({ context: { includeConversation: false } });
  const envelope = buildEnvelope({
    prompt: "Send the final email.",
    tools: [{ name: "read", description: "Only local file reads; no network or mail capability." }],
  }, config);
  assert.equal(decide(scores({ unsupported_capability: 0.99 }), envelope, config).action, "ASK");
});

test("uninspected images cannot establish a missing reference in text alone", () => {
  const config = parseConfig({});
  const envelope = buildEnvelope({ prompt: "Match this diagram.", imageCount: 1 }, config);
  assert.equal(envelope.coverage.imagesInspected, false);
  assert.equal(envelope.runtime.imageCount, 1);
  assert.equal(decide(scores({ unresolved_reference: 0.99 }), envelope, config).action, "PROMOTE");
});

test("audit calls only the screening provider and leaves the raw prompt untouched", async () => {
  const config = parseConfig({});
  const prompt = "  한국어와 English: do the thing.\n";
  let screeningCalls = 0;
  let rewriteCalls = 0;
  const providers: Providers = {
    screen: async envelope => { screeningCalls++; assert.equal(envelope.prompt, prompt); return scores({ missing_user_choice: 0.95 }); },
    rewrite: async () => { rewriteCalls++; throw new Error("Must be explicitly requested"); },
  };
  const result = await audit({ prompt }, config, providers);
  assert.equal(result.envelope.prompt, prompt);
  assert.equal(result.decision.action, "ASK");
  assert.equal(screeningCalls, 1);
  assert.equal(rewriteCalls, 0);
});

test("overlong input is rejected before network work and provider errors are not fabricated judgments", async () => {
  let calls = 0;
  const providers: Providers = {
    screen: async () => { calls++; throw new Error("synthetic network failure"); },
    rewrite: async () => { throw new Error("not called"); },
  };
  const config: Config = parseConfig({ context: { maxPromptChars: 4 } });
  await assert.rejects(audit({ prompt: "12345" }, config, providers), /not truncated/);
  assert.equal(calls, 0);
  await assert.rejects(audit({ prompt: "1234" }, config, providers), /synthetic network failure/);
  assert.equal(calls, 1);
});

test("evaluation fixtures cover language, factual evidence, and user-owned ambiguity", () => {
  const fixtures = readFixtures();
  assert.ok(fixtures.length >= 20);
  assert.equal(new Set(fixtures.map(item => item.id)).size, fixtures.length);
  for (const language of ["en", "ko", "mixed"]) {
    assert.ok(fixtures.some(item => item.language === language && item.expectedAction === "PASS"));
    assert.ok(fixtures.some(item => item.language === language && item.expectedAction === "ASK"));
    assert.ok(fixtures.some(item => item.language === language && item.expectedAction === "OBSERVE"));
  }
  for (const category of ["resolved_reference", "missing_reference", "compaction_summary", "discoverable_evidence", "user_choice", "conflict"]) {
    assert.ok(fixtures.some(item => item.category === category));
  }
  assert.throws(() => validateFixture({ ...fixtures[0], expectedAction: "probably" }));
  assert.throws(() => validateFixture({ ...fixtures[0], input: { prompt: 123 } }));
  assert.throws(() => validateFixture({ ...fixtures[0], input: { prompt: "Example", imageCount: -1 } }));
  assert.throws(() => validateFixture({ ...fixtures[0], input: { prompt: "Example", recentMessages: [{ role: "tool", text: "Result" }] } }));
});

test("evaluation latency percentiles are numeric nearest ranks and do not fabricate empty results", () => {
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([10, 2, 100, 20, 1], 0.5), 10);
  assert.equal(percentile([10, 2, 100, 20, 1], 0.95), 100);
});
