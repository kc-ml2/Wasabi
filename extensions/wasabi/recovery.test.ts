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
  const pi = { on: (name: string, fn: any) => { handlers[name] = fn; },
    registerCommand: (name: string, command: any) => { commands[name] = command; }, appendEntry: jest.fn(),
    sendMessage: jest.fn(), sendUserMessage: jest.fn() };
  wasabi(pi as any, invoke);
  return { ctx, handlers, commands, pi };
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

test("finish without a model draft holds input through editing and approves only the current revision", async () => {
  jest.useFakeTimers();
  let late!: (value: any) => void;
  let review!: (action: string) => void;
  const invoke = jest.fn<any>(() => new Promise(resolve => { late = resolve; }));
  const h = harness([], invoke);
  h.ctx.ui.editor = jest.fn<any>(async () => "Edited and approved by user");
  h.ctx.ui.select.mockResolvedValueOnce("Finish clarification and review prompt")
    .mockImplementationOnce(() => new Promise(resolve => { review = resolve; }))
    .mockResolvedValueOnce("Approve and send");
  await h.commands["wasabi-model"].handler("p/light", h.ctx);
  let settled = false;
  const input = h.handlers.input({ source: "interactive", text: "Exact original" }, h.ctx)
    .then((result: any) => { settled = true; return result; });
  await jest.advanceTimersByTimeAsync(200);
  expect(settled).toBe(false);
  expect((invoke.mock.calls[0][2] as any).signal.aborted).toBe(true);
  expect(h.ctx.ui.select.mock.calls[1][0]).toContain("Exact original");
  expect(h.ctx.ui.select.mock.calls[1][0]).toContain("Checking ended before options were assessed");
  late(response);
  await jest.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  expect(h.ctx.ui.select).toHaveBeenCalledTimes(2);
  review("Edit final prompt");
  expect(await input).toEqual({ action: "transform", text: "Edited and approved by user", images: undefined });
  expect(h.ctx.ui.select.mock.calls[2][0]).toContain("Edited and approved by user");
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("wasabi", undefined);
});

test("finish revokes a clarifying call before cancellation completes", async () => {
  jest.useFakeTimers();
  const state = new WasabiRequest("Original without a draft");
  const ctx: any = { hasUI: true, ui: { select: async () => "Finish clarification and review prompt" } };
  let late!: (value: string) => void;
  const pending = state.call(ctx, () => new Promise<string>(resolve => { late = resolve; }), CALL_TIMEOUT_MS, "clarifying");
  const rejected = expect(pending).rejects.toThrow("clarification finished");
  const active = state.active_call!;
  await jest.advanceTimersByTimeAsync(200);
  await rejected;
  expect(state.active_call).toBeNull();
  expect(active.controller.signal.aborted).toBe(true);
  expect(state.call_generation).toBeGreaterThan(active.call_generation);
  expect(state.interaction_state).toBe("reviewing");
  expect(state.forwarded).toBe(false);
  late("Unapproved model draft");
  await Promise.resolve();
  expect(state.interaction_state).toBe("reviewing");
  expect(state.failure).toBeUndefined();
});

