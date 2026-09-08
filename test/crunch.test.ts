import * as assert from "node:assert/strict";
import { test } from "@jest/globals";
import { createHarness, writeCall } from "./crunch-harness.ts";

// All model calls are injected mocks: no credentials, network or user files.
test("Crunch starts OFF and only accepts explicit on/off", async () => {
  const h = createHarness();
  await h.emit("session_start");
  await h.emit("tool_call", writeCall());
  assert.equal(h.statuses.get("crunch"), "Crunch focus mode: OFF");
  assert.equal(h.pi.registerTool.mock.calls.length, 0);
  assert.equal(h.ctx.ui.select.mock.calls.length, 0);
  assert.equal(h.summarize.mock.calls.length, 0);
  for (const arg of ["", "status", "toggle", "wrong"]) await h.command(arg);
  assert.equal(h.entries.length, 0);
  assert.deepEqual(h.commands.crunch.getArgumentCompletions("").map((i: any) => i.value), ["on", "off"]);
  await h.command("on");
  await h.command("on");
  assert.equal(h.pi.registerTool.mock.calls.length, 1);
  await h.command("off");
  assert.equal(h.statuses.get("crunch"), "Crunch focus mode: OFF");
  await h.emit("tool_call", writeCall());
  assert.equal(h.ctx.ui.select.mock.calls.length, 0);
});

test("stored mode follows the active branch; existing custom edits are never overridden", async () => {
  const h = createHarness("extension");
  h.entries.push({ type: "custom", customType: "crunch-mode", data: { enabled: true } });
  await h.emit("session_start");
  assert.equal(h.statuses.get("crunch"), "Crunch focus mode: ON");
  assert.equal(h.pi.registerTool.mock.calls.length, 0);
  assert.match(h.notifications[0], /keep the existing edit tool/);
  await h.command("on");
  assert.equal(h.notifications.filter(n => n.includes("keep the existing")).length, 1);
  // A custom schema without edits[] remains reviewable without local preview I/O.
  const custom = { toolCallId: "custom", toolName: "edit", input: { path: "remote-only.ts", patch: "patch" } };
  h.batch([custom]);
  await h.emit("tool_call", custom);
  assert.match(h.ctx.ui.select.mock.calls.at(-1)[0], /Run this edit tool call/);
  h.entries.length = 0;
  await h.emit("session_tree");
  assert.equal(h.statuses.get("crunch"), "Crunch focus mode: OFF");
});

test("single call has three choices; a mixed batch retains both feedback scopes", async () => {
  const h = createHarness();
  await h.command("on");
  const a = writeCall(), b = writeCall("write-2", "a.ts");
  h.batch([a]);
  await h.emit("tool_call", a);
  assert.deepEqual(h.ctx.ui.select.mock.calls.at(-1)[1], ["Approve", "Reject", "Reject this change with feedback"]);
  h.batch([a, b, { toolCallId: "bash", toolName: "bash", input: { command: "pwd" } }]);
  await h.emit("tool_call", b);
  const [title, options] = h.ctx.ui.select.mock.calls.at(-1);
  assert.equal(options.length, 4);
  assert.match(title, /\[Approved\] write: a.ts/);
  assert.match(title, /\[Reviewing\] write: a.ts/);
  assert.match(title, /1 other tool call/);
  assert.match(title, /not rolled back/);
});

test("batch completion tracking uses start args, not nonexistent end args", async () => {
  const h = createHarness();
  await h.command("on");
  const a = writeCall(), b = writeCall("write-2", "b.ts");
  h.batch([a, b]);
  await h.emit("tool_execution_start", { ...a, args: a.input });
  await h.emit("tool_call", a);
  await h.emit("tool_execution_end", { toolCallId: a.toolCallId, toolName: "write", isError: false });
  await h.emit("tool_call", b);
  assert.match(h.ctx.ui.select.mock.calls.at(-1)[0], /\[Completed\] write: a.ts/);
});

for (const feedback of [undefined, "", "   "]) {
  test(`Stop all really aborts with empty/cancelled feedback (${String(feedback)})`, async () => {
    const h = createHarness();
    await h.command("on");
    const a = writeCall();
    h.batch([a, writeCall("sibling")]);
    h.ctx.ui.select.mockResolvedValue("Stop all with feedback");
    h.ctx.ui.editor.mockResolvedValue(feedback);
    const result = await h.emit("tool_call", a);
    assert.equal(result.block, true);
    assert.equal(result.terminate, true);
    assert.equal(h.ctx.abort.mock.calls.length, 1);
    await h.emit("agent_settled");
    assert.equal(h.messages.length, 0, "no automatic retry without feedback");
  });
}

