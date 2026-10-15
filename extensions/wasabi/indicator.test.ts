import { jest } from "@jest/globals";
import wasabi from "./index.ts";
import { CALL_TIMEOUT_MS, WasabiRequest } from "./recovery.ts";

const active = "Wasabi · Private clarification · Main session paused";
const selecting = "Wasabi · Selecting dedicated model · Main session paused";
const result = {
  missing_options: [{ id: "focus", question: "Which focus?",
    evidence: { message_index: 0, quote: "Speed or cost" }, available_choices: [
      { id: "speed", label: "Speed", evidence: { message_index: 0, quote: "Speed" } },
      { id: "cost", label: "Cost", evidence: { message_index: 0, quote: "cost" } },
    ] }], recommended_combination: [{ option_id: "focus", choice_id: "speed" }],
};

function harness(actions: (string | undefined)[] = []) {
  const events: Record<string, any> = {};
  const commands: Record<string, any> = {};
  let status: string | undefined;
  const ctx: any = {
    hasUI: true,
    sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "Speed or cost" } }] },
    modelRegistry: { getAvailable: () => [{ provider: "p", id: "light" }],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) },
    ui: {
      setStatus: jest.fn((_key: string, text: string | undefined) => { status = text; }),
      select: jest.fn<any>(async (title: string) => {
        expect(status).toBe(title.includes("Choose a lightweight model") ? selecting : active);
        expect(title).toContain("Wasabi");
        return actions.shift();
      }),
      editor: jest.fn<any>(async (title: string) => {
        expect(status).toBe(active);
        expect(title).toContain("Wasabi");
        return "Edited prompt";
      }), notify: jest.fn(),
    },
  };
  const invoke = jest.fn<any>(async () => {
    expect(status).toBe(active);
    return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify(result) }] };
  });
  wasabi({ on: (name: string, handler: any) => { events[name] = handler; },
    registerCommand: (name: string, command: any) => { commands[name] = command; },
    appendEntry: jest.fn(),
  } as any, invoke);
  return { ctx, invoke, commands, events, status: () => status,
    input: () => events.input({ source: "interactive", text: "Compare them" }, ctx) };
}

test.each([
  ["approval", ["Confirm recommended combination", "Edit final prompt", "Approve and send"], "transform"],
  ["question cancellation", ["Cancel request"], "handled"],
  ["question dismissal", [undefined], "handled"],
  ["review cancellation", ["Finish clarification and review prompt", "Cancel request"], "handled"],
] as const)("Wasabi is identified throughout private UI and cleared after %s", async (_name, actions, expected) => {
  const h = harness([...actions]);
  await h.commands["wasabi-model"].handler("p/light", h.ctx);
  expect((await h.input()).action).toBe(expected);
  expect(h.ctx.ui.setStatus.mock.calls).toEqual([["wasabi", active], ["wasabi", undefined]]);
  expect(h.status()).toBeUndefined();
});

test.each(["p/light", undefined])("model selection is identified and clears after choosing or dismissing: %s", async choice => {
  const h = harness([choice]);
  await h.commands["wasabi-model"].handler("", h.ctx);
  expect(h.ctx.ui.select).toHaveBeenCalledTimes(1);
  expect(h.ctx.ui.setStatus.mock.calls).toEqual([["wasabi", selecting], ["wasabi", undefined]]);
  expect(h.status()).toBeUndefined();
});

test("first input identifies selection, checking, clarification, review, and forwarding", async () => {
  const h = harness(["p/light", "Confirm recommended combination", "Approve and send"]);
  const forward = WasabiRequest.prototype.forward;
  const spy = jest.spyOn(WasabiRequest.prototype, "forward").mockImplementation(function (this: WasabiRequest, text) {
    expect(h.status()).toBe(active);
    const claimed = forward.call(this, text);
    expect(this.interaction_state).toBe("forwarding");
    expect(h.status()).toBe(active);
    return claimed;
  });
  try {
    expect((await h.input()).action).toBe("transform");
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.ctx.ui.select.mock.calls.map((call: any[]) => call[0])).toEqual([
      expect.stringContaining("Choose a lightweight model"),
      expect.stringContaining("Clarification"),
      expect.stringContaining("Review final prompt"),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(h.status()).toBeUndefined();
  } finally { spy.mockRestore(); }
});

test.each(["Retry", "Send original unchanged", "Cancel request", undefined])(
  "recovery stays identified through %s and clears only after returning", async action => {
    const h = harness([action, "Confirm recommended combination", "Approve and send"]);
    await h.commands["wasabi-model"].handler("p/light", h.ctx);
    h.invoke.mockRejectedValueOnce(new Error("Unavailable"));
    expect((await h.input()).action).toBe(action === "Retry" || action === "Send original unchanged" ? "transform" : "handled");
    expect(h.ctx.ui.select.mock.calls[0][0]).toContain("Wasabi · Recovery");
    // Neither recovery nor retry clears the status while the request is held.
    expect(h.ctx.ui.setStatus.mock.calls).toEqual([["wasabi", active], ["wasabi", undefined]]);
    expect(h.status()).toBeUndefined();
  },
);

test("an overlapping model chooser restores the request indicator instead of clearing it", async () => {
  const h = harness();
  await h.commands["wasabi-model"].handler("p/light", h.ctx);
  let resolveCheck!: (value: any) => void;
  const started = new Promise<void>(resolve => {
    h.invoke.mockImplementationOnce(() => {
      resolve();
      return new Promise(done => { resolveCheck = done; });
    });
  });
  const input = h.input();
  await started;
  h.ctx.ui.select.mockImplementationOnce(async () => {
    expect(h.status()).toBe(selecting);
    return undefined;
  });
  await h.commands["wasabi-model"].handler("", h.ctx);
  expect(h.status()).toBe(active);
  expect(h.ctx.ui.setStatus.mock.calls.some((call: any[]) => call[1] === undefined)).toBe(false);
  resolveCheck({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({
    missing_options: [], recommended_combination: [],
  }) }] });
  expect((await input).action).toBe("continue");
  expect(h.status()).toBeUndefined();
});

