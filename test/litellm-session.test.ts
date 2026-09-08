import * as assert from "node:assert/strict";
import { test } from "@jest/globals";
import litellmSession from "../extensions/litellm-session.ts";
import { liteLLMSessionHeaders } from "../src/litellm-session.ts";

test("shared header policy only attaches the session ID to configured providers", () => {
  for (const provider of ["centinels", "openai"]) {
    assert.deepEqual(liteLLMSessionHeaders(provider, "session-1"), { "x-litellm-session-id": "session-1" });
  }
  for (const provider of ["anthropic", "other", undefined]) {
    assert.deepEqual(liteLLMSessionHeaders(provider, "session-1"), {});
  }
});

test("main conversation hook uses the same header policy and current session ID", () => {
  let handler: any;
  litellmSession({ on: (_name: string, fn: any) => { handler = fn; }, registerCommand: () => {} } as any);
  const event = { headers: { "x-existing": "keep" } };
  const ctx = { model: { provider: "openai" }, sessionManager: { getSessionId: () => "session-2" } };
  handler(event, ctx);
  assert.deepEqual(event.headers, { "x-existing": "keep", "x-litellm-session-id": "session-2" });
});
