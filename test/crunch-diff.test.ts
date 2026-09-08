import * as assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "@jest/globals";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { previewEdit, selectDiffExcerpt } from "../src/crunch-diff.ts";
import { createHarness } from "./crunch-harness.ts";

const theme: any = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
initTheme("dark", false);
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "wasabi-crunch-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const original = "const first = 1;\nconst retries = 3;\nconst middle = 2;\nconst timeout = 100;\nconst last = 3;\n";
const args = { path: "fixture.ts", edits: [
  { oldText: "const retries = 3;", newText: "const retries = config.maxRetries ?? 3;" },
  { oldText: "const timeout = 100;", newText: "const timeout = 200;" },
] };
const renderText = (component: any) => component.render(100).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const renderContext = (id: string) => ({
  args, state: {}, expanded: false, toolCallId: id, cwd: dir,
  argsComplete: true, executionStarted: true, isPartial: false, isError: false,
  invalidate: () => {},
});

async function fixture() {
  await writeFile(join(dir, args.path), original);
  const h = createHarness();
  h.ctx.cwd = dir;
  h.ctx.model = { provider: "openai", id: "summary-model" };
  await h.command("on");
  const diff = await previewEdit(args, h.ctx);
  const start = diff.split("\n").findIndex(line => line.startsWith("-") && line.includes("retries")) + 1;
  assert.ok(start > 0);
  h.summarize.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ summary: "재시도 설정을 변경합니다.", ranges: [{ start, end: start + 1 }] }) }] });
  const event = { toolCallId: "edit-1", toolName: "edit", input: args };
  h.batch([event]);
  return { h, diff, event };
}

test("excerpt validates indices and only copies original diff rows", () => {
  const diff = " 1 context\n-2 before\n+2 after\n 3 more";
  const expected = { excerpt: "...\n-2 before\n+2 after\n...", omitted: 2 };
  assert.deepEqual(selectDiffExcerpt(diff, [{ start: 2, end: 3 }]), expected);
  assert.deepEqual(selectDiffExcerpt(diff, [{ start: 3, end: 3 }, { start: 2, end: 3 }]), expected);
  for (const invalid of [undefined, null, [], "code", [{ start: 0, end: 2 }], [{ start: 3, end: 2 }], [{ start: 2, end: 100 }], [{ start: 1.2, end: 2 }], [{ start: "2", end: 3 }], [{ start: 1, end: 1 }], [{ start: 1, end: 4 }]]) {
    assert.equal(selectDiffExcerpt(diff, invalid), undefined);
  }
  const long = Array(30).fill("+1 test").join("\n");
  assert.equal(selectDiffExcerpt(long, [{ start: 1, end: 12 }, { start: 13, end: 14 }]), undefined);
  assert.equal(selectDiffExcerpt(long, Array(4).fill({ start: 1, end: 1 })), undefined);
});

test("preview never writes; execution preserves built-in matching and full diff", async () => {
  const { h, diff, event } = await fixture();
  assert.equal(await readFile(join(dir, args.path), "utf8"), original);
  const actual = await h.tools.edit.execute(event.toolCallId, args, undefined, undefined, h.ctx);
  assert.equal(actual.details.diff, diff);
  assert.match(actual.details.patch, /maxRetries/);
  assert.match(await readFile(join(dir, args.path), "utf8"), /config.maxRetries/);
  await assert.rejects(previewEdit({ path: args.path, edits: [{ oldText: "not found", newText: "wrong" }] }, h.ctx));
  assert.ok(!(await readFile(join(dir, args.path), "utf8")).includes("wrong"));
});

test("collapsed shows AI excerpt, expanded shows full diff, and rows fit terminal width", async () => {
  const { h, diff, event } = await fixture();
  const rc = renderContext(event.toolCallId);
  const collapsed = h.tools.edit.renderCall(args, theme, rc);
  await h.emit("tool_call", event);
  assert.match(renderText(collapsed), /Key diff · AI-selected/);
  assert.match(renderText(collapsed), /omitted/);
  assert.ok(!renderText(collapsed).includes("timeout"));
  assert.match(h.summarize.mock.calls[0][1].systemPrompt, /Select row numbers only/);
  assert.equal(h.summarize.mock.calls[0][2].maxTokens, 400);
  for (const width of [15, 40, 100]) {
    for (const line of collapsed.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  // A result supplies the canonical full diff to the built-in renderer.
  const actual = await h.tools.edit.execute(event.toolCallId, args, undefined, undefined, h.ctx);
  h.tools.edit.renderResult(actual, { expanded: false, isPartial: false }, theme, rc);
  assert.equal(actual.details.diff, diff);
  assert.match(renderText(collapsed), /AI-selected/);
  const expanded = h.tools.edit.renderCall(args, theme, { ...rc, expanded: true });
  assert.match(renderText(expanded), /timeout/);
  assert.ok(!renderText(expanded).includes("AI-selected"));
  await h.command("off");
  assert.match(renderText(collapsed), /timeout/);
  assert.ok(!renderText(collapsed).includes("AI-selected"));
});

test("changed execution diffs and errors can never remain hidden by an excerpt", async () => {
  const { h, diff, event } = await fixture();
  const rc = renderContext(event.toolCallId);
  const collapsed = h.tools.edit.renderCall(args, theme, rc);
  await h.emit("tool_call", event);
  h.tools.edit.renderResult({ content: [], details: { diff: diff + "\n+9 unexpected" } }, { expanded: false, isPartial: false }, theme, rc);
  assert.ok(!renderText(collapsed).includes("AI-selected"));
  assert.match(renderText(collapsed), /unexpected/);
  await h.emit("tool_call", event);
  const result = h.tools.edit.renderResult({ content: [{ type: "text", text: "User denied edit" }], details: {} }, { expanded: false, isPartial: false }, theme, { ...rc, isError: true });
  assert.ok(!renderText(collapsed).includes("AI-selected"));
  assert.match(renderText(result), /User denied edit/);
});

for (const response of ["not JSON", "null", JSON.stringify({ summary: "요약", ranges: [{ start: 9999, end: 10000 }] })]) {
  test(`invalid selection falls back without bypassing approval: ${response}`, async () => {
    const { h, event } = await fixture();
    h.summarize.mockResolvedValue({ content: [{ type: "text", text: response }] });
    const component = h.tools.edit.renderCall(args, theme, renderContext(event.toolCallId));
    await h.emit("tool_call", event);
    assert.equal(h.ctx.ui.select.mock.calls.length, 1);
    assert.ok(!renderText(component).includes("AI-selected"));
    assert.equal(await readFile(join(dir, args.path), "utf8"), original);
  });
}

test("oversized diff uses bounded plain summary input and no excerpt", async () => {
  const { h, event } = await fixture();
  const largeArgs = { path: args.path, edits: [{ oldText: original, newText: "x".repeat(22000) }] };
  h.summarize.mockResolvedValue({ content: [{ type: "text", text: "큰 변경입니다." }] });
  const component = h.tools.edit.renderCall(largeArgs, theme, { ...renderContext(event.toolCallId), args: largeArgs });
  await h.emit("tool_call", { ...event, input: largeArgs });
  const [, request, options] = h.summarize.mock.calls[0];
  assert.equal(options.maxTokens, 100);
  assert.match(request.messages[0].content[0].text, /Input truncated/);
  assert.ok(request.messages[0].content[0].text.length < 21000);
  assert.ok(!renderText(component).includes("AI-selected"));
  assert.equal(await readFile(join(dir, args.path), "utf8"), original);
});
