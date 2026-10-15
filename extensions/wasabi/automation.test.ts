import { jest } from "@jest/globals";
import wasabi from "./index.ts";
import { AUTOMATION_ENTRY_TYPE, WasabiAutomation } from "./automation.ts";
import { WasabiModel } from "./model.ts";

function harness() {
  const entries: any[] = [];
  const pi = {
    appendEntry: jest.fn<any>((customType: string, data: any) => {
      entries.push({ type: "custom", customType, data });
    }),
  };
  const ctx: any = {
    hasUI: true,
    sessionManager: { getBranch: () => entries },
    modelRegistry: {
      getAvailable: () => [{ provider: "p", id: "light" }, { provider: "p", id: "other" }],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
    },
    ui: {
      select: jest.fn<any>(async () => "p/light"),
      setStatus: jest.fn(), notify: jest.fn(),
    },
  };
  const model = new WasabiModel(pi);
  const automation = new WasabiAutomation(pi, model);
  return { pi, ctx, entries, model, automation };
}

test("first ordinary input enables checking only after model selection resolves", async () => {
  const h = harness();
  let choose!: (choice: string) => void;
  h.ctx.ui.select.mockImplementation(() => new Promise(resolve => { choose = resolve; }));
  const pending = h.automation.shouldCheck(h.ctx);
  expect(h.automation.enabled).toBe(false);
  expect(h.automation.initial_setup_completed).toBe(false);
  expect(h.automation.activation_pending).toBe(true);
  expect(h.pi.appendEntry).not.toHaveBeenCalled();
  choose("p/light");
  expect(await pending).toBe(true);
  expect(h.automation.enabled).toBe(true);
  expect(h.automation.initial_setup_completed).toBe(true);
  expect(h.automation.activation_pending).toBe(false);
  expect(h.pi.appendEntry).toHaveBeenCalledWith(AUTOMATION_ENTRY_TYPE, { enabled: true });
  expect(await h.automation.shouldCheck(h.ctx)).toBe(true);
  expect(h.ctx.ui.select).toHaveBeenCalledTimes(1);
});

test("dismissed first selection leaves checking off and allows a later selection", async () => {
  const h = harness();
  h.ctx.ui.select.mockResolvedValueOnce(undefined);
  expect(await h.automation.shouldCheck(h.ctx)).toBe(false);
  expect(h.automation.enabled).toBe(false);
  expect(h.automation.initial_setup_completed).toBe(false);
  expect(h.automation.activation_pending).toBe(false);
  expect(h.pi.appendEntry).not.toHaveBeenCalled();
  expect(await h.automation.shouldCheck(h.ctx)).toBe(true);
});

test.each(["ordinary input", "on command", "model command"])("off during pending %s cannot be overwritten by late selection", async mode => {
  const h = harness();
  let choose!: (choice: string) => void;
  h.ctx.ui.select.mockImplementation(() => new Promise(resolve => { choose = resolve; }));
  const pending = mode === "ordinary input" ? h.automation.shouldCheck(h.ctx)
    : mode === "on command" ? h.automation.setEnabled(h.ctx, true)
      : h.automation.selectModel(h.ctx);
  expect(h.automation.activation_pending).toBe(true);
  expect(h.automation.enabled).toBe(false);
  await h.automation.setEnabled(h.ctx, false);
  expect(h.automation.activation_pending).toBe(false);
  choose("p/light");
  expect(await pending).toBe(mode === "model command");
  expect(h.model.selectedKey).toBe("p/light");
  expect(h.automation.initial_setup_completed).toBe(true);
  expect(h.automation.enabled).toBe(false);
  expect(h.entries.filter(entry => entry.customType === AUTOMATION_ENTRY_TYPE)
    .map(entry => entry.data.enabled)).toEqual([false]);
  expect(await h.automation.setEnabled(h.ctx, true)).toBe(true);
});

test("direct first model selection records pending activation until the choice completes", async () => {
  const h = harness();
  let choose!: (choice: string) => void;
  h.ctx.ui.select.mockImplementation(() => new Promise(resolve => { choose = resolve; }));
  const pending = h.automation.selectModel(h.ctx);
  expect(h.automation.activation_pending).toBe(true);
  expect(h.automation.enabled).toBe(false);
  expect(h.automation.initial_setup_completed).toBe(false);
  choose("p/light");
  expect(await pending).toBe(true);
  expect(h.automation.activation_pending).toBe(false);
  expect(h.automation.initial_setup_completed).toBe(true);
  expect(h.automation.enabled).toBe(true);
});

