import { jest } from "@jest/globals";
import { MODEL_ENTRY_TYPE, WasabiModel } from "./model.ts";
import wasabi from "./index.ts";

function harness() {
  const dedicated = { provider: "provider", id: "user-chosen-model" };
  const main = { provider: "provider", id: "main-model" };
  const entries: any[] = [];
  const invoke = jest.fn<any>(async () => ({ content: [] }));
  const appendEntry = jest.fn<any>((customType: string, data: any) => {
    entries.push({ type: "custom", customType, data });
  });
  const select = jest.fn<any>(async () => "provider/user-chosen-model");
  const ctx: any = {
    hasUI: true,
    model: main,
    sessionManager: { getBranch: () => entries },
    modelRegistry: {
      getAvailable: jest.fn<any>(() => [dedicated, main]),
      getApiKeyAndHeaders: jest.fn<any>(async () => ({
        ok: true, apiKey: "dedicated-key", headers: { "x-auth": "existing" }, env: {},
      })),
    },
    ui: { select, setStatus: jest.fn(), notify: jest.fn() },
  };
  const pi = { appendEntry };
  const client = new WasabiModel(pi as any, invoke);
  return { client, ctx, pi, entries, invoke, select, dedicated, main };
}

const checking = { systemPrompt: "Check request", messages: [] };
const clarification = { systemPrompt: "Clarify request", messages: [] };

function extensionHarness() {
  const h = harness();
  const events: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const response = { stopReason: "stop", content: [{ type: "text", text:
    JSON.stringify({ missing_options: [], recommended_combination: [] }) }] };
  h.invoke.mockResolvedValue(response);
  wasabi({ ...h.pi,
    registerCommand: (name: string, command: any) => { commands[name] = command; },
    on: (name: string, callback: any) => { events[name] = callback; },
  } as any, h.invoke);
  return { ...h, events, commands, response };
}

test.each(["interactive", "rpc"])("%s input shares a pending model command without using the main model", async source => {
  const h = extensionHarness();
  let choose!: (choice: string) => void;
  h.select.mockImplementation(() => new Promise(resolve => { choose = resolve; }));
  const selecting = h.commands["wasabi-model"].handler("", h.ctx);
  let returned = false;
  const input = h.events.input({ source, text: "Research the alternatives" }, h.ctx)
    .then((result: any) => { returned = true; return result; });
  // Let promise continuations run: the input must remain held by the chooser.
  await Promise.resolve();
  expect(returned).toBe(false);
  expect(h.select).toHaveBeenCalledTimes(1);
  expect(h.invoke).not.toHaveBeenCalled();
  expect(h.ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
  h.ctx.model = { provider: "other", id: "new-main" };
  choose("provider/user-chosen-model");
  await selecting;
  expect(await input).toEqual({ action: "continue" });
  expect(h.ctx.modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledWith(h.dedicated);
  expect(h.invoke).toHaveBeenCalledTimes(1);
  expect(h.invoke.mock.calls[0][0]).toBe(h.dedicated);
});

test("private clarification and resumed input retain selection across main-model changes", async () => {
  const h = extensionHarness();
  await h.commands["wasabi-model"].handler("provider/user-chosen-model", h.ctx);
  let finishCheck!: (response: any) => void;
  let started!: () => void;
  const checkingStarted = new Promise<void>(resolve => { started = resolve; });
  h.invoke.mockImplementationOnce(() => {
    started();
    return new Promise(resolve => { finishCheck = resolve; });
  });
  const first = h.events.input({ source: "interactive", text: "Compare speed or cost" }, h.ctx);
  await checkingStarted;
  h.ctx.model = { provider: "other", id: "changed-during-checking" };
  h.select.mockImplementation(async (title: string) => {
    // Neither the private question UI nor review may replace the selected model.
    h.ctx.model = { provider: "other", id: "changed-during-private-ui" };
    return title.includes("Review final prompt") ? "Approve and send" : "Confirm recommended combination";
  });
  finishCheck({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({
    missing_options: [{ id: "focus", question: "Which focus?",
      evidence: { message_index: -1, quote: "speed or cost" }, available_choices: [
        { id: "speed", label: "Speed", evidence: { message_index: -1, quote: "speed" } },
        { id: "cost", label: "Cost", evidence: { message_index: -1, quote: "cost" } },
      ] }], recommended_combination: [{ option_id: "focus", choice_id: "speed" }],
  }) }] });
  expect(await first).toEqual({ action: "transform", text: expect.stringContaining("Speed"), images: undefined });
  expect(h.invoke).toHaveBeenCalledTimes(1);
  expect(h.select.mock.calls.map(call => call[0])).toEqual([
    expect.stringContaining("Clarification"), expect.stringContaining("Review final prompt"),
  ]);
  await h.events.session_start({ reason: "resume" }, h.ctx);
  expect(await h.events.input({ source: "rpc", text: "Implement the result" }, h.ctx))
    .toEqual({ action: "continue" });
  expect(h.invoke.mock.calls.map(call => call[0])).toEqual([h.dedicated, h.dedicated]);
  expect(h.ctx.modelRegistry.getApiKeyAndHeaders.mock.calls.map((call: any[]) => call[0]))
    .toEqual([h.dedicated, h.dedicated]);
  expect(h.entries.filter(entry => entry.customType === MODEL_ENTRY_TYPE))
    .toEqual([{ type: "custom", customType: MODEL_ENTRY_TYPE, data: { key: "provider/user-chosen-model" } }]);
});