test.each(["Approve and send", "Cancel request"])(
  "early finish keeps an edited draft private until the user chooses %s despite a late provider failure", async action => {
    jest.useFakeTimers();
    let fail!: (error: Error) => void;
    let decide!: (action: string) => void;
    const invoke = jest.fn<any>(() => new Promise((_resolve, reject) => { fail = reject; }));
    const h = harness([], invoke);
    const entries = [{ type: "message", message: { role: "user", content: "Use Kotlin for this task." } }];
    h.ctx.sessionManager.getBranch = () => entries;
    h.ctx.ui.editor = jest.fn<any>(async (_title: string, draft: string) => draft + "\nInclude tests.");
    h.ctx.ui.select.mockResolvedValueOnce("Finish clarification and review prompt")
      .mockResolvedValueOnce("Edit final prompt")
      .mockImplementationOnce(() => new Promise(resolve => { decide = resolve; }));
    await h.commands["wasabi-model"].handler("p/light", h.ctx);
    h.pi.appendEntry.mockClear();
    const before = JSON.stringify(entries);
    let settled = false;
    const input = h.handlers.input({ source: "interactive", text: "Implement retry handling" }, h.ctx)
      .then((result: any) => { settled = true; return result; });
    await jest.advanceTimersByTimeAsync(200);
    expect(settled).toBe(false);
    expect((invoke.mock.calls[0][2] as any).signal.aborted).toBe(true);
    const edited = h.ctx.ui.editor.mock.results[0];
    const draft = await edited.value;
    expect(draft).toContain("Kotlin");
    expect(h.ctx.ui.select.mock.calls[2][0]).toContain(draft);
    fail(new Error("Obsolete provider failure"));
    await jest.advanceTimersByTimeAsync(CALL_TIMEOUT_MS);
    expect(settled).toBe(false);
    expect(h.ctx.ui.select).toHaveBeenCalledTimes(3);
    expect(invoke).toHaveBeenCalledTimes(1);
    decide(action);
    expect(await input).toEqual(action === "Approve and send"
      ? { action: "transform", text: draft, images: undefined } : { action: "handled" });
    expect(JSON.stringify(entries)).toBe(before);
    expect(h.pi.appendEntry).not.toHaveBeenCalled();
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("wasabi", undefined);
  });


test("finish before any model reply retains the captured language directive through editing and approval", async () => {
  jest.useFakeTimers();
  const invoke = jest.fn<any>(() => new Promise(() => {}));
  const h = harness(["Finish clarification and review prompt", "Edit final prompt", "Approve and send"], invoke);
  const entries = [{ type: "message", message: { role: "user", content: "Please answer in Korean." } }];
  h.ctx.sessionManager.getBranch = () => entries;
  h.ctx.ui.editor = jest.fn<any>(async (_title: string, draft: string) => draft + "\nInclude benchmark data.");
  await h.commands["wasabi-model"].handler("p/light", h.ctx);
  const before = JSON.stringify(entries);
  const input = h.handlers.input({ source: "interactive", text: "Compare databases" }, h.ctx);
  await jest.advanceTimersByTimeAsync(200);
  const result = await input;
  expect(result.action).toBe("transform");
  expect(result.text).toContain("Compare databases");
  expect(result.text).toContain("answer in Korean");
  expect(result.text).toContain("Include benchmark data");
  expect(h.ctx.ui.select.mock.calls[1][0]).toContain("answer in Korean");
  expect(h.ctx.ui.select.mock.calls[2][0]).toContain("Include benchmark data");
  expect(invoke).toHaveBeenCalledTimes(1);
  expect((invoke.mock.calls[0][2] as any).signal.aborted).toBe(true);
  expect(JSON.stringify(entries)).toBe(before);
});

test.each(["TypeScript", "Rust", "Kotlin", "Elixir"])(
  "finish with no model response preserves %s, holds review for approval, and ignores late drafts", async language => {
    jest.useFakeTimers();
    let late!: (value: any) => void;
    let approve!: (value: string) => void;
    const invoke = jest.fn<any>(() => new Promise(resolve => { late = resolve; }));
    const h = harness([], invoke);
    const entries = [{ type: "message", message: { role: "user", content: `Use ${language} for this task.` } }];
    h.ctx.sessionManager.getBranch = () => entries;
    h.ctx.ui.editor = jest.fn<any>(async (_title: string, draft: string) => draft + "\nInclude tests.");
    h.ctx.ui.select.mockResolvedValueOnce("Finish clarification and review prompt")
      .mockResolvedValueOnce("Edit final prompt")
      .mockImplementationOnce(() => new Promise(resolve => { approve = resolve; }));
    await h.commands["wasabi-model"].handler("p/light", h.ctx);
    const before = JSON.stringify(entries);
    let sent = false;
    const input = h.handlers.input({ source: "interactive", text: "Implement retry handling" }, h.ctx)
      .then((result: any) => { sent = true; return result; });
    await jest.advanceTimersByTimeAsync(200);
    expect(sent).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect((invoke.mock.calls[0][2] as any).signal.aborted).toBe(true);
    const review = h.ctx.ui.select.mock.calls[2][0] as string;
    expect(review).toContain(language);
    expect(review).toContain("Include tests");
    expect(review).toContain("Checking ended before options were assessed");
    late(response);
    await jest.advanceTimersByTimeAsync(0);
    expect(sent).toBe(false);
    expect(h.ctx.ui.select).toHaveBeenCalledTimes(3);
    approve("Approve and send");
    const result = await input;
    expect(result.action).toBe("transform");
    expect(result.text).toContain(language);
    expect(result.text).toContain("Include tests");
    expect(JSON.stringify(entries)).toBe(before);
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("wasabi", undefined);
  });

