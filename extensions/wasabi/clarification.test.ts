import { jest } from "@jest/globals";
import wasabi from "./index.ts";
import { applyClarificationActions, WasabiClarification, reviewClarification } from "./clarification.ts";
import type { CheckedRequest } from "./checker.ts";

const request: CheckedRequest = { check: {
  original_prompt: "Compare the databases", conversation_context: [{ role: "user", text: "Performance or deployment" }],
  information_sources: ["conversation"], missing_options: [{ id: "focus", question: "Which focus?",
    evidence: { message_index: 0, quote: "Performance or deployment" }, available_choices: [
      { id: "performance", label: "Performance", evidence: { message_index: 0, quote: "Performance" } },
      { id: "deployment", label: "Deployment", evidence: { message_index: 0, quote: "deployment" } },
    ] }], recommended_combination: [{ option_id: "focus", choice_id: "performance" }],
} };

function ui(actions: (string | undefined)[], edits: (string | undefined)[] = []) {
  return { hasUI: true, ui: {
    select: jest.fn<any>(async () => actions.shift()),
    editor: jest.fn<any>(async () => edits.shift()), setStatus: jest.fn(), notify: jest.fn(),
  } } as any;
}

test("current draft needs approval, editing revokes approval, and forwarding is claimed once", () => {
  const state = new WasabiClarification("Original");
  expect(state.apply([{ type: "approve" }, { type: "forward" }])).toBeUndefined();
  state.apply([{ type: "answer", question: "Focus?", answer: "Performance" }, { type: "finish" }, { type: "approve" }]);
  expect(state.approved).toBe(true);
  expect(state.prompt_revision).toBe(1);
  expect(state.approved_revision).toBe(1);
  state.apply([{ type: "edit", text: "Edited" }]);
  expect(state.approved).toBe(false);
  expect(state.prompt_revision).toBe(2);
  expect(state.approved_revision).toBeNull();
  expect(state.apply([{ type: "forward" }])).toBeUndefined();
  expect(state.apply([{ type: "approve" }, { type: "forward" }])).toBe("Edited");
  expect(state.approved_revision).toBe(2);
  expect(state.apply([{ type: "forward" }, { type: "edit", text: "Again" }, { type: "approve" }, { type: "forward" }])).toBeUndefined();
  expect(state.forwarded).toBe(true);
});

test("no question count limit; history remains private and latest answers form the draft", () => {
  const state = new WasabiClarification("Original");
  for (let index = 0; index < 250; index++) state.apply([{ type: "answer", question: `Question ${index}`, answer: `Answer ${index}` }]);
  state.apply([{ type: "answer", question: "Question 0", answer: "Corrected" }, { type: "finish" }]);
  expect(state.clarification_history).toHaveLength(251);
  expect(state.final_prompt).toContain("Answer 249");
  expect(state.final_prompt).toContain("- Corrected");
  expect(state.final_prompt).not.toContain("Answer 0");
  expect(state.final_prompt).not.toContain("Question");
  expect(state.approved).toBe(false);
});

test("cancelled or empty drafts cannot be approved or forwarded", () => {
  const state = new WasabiClarification("Original");
  state.apply([{ type: "finish" }, { type: "edit", text: " " }, { type: "approve" }]);
  expect(state.approved).toBe(false);
  expect(state.apply([{ type: "forward" }])).toBeUndefined();
  state.apply([{ type: "cancel" }]);
  expect(state.apply([{ type: "edit", text: "Late" }, { type: "approve" }, { type: "forward" }])).toBeUndefined();
});

test("users finish immediately without accepting recommendations, then edit and approve", async () => {
  const ctx = ui(["Finish clarification and review prompt", "Edit final prompt", "Approve and send"], ["User's final text"]);
  expect(await reviewClarification(ctx, request)).toBe("User's final text");
  expect(ctx.ui.select.mock.calls[1][0]).toContain("Compare the databases");
  expect(ctx.ui.select.mock.calls[1][0]).not.toContain("Performance");
  expect(ctx.ui.select.mock.calls[2][0]).toContain("User's final text");
});

