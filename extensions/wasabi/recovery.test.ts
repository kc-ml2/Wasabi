import { jest } from "@jest/globals";
import { WasabiRequest, CALL_TIMEOUT_MS } from "./recovery.ts";
import { WasabiChecker } from "./checker.ts";
import wasabi from "./index.ts";

const quiet: any = { hasUI: false };
const response = { stopReason: "stop", content: [{ type: "text", text: '{"missing_options":[],"recommended_combination":[]}' }] };
afterEach(() => jest.useRealTimers());

test("finite timeout aborts a nonresponsive provider and preserves the original", async () => {
  jest.useFakeTimers();
  const state = new WasabiRequest("Original");
  let signal!: AbortSignal;
  const pending = state.call(quiet, async s => { signal = s; return new Promise(() => {}); });
  const failed = expect(pending).rejects.toThrow("stopped");
  await jest.advanceTimersByTimeAsync(CALL_TIMEOUT_MS);
  await failed;
  expect(signal.aborted).toBe(true);
  expect(state.original_prompt).toBe("Original");
  expect(state.failure).toBeInstanceOf(Error);
});

test("user can stop waiting before timeout and waiting UI closes", async () => {
  jest.useFakeTimers();
  const select = jest.fn<any>(async () => "Stop waiting");
  const state = new WasabiRequest("Original");
  const pending = state.call({ hasUI: true, ui: { select } } as any, async () => new Promise(() => {}));
  const failed = expect(pending).rejects.toThrow("stopped");
  await jest.advanceTimersByTimeAsync(200);
  await failed;
  expect((select.mock.calls[0][2] as any).signal.aborted).toBe(true);
});

test.each(["retry", "cancel", "finish"])("late provider response after %s cannot update checker or forward", async action => {
  const state = new WasabiRequest("Original");
  let late!: (value: any) => void;
  const checker = new WasabiChecker({ complete: jest.fn<any>(() => new Promise(resolve => { late = resolve; })) });
  const ctx: any = { ...quiet, sessionManager: { getBranch: () => [] } };
  const old = state.call(ctx, signal => checker.check(ctx, "Original", signal));
  const rejected = expect(old).rejects.toThrow();
  if (action === "cancel") state.cancel();
  else state.invalidate();
  await rejected;
  const generation = state.call_generation;
  if (action === "retry") expect(await state.call(ctx, async () => "new response")).toBe("new response");
  if (action === "finish") expect(state.forward("Approved draft")).toBe("Approved draft");
  late(response);
  await Promise.resolve();
  await Promise.resolve();
  expect(checker.pending).toBeUndefined();
  expect(state.call_generation).toBeGreaterThanOrEqual(generation);
  if (action !== "retry") expect(state.forward("Late text")).toBeUndefined();
});

function harness(actions: string[], invoke: any) {
  const handlers: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const ctx: any = { hasUI: true, sessionManager: { getBranch: () => [] },
    modelRegistry: { getAvailable: () => [{ provider: "p", id: "light" }],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) },
    ui: { select: jest.fn<any>(async () => actions.shift()), notify: jest.fn(), setStatus: jest.fn() } };
  wasabi({ on: (name: string, fn: any) => { handlers[name] = fn; },
    registerCommand: (name: string, command: any) => { commands[name] = command; }, appendEntry: jest.fn() } as any, invoke);
  return { ctx, handlers, commands };
}

test.each(["Send original unchanged", "Cancel request"])("provider errors preserve original and support %s", async action => {
  const h = harness([action], jest.fn<any>(async () => { throw new Error("provider failed"); }));
  await h.commands["wasabi-model"].handler("p/light", h.ctx);
  const images: any[] = [];
  expect(await h.handlers.input({ source: "interactive", text: "Exact original", images }, h.ctx))
    .toEqual(action === "Cancel request" ? { action: "handled" } : { action: "transform", text: "Exact original", images });
  expect(h.ctx.ui.select.mock.calls[0][0]).toContain("Exact original");
  expect(h.ctx.ui.select.mock.calls[0][1]).toEqual(["Retry", "Send original unchanged", "Cancel request"]);
});

