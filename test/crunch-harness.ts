import { jest } from "@jest/globals";
import crunchExtension from "../extensions/crunch.ts";

export function createHarness(source = "builtin") {
  const events: Record<string, (event: any, ctx: any) => any> = {};
  const commands: Record<string, any> = {};
  const tools: Record<string, any> = {};
  const entries: any[] = [];
  const notifications: string[] = [];
  const statuses = new Map<string, string | undefined>();
  const messages: string[] = [];
  let availableTools: any[] = [{ name: "edit", sourceInfo: { source } }];
  const summarize = jest.fn<(...args: any[]) => Promise<any>>(async () => ({ content: [{ type: "text", text: "변경 요약입니다." }] }));
  const pi = {
    on: (name: string, handler: any) => { events[name] = handler; },
    registerCommand: (name: string, definition: any) => { commands[name] = definition; },
    registerTool: jest.fn<any>((tool: any) => {
      tools[tool.name] = tool;
      availableTools = [{ name: tool.name, sourceInfo: { source: "extension" } }];
    }),
    getAllTools: () => availableTools,
    appendEntry: (customType: string, data: any) => { entries.push({ type: "custom", customType, data }); },
    sendUserMessage: (text: string) => { messages.push(text); },
  };
  const ctx: any = {
    cwd: process.cwd(), mode: "tui", hasUI: true, model: undefined,
    sessionManager: { getBranch: () => entries, getSessionId: () => "test-session" },
    modelRegistry: {
      getAvailable: () => [{ provider: "openai", id: "summary-model" }],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: { "x-existing": "keep" } }),
    },
    ui: {
      notify: (text: string) => { notifications.push(text); },
      setStatus: (key: string, text: string | undefined) => { statuses.set(key, text); },
      select: jest.fn<any>(async () => "Approve"),
      editor: jest.fn<any>(async () => "Keep the public API"),
    },
    abort: jest.fn(),
  };
  crunchExtension(pi as any, summarize as any);
  const emit = (name: string, event: any = {}) => events[name]?.(event, ctx);
  const command = (args: string) => commands.crunch.handler(args, ctx);
  function batch(calls: any[]) {
    entries.push({ type: "message", message: { role: "assistant", content: calls.map(c => ({ type: "toolCall", id: c.toolCallId, name: c.toolName, arguments: c.input })) } });
  }
  return { pi, ctx, events, commands, tools, entries, notifications, statuses, messages, summarize, emit, command, batch };
}

export function writeCall(id = "write-1", path = "a.ts") {
  return { toolCallId: id, toolName: "write", input: { path, content: "const value = 1;" } };
}
