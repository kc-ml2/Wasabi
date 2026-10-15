import { jest } from "@jest/globals";
import wasabi from "./index.ts";
import { CHECK_SYSTEM_PROMPT, conversationDecisions, conversationSource, parseCheckResponse, WasabiChecker } from "./checker.ts";

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

test("omitted applicable decisions are retained without reconfirmation; unresolved options stay proposals", async () => {
  const settled = { id: "format", applies_to_request: true, confirmed: true, value: "Short summary",
    evidence: { message_index: 2, quote: "Use a short summary for this comparison" } };
  const h = harness({ ...missing(), option_resolutions: [settled] });
  h.entries.push({ type: "message", message: { role: "user", content: settled.evidence.quote } });
  const request = await h.checker.check(h.ctx, "Compare them");
  expect(request.check.option_resolutions).toEqual([settled]);
  expect(request.check.missing_options.map(option => option.id)).toEqual(["focus"]);
  expect(request.confirmed_combination).toBeUndefined();
  const payload = JSON.parse((h.complete.mock.calls[0][1] as any).messages[0].content);
  expect(payload.original_prompt).toBe("Compare them");
  expect(payload.conversation_context[2].text).toBe(settled.evidence.quote);
  expect(CHECK_SYSTEM_PROMPT).toContain("Reuse applicable prior user decisions");
  expect(CHECK_SYSTEM_PROMPT).toContain("Assistant suggestions and inferred intent are not user confirmation");
});

test("fully settled omitted options do not open clarification dialogs", async () => {
  const settled = { id: "focus", applies_to_request: true, confirmed: true, value: "Performance",
    evidence: { message_index: 2, quote: "Focus on performance" } };
  const h = harness({ ...clear, option_resolutions: [settled] });
  h.entries.push({ type: "message", message: { role: "user", content: settled.evidence.quote } });
  wasabi(h.pi, h.complete);
  await h.commands["wasabi-model"].handler("p/light", h.ctx);
  expect(await h.events.input({ source: "interactive", text: "Compare them" }, h.ctx)).toEqual({ action: "continue" });
  expect(h.complete).toHaveBeenCalledTimes(1);
  expect(h.ctx.ui.select).not.toHaveBeenCalled();
});

test.each([
  ["Confirm recommended combination", "Compare them\n\n- format: Short summary\n- focus: Performance"],
  ["Finish clarification and review prompt", "Compare them\n\n- format: Short summary"],
])("input review reuses settled omissions and includes recommendations only after %s", async (action, finalPrompt) => {
  const settled = { id: "format", applies_to_request: true, confirmed: true, value: "Short summary",
    evidence: { message_index: 2, quote: "Use a short summary for this comparison" } };
  const h = harness({ ...missing(), option_resolutions: [settled] });
  h.entries.push({ type: "message", message: { role: "user", content: settled.evidence.quote } });
  wasabi(h.pi, h.complete);
  await h.commands["wasabi-model"].handler("p/light", h.ctx);
  const before = [...h.entries];
  let approve!: (value: string) => void;
  let showReview!: () => void;
  const reviewShown = new Promise<void>(resolve => { showReview = resolve; });
  h.ctx.ui.select.mockResolvedValueOnce(action)
    .mockImplementationOnce(() => new Promise(resolve => { approve = resolve; showReview(); }));

  const input = h.events.input({ source: "interactive", text: "Compare them" }, h.ctx);
  // Wait until final review is displayed, leaving its approval unresolved.
  await reviewShown;
  expect(h.ctx.ui.select).toHaveBeenCalledTimes(2);
  const [questions, actions] = h.ctx.ui.select.mock.calls[0];
  expect(questions).toContain("Performance (recommended)");
  expect(questions).toContain("Deployment");
  expect(actions).toContain("1. Should the comparison focus on performance or deployment?");
  expect(actions).not.toContain(expect.stringContaining("format"));
  const review = h.ctx.ui.select.mock.calls[1][0] as string;
  const [draft, unresolved] = review.split("Unresolved options (not included in the prompt):");
  expect(draft).toContain(finalPrompt);
  expect(draft).toContain("format: Short summary");
  if (action === "Finish clarification and review prompt") {
    expect(draft).not.toContain("focus: Performance");
    expect(unresolved).toContain(missing().missing_options[0].question);
  } else {
    expect(unresolved).toContain("None identified.");
  }
  expect(h.entries).toEqual(before);
  expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
  expect(h.pi.sendMessage).not.toHaveBeenCalled();

  approve("Approve and send");
  expect(await input).toEqual({ action: "transform", text: finalPrompt });
  expect(h.complete).toHaveBeenCalledTimes(1);
  expect(h.entries).toEqual(before);
});

test("current input grounds questions on the first turn without filesystem information", async () => {
  const h = harness(missing());
  h.entries.length = 0;
  const result = missing();
  result.missing_options[0].evidence.message_index = -1;
  for (const choice of result.missing_options[0].available_choices) choice.evidence.message_index = -1;
  h.complete.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify(result) }] });
  const request = await h.checker.check(h.ctx, "Compare performance or deployment");
  expect(request.check.conversation_context).toEqual([]);
  expect(request.check.missing_options).toEqual(result.missing_options);
  expect(request.confirmed_combination).toBeUndefined();
  expect(() => parseCheckResponse(JSON.stringify(result), [], "Unrelated input")).toThrow();
});

