import { jest } from "@jest/globals";
import wasabi from "../wasabi.ts";
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
    modelRegistry: { getAvailable: () => [{ provider: "p", id: "light" }] },
    ui: {
      select: jest.fn<any>(async () => "p/light"),
      notify: jest.fn(),
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
  expect(h.pi.appendEntry).not.toHaveBeenCalled();
  choose("p/light");
  expect(await pending).toBe(true);
  expect(h.automation.enabled).toBe(true);
  expect(h.pi.appendEntry).toHaveBeenCalledWith(AUTOMATION_ENTRY_TYPE, { enabled: true });
  expect(await h.automation.shouldCheck(h.ctx)).toBe(true);
  expect(h.ctx.ui.select).toHaveBeenCalledTimes(1);
});

test("dismissed first selection leaves checking off and allows a later selection", async () => {
  const h = harness();
  h.ctx.ui.select.mockResolvedValueOnce(undefined);
  expect(await h.automation.shouldCheck(h.ctx)).toBe(false);
  expect(h.automation.enabled).toBe(false);
  expect(h.pi.appendEntry).not.toHaveBeenCalled();
  expect(await h.automation.shouldCheck(h.ctx)).toBe(true);
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
  await restored.setEnabled(h.ctx, true);
  restored.restore(h.ctx);
  expect(restored.enabled).toBe(true);
  h.entries.length = 0;
  restored.restore(h.ctx);
  expect(restored.enabled).toBe(false);
  expect(await restored.shouldCheck(h.ctx)).toBe(true);
});

test("extension commands and ordinary input use the automatic checking configuration", async () => {
  const h = harness();
  const commands: Record<string, any> = {};
  const events: Record<string, any> = {};
  wasabi({ ...h.pi,
    registerCommand: (name: string, command: any) => { commands[name] = command; },
    on: (name: string, handler: any) => { events[name] = handler; },
  } as any);
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