test("retry checks the same original and delivers once", async () => {
  const invoke = jest.fn<any>().mockRejectedValueOnce(new Error("failed")).mockResolvedValueOnce(response);
  const h = harness(["Retry"], invoke);
  await h.commands["wasabi-model"].handler("p/light", h.ctx);
  expect(await h.handlers.input({ source: "interactive", text: "Original" }, h.ctx)).toEqual({ action: "continue" });
  expect(invoke).toHaveBeenCalledTimes(2);
  for (const call of invoke.mock.calls) expect(JSON.parse((call[1] as any).messages[0].content).original_prompt).toBe("Original");
  const state = new WasabiRequest("Original");
  expect(state.forward("Approved")).toBe("Approved");
  expect(state.forward("Approved")).toBeUndefined();
  expect(state.failure).toBeUndefined();
});

test("timed-out input retries while obsolete completion cannot forward", async () => {
  jest.useFakeTimers();
  let late!: (value: any) => void;
  const invoke = jest.fn<any>().mockImplementationOnce(() => new Promise(resolve => { late = resolve; }))
    .mockResolvedValueOnce(response);
  const h = harness(["Keep waiting", "Retry"], invoke);
  // Leave the waiting selector open until the timeout closes it.
  h.ctx.ui.select.mockImplementationOnce((_title: string, _items: string[], opts: any) => new Promise(resolve => {
    opts.signal.addEventListener("abort", () => resolve(undefined));
  })).mockResolvedValueOnce("Retry");
  await h.commands["wasabi-model"].handler("p/light", h.ctx);
  const pending = h.handlers.input({ source: "interactive", text: "Original" }, h.ctx);
  await jest.advanceTimersByTimeAsync(CALL_TIMEOUT_MS);
  expect(await pending).toEqual({ action: "continue" });
  expect(invoke).toHaveBeenCalledTimes(2);
  expect((invoke.mock.calls[0][2] as any).signal.aborted).toBe(true);
  late(response);
  await Promise.resolve();
  expect(invoke).toHaveBeenCalledTimes(2);
});

test("authentication resolving after cancellation cannot launch a provider call", async () => {
  const { WasabiModel } = await import("./model.ts");
  let authenticate!: (value: any) => void;
  const invoke = jest.fn<any>();
  const model = new WasabiModel({ appendEntry: jest.fn() } as any, invoke);
  const ctx: any = { hasUI: false, ui: { notify: jest.fn() },
    modelRegistry: { getAvailable: () => [{ provider: "p", id: "light" }],
      getApiKeyAndHeaders: () => new Promise(resolve => { authenticate = resolve; }) } };
  await model.select(ctx, "p/light");
  const controller = new AbortController();
  const pending = model.complete(ctx, { messages: [] }, { signal: controller.signal });
  controller.abort();
  authenticate({ ok: true, apiKey: "key" });
  await expect(pending).rejects.toThrow("invalidated");
  expect(invoke).not.toHaveBeenCalled();
});

test.each(["timeout", "interrupted"] as const)("%s revokes active call and enters recovery before a provider settles", async kind => {
  jest.useFakeTimers();
  let late!: (value: string) => void;
  let signal!: AbortSignal;
  const state = new WasabiRequest("Preserved verbatim");
  const ctx: any = kind === "timeout" ? quiet : {
    hasUI: true, ui: { select: async () => "Stop waiting" },
  };
  const pending = state.call(ctx, s => { signal = s; return new Promise<string>(resolve => { late = resolve; }); });
  const rejected = expect(pending).rejects.toThrow("stopped");
  const call = state.active_call!;
  expect(call.request_id).toBe(state.request_id);
  expect(call.deadline).toBe(Date.now() + CALL_TIMEOUT_MS);
  expect(state.interaction_state).toBe("checking");
  await jest.advanceTimersByTimeAsync(kind === "timeout" ? CALL_TIMEOUT_MS : 200);
  await rejected;
  expect(signal.aborted).toBe(true);
  expect(state.active_call).toBeNull();
  expect(state.call_generation).toBeGreaterThan(call.call_generation);
  expect(state.interaction_state).toBe("recovering");
  expect(state.failure).toMatchObject({ kind, request_id: state.request_id, call_generation: call.call_generation });
  const failure = state.failure;
  late("Obsolete result");
  await Promise.resolve();
  expect(state.failure).toBe(failure);
  expect(state.interaction_state).toBe("recovering");
  expect(state.original_prompt).toBe("Preserved verbatim");
});