test("resolution evidence must be grounded and a confirmed option cannot also require confirmation", () => {
  const resolution = { id: "focus", applies_to_request: true, confirmed: true, value: "Performance",
    evidence: { message_index: -1, quote: "Performance" } };
  expect(() => parseCheckResponse(JSON.stringify({ ...clear, option_resolutions: [resolution] }), conversation,
    "Use Performance")).not.toThrow();
  expect(() => parseCheckResponse(JSON.stringify({ ...clear, option_resolutions: [resolution] }), conversation,
    "Compare them")).toThrow("not in the conversation");
  expect(() => parseCheckResponse(JSON.stringify({ ...missing(), option_resolutions: [resolution] }), conversation,
    "Use Performance")).toThrow("cannot ask again");
});

test("assistant proposals cannot serve as user confirmation evidence", () => {
  const resolution = { id: "format", applies_to_request: true, confirmed: true, value: "Short summary",
    evidence: { message_index: 1, quote: "short summary" } };
  expect(() => parseCheckResponse(JSON.stringify({ ...clear, option_resolutions: [resolution] }), conversation))
    .toThrow("explicit user evidence");
  expect(() => parseCheckResponse(JSON.stringify({ ...clear, option_resolutions: [{ ...resolution, confirmed: false }] }),
    conversation)).not.toThrow();
});

test.each([
  { kind: "coding", original: "Implement the exporter", settledId: "language", settledValue: "TypeScript",
    decision: "Use TypeScript for the exporter.", option: "format", question: "Which export format is required?",
    proposal: "The exporter could produce JSON Lines or CSV.", choices: ["JSON Lines", "CSV"] },
  { kind: "research", original: "Research the database options", settledId: "scope", settledValue: "Deployment",
    decision: "Focus this database research on deployment.", option: "audience", question: "Who will use the research?",
    proposal: "The research could address operators or application developers.", choices: ["operators", "application developers"] },
])("$kind reuses a settled omission and privately confirms only the genuinely undecided option", async scenario => {
  const proof = { message_index: 0, quote: scenario.decision };
  const result = {
    option_resolutions: [
      { id: scenario.settledId, applies_to_request: true, confirmed: true, value: scenario.settledValue, evidence: proof },
      { id: "unrelated", applies_to_request: false, confirmed: true, value: "French",
        evidence: { message_index: 2, quote: "For a different report, use French." } },
    ],
    missing_options: [{ id: scenario.option, question: scenario.question,
      evidence: { message_index: 1, quote: scenario.proposal },
      available_choices: scenario.choices.map((label, index) => ({ id: String(index), label,
        evidence: { message_index: 1, quote: label } })) }],
    recommended_combination: [{ option_id: scenario.option, choice_id: "0" }],
  };
  const h = harness(result);
  h.entries.splice(0, h.entries.length,
    { type: "message", message: { role: "user", content: scenario.decision } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: scenario.proposal }] } },
    { type: "message", message: { role: "user", content: "For a different report, use French." } },
  );
  wasabi(h.pi, h.complete);
  await h.commands["wasabi-model"].handler("p/light", h.ctx);
  const before = [...h.entries];
  let answered = false;
  h.ctx.ui.select.mockImplementation(async (title: string, actions: string[]) => {
    if (title.startsWith("Wasabi · Review final prompt")) {
      expect(title).toContain(`${scenario.settledId}: ${scenario.settledValue}`);
      expect(title).toContain(`${scenario.option}: ${scenario.choices[1]}`);
      expect(title).not.toContain(`${scenario.option}: ${scenario.choices[0]}`);
      expect(title).not.toContain("unrelated: French");
      return "Approve and send";
    }
    if (actions.includes(`1. ${scenario.question}`)) {
      // Reuse the omitted decision without offering it as another question.
      expect(actions.filter(action => /^\d+\./.test(action))).toEqual([`1. ${scenario.question}`]);
      expect(title).toContain(`${scenario.choices[0]} (recommended)`);
      expect(title).toContain(scenario.proposal);
      return answered ? "Finish clarification and review prompt" : `1. ${scenario.question}`;
    }
    answered = true;
    return `2. ${scenario.choices[1]}`;
  });
  expect(await h.events.input({ source: "interactive", text: scenario.original }, h.ctx)).toEqual({
    action: "transform",
    text: `${scenario.original}\n\n- ${scenario.settledId}: ${scenario.settledValue}\n- ${scenario.option}: ${scenario.choices[1]}`,
  });
  const payload = h.complete.mock.calls[0][1] as any;
  expect(Object.keys(JSON.parse(payload.messages[0].content)).sort()).toEqual([
    "conversation_context", "information_sources", "original_prompt",
  ]);
  expect(JSON.parse(payload.messages[0].content).conversation_context).toEqual([
    { role: "user", text: scenario.decision }, { role: "assistant", text: scenario.proposal },
    { role: "user", text: "For a different report, use French." },
  ]);
  expect(payload.tools).toBeUndefined();
  expect(h.complete).toHaveBeenCalledTimes(1);
  expect(h.entries).toEqual(before);
  expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
});