test("off before first selection survives setup, reselection, main model changes and restore", async () => {
  const h = harness();
  await h.automation.setEnabled(h.ctx, false);
  expect(h.automation.initial_setup_completed).toBe(false);
  await h.automation.selectModel(h.ctx, "p/light");
  expect(h.automation.initial_setup_completed).toBe(true);
  expect(h.automation.enabled).toBe(false);
  await h.automation.selectModel(h.ctx, "p/other");
  h.ctx.model = { provider: "main", id: "changed" };
  expect(await h.automation.shouldCheck(h.ctx)).toBe(false);
  const restored = new WasabiAutomation(h.pi, new WasabiModel(h.pi));
  restored.restore(h.ctx);
  expect(restored.initial_setup_completed).toBe(true);
  expect(restored.enabled).toBe(false);
  expect(restored.activation_pending).toBe(false);
  expect(await restored.setEnabled(h.ctx, true)).toBe(true);
  expect(await restored.shouldCheck(h.ctx)).toBe(true);
  expect(h.model.selectedKey).toBe("p/other");
  expect(h.ctx.ui.select).not.toHaveBeenCalled();
});

test("off skips initialization and on requires a successful dedicated selection", async () => {
  const h = harness();
  await h.automation.setEnabled(h.ctx, false);
  expect(await h.automation.shouldCheck(h.ctx)).toBe(false);
  expect(h.ctx.ui.select).not.toHaveBeenCalled();
  h.ctx.ui.select.mockResolvedValueOnce(undefined);
  expect(await h.automation.setEnabled(h.ctx, true)).toBe(false);
  expect(h.automation.enabled).toBe(false);
  expect(await h.automation.setEnabled(h.ctx, true)).toBe(true);
  expect(h.automation.enabled).toBe(true);
});

test("explicit model selection enables first use but preserves an explicit off preference", async () => {
  const h = harness();
  await h.automation.selectModel(h.ctx, "p/light");
  expect(h.automation.enabled).toBe(true);
  await h.automation.setEnabled(h.ctx, false);
  await h.automation.selectModel(h.ctx, "p/light");
  expect(h.automation.enabled).toBe(false);
  expect(await h.automation.shouldCheck(h.ctx)).toBe(false);
  await h.automation.setEnabled(h.ctx, true);
  expect(h.automation.enabled).toBe(true);
  expect(h.ctx.ui.select).not.toHaveBeenCalled();
});

test("restores toggles per session and resets configuration in a new session", async () => {
  const h = harness();
  await h.automation.selectModel(h.ctx, "p/light");
  await h.automation.setEnabled(h.ctx, false);
  const restored = new WasabiAutomation(h.pi, new WasabiModel(h.pi));
  restored.restore(h.ctx);
  expect(restored.enabled).toBe(false);
  expect(restored.initial_setup_completed).toBe(true);
  await restored.setEnabled(h.ctx, true);
  restored.restore(h.ctx);
  expect(restored.enabled).toBe(true);
  h.entries.length = 0;
  restored.restore(h.ctx);
  expect(restored.enabled).toBe(false);
  expect(restored.initial_setup_completed).toBe(false);
  expect(await restored.shouldCheck(h.ctx)).toBe(true);
});

test("extension commands and ordinary input use the automatic checking configuration", async () => {
  const h = harness();
  const commands: Record<string, any> = {};
  const events: Record<string, any> = {};
  wasabi({ ...h.pi,
    registerCommand: (name: string, command: any) => { commands[name] = command; },
    on: (name: string, handler: any) => { events[name] = handler; },
  } as any, jest.fn<any>(async () => ({ content: [{ type: "text", text:
    JSON.stringify({ missing_options: [], recommended_combination: [] }) }], stopReason: "stop" })));
  await events.session_start({}, h.ctx);
  await events.input({ source: "extension", text: "forwarded" }, h.ctx);
  expect(h.ctx.ui.select).not.toHaveBeenCalled();
  await events.input({ source: "interactive", text: "implement it" }, h.ctx);
  expect(h.ctx.ui.select).toHaveBeenCalledTimes(1);
  expect(h.entries.at(-1).data).toEqual({ enabled: true });
  await commands.wasabi.handler("off", h.ctx);
  expect(h.entries.at(-1).data).toEqual({ enabled: false });
  await events.input({ source: "rpc", text: "research it" }, h.ctx);
  expect(h.ctx.ui.select).toHaveBeenCalledTimes(1);
  const count = h.entries.length;
  await commands.wasabi.handler("invalid", h.ctx);
  expect(h.entries).toHaveLength(count);
  await commands.wasabi.handler(" on ", h.ctx);
  expect(h.entries.at(-1).data).toEqual({ enabled: true });
  expect(h.ctx.ui.select).toHaveBeenCalledTimes(1);
});

