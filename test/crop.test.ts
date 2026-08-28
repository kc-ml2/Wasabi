import * as assert from "node:assert/strict";
import { test } from "@jest/globals";
import cropExtension from "../extensions/crop.ts";

type RegisteredCommand = {
  name: string;
  handler: (args: string, ctx: any) => Promise<void>;
};

function registerCropCommand(): RegisteredCommand {
  let command: RegisteredCommand | undefined;
  cropExtension({
    registerCommand(name: string, definition: Omit<RegisteredCommand, "name">) {
      command = { name, ...definition };
    },
  } as any);

  assert.ok(command, "the extension must register /crop");
  return command;
}

function user(id: string, content: string): any {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content, timestamp: 0 } };
}

function createDestination() {
  const copied: Array<[string, unknown]> = [];
  let leafId: string | null = null;

  return {
    copied,
    appendMessage(message: any) {
      leafId = `entry-${copied.length}`;
      copied.push(["message", message]);
    },
    appendModelChange(provider: string, modelId: string) {
      leafId = `entry-${copied.length}`;
      copied.push(["model_change", { provider, modelId }]);
    },
    appendThinkingLevelChange(thinkingLevel: string) {
      leafId = `entry-${copied.length}`;
      copied.push(["thinking_level_change", thinkingLevel]);
    },
    appendCustomEntry(customType: string, data: unknown) {
      leafId = `entry-${copied.length}`;
      copied.push(["custom", { customType, data }]);
    },
    appendCustomMessageEntry(customType: string, content: unknown, display: boolean, details: unknown) {
      leafId = `entry-${copied.length}`;
      copied.push(["custom_message", { customType, content, display, details }]);
    },
    getLeafId() {
      return leafId;
    },
    branchWithSummary(parentId: string | null, summary: string) {
      leafId = `entry-${copied.length}`;
      copied.push(["branch_summary", { parentId, summary }]);
    },
  };
}

test("/crop copies the selected user-turn suffix into a replacement session", async () => {
  const command = registerCropCommand();
  const first = user("first", "old context");
  const selected = user("selected", "start here");
  const later = user("later", "last request");
  const branch = [
    first,
    { type: "message", id: "old-answer", parentId: "first", timestamp: "", message: { role: "assistant", content: [], timestamp: 0 } },
    selected,
    { type: "message", id: "answer", parentId: "selected", timestamp: "", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }], timestamp: 0 } },
    { type: "message", id: "result", parentId: "answer", timestamp: "", message: { role: "toolResult", toolCallId: "call", toolName: "read", content: [], isError: false, timestamp: 0 } },
    { type: "model_change", id: "model", parentId: "result", timestamp: "", provider: "openai", modelId: "gpt-test" },
    { type: "thinking_level_change", id: "thinking", parentId: "model", timestamp: "", thinkingLevel: "high" },
    { type: "custom", id: "custom", parentId: "thinking", timestamp: "", customType: "test", data: { value: 1 } },
    { type: "custom_message", id: "custom-message", parentId: "custom", timestamp: "", customType: "test", content: "context", display: true, details: { value: 2 } },
    { type: "branch_summary", id: "summary", parentId: "custom-message", timestamp: "", fromId: "other", summary: "alternate work" },
    { type: "label", id: "label", parentId: "summary", timestamp: "", targetId: "selected", label: "bookmark" },
    { type: "compaction", id: "compaction", parentId: "label", timestamp: "", summary: "old summary", firstKeptEntryId: "selected", tokensBefore: 1 },
    { type: "session_info", id: "name", parentId: "compaction", timestamp: "", name: "source name" },
    later,
  ];
  const destination = createDestination();
  const notifications: string[] = [];
  let parentSession: string | undefined;

  await command.handler("2", {
    hasUI: true,
    waitForIdle: async () => {},
    sessionManager: {
      getBranch: () => branch,
      getSessionFile: () => "/sessions/source.jsonl",
    },
    newSession: async (options: any) => {
      parentSession = options.parentSession;
      await options.setup(destination);
      await options.withSession({ ui: { notify: (message: string) => notifications.push(message) } });
      return { cancelled: false };
    },
    ui: { notify: (message: string) => notifications.push(message) },
  });

  assert.equal(parentSession, "/sessions/source.jsonl");
  assert.deepEqual(destination.copied.map(([type]) => type), [
    "message", "message", "message", "model_change", "thinking_level_change",
    "custom", "custom_message", "branch_summary", "message",
  ]);
  assert.equal((destination.copied[0]![1] as any).content, "start here");
  assert.equal((destination.copied.at(-1)![1] as any).content, "last request");
  assert.match(notifications.at(-1)!, /^Created a cropped session from 12 source entries\.$/);
});

test("/crop refuses an invalid user-turn selector without replacing the session", async () => {
  const command = registerCropCommand();
  const notifications: string[] = [];
  let newSessionCalled = false;

  await command.handler("not-an-entry-id", {
    hasUI: true,
    waitForIdle: async () => {},
    sessionManager: { getBranch: () => [user("only", "only turn")] },
    newSession: async () => { newSessionCalled = true; },
    ui: { notify: (message: string) => notifications.push(message) },
  });

  assert.equal(newSessionCalled, false);
  assert.deepEqual(notifications, ["Use a user-turn number or entry ID from /crop."]);
});
