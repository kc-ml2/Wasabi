import { jest } from "@jest/globals";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCallFileWriter } from "./call-log.ts";
import { WasabiModel } from "./model.ts";

let root: string;
let previous: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wasabi-log-"));
  previous = process.env.WASABI_LOG_DIR;
  delete process.env.WASABI_LOG_DIR;
});
afterEach(() => {
  if (previous === undefined) delete process.env.WASABI_LOG_DIR;
  else process.env.WASABI_LOG_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
const records = (id: string) => readFileSync(join(root, "logs", `${id}.wasabi.jsonl`), "utf8")
  .trim().split("\n").map(line => JSON.parse(line));

function harness() {
  const entries: any[] = [];
  const pi = { appendEntry: jest.fn<any>((_type: string, data: unknown) => entries.push(data)) };
  const ctx: any = { cwd: root, hasUI: false,
    sessionManager: { getSessionId: () => "session-a", getBranch: () => [] },
    modelRegistry: { getAvailable: () => [{ provider: "p", id: "m" }],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret" }) },
    ui: { notify: jest.fn() } };
  const invoke = jest.fn<any>(async () => ({ content: [], stopReason: "stop" }));
  return { ctx, pi, entries, invoke, model: new WasabiModel(pi, invoke) };
}

test("file logging is opt-in", () => {
  expect(createCallFileWriter("a", root)).toBeUndefined();
  expect(createCallFileWriter("a", root, "  ")).toBeUndefined();
  expect(readdirSync(root)).toEqual([]);
});

test("relative directories resolve against session cwd and session files remain separate", () => {
  const a = createCallFileWriter("a", root, "logs")!;
  const b = createCallFileWriter("b", root, "logs")!;
  a({ callId: "1" }); b({ callId: "2" }); a({ callId: "3" });
  expect(records("a")).toEqual([{ callId: "1" }, { callId: "3" }]);
  expect(records("b")).toEqual([{ callId: "2" }]);
});

test("both sinks receive identical identities and outputs", async () => {
  process.env.WASABI_LOG_DIR = "logs";
  const h = harness();
  await h.model.select(h.ctx, "p/m");
  h.entries.length = 0;
  await h.model.complete(h.ctx, { messages: [] });
  expect(records("session-a")).toEqual(h.entries);
  expect(h.entries[0]).toMatchObject({ sessionId: "session-a", phase: "start" });
  expect(h.entries[1].callId).toBe(h.entries[0].callId);
});

test.each([false, true])("late completion stays in captured file after session switch (failure=%s)", async failure => {
  process.env.WASABI_LOG_DIR = "logs";
  const h = harness();
  let finish!: () => void;
  h.invoke.mockImplementationOnce(() => new Promise((resolve, reject) => {
    finish = () => failure ? reject(new Error("late failure")) : resolve({ content: [], stopReason: "stop" });
  }));
  await h.model.select(h.ctx, "p/m");
  h.entries.length = 0;
  const pending = h.model.complete(h.ctx, { messages: [] });
  await Promise.resolve();
  h.ctx.sessionManager.getSessionId = () => "session-b";
  h.model.restore(h.ctx);
  process.env.WASABI_LOG_DIR = "different";
  finish();
  if (failure) await expect(pending).rejects.toThrow("late failure");
  else await pending;
  expect(h.entries).toHaveLength(1);
  expect(records("session-a")[1]).toMatchObject({ sessionId: "session-a", phase: "end",
    status: failure ? "error" : "success" });
  expect(readdirSync(join(root, "logs"))).toEqual(["session-a.wasabi.jsonl"]);
});

test("file errors do not prevent session logging or change model results", async () => {
  writeFileSync(join(root, "blocked"), "not a directory");
  process.env.WASABI_LOG_DIR = "blocked";
  const h = harness();
  await h.model.select(h.ctx, "p/m");
  h.entries.length = 0;
  await expect(h.model.complete(h.ctx, { messages: [] })).resolves.toMatchObject({ stopReason: "stop" });
  expect(h.entries).toHaveLength(2);
  expect(h.invoke).toHaveBeenCalledTimes(1);
  expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("could not be saved"), "warning");
});

test("session persistence failure does not prevent file logging", async () => {
  process.env.WASABI_LOG_DIR = "logs";
  const h = harness();
  await h.model.select(h.ctx, "p/m");
  h.pi.appendEntry.mockImplementation(() => { throw new Error("session failure"); });
  await h.model.complete(h.ctx, { messages: [] });
  expect(records("session-a")).toHaveLength(2);
});