function extensionHarness() {
  const h = harness();
  const commands: Record<string, any> = {};
  const events: Record<string, any> = {};
  const invoke = jest.fn<any>(async () => ({ content: [{ type: "text", text:
    JSON.stringify({ missing_options: [], recommended_combination: [] }) }], stopReason: "stop" }));
  h.ctx.modelRegistry.getApiKeyAndHeaders = jest.fn<any>(async () => ({ ok: true, apiKey: "test-key" }));
  wasabi({ ...h.pi,
    registerCommand: (name: string, command: any) => { commands[name] = command; },
    on: (name: string, handler: any) => { events[name] = handler; },
  } as any, invoke);
  const input = () => events.input({ source: "interactive", text: "Research the alternatives" }, h.ctx);
  const toggle = (mode: string) => commands.wasabi.handler(mode, h.ctx);
  const select = (key: string) => commands["wasabi-model"].handler(key, h.ctx);
  const toggles = () => h.entries.filter(entry => entry.customType === AUTOMATION_ENTRY_TYPE)
    .map(entry => entry.data.enabled);
  return { ...h, events, invoke, input, toggle, select, toggles };
}

test.each(["first input", "on command"])("off invalidates pending activation from %s at the extension boundary", async mode => {
  const h = extensionHarness();
  await h.events.session_start({}, h.ctx);
  let choose!: (choice: string) => void;
  h.ctx.ui.select.mockImplementation(() => new Promise(resolve => { choose = resolve; }));
  const pending = mode === "first input" ? h.input() : h.toggle("on");
  expect(h.toggles()).toEqual([]);
  expect(h.invoke).not.toHaveBeenCalled();
  expect(h.ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
  await h.toggle("off");
  choose("p/light");
  await pending;
  expect(h.toggles()).toEqual([false]);
  expect(await h.input()).toEqual({ action: "continue" });
  expect(h.invoke).not.toHaveBeenCalled();
  expect(h.ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
  await h.toggle("on");
  expect(h.toggles()).toEqual([false, true]);
  expect(await h.input()).toEqual({ action: "continue" });
  expect(h.invoke).toHaveBeenCalledTimes(1);
  expect(h.invoke.mock.calls[0][0]).toEqual({ provider: "p", id: "light" });
  expect(h.ctx.ui.select).toHaveBeenCalledTimes(1);
});

test("off before setup survives model commands, main model changes and resume until on", async () => {
  const h = extensionHarness();
  await h.toggle("off");
  await h.input();
  expect(h.ctx.ui.select).not.toHaveBeenCalled();
  await h.select("p/light");
  await h.select("p/other");
  h.ctx.model = { provider: "main", id: "changed" };
  await h.events.session_start({ reason: "resume" }, h.ctx);
  await h.input();
  expect(h.toggles()).toEqual([false]);
  expect(h.invoke).not.toHaveBeenCalled();
  expect(h.ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
  await h.toggle("on");
  await h.input();
  expect(h.toggles()).toEqual([false, true]);
  expect(h.invoke).toHaveBeenCalledTimes(1);
  expect(h.invoke.mock.calls[0][0]).toEqual({ provider: "p", id: "other" });
  expect(h.ctx.ui.select).not.toHaveBeenCalled();
});

test("on after off records pending activation without enabling until first selection succeeds", async () => {
  const h = harness();
  await h.automation.setEnabled(h.ctx, false);
  let choose!: (choice: string | undefined) => void;
  h.ctx.ui.select.mockImplementation(() => new Promise(resolve => { choose = resolve; }));
  const cancelled = h.automation.setEnabled(h.ctx, true);
  expect(h.automation.activation_pending).toBe(true);
  expect(h.automation.enabled).toBe(false);
  expect(h.automation.initial_setup_completed).toBe(false);
  choose(undefined);
  expect(await cancelled).toBe(false);
  expect(h.automation.activation_pending).toBe(false);
  expect(h.automation.enabled).toBe(false);
  expect(h.automation.initial_setup_completed).toBe(false);
  const pending = h.automation.setEnabled(h.ctx, true);
  expect(h.automation.activation_pending).toBe(true);
  expect(h.automation.enabled).toBe(false);
  choose("p/light");
  expect(await pending).toBe(true);
  expect(h.automation.activation_pending).toBe(false);
  expect(h.automation.enabled).toBe(true);
  expect(h.automation.initial_setup_completed).toBe(true);
  expect(h.entries.filter(entry => entry.customType === AUTOMATION_ENTRY_TYPE)
    .map(entry => entry.data.enabled)).toEqual([false, true]);
});