test("interruption fallback preserves explicit language with current-input precedence and exact user evidence", () => {
  const prior = [{ role: "user" as const, text: "Please answer in Korean." },
    { role: "assistant" as const, text: "Answer in French." }];
  expect(conversationDecisions(prior, "Compare them")).toEqual([{
    id: "response_language", applies_to_request: true, confirmed: true, value: "answer in Korean",
    evidence: { message_index: 0, quote: "answer in Korean" },
  }]);
  expect(conversationDecisions(prior, "Answer in English.")[0]).toMatchObject({
    value: "Answer in English", evidence: { message_index: -1, quote: "Answer in English" },
  });
  expect(conversationDecisions([{ role: "user", text: "답변은 한국어로 작성해 주세요." }], "비교해 줘")[0].value)
    .toContain("한국어로");
});

test.each([
  'For a different report, answer in French.',
  'Could you answer in French?',
  'Answer in French?',
  'If this is for France, answer in French.',
  'Example: "Answer in French".',
  'Answer in French or Korean.',
  'The previous request was to answer in French.',
])("interruption fallback never confirms ambiguous or unrelated instructions: %s", text => {
  expect(conversationDecisions([{ role: "user", text }], "Compare databases")).toEqual([]);
});


test.each(["Use Korean.", "For this task, answer in Korean.", "Always respond in Korean."])(
  "direct language instructions survive interruption: %s", text => {
    expect(conversationDecisions([{ role: "user", text }], "Compare databases")[0].value).toContain("Korean");
  });

test.each(["TypeScript", "Rust", "Kotlin", "Elixir"])(
  "review snapshot preserves explicit implementation decisions without a language vocabulary: %s", value => {
    const text = `We already decided to use ${value} for this task.`;
    const [decision] = conversationDecisions([{ role: "user", text }], "Implement retry handling");
    expect(decision).toMatchObject({ applies_to_request: true, confirmed: true,
      value: `use ${value} for this task`, evidence: { message_index: 0, quote: `use ${value} for this task` } });
    expect(text).toContain(decision.evidence.quote);
  });

test("new explicit implementation instructions replace prior decisions for the same scope", () => {
  const decisions = conversationDecisions([{ role: "user", text: "Use TypeScript for implementation." }], "Use Kotlin for this task.");
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({ value: "Use Kotlin for this task", evidence: { message_index: -1 } });
});

test.each([
  ["The output format for this task is JSON Lines. This is decided.", "output format", "JSON Lines"],
  ["For this request, the deployment target is Cloud Run.", "deployment target", "Cloud Run"],
  ["This task's research scope is database performance.", "research scope", "database performance"],
])("snapshot retains explicit task-scoped option declarations: %s", (text, option, value) => {
  const [decision] = conversationDecisions([{ role: "user", text }], "Generate the pipeline");
  expect(decision).toMatchObject({ id: `instruction:${option}`, applies_to_request: true, confirmed: true,
    evidence: { message_index: 0 } });
  expect(decision.value).toContain(value);
  expect(text).toContain(decision.evidence.quote);
});

test("current option declarations replace prior values without dropping independent decisions", () => {
  const prior = [{ role: "user" as const, text:
    "The output format for this task is JSON Lines. The deployment target for this task is Cloud Run." }];
  const decisions = conversationDecisions(prior, "For this task, the output format is CSV.");
  expect(decisions).toHaveLength(2);
  expect(decisions.find(item => item.id === "instruction:output format")).toMatchObject({
    value: "For this task, the output format is CSV", evidence: { message_index: -1 },
  });
  expect(decisions.find(item => item.id === "instruction:deployment target")?.value).toContain("Cloud Run");
});

test.each([
  "The output format for another task is JSON Lines. This is decided.",
  "The output format for this task might be JSON Lines.",
  "The output format for this task is not yet decided.",
  "The output format for this task is a proposed JSON Lines export.",
  "The output format for this task is JSON Lines or CSV.",
  "If approved, the output format for this task is JSON Lines.",
  'Example: "The output format for this task is JSON Lines".',
  "Is the output format for this task JSON Lines?",
])("snapshot excludes unrelated and unconfirmed declarations: %s", text => {
  expect(conversationDecisions([{ role: "user", text }], "Generate the pipeline")).toEqual([]);
});

test("assistant option declarations are never explicit user decisions", () => {
  expect(conversationDecisions([{ role: "assistant", text: "The output format for this task is JSON Lines." }],
    "Generate the pipeline")).toEqual([]);
});

test.each([
  "Could we use Kotlin?", "Use Kotlin or Rust.", "If needed, use Kotlin.",
  "For another project, use Kotlin.", "The previous task used Kotlin.",
  'Example: "Use Kotlin".',
])("snapshot leaves proposed or unrelated implementation choices unassessed: %s", text => {
  expect(conversationDecisions([{ role: "user", text }], "Implement retry handling")).toEqual([]);
});
