import { jest } from "@jest/globals";
import wasabi from "./index.ts";
import { CHECK_SYSTEM_PROMPT, conversationSource, parseCheckResponse, WasabiChecker } from "./checker.ts";

const conversation = [
  { role: "user" as const, text: "For research, compare SQLite and Postgres. Cover performance or deployment." },
  { role: "assistant" as const, text: "We can use a short summary or a detailed report." },
];
const evidence = { message_index: 0, quote: "performance or deployment" };
function missing() {
  return {
    missing_options: [{ id: "focus", question: "Should the comparison focus on performance or deployment?", evidence: { ...evidence },
      available_choices: [
        { id: "performance", label: "Performance", evidence: { message_index: 0, quote: "performance" } },
        { id: "deployment", label: "Deployment", evidence: { message_index: 0, quote: "deployment" } },
      ] }],
    recommended_combination: [{ option_id: "focus", choice_id: "performance" }],
  };
}
const clear = { missing_options: [], recommended_combination: [] };
function harness(result: unknown = missing()) {
  const entries: any[] = conversation.map(message => ({ type: "message", message: {
    role: message.role, content: message.role === "user" ? message.text : [{ type: "text", text: message.text }],
  } }));
  entries.push(
    { type: "custom", customType: "private", data: "hidden configuration" },
    { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "file contents" }] } },
    { type: "message", message: { role: "assistant", content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "toolCall", name: "read", arguments: { path: "local-file" } },
    ] } },
  );
  const complete = jest.fn<any>(async () => ({ content: [{ type: "text", text: JSON.stringify(result) }], stopReason: "stop" }));
  const ctx: any = {
    hasUI: true,
    sessionManager: { getBranch: jest.fn(() => entries) },
    modelRegistry: {
      getAvailable: () => [{ provider: "p", id: "light" }],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
    },
    ui: { select: jest.fn<any>(async () => "Confirm recommended combination"), setStatus: jest.fn(), notify: jest.fn() },
  };
  Object.defineProperty(ctx, "cwd", { get() { throw new Error("Local files must not be consulted"); } });
  const checker = new WasabiChecker({ complete });
  const events: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const pi: any = {
    on: (name: string, handler: any) => { events[name] = handler; },
    registerCommand: (name: string, command: any) => { commands[name] = command; },
    appendEntry: jest.fn<any>((customType: string, data: any) => { entries.push({ type: "custom", customType, data }); }),
    sendUserMessage: jest.fn(), sendMessage: jest.fn(),
  };
  return { checker, ctx, complete, entries, pi, events, commands };
}

test("checker reads only branch conversation text, retaining roles and an extensible source boundary", async () => {
  const h = harness();
  expect(conversationSource.read(h.ctx)).toEqual(conversation);
  const request = await h.checker.check(h.ctx, "Compare them");
  expect(request.check).toEqual({ original_prompt: "Compare them", conversation_context: conversation,
    information_sources: ["conversation"], ...missing() });
  const call = h.complete.mock.calls[0][1] as any;
  expect(JSON.parse(call.messages[0].content)).toEqual({ original_prompt: "Compare them",
    conversation_context: conversation, information_sources: ["conversation"] });
  expect(call.tools).toBeUndefined();
  expect(call.systemPrompt).toBe(CHECK_SYSTEM_PROMPT);
  expect(call.systemPrompt).toContain("Even if intent can be inferred");
  expect(call.systemPrompt).toContain("Do not ask again");
  expect(request.confirmed_combination).toBeUndefined();
});

test("recommendations list concrete choices and require explicit combination confirmation", async () => {
  const h = harness();
  const request = await h.checker.check(h.ctx, "Compare them");
  let resolve!: (value: string) => void;
  h.ctx.ui.select.mockImplementation(() => new Promise(r => { resolve = r; }));
  const pending = h.checker.confirmRecommendations(h.ctx, request);
  expect(request.confirmed_combination).toBeUndefined();
  const [title, actions] = h.ctx.ui.select.mock.calls[0];
  expect(title).toContain("Wasabi");
  expect(title).toContain("performance or deployment");
  expect(title).toContain("Performance (recommended)");
  expect(title).toContain("Deployment");
  expect(actions).toContain("Confirm recommended combination");
  resolve("Confirm recommended combination");
  await pending;
  expect(request.confirmed_combination).toEqual(missing().recommended_combination);
});

test.each([undefined, "Leave unconfirmed"])("dismissal or declining (%s) does not confirm recommendations", async action => {
  const h = harness();
  const request = await h.checker.check(h.ctx, "Compare them");
  h.ctx.ui.select.mockResolvedValue(action);
  await h.checker.confirmRecommendations(h.ctx, request);
  expect(request.confirmed_combination).toBeUndefined();
});