test("finish is available inside individual questions and no answer is implicitly chosen", async () => {
  const ctx = ui(["1. Which focus?", "Finish clarification and review prompt", "Approve and send"]);
  expect(await reviewClarification(ctx, request)).toBe(request.check.original_prompt);
  expect(ctx.ui.select.mock.calls[1][1]).toContain("Finish clarification and review prompt");
});

test("UI allows arbitrarily many questions and answers before review", async () => {
  const actions = Array.from({ length: 120 }, () => ["1. Which focus?", "2. Deployment"]).flat();
  const ctx = ui([...actions, "Finish clarification and review prompt", "Approve and send"]);
  expect(await reviewClarification(ctx, request)).toBe("Compare the databases\n\n- focus: Deployment");
  expect(ctx.ui.select).toHaveBeenCalledTimes(242);
});

test.each([undefined, "Cancel request"])("dismissal or cancellation (%s) during review never forwards", async action => {
  expect(await reviewClarification(ui(["Confirm recommended combination", action]), request)).toBeUndefined();
});

test("input entry point transforms only approved final text; private dialogs never enter session", async () => {
  const ctx = ui(["Confirm recommended combination", "Edit final prompt", "Approve and send"], ["Final approved prompt"]);
  const entries: any[] = [{ type: "message", message: { role: "user", content: "Performance or deployment" } }];
  ctx.sessionManager = { getBranch: () => entries };
  ctx.modelRegistry = { getAvailable: () => [{ provider: "p", id: "light" }],
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) };
  const handlers: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const pi: any = { on: (name: string, handler: any) => { handlers[name] = handler; },
    registerCommand: (name: string, command: any) => { commands[name] = command; },
    appendEntry: jest.fn(), sendMessage: jest.fn(), sendUserMessage: jest.fn() };
  const invoke = jest.fn<any>(async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({
    missing_options: request.check.missing_options, recommended_combination: request.check.recommended_combination,
  }) }] }));
  wasabi(pi, invoke);
  await commands["wasabi-model"].handler("p/light", ctx);
  const before = [...entries];
  const images: any[] = [];
  expect(await handlers.input({ source: "interactive", text: request.check.original_prompt, images }, ctx))
    .toEqual({ action: "transform", text: "Final approved prompt", images });
  expect(entries).toEqual(before);
  expect(pi.sendMessage).not.toHaveBeenCalled();
  expect(pi.sendUserMessage).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledTimes(1);
});

test("functional action entry point uses the same approval and single-forwarding guards", () => {
  const state = new WasabiClarification("Original");
  expect(applyClarificationActions([{ type: "finish" }, { type: "approve" },
    { type: "edit", text: "Current draft" }, { type: "forward" }], state)).toBeUndefined();
  expect(state.approved).toBe(false);
  expect(applyClarificationActions([{ type: "approve" }, { type: "forward" }], state)).toBe("Current draft");
  expect(applyClarificationActions([{ type: "approve" }, { type: "forward" }], state)).toBeUndefined();
  expect(applyClarificationActions([{ type: "finish" }, { type: "edit", text: "Standalone draft" },
    { type: "approve" }, { type: "forward" }])).toBe("Standalone draft");
});

test("early review reuses only applicable confirmed conversation decisions and leaves recommendations unconfirmed", async () => {
  const ctx = ui(["Finish clarification and review prompt", "Approve and send"]);
  const result = await reviewClarification(ctx, { check: { ...request.check, option_resolutions: [
    { id: "format", applies_to_request: true, confirmed: true, value: "Short summary",
      evidence: { message_index: 0, quote: "Performance" } },
    { id: "suggestion", applies_to_request: true, confirmed: false, value: "Unapproved suggestion",
      evidence: { message_index: 0, quote: "Performance" } },
    { id: "unrelated", applies_to_request: false, confirmed: true, value: "Unrelated decision",
      evidence: { message_index: 0, quote: "Performance" } },
  ] } });
  expect(result).toBe("Compare the databases\n\n- format: Short summary");
  expect(result).not.toContain("Performance");
  expect(result).not.toContain("Unapproved");
  expect(result).not.toContain("Unrelated");
});