test("feedback restarts once after settlement and includes late-completing files", async () => {
  const h = createHarness();
  await h.command("on");
  const a = writeCall();
  h.batch([a]);
  h.ctx.ui.select.mockResolvedValue("Reject this change with feedback");
  await h.emit("tool_call", a);
  assert.equal(h.ctx.abort.mock.calls.length, 1);
  assert.equal(h.messages.length, 0);
  await h.emit("tool_execution_start", { toolCallId: "late", toolName: "edit", args: { path: "late.ts" } });
  await h.emit("tool_execution_end", { toolCallId: "late", toolName: "edit", isError: false });
  await h.emit("agent_settled");
  await h.emit("agent_settled");
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /Keep the public API/);
  assert.match(h.messages[0], /Before using any tools/);
  assert.match(h.messages[0], /late.ts/);
});

test("per-call feedback in a batch does not abort siblings or restart the agent", async () => {
  const h = createHarness();
  await h.command("on");
  const a = writeCall();
  h.batch([a, writeCall("sibling")]);
  h.ctx.ui.select.mockResolvedValue("Reject this change with feedback");
  const result = await h.emit("tool_call", a);
  assert.match(result.reason, /Keep the public API/);
  assert.equal(h.ctx.abort.mock.calls.length, 0);
  await h.emit("agent_settled");
  assert.equal(h.messages.length, 0);
});

test("shutdown discards a queued restart", async () => {
  const h = createHarness();
  await h.command("on");
  const a = writeCall();
  h.batch([a]);
  h.ctx.ui.select.mockResolvedValue("Reject this change with feedback");
  await h.emit("tool_call", a);
  await h.emit("session_shutdown");
  await h.emit("agent_settled");
  assert.equal(h.messages.length, 0);
});

test("summary uses its own selected model and LiteLLM session headers", async () => {
  const h = createHarness();
  h.ctx.model = { provider: "anthropic", id: "conversation-model" };
  h.entries.push({ type: "custom", customType: "crunch-model", data: { key: "openai/summary-model" } });
  await h.emit("session_start");
  await h.command("on");
  const a = writeCall();
  h.batch([a]);
  await h.emit("tool_call", a);
  const [model, , options] = h.summarize.mock.calls[0];
  assert.equal(model.provider, "openai");
  assert.equal(model.id, "summary-model");
  assert.equal(options.headers["x-existing"], "keep");
  assert.equal(options.headers["x-litellm-session-id"], "test-session");
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(h.statuses.get("crunch-summary"), undefined);
  await h.commands["crunch-model"].handler("current", h.ctx);
  await h.emit("tool_call", a);
  assert.equal(h.summarize.mock.calls.at(-1)![0], h.ctx.model);
  assert.equal(h.summarize.mock.calls.at(-1)![2].headers["x-litellm-session-id"], undefined);
});

test("missing model, auth failure and summary errors retain the approval gate", async () => {
  const h = createHarness();
  await h.command("on");
  const a = writeCall();
  h.batch([a]);
  await h.commands["crunch-model"].handler("openai/summary-model", h.ctx);
  h.ctx.modelRegistry.getAvailable = () => [];
  await h.emit("tool_call", a);
  assert.equal(h.summarize.mock.calls.length, 0);
  assert.equal(h.ctx.ui.select.mock.calls.length, 1);
  await h.commands["crunch-model"].handler("current", h.ctx);
  h.ctx.model = { provider: "openai", id: "model" };
  h.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false });
  await h.emit("tool_call", a);
  assert.equal(h.summarize.mock.calls.length, 0);
  h.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true });
  h.summarize.mockRejectedValue(new Error("offline"));
  await h.emit("tool_call", a);
  assert.equal(h.ctx.ui.select.mock.calls.length, 3);
});

test("RPC reviews files without replacing tools; headless calls do not prompt", async () => {
  const h = createHarness();
  h.ctx.mode = "rpc";
  await h.command("on");
  assert.equal(h.pi.registerTool.mock.calls.length, 0);
  h.batch([writeCall()]);
  await h.emit("tool_call", writeCall());
  assert.equal(h.ctx.ui.select.mock.calls.length, 1);
  h.ctx.hasUI = false;
  await h.emit("tool_call", writeCall());
  assert.equal(h.ctx.ui.select.mock.calls.length, 1);
});

test("aborting a nested model call does not reopen an approval prompt", async () => {
  const h = createHarness();
  const controller = new AbortController();
  h.ctx.signal = controller.signal;
  h.ctx.model = { provider: "openai", id: "model" };
  h.summarize.mockImplementation(async () => { controller.abort(); throw new Error("aborted"); });
  await h.command("on");
  const result = await h.emit("tool_call", writeCall());
  assert.equal(result.block, true);
  assert.equal(result.terminate, true);
  assert.equal(h.ctx.ui.select.mock.calls.length, 0);
});