test("session reset clears a pending selector and its late cleanup cannot hide a new interaction", async () => {
  const h = harness();
  let close!: (value: string) => void;
  h.ctx.ui.select.mockImplementationOnce(() => new Promise(resolve => { close = resolve; }));
  const selection = h.commands["wasabi-model"].handler("", h.ctx);
  expect(h.status()).toBe(selecting);
  await h.events.session_start({}, h.ctx);
  expect(h.status()).toBeUndefined();
  let closeNew!: (value: undefined) => void;
  h.ctx.ui.select.mockImplementationOnce(() => new Promise(resolve => { closeNew = resolve; }));
  const newSelection = h.commands["wasabi-model"].handler("", h.ctx);
  expect(h.status()).toBe(selecting);
  close("p/light");
  await selection;
  expect(h.status()).toBe(selecting);
  closeNew(undefined);
  await newSelection;
  expect(h.status()).toBeUndefined();
});

test.each(["timeout", "stop", "finish"])("%s while checking retains the indicator through recovery or review", async mode => {
  jest.useFakeTimers();
  try {
    const h = harness();
    await h.commands["wasabi-model"].handler("p/light", h.ctx);
    h.invoke.mockImplementationOnce(() => new Promise(() => {}));
    h.ctx.ui.select.mockImplementationOnce(async (_title: string, _items: string[], options: any) => {
      expect(h.status()).toBe(active);
      if (mode === "timeout") return new Promise(resolve => {
        options.signal.addEventListener("abort", () => resolve(undefined));
      });
      return mode === "finish" ? "Finish clarification and review prompt" : "Stop waiting";
    }).mockImplementationOnce(async (title: string) => {
      expect(h.status()).toBe(active);
      expect(title).toContain(mode === "finish" ? "Review final prompt" : "Recovery");
      return "Cancel request";
    });
    const input = h.input();
    await jest.advanceTimersByTimeAsync(mode === "timeout" ? CALL_TIMEOUT_MS : 200);
    expect((await input).action).toBe("handled");
    expect(h.ctx.ui.setStatus.mock.calls).toEqual([["wasabi", active], ["wasabi", undefined]]);
    expect(h.status()).toBeUndefined();
  } finally { jest.useRealTimers(); }
});

test("a failed model-selection dialog clears its indicator", async () => {
  const h = harness();
  h.ctx.ui.select.mockImplementationOnce(async () => {
    expect(h.status()).toBe(selecting);
    throw new Error("Dialog failed");
  });
  await expect(h.commands["wasabi-model"].handler("", h.ctx)).rejects.toThrow("Dialog failed");
  expect(h.status()).toBeUndefined();
});

test.each(["checker failure", "dialog failure", "no missing options"])("clears Wasabi status on %s", async mode => {
  const h = harness();
  await h.commands["wasabi-model"].handler("p/light", h.ctx);
  if (mode === "checker failure") h.invoke.mockRejectedValueOnce(new Error("Unavailable"));
  if (mode === "dialog failure") h.ctx.ui.select.mockRejectedValueOnce(new Error("Closed"));
  if (mode === "no missing options") h.invoke.mockResolvedValueOnce({ stopReason: "stop", content: [
    { type: "text", text: JSON.stringify({ missing_options: [], recommended_combination: [] }) },
  ] });
  expect((await h.input()).action).toBe(mode === "no missing options" ? "continue" : "handled");
  expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("wasabi", undefined);
  expect(h.status()).toBeUndefined();
});

test("disabled and headless inputs do not install a UI indicator", async () => {
  const h = harness();
  await h.commands.wasabi.handler("off", h.ctx);
  expect((await h.input()).action).toBe("continue");
  expect(h.ctx.ui.setStatus).not.toHaveBeenCalled();
  await h.commands["wasabi-model"].handler("p/light", h.ctx);
  await h.commands.wasabi.handler("on", h.ctx);
  h.ctx.hasUI = false;
  h.invoke.mockResolvedValueOnce({ stopReason: "stop", content: [
    { type: "text", text: JSON.stringify(result) },
  ] });
  expect((await h.input()).action).toBe("handled");
  expect(h.ctx.ui.setStatus).not.toHaveBeenCalled();
});
