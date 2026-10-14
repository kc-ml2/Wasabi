import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CheckedRequest } from "./checker.ts";

export type ClarificationAction =
  | { type: "answer"; question: string; answer: string }
  | { type: "finish" }
  | { type: "edit"; text: string }
  | { type: "approve" }
  | { type: "forward" }
  | { type: "cancel" };

/** Private per-input state. Only forward()'s claimed prompt crosses the input boundary. */
export class WasabiClarification {
  readonly clarification_history: { question: string; answer: string }[] = [];
  final_prompt: string | undefined;
  approved = false;
  forwarded = false;
  interaction_state: "clarifying" | "reviewing" | "forwarding" | "cancelled" = "clarifying";

  constructor(readonly original_prompt: string) {}

  /** Apply ordered user actions; return a prompt only for the first approved forward. */
  apply(actions: ClarificationAction[]): string | undefined {
    return applyClarificationActions(actions, this);
  }
}

/** Execute a batch against one request; retain the state across batches for single forwarding. */
export function applyClarificationActions(
  actions: ClarificationAction[],
  state: WasabiClarification = new WasabiClarification(""),
): string | undefined {
  let forwardedPrompt: string | undefined;
  for (const action of actions) {
    if (state.forwarded || state.interaction_state === "cancelled") break;
    switch (action.type) {
      case "answer":
        if (state.interaction_state !== "clarifying" || !action.answer.trim()) break;
        state.clarification_history.push({ question: action.question, answer: action.answer });
        break;
      case "finish":
        if (state.interaction_state !== "clarifying") break;
        // Only explicit answers are included, never unconfirmed recommendations.
        {
          const decisions = Array.from(new Map(state.clarification_history.map(item =>
            [item.question, item.answer])).values());
          state.final_prompt = state.original_prompt + (decisions.length
            ? `\n\n${decisions.map(answer => `- ${answer}`).join("\n")}` : "");
        }
        state.approved = false;
        state.interaction_state = "reviewing";
        break;
      case "edit":
        if (state.interaction_state !== "reviewing") break;
        state.final_prompt = action.text;
        state.approved = false;
        break;
      case "approve":
        if (state.interaction_state === "reviewing" && state.final_prompt?.trim()) state.approved = true;
        break;
      case "forward":
        if (state.interaction_state !== "reviewing" || !state.approved || !state.final_prompt?.trim()) break;
        state.forwarded = true;
        state.interaction_state = "forwarding";
        forwardedPrompt = state.final_prompt;
        break;
      case "cancel":
        state.approved = false;
        state.interaction_state = "cancelled";
        break;
    }
  }
  return forwardedPrompt;
}

/** Local UI only: questions and answers never become Pi session messages. */
export async function reviewClarification(ctx: ExtensionContext, request: CheckedRequest): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;
  const state = new WasabiClarification(request.check.original_prompt);
  const options = request.check.missing_options;
  const finish = "Finish clarification and review prompt";
  const cancel = "Cancel request";
  const confirm = "Confirm recommended combination";
  const details = options.map(option => {
    const recommended = request.check.recommended_combination.find(item => item.option_id === option.id);
    return `${option.question}\nConversation: ${option.evidence.quote}\n${option.available_choices.map(choice =>
      `- ${choice.label}${choice.id === recommended?.choice_id ? " (recommended)" : ""}`).join("\n")}`;
  }).join("\n\n");
  // No turn counter or question limit: questions may be revisited and details added freely.
  while (state.interaction_state === "clarifying") {
    const questions = options.map((option, index) => `${index + 1}. ${option.question}`);
    const action = await ctx.ui.select(`Wasabi · Clarification\n${details}`, [
      confirm, ...questions, "Add clarification", finish, cancel,
    ]);
    if (!action || action === cancel) { state.apply([{ type: "cancel" }]); return undefined; }
    if (action === finish) { state.apply([{ type: "finish" }]); break; }
    if (action === confirm) {
      for (const recommendation of request.check.recommended_combination) {
        const option = options.find(item => item.id === recommendation.option_id)!;
        const choice = option.available_choices.find(item => item.id === recommendation.choice_id)!;
        state.apply([{ type: "answer", question: option.question, answer: choice.label }]);
      }
      state.apply([{ type: "finish" }]);
      break;
    }
    const option = options[questions.indexOf(action)];
    if (option) {
      const choices = option.available_choices.map((choice, index) => `${index + 1}. ${choice.label}`);
      const answer = await ctx.ui.select(`Wasabi · ${option.question}`, [...choices, "Write an answer", finish, cancel]);
      if (answer === cancel) { state.apply([{ type: "cancel" }]); return undefined; }
      if (answer === finish) { state.apply([{ type: "finish" }]); break; }
      const choice = option.available_choices[choices.indexOf(answer ?? "")];
      const text = choice?.label ?? (answer === "Write an answer"
        ? await ctx.ui.editor(`Wasabi · ${option.question} (close to return to controls)`, "") : undefined);
      if (text?.trim()) state.apply([{ type: "answer", question: option.question, answer: text }]);
    } else if (action === "Add clarification") {
      const answer = await ctx.ui.editor("Wasabi · Additional clarification (close to return to controls)", "");
      if (answer?.trim()) state.apply([{ type: "answer", question: "Additional clarification", answer }]);
    }
  }
  while (state.interaction_state === "reviewing") {
    const action = await ctx.ui.select(`Wasabi · Review final prompt\n\n${state.final_prompt}`, [
      "Approve and send", "Edit final prompt", cancel,
    ]);
    if (action === "Approve and send") return state.apply([{ type: "approve" }, { type: "forward" }]);
    if (action === "Edit final prompt") {
      const edited = await ctx.ui.editor("Wasabi · Edit final prompt", state.final_prompt!);
      if (edited !== undefined) state.apply([{ type: "edit", text: edited }]);
    } else { state.apply([{ type: "cancel" }]); return undefined; }
  }
  return undefined;
}