test("a user can choose any authenticated provider and model without lightweight-name heuristics", async () => {
  const h = harness();
  const selected = { provider: "custom-provider", id: "arbitrary-user-choice" };
  h.ctx.modelRegistry.getAvailable.mockReturnValue([h.main, selected]);
  h.select.mockResolvedValue("custom-provider/arbitrary-user-choice");
  await h.client.complete(h.ctx, checking);
  h.ctx.model = { provider: "another-provider", id: "another-main" };
  await h.client.complete(h.ctx, clarification);
  expect(h.select.mock.calls[0][1]).toEqual(["provider/main-model", "custom-provider/arbitrary-user-choice"]);
  expect(h.invoke.mock.calls.map(call => call[0])).toEqual([selected, selected]);
});

test("first use waits for explicit selection before authentication or invocation", async () => {
  const h = harness();
  let choose!: (choice: string) => void;
  h.select.mockImplementation(() => new Promise(resolve => { choose = resolve; }));
  const pending = h.client.complete(h.ctx, checking);
  expect(h.client.selectedKey).toBeUndefined();
  expect(h.invoke).not.toHaveBeenCalled();
  expect(h.ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
  choose("provider/user-chosen-model");
  await pending;
  expect(h.invoke).toHaveBeenCalledWith(h.dedicated, checking, expect.objectContaining({
    apiKey: "dedicated-key", headers: { "x-auth": "existing" },
  }));
});

test("dismissed first selection never invokes the main model", async () => {
  const h = harness();
  h.select.mockResolvedValue(undefined);
  await expect(h.client.complete(h.ctx, checking)).rejects.toThrow("Select a dedicated Wasabi model");
  expect(h.invoke).not.toHaveBeenCalled();
  expect(h.pi.appendEntry).not.toHaveBeenCalled();
});

test("concurrent first calls share selection and never authenticate while it is pending", async () => {
  const h = harness();
  let choose!: (choice: string) => void;
  h.select.mockImplementation(() => new Promise(resolve => { choose = resolve; }));
  const first = h.client.complete(h.ctx, checking);
  const second = h.client.complete(h.ctx, clarification);
  h.ctx.model = { provider: "other", id: "changed-while-selecting" };
  expect(h.select).toHaveBeenCalledTimes(1);
  expect(h.invoke).not.toHaveBeenCalled();
  expect(h.ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
  choose("provider/user-chosen-model");
  await Promise.all([first, second]);
  expect(h.invoke.mock.calls.map(call => call[0])).toEqual([h.dedicated, h.dedicated]);
});

test("a selection from a previous session cannot configure or call the new session", async () => {
  const h = harness();
  let choose!: (choice: string) => void;
  h.select.mockImplementation(() => new Promise(resolve => { choose = resolve; }));
  const pending = h.client.complete(h.ctx, checking);
  h.client.restore(h.ctx);
  choose("provider/user-chosen-model");
  await expect(pending).rejects.toThrow("Select a dedicated Wasabi model");
  expect(h.client.selectedKey).toBeUndefined();
  expect(h.pi.appendEntry).not.toHaveBeenCalled();
  expect(h.invoke).not.toHaveBeenCalled();
});

test("ordinary input is held before selection and uses the dedicated model after main model changes", async () => {
  const h = harness();
  const events: Record<string, any> = {};
  const commands: Record<string, any> = {};
  h.invoke.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text:
    JSON.stringify({ missing_options: [], recommended_combination: [] }) }] });
  wasabi({ ...h.pi,
    registerCommand: (name: string, command: any) => { commands[name] = command; },
    on: (name: string, callback: any) => { events[name] = callback; },
  } as any, h.invoke);
  let choose!: (choice: string) => void;
  h.select.mockImplementation(() => new Promise(resolve => { choose = resolve; }));
  let returned = false;
  const pending = events.input({ source: "interactive", text: "Implement it" }, h.ctx)
    .then((result: any) => { returned = true; return result; });
  expect(returned).toBe(false);
  expect(h.invoke).not.toHaveBeenCalled();
  h.ctx.model = { provider: "other", id: "new-main" };
  choose("provider/user-chosen-model");
  expect(await pending).toEqual({ action: "continue" });
  await events.input({ source: "rpc", text: "Research it" }, h.ctx);
  expect(h.invoke.mock.calls.map(call => call[0])).toEqual([h.dedicated, h.dedicated]);
  expect(h.select).toHaveBeenCalledTimes(1);
  await commands.wasabi.handler("off", h.ctx);
  await commands["wasabi-model"].handler("provider/main-model", h.ctx);
  await events.input({ source: "interactive", text: "Keep checking off" }, h.ctx);
  expect(h.invoke).toHaveBeenCalledTimes(2);
});

