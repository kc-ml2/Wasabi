import assert from "node:assert/strict";
import { test, jest, afterEach } from "@jest/globals";
const cleanup: Array<() => void> = [];
afterEach(() => { jest.restoreAllMocks(); for (const fn of cleanup.splice(0)) fn(); });
import { HttpRequestError, postJson } from "../screening/http.ts";
import { screen } from "../screening/jev.ts";
import { DETECTOR_IDS, type Config, type Envelope } from "../screening/types.ts";

const keyEnv = "PI_JEV_AUDITOR_TEST_KEY";
const config: Config = {
  mode: "review",
  jev: { url: "https://api.typesafe.ai/v1/systemone", model: "jev-1.13.0", apiKeyEnv: keyEnv, timeoutMs: 1000 },
  rewrite: { baseUrl: "http://localhost:8080/v1", model: "test", apiKeyEnv: "REWRITE_TEST_KEY", timeoutMs: 1000, maxTokens: 512 },
  context: { recentMessages: 4, maxContextChars: 4000, maxPromptChars: 4000, includeConversation: true, includeSystemPrompt: false, includeCwd: false },
  policy: { askThreshold: 0.85, observeThreshold: 0.7, uncertaintyLow: 0.35, uncertaintyHigh: 0.65, failure: "open", headless: "pass" },
  approvedConventions: [],
};
const envelope: Envelope = {
  profile: "jev-screen-v1", prompt: "Apply that fix.",
  recentMessages: [{ role: "assistant", text: "The proposed fix validates the parsed response." }],
  tools: [{ name: "read", description: "Read local files" }], approvedConventions: [],
  runtime: { source: "interactive", imageCount: 0 },
  coverage: { truncated: [], omitted: [], contextChars: 70, promptChars: 15, imagesInspected: false },
  provenance: {},
};

function validResponse(): Record<string, unknown> {
  return {
    model: "jev-1.13.0",
    answers: Object.fromEntries(DETECTOR_IDS.map((id, i) => [id, { type: "noul", noul: i === 0 ? 0.5 : 0.02 }])),
    usage: { input_tokens: 1234, output_tokens: 60 },
  };
}

test("Jev sends one real-contract request and preserves uncertain probability", async () => {
  const previous = process.env[keyEnv];
  process.env[keyEnv] = "test-secret";
  cleanup.push(() => { if (previous === undefined) delete process.env[keyEnv]; else process.env[keyEnv] = previous; });
  let calls = 0;
  jest.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    calls++;
    assert.equal(url, config.jev.url);
    assert.equal(init!.method, "POST");
    assert.equal(init!.redirect, "error");
    assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer test-secret");
    const body = JSON.parse(init!.body as string);
    assert.equal(body.model, "jev-1.13.0");
    assert.deepEqual(body.state, envelope);
    assert.deepEqual(Object.keys(body.questions), [...DETECTOR_IDS]);
    for (const question of Object.values(body.questions) as { type: string; instructions: string; criteria: { true: string; false: string } }[]) {
      assert.equal(question.type, "noul");
      assert.equal(typeof question.instructions, "string");
      assert.equal(typeof question.criteria.true, "string");
      assert.equal(typeof question.criteria.false, "string");
    }
    return Response.json(validResponse());
  });
  const result = await screen(envelope, config);
  assert.equal(calls, 1);
  assert.equal(result.probabilities.unresolved_reference, 0.5);
  assert.equal(result.model, "jev-1.13.0");
  assert.deepEqual(result.usage, { input_tokens: 1234, output_tokens: 60 });
  assert.ok(result.latencyMs >= 0);
});