test("an obsolete failure cannot overwrite an active retry or its result", async () => {
  let fail!: (error: Error) => void;
  let resolve!: (text: string) => void;
  const state = new WasabiRequest("Original");
  const old = state.call(quiet, () => new Promise<string>((_, reject) => { fail = reject; }));
  const rejected = expect(old).rejects.toThrow("stopped");
  const retry = state.call(quiet, () => new Promise<string>(done => { resolve = done; }));
  await rejected;
  const active = state.active_call;
  fail(new Error("Obsolete failure"));
  await Promise.resolve();
  expect(state.active_call).toBe(active);
  expect(state.failure).toBeUndefined();
  expect(state.interaction_state).toBe("checking");
  resolve("Current result");
  expect(await retry).toBe("Current result");
  expect(state.active_call).toBeNull();
  expect(state.failure).toBeUndefined();
});

test("finish while checking opens review immediately without waiting for a cancellation-ignoring model", async () => {
  jest.useFakeTimers();
  let late!: (value: any) => void;
  const invoke = jest.fn<any>(() => new Promise(resolve => { late = resolve; }));
  const h = harness(["Finish clarification and review prompt", "Approve and send"], invoke);
  await h.commands["wasabi-model"].handler("p/light", h.ctx);
  const input = h.handlers.input({ source: "interactive", text: "Exact original" }, h.ctx);
  await jest.advanceTimersByTimeAsync(200);
  expect(await input).toEqual({ action: "transform", text: "Exact original", images: undefined });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect((invoke.mock.calls[0][2] as any).signal.aborted).toBe(true);
  expect(h.ctx.ui.select.mock.calls[1][0]).toContain("Review final prompt");
  const calls = h.ctx.ui.select.mock.calls.length;
  late(response);
  await Promise.resolve();
  await Promise.resolve();
  expect(h.ctx.ui.select).toHaveBeenCalledTimes(calls);
  expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("wasabi", undefined);
});

test("session replacement cancels an old provider and prevents its late result from forwarding", async () => {
  let late!: (value: any) => void;
  const invoke = jest.fn<any>().mockImplementationOnce(() => new Promise(resolve => { late = resolve; }))
    .mockResolvedValueOnce(response);
  const h = harness([], invoke);
  await h.commands["wasabi-model"].handler("p/light", h.ctx);
  const old = h.handlers.input({ source: "interactive", text: "Old" }, h.ctx);
  // Let automatic activation and authentication finish before replacing the session.
  for (let turn = 0; turn < 20 && !invoke.mock.calls.length; turn++) await Promise.resolve();
  expect(invoke).toHaveBeenCalledTimes(1);
  await h.handlers.session_start({}, h.ctx);
  expect(await old).toEqual({ action: "handled" });
  late(response);
  await Promise.resolve();
  expect(h.ctx.ui.select).not.toHaveBeenCalled();
});

test("clarification calls also enforce a finite timeout and cancel immediately", async () => {
  jest.useFakeTimers();
  const state = new WasabiRequest("Original");
  const pending = state.call(quiet, () => new Promise(() => {}), 10, "clarifying");
  const rejected = expect(pending).rejects.toThrow("stopped");
  const active = state.active_call!;
  expect(active.kind).toBe("clarifying");
  expect(state.interaction_state).toBe("clarifying");
  await jest.advanceTimersByTimeAsync(10);
  await rejected;
  expect(active.controller.signal.aborted).toBe(true);
  expect(state.interaction_state).toBe("recovering");
  expect(state.failure?.kind).toBe("timeout");
});

test("synchronous provider failure revokes the call and preserves structured recovery evidence", async () => {
  const state = new WasabiRequest("Original");
  let active: typeof state.active_call;
  await expect(state.call(quiet, () => {
    active = state.active_call;
    throw new Error("Synchronous failure");
  })).rejects.toThrow("Synchronous failure");
  expect(active!.controller.signal.aborted).toBe(true);
  expect(state.active_call).toBeNull();
  expect(state.interaction_state).toBe("recovering");
  expect(state.failure).toMatchObject({ kind: "error", request_id: state.request_id,
    call_generation: active!.call_generation, message: "Synchronous failure" });
});