test("users can choose a concrete alternative instead of the recommended combination", async () => {
  const h = harness();
  const request = await h.checker.check(h.ctx, "Compare them");
  h.ctx.ui.select.mockResolvedValueOnce("Choose options individually").mockResolvedValueOnce("Deployment");
  await h.checker.confirmRecommendations(h.ctx, request);
  expect(request.confirmed_combination).toEqual([{ option_id: "focus", choice_id: "deployment" }]);
  expect(h.ctx.ui.select.mock.calls[1][1]).toEqual(["Performance", "Deployment"]);
});

test("each missing option must have grounded choices and a complete recommendation", () => {
  expect(parseCheckResponse(JSON.stringify(clear), [])).toEqual(clear);
  const badQuote = missing();
  badQuote.missing_options[0].available_choices[0].evidence.quote = "invented filesystem fact";
  expect(() => parseCheckResponse(JSON.stringify(badQuote), conversation)).toThrow("not in the conversation");
  const badIndex = missing();
  badIndex.missing_options[0].evidence.message_index = 9;
  expect(() => parseCheckResponse(JSON.stringify(badIndex), conversation)).toThrow("not in the conversation");
  const noAlternative = missing();
  noAlternative.missing_options[0].available_choices.pop();
  expect(() => parseCheckResponse(JSON.stringify(noAlternative), conversation)).toThrow("alternative choices");
  const noRecommendation = missing();
  noRecommendation.recommended_combination = [];
  expect(() => parseCheckResponse(JSON.stringify(noRecommendation), conversation)).toThrow("every missing option");
  const unknownChoice = missing();
  unknownChoice.recommended_combination[0].choice_id = "invented";
  expect(() => parseCheckResponse(JSON.stringify(unknownChoice), conversation)).toThrow("listed choice");
});

test("a recommendation combination covers multiple independent missing options", async () => {
  const result = missing();
  result.missing_options.push({ id: "format", question: "Short summary or detailed report?",
    evidence: { message_index: 1, quote: "short summary or a detailed report" }, available_choices: [
      { id: "short", label: "Short summary", evidence: { message_index: 1, quote: "short summary" } },
      { id: "detailed", label: "Detailed report", evidence: { message_index: 1, quote: "detailed report" } },
    ] });
  result.recommended_combination.push({ option_id: "format", choice_id: "short" });
  const h = harness(result);
  const request = await h.checker.check(h.ctx, "Compare them");
  await h.checker.confirmRecommendations(h.ctx, request);
  expect(request.confirmed_combination).toEqual(result.recommended_combination);
  expect(h.ctx.ui.select.mock.calls[0][0]).toContain("Short summary (recommended)");
});

test("enabled extension checks every interactive and RPC input, including clear requests, while off and extension inputs bypass", async () => {
  const h = harness(clear);
  wasabi(h.pi, h.complete);
  await h.commands["wasabi-model"].handler("p/light", h.ctx);
  for (const text of ["Compare them", "Compare SQLite and Postgres performance in a short summary", "hello", "/ordinary text"]) {
    expect(await h.events.input({ source: "interactive", text }, h.ctx)).toEqual({ action: "continue" });
  }
  expect(await h.events.input({ source: "rpc", text: "research it" }, h.ctx)).toEqual({ action: "continue" });
  expect(h.complete).toHaveBeenCalledTimes(5);
  expect(h.complete.mock.calls.map(call => JSON.parse((call[1] as any).messages[0].content).original_prompt)).toEqual([
    "Compare them", "Compare SQLite and Postgres performance in a short summary", "hello", "/ordinary text", "research it",
  ]);
  await h.events.input({ source: "extension", text: "forwarded" }, h.ctx);
  await h.commands.wasabi.handler("off", h.ctx);
  await h.events.input({ source: "interactive", text: "skip" }, h.ctx);
  expect(h.complete).toHaveBeenCalledTimes(5);
});

test("missing options consume the input and keep confirmation outside the main conversation", async () => {
  const h = harness();
  wasabi(h.pi, h.complete);
  await h.commands["wasabi-model"].handler("p/light", h.ctx);
  const before = [...h.entries];
  expect(await h.events.input({ source: "interactive", text: "Compare them" }, h.ctx)).toEqual({ action: "handled" });
  expect(h.entries).toEqual(before);
  expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
});

test("headless requests and malformed checker replies never become implicit confirmation or main-session input", async () => {
  const h = harness();
  h.ctx.hasUI = false;
  const request = await h.checker.check(h.ctx, "Compare them");
  await h.checker.confirmRecommendations(h.ctx, request);
  expect(h.ctx.ui.select).not.toHaveBeenCalled();
  expect(request.confirmed_combination).toBeUndefined();
  wasabi(h.pi, h.complete);
  await h.commands["wasabi-model"].handler("p/light", h.ctx);
  h.complete.mockResolvedValue({ content: [{ type: "text", text: "not JSON" }] });
  expect(await h.events.input({ source: "rpc", text: "Compare them" }, h.ctx)).toEqual({ action: "handled" });
  expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Original request not sent"), "error");
});