test("Jev rejects missing and malformed answers instead of treating them as passes", async () => {
  const previous = process.env[keyEnv];
  process.env[keyEnv] = "test-secret";
  cleanup.push(() => { if (previous === undefined) delete process.env[keyEnv]; else process.env[keyEnv] = previous; });
  const mutations: [string, (response: Record<string, unknown>) => void][] = [
    ["missing answer", (r) => { delete (r.answers as Record<string, unknown>).missing_user_choice; }],
    ["out of range", (r) => { (r.answers as Record<string, unknown>).missing_user_choice = { type: "noul", noul: 1.1 }; }],
    ["string probability", (r) => { (r.answers as Record<string, unknown>).missing_user_choice = { type: "noul", noul: "0.1" }; }],
    ["wrong primitive", (r) => { (r.answers as Record<string, unknown>).missing_user_choice = { type: "choice", noul: 0.1 }; }],
    ["missing model", (r) => { delete r.model; }],
    ["bad usage", (r) => { r.usage = { input_tokens: -1, output_tokens: 2 }; }],
  ];
  for (const [name, mutate] of mutations) {
    {
      const response = validResponse();
      mutate(response);
      jest.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(response));
      await assert.rejects(screen(envelope, config), /^Error: Jev returned an invalid screening response\.$/);
    }
  }
});

test("missing Jev credentials fail before a network request", async () => {
  const previous = process.env[keyEnv];
  delete process.env[keyEnv];
  cleanup.push(() => { if (previous !== undefined) process.env[keyEnv] = previous; });
  const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("must not be called"); });
  await assert.rejects(screen(envelope, config), /API key is not configured/);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("HTTP errors do not retry or expose endpoint, API key, or response body", async () => {
  const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("private response detail", { status: 429 }));
  await assert.rejects(postJson("https://example.test/?secret=endpoint-secret", { prompt: "private prompt" }, {
    apiKey: "credential-secret", timeoutMs: 100,
  }), (error: unknown) => {
    assert.ok(error instanceof HttpRequestError);
    assert.equal(error.status, 429);
    assert.equal(error.code, "status");
    assert.equal(error.message, "HTTP request failed (status 429).");
    assert.equal("cause" in error, false);
    return true;
  });
  assert.equal(fetchMock.mock.calls.length, 1);
});

test("deadline covers a response body that stalls after headers arrive", async () => {
  let signal: AbortSignal | null | undefined;
  let cancelled = false;
  jest.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    signal = init!.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"pending":')); },
      cancel() { cancelled = true; },
    }));
  });
  await assert.rejects(postJson("http://localhost:8080/v1/chat/completions", {}, { timeoutMs: 30 }),
    (error: unknown) => error instanceof HttpRequestError && error.code === "timeout");
  assert.equal(signal?.aborted, true);
  assert.equal(cancelled, true);
});

test("response limits count delivered bytes even without a content-length header", async () => {
  jest.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ text: "가나다라마바사" })));
  await assert.rejects(postJson("http://localhost:8080/v1/chat/completions", {}, { timeoutMs: 100, maxResponseBytes: 20 }),
    (error: unknown) => error instanceof HttpRequestError && error.code === "response_size");
});

test("invalid JSON and network errors are sanitized", async () => {
  {
    jest.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("private-invalid-response"));
    await assert.rejects(postJson("http://localhost:8080/v1/chat/completions", {}, { timeoutMs: 100 }),
      (error: unknown) => error instanceof HttpRequestError && error.message === "HTTP response was not valid JSON.");
  }
  {
    jest.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Bearer sensitive-token sent to secret-endpoint"); });
    await assert.rejects(postJson("http://localhost:8080/v1/chat/completions", {}, { timeoutMs: 100 }),
      (error: unknown) => error instanceof HttpRequestError && error.message === "HTTP request could not be completed.");
  }
});

test("HTTP requests omit Authorization when no credential is supplied", async () => {
  jest.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    assert.equal(new Headers(init!.headers).has("authorization"), false);
    return Response.json({ ok: true });
  });
  assert.deepEqual(await postJson("http://localhost:8080/v1/chat/completions", {}, { timeoutMs: 100 }), { ok: true });
});

test("external cancellation aborts a stalled body before the deadline", async () => {
  const controller = new AbortController();
  let deliveredHeaders: () => void = () => {};
  const ready = new Promise<void>(resolve => { deliveredHeaders = resolve; });
  let cancelled = false;
  let signal: AbortSignal | null | undefined;
  jest.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    signal = init!.signal;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new TextEncoder().encode("{")); },
      cancel() { cancelled = true; },
    }));
    deliveredHeaders();
    return response;
  });
  const request = postJson("https://example.test", {}, { timeoutMs: 60_000, signal: controller.signal });
  await ready;
  controller.abort();
  await assert.rejects(request);
  assert.equal(signal?.aborted, true);
  assert.equal(cancelled, true);
});