test.each(["checking", "clarifying"] as const)(
  "%s rejects a response past its deadline even before the timeout callback runs", async kind => {
    jest.useFakeTimers();
    const state = new WasabiRequest("Original");
    let resolve!: (value: string) => void;
    const pending = state.call(quiet, () => new Promise<string>(done => { resolve = done; }), 50, kind);
    const active = state.active_call!;
    // Move the wall clock without running timers, as when the event loop is busy.
    jest.setSystemTime(active.deadline);
    resolve("Too late");
    await expect(pending).rejects.toThrow("timed out");
    expect(active.controller.signal.aborted).toBe(true);
    expect(state.active_call).toBeNull();
    expect(state.call_generation).toBeGreaterThan(active.call_generation);
    expect(state.failure).toMatchObject({ kind: "timeout", request_id: state.request_id,
      call_generation: active.call_generation });
    expect(state.interaction_state).toBe("recovering");
    expect(state.original_prompt).toBe("Original");
  });

for (const kind of ["timeout", "interrupted"] as const) {
  for (const settlement of ["resolve", "reject"] as const) {
    test.each(["Retry", "Send original unchanged", "Cancel request"])(
      `${kind}: obsolete ${settlement} cannot change held recovery or its %s decision`, async action => {
        jest.useFakeTimers();
        let resolve!: (value: any) => void;
        let reject!: (error: Error) => void;
        let recover!: (value: string) => void;
        const invoke = jest.fn<any>().mockImplementationOnce(() => new Promise((done, fail) => {
          resolve = done;
          reject = fail;
        })).mockResolvedValue(response);
        const h = harness([], invoke);
        h.ctx.ui.select.mockImplementationOnce((_title: string, _items: string[], opts: any) =>
          kind === "interrupted" ? Promise.resolve("Stop waiting") : new Promise(done => {
            opts.signal.addEventListener("abort", () => done(undefined));
          }))
          .mockImplementationOnce(() => new Promise(done => { recover = done; }));
        await h.commands["wasabi-model"].handler("p/light", h.ctx);
        let returned = false;
        const pending = h.handlers.input({ source: "interactive", text: "Preserve exactly" }, h.ctx)
          .then((result: any) => { returned = true; return result; });
        await jest.advanceTimersByTimeAsync(kind === "timeout" ? CALL_TIMEOUT_MS : 200);
        expect(returned).toBe(false);
        expect(invoke).toHaveBeenCalledTimes(1);
        expect((invoke.mock.calls[0][2] as any).signal.aborted).toBe(true);
        const recovery = h.ctx.ui.select.mock.calls[1];
        expect(recovery[0]).toContain("Recovery");
        expect(recovery[0]).toContain("Preserve exactly");
        expect(recovery[1]).toEqual(["Retry", "Send original unchanged", "Cancel request"]);
        if (settlement === "resolve") resolve(response);
        else reject(new Error("Obsolete provider failure"));
        await jest.advanceTimersByTimeAsync(0);
        expect(returned).toBe(false);
        expect(h.ctx.ui.select).toHaveBeenCalledTimes(2);
        expect(invoke).toHaveBeenCalledTimes(1);
        recover(action);
        expect(await pending).toEqual(action === "Retry" ? { action: "continue" }
          : action === "Cancel request" ? { action: "handled" }
            : { action: "transform", text: "Preserve exactly", images: undefined });
        expect(invoke).toHaveBeenCalledTimes(action === "Retry" ? 2 : 1);
        expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("wasabi", undefined);
        // Subsequent input has its own authority and cannot resurrect the old request.
        expect(await h.handlers.input({ source: "interactive", text: "Next request" }, h.ctx))
          .toEqual({ action: "continue" });
        expect(h.ctx.ui.select).toHaveBeenCalledTimes(2);
      });
  }
}