test("review separates unresolved questions from the draft and excludes unapproved choices", async () => {
  const ctx = ui(["Finish clarification and review prompt", "Approve and send"]);
  expect(await reviewClarification(ctx, request)).toBe(request.check.original_prompt);
  const title = ctx.ui.select.mock.calls[1][0] as string;
  const [draft, unresolved] = title.split("Unresolved options (not included in the prompt):");
  expect(draft).not.toContain("Which focus?");
  expect(unresolved).toContain("Which focus?");
  expect(title).not.toContain("Performance");
});

test("early finish combines applicable decisions and explicit answers while leaving other options unresolved", async () => {
  const other = { ...request.check.missing_options[0], id: "format", question: "Which format?" };
  const ctx = ui(["1. Which focus?", "2. Deployment", "Finish clarification and review prompt", "Approve and send"]);
  const result = await reviewClarification(ctx, { check: { ...request.check,
    missing_options: [...request.check.missing_options, other],
    recommended_combination: [...request.check.recommended_combination, { option_id: "format", choice_id: "performance" }],
    option_resolutions: [{ id: "scope", applies_to_request: true, confirmed: true, value: "Existing project",
      evidence: { message_index: 0, quote: "Performance" } }],
  } });
  expect(result).toBe("Compare the databases\n\n- scope: Existing project\n- focus: Deployment");
  const unresolved = (ctx.ui.select.mock.calls[3][0] as string).split("Unresolved options (not included in the prompt):")[1];
  expect(unresolved).toContain("Which format?");
  expect(unresolved).not.toContain("Which focus?");
  expect(result).not.toContain("Performance");
});


test("model replies without resolutions still retain an explicit conversation language directive", async () => {
  const ctx = ui(["Finish clarification and review prompt", "Approve and send"]);
  const result = await reviewClarification(ctx, { check: { ...request.check,
    conversation_context: [{ role: "user", text: "Please answer in Korean." }],
  } });
  expect(result).toContain("answer in Korean");
  expect(result).not.toContain("Which focus?");
  expect(result).not.toContain("Performance");
});

test("additional explicit details are accumulated instead of replacing earlier details", async () => {
  const ctx = ui(["Add clarification", "Add clarification", "Finish clarification and review prompt", "Approve and send"],
    ["Include benchmarks", "Include deployment steps"]);
  const result = await reviewClarification(ctx, request);
  expect(result).toContain("Include benchmarks");
  expect(result).toContain("Include deployment steps");
  expect(result).not.toContain("Additional clarification");
});

test("review reconciles explicit answers with previously unconfirmed option resolutions", async () => {
  const ctx = ui(["1. Which focus?", "2. Deployment", "Finish clarification and review prompt", "Approve and send"]);
  const result = await reviewClarification(ctx, { check: { ...request.check,
    option_resolutions: ["focus", "format"].map(id => ({ id, applies_to_request: true,
      confirmed: false, value: "Unapproved suggestion",
      evidence: { message_index: 0, quote: "Performance" } })),
  } });
  expect(result).toBe("Compare the databases\n\n- focus: Deployment");
  const [draft, unresolved] = (ctx.ui.select.mock.calls[3][0] as string)
    .split("Unresolved options (not included in the prompt):");
  expect(draft).not.toContain("Unapproved suggestion");
  expect(unresolved).toContain("format");
  expect(unresolved).not.toContain("focus");
});

test.each(["TypeScript", "Rust", "Kotlin", "Elixir"])(
  "finish retains settled %s even when the model omits resolutions, and exposes unresolved choices", async language => {
    const ctx = ui(["Finish clarification and review prompt", "Approve and send"]);
    const result = await reviewClarification(ctx, { check: { ...request.check,
      original_prompt: "Implement retry handling",
      conversation_context: [{ role: "user", text: `Use ${language} for this task.` }],
      option_resolutions: [],
    } });
    expect(result).toContain("Implement retry handling");
    expect(result).toContain(language);
    expect(result).not.toContain("Performance");
    expect(result).not.toContain("Which focus?");
    const [draft, unresolved] = (ctx.ui.select.mock.calls[1][0] as string).split("Unresolved options (not included in the prompt):");
    expect(draft).toContain(language);
    expect(unresolved).toContain("Which focus?");
  });