test("checking and clarification keep the dedicated model after the main model changes", async () => {
  const h = harness();
  await h.client.complete(h.ctx, checking);
  h.ctx.model = { provider: "other", id: "new-main" };
  await h.client.complete(h.ctx, clarification);
  expect(h.select).toHaveBeenCalledTimes(1);
  expect(h.select.mock.calls[0][1]).toEqual(["provider/user-chosen-model", "provider/main-model"]);
  expect(h.invoke.mock.calls.map(call => call[0])).toEqual([h.dedicated, h.dedicated]);
});

test("restores explicit selection from session configuration without consulting the main model", async () => {
  const h = harness();
  await h.client.select(h.ctx, "provider/user-chosen-model");
  const restored = new WasabiModel(h.pi as any, h.invoke);
  h.entries.push({ type: "custom", customType: "other-model", data: { key: "provider/main-model" } });
  restored.restore(h.ctx);
  await restored.complete(h.ctx, clarification);
  expect(restored.selectedKey).toBe("provider/user-chosen-model");
  expect(h.select).not.toHaveBeenCalled();
  expect(h.pi.appendEntry).toHaveBeenCalledWith(MODEL_ENTRY_TYPE, { key: "provider/user-chosen-model" });
  h.entries.length = 0;
  restored.restore(h.ctx);
  expect(restored.selectedKey).toBeUndefined();
});

test("unavailable selection and authentication failure do not fall back", async () => {
  const h = harness();
  await h.client.select(h.ctx, "provider/user-chosen-model");
  h.ctx.modelRegistry.getAvailable.mockReturnValue([h.main]);
  await expect(h.client.complete(h.ctx, checking)).rejects.toThrow("unavailable");
  expect(h.client.selectedKey).toBe("provider/user-chosen-model");
  h.ctx.modelRegistry.getAvailable.mockReturnValue([h.dedicated, h.main]);
  h.ctx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({ ok: false });
  await expect(h.client.complete(h.ctx, clarification)).rejects.toThrow("Authentication unavailable");
  expect(h.invoke).not.toHaveBeenCalled();
});

test("headless first use and invalid explicit selections cannot trigger calls", async () => {
  const h = harness();
  h.ctx.hasUI = false;
  await expect(h.client.complete(h.ctx, checking)).rejects.toThrow("Select a dedicated Wasabi model");
  expect(await h.client.select(h.ctx, "current")).toBe(false);
  expect(h.client.selectedKey).toBeUndefined();
  expect(h.select).not.toHaveBeenCalled();
  expect(h.invoke).not.toHaveBeenCalled();
  expect(await h.client.select(h.ctx, "provider/user-chosen-model")).toBe(true);
  await h.client.complete(h.ctx, checking);
  expect(h.invoke.mock.calls[0][0]).toBe(h.dedicated);
});

test("extension exposes dedicated selection and restores it on session lifecycle events", async () => {
  const h = harness();
  const commands: Record<string, any> = {};
  const events: Record<string, any> = {};
  wasabi({ ...h.pi,
    registerCommand: (name: string, command: any) => { commands[name] = command; },
    on: (name: string, callback: any) => { events[name] = callback; },
  } as any);
  await commands["wasabi-model"].handler("provider/user-chosen-model", h.ctx);
  expect(h.pi.appendEntry).toHaveBeenCalledWith(MODEL_ENTRY_TYPE, { key: "provider/user-chosen-model" });
  await events.session_start({ reason: "startup" }, h.ctx);
  await events.session_start({ reason: "resume" }, h.ctx);
  expect(h.invoke).not.toHaveBeenCalled();
});
