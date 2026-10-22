import { jest } from "@jest/globals";
import { visibleWidth } from "@earendil-works/pi-tui";
import { selectWasabiModel, WasabiModelSelector } from "./model-selector.ts";
import { WasabiModel } from "./model.ts";

const models = Array.from({ length: 40 }, (_, i) => ({
  provider: i < 20 ? "alpha" : "beta", id: `model-${String(i).padStart(2, "0")}`,
  name: i === 35 ? "Needle Reasoner" : `Display ${i}`,
}));
const theme: any = { fg: (_color: string, text: string) => text };
function harness() {
  const done = jest.fn<(key: string | undefined) => void>();
  const tui: any = { terminal: { rows: 40 }, requestRender: jest.fn() };
  const selector = new WasabiModelSelector(models, undefined, tui, theme, done);
  return { done, tui, selector, lines: () => selector.render(100) };
}

test("a large catalog is cropped to ten rows and scrolls to a selectable offscreen model", () => {
  const h = harness();
  expect(h.lines().filter(line => /model-\d/.test(line))).toHaveLength(10);
  expect(h.lines().join("\n")).not.toContain("model-15");
  for (let i = 0; i < 15; i++) h.selector.handleInput("\x1b[B");
  expect(h.lines().join("\n")).toContain("→ model-15 [alpha]");
  expect(h.lines().join("\n")).toContain("(16/40)");
  h.selector.handleInput("\r");
  expect(h.done).toHaveBeenCalledWith("alpha/model-15");
});

test.each(["beta/model-35", "Needle", "beta 35"])("fuzzy search finds a model by %s", query => {
  const h = harness();
  for (const char of query) h.selector.handleInput(char);
  expect(h.lines().join("\n")).toContain("→ model-35 [beta]");
  h.selector.handleInput("\r");
  expect(h.done).toHaveBeenCalledWith("beta/model-35");
});

test("empty search results cannot select a model and clearing search restores the catalog", () => {
  const h = harness();
  h.selector.handleInput("zzzz");
  expect(h.lines().join("\n")).toContain("No matching models");
  h.selector.handleInput("\x1b[B");
  h.selector.handleInput("\r");
  expect(h.done).not.toHaveBeenCalled();
  for (let i = 0; i < 4; i++) h.selector.handleInput("\x7f");
  expect(h.lines().filter(line => /model-\d/.test(line))).toHaveLength(10);
  h.selector.handleInput("\x1b");
  expect(h.done).toHaveBeenCalledWith(undefined);
});

test("short terminals reduce visible rows and resize keeps the current selection", () => {
  const h = harness();
  for (let i = 0; i < 15; i++) h.selector.handleInput("\x1b[B");
  h.tui.terminal.rows = 12;
  const lines = h.selector.render(40);
  expect(lines.length).toBeLessThanOrEqual(12);
  expect(lines.every(line => visibleWidth(line) <= 40)).toBe(true);
  expect(lines.join("\n")).toContain("→ model-15 [alpha]");
});

test("interactive model selection saves only Wasabi configuration and cancellation never opens a second dialog", async () => {
  const appendEntry = jest.fn();
  const main = { provider: "main", id: "unchanged" };
  let cancel = false;
  const ctx: any = { hasUI: true, model: main,
    modelRegistry: { getAvailable: () => models },
    ui: { select: jest.fn(), setStatus: jest.fn(), notify: jest.fn(),
      custom: async (factory: any) => new Promise(resolve => {
        const component = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, resolve);
        component.handleInput(cancel ? "\x1b" : "Needle");
        if (!cancel) component.handleInput("\r");
      }),
    },
  };
  const client = new WasabiModel({ appendEntry } as any);
  expect(await client.select(ctx)).toBe(true);
  expect(client.selectedKey).toBe("beta/model-35");
  expect(appendEntry).toHaveBeenCalledTimes(1);
  expect(ctx.model).toBe(main);
  cancel = true;
  expect(await client.select(ctx)).toBe(false);
  expect(client.selectedKey).toBe("beta/model-35");
  expect(appendEntry).toHaveBeenCalledTimes(1);
  expect(ctx.ui.select).not.toHaveBeenCalled();
});

test("RPC uses its standard model dialog when custom TUI factories are unsupported", async () => {
  const ctx: any = { modelRegistry: { getAvailable: () => models }, ui: {
    custom: async () => undefined, select: jest.fn<any>(async () => "beta/model-35"),
  } };
  expect(await selectWasabiModel(ctx)).toBe("beta/model-35");
  expect(ctx.ui.select).toHaveBeenCalledTimes(1);
});