test("model assessment of applicability takes precedence over synchronous evidence", async () => {
  const ctx = ui(["Finish clarification and review prompt", "Approve and send"]);
  const result = await reviewClarification(ctx, { check: { ...request.check,
    conversation_context: [{ role: "user", text: "Use Kotlin for the prototype." }],
    option_resolutions: [{ id: "language", applies_to_request: false, confirmed: true, value: "Kotlin",
      evidence: { message_index: 0, quote: "Use Kotlin for the prototype" } }],
  } });
  expect(result).toBe(request.check.original_prompt);
});

test.each(["Approve and send", "Cancel request", undefined])(
  "partially answered input stays private through repeated edits until review decision %s", async decision => {
    const format = { ...request.check.missing_options[0], id: "format", question: "Which format?" };
    let decide!: (action: string | undefined) => void;
    const ctx = ui([], ["First edited draft", "Current edited draft"]);
    ctx.ui.select.mockImplementation(async () => {
      throw new Error("Unexpected additional dialog");
    });
    for (const action of ["1. Which focus?", "2. Deployment", "Finish clarification and review prompt",
      "Edit final prompt", "Edit final prompt"]) ctx.ui.select.mockResolvedValueOnce(action);
    ctx.ui.select.mockImplementationOnce(() => new Promise(resolve => { decide = resolve; }));
    const entries = [{ type: "message", message: { role: "user", content: "Performance or deployment. Use Kotlin for this task." } }];
    ctx.sessionManager = { getBranch: () => entries };
    ctx.modelRegistry = { getAvailable: () => [{ provider: "p", id: "light" }],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) };
    const handlers: Record<string, any> = {};
    const commands: Record<string, any> = {};
    const pi: any = { on: (name: string, handler: any) => { handlers[name] = handler; },
      registerCommand: (name: string, command: any) => { commands[name] = command; },
      appendEntry: jest.fn(), sendMessage: jest.fn(), sendUserMessage: jest.fn() };
    const invoke = jest.fn<any>(async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({
      missing_options: [...request.check.missing_options, format],
      recommended_combination: [...request.check.recommended_combination, { option_id: "format", choice_id: "performance" }],
    }) }] }));
    wasabi(pi, invoke);
    await commands["wasabi-model"].handler("p/light", ctx);
    pi.appendEntry.mockClear();
    const before = JSON.stringify(entries);
    let returned = false;
    const images: any[] = [];
    const input = handlers.input({ source: "interactive", text: request.check.original_prompt, images }, ctx)
      .then((result: any) => { returned = true; return result; });
    // Wait for the final held review, without timers or allowing a model draft.
    for (let turn = 0; turn < 100 && !decide; turn++) await Promise.resolve();
    expect(decide).toBeDefined();
    expect(returned).toBe(false);
    const [draft, unresolved] = (ctx.ui.select.mock.calls[3][0] as string)
      .split("Unresolved options (not included in the prompt):");
    expect(draft).toContain(request.check.original_prompt);
    expect(draft).toContain("Kotlin");
    expect(draft).toContain("focus: Deployment");
    expect(draft).not.toContain("Performance");
    expect(unresolved).toContain("Which format?");
    expect(unresolved).not.toContain("Which focus?");
    expect(ctx.ui.editor.mock.calls[1][1]).toBe("First edited draft");
    expect(ctx.ui.select.mock.calls[5][0]).toContain("Current edited draft");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(entries)).toBe(before);
    expect(pi.appendEntry).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    decide(decision);
    expect(await input).toEqual(decision === "Approve and send"
      ? { action: "transform", text: "Current edited draft", images } : { action: "handled" });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(entries)).toBe(before);
    expect(pi.appendEntry).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("wasabi", undefined);
  });
