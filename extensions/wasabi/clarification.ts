import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { conversationDecisions, type CheckedRequest } from "./checker.ts";

export type ClarificationAction =
  | { type: "answer"; question: string; answer: string; option_id?: string }
  | { type: "finish" }
  | { type: "edit"; text: string }
  | { type: "approve" }
  | { type: "forward" }
  | { type: "cancel" };

/** Private per-input state. Only forward()'s claimed prompt crosses the input boundary. */
export class WasabiClarification {
  readonly clarification_history: { question: string; answer: string; option_id?: string }[] = [];
  private draft: string | undefined;
  prompt_revision = 0;
  approved_revision: number | null = null;
  get final_prompt(): string | undefined { return this.draft; }
  set final_prompt(text: string | undefined) {
    this.draft = text;
    this.prompt_revision++;
    this.approved_revision = null;
  }
  get approved(): boolean {
    return !!this.final_prompt?.trim() && this.approved_revision === this.prompt_revision;
  }
  forwarded = false;
  interaction_state: "clarifying" | "reviewing" | "forwarding" | "cancelled" = "clarifying";

  readonly original_prompt: string;
  readonly applicable_decisions: string[];

  constructor(original_prompt: string, applicable_decisions: string[] = []) {
    this.original_prompt = original_prompt;
    this.applicable_decisions = applicable_decisions;
  }

  /** Preview uses exactly the same explicit decisions as the final draft. */
  get prompt_preview(): string {
    if (this.final_prompt !== undefined) return this.final_prompt;
    const decisions = [...this.applicable_decisions, ...new Map(this.clarification_history.map(item =>
      [item.question, item.option_id ? `${item.option_id}: ${item.answer}` : item.answer])).values()];
    return this.original_prompt + (decisions.length
      ? `\n\n${decisions.map(answer => `- ${answer}`).join("\n")}` : "");
  }

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
        state.clarification_history.push({ question: action.question, answer: action.answer, ...(action.option_id ? { option_id: action.option_id } : {}) });
        break;
      case "finish":
        if (state.interaction_state !== "clarifying") break;
        // Only explicit answers are included, never unconfirmed recommendations.
        state.final_prompt = state.prompt_preview;
        state.interaction_state = "reviewing";
        break;
      case "edit":
        if (state.interaction_state !== "reviewing") break;
        state.final_prompt = action.text;
        break;
      case "approve":
        if (state.interaction_state === "reviewing" && state.final_prompt?.trim()) {
          state.approved_revision = state.prompt_revision;
        }
        break;
      case "forward":
        if (state.interaction_state !== "reviewing" || !state.approved || !state.final_prompt?.trim()) break;
        state.forwarded = true;
        state.interaction_state = "forwarding";
        forwardedPrompt = state.final_prompt;
        break;
      case "cancel":
        state.approved_revision = null;
        state.interaction_state = "cancelled";
        break;
    }
  }
  return forwardedPrompt;
}

/** Local UI only: questions and answers never become Pi session messages. */
export async function reviewClarification(ctx: ExtensionContext, request: CheckedRequest, startReview = false): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;
  const assessed = request.check.option_resolutions ?? [];
  const snapshot = conversationDecisions(request.check.conversation_context, request.check.original_prompt);
  // An empty/partial model result must not erase already explicit user decisions.
  // Prefer model applicability assessments when they address the same evidence.
  const decisions = [...assessed, ...snapshot.filter(item => !assessed.some(other =>
    other.id === item.id || (other.evidence.message_index === item.evidence.message_index
      && (other.evidence.quote.includes(item.evidence.quote) || item.evidence.quote.includes(other.evidence.quote)))))];
  const state = new WasabiClarification(request.check.original_prompt,
    decisions.filter(item => item.applies_to_request && item.confirmed)
      .map(item => `${item.id}: ${item.value}`));
  if (startReview) state.apply([{ type: "finish" }]);
  const options = request.check.missing_options;
  const finish = "Finish clarification and review prompt";
  const cancel = "Cancel request";
  const confirm = "Confirm recommended combination";
  const preview = () => `Current prompt draft (not sent; final approval required):\n${state.prompt_preview}`;
  const currentAnswer = (question: string) => new Map(state.clarification_history.map(item =>
    [item.question, item.answer])).get(question);
  // No turn counter or question limit: questions may be revisited and details added freely.
  while (state.interaction_state === "clarifying") {
    const details = options.map(option => {
      const answer = currentAnswer(option.question);
      if (answer !== undefined) return `${option.question}\nConfirmed answer: ${answer}`;
      const recommended = request.check.recommended_combination.find(item => item.option_id === option.id);
      return `${option.question}\nNot answered\nConversation: ${option.evidence.quote}\n${option.available_choices.map(choice =>
        `- ${choice.label}${choice.id === recommended?.choice_id ? " (recommended)" : ""}`).join("\n")}`;
    }).join("\n\n");
    const questions = options.map((option, index) => `${index + 1}. ${option.question}`);
    const action = await ctx.ui.select(`Wasabi · Clarification\n${details}\n\n${preview()}`, [
      confirm, ...questions, "Add clarification", finish, cancel,
    ]);
    if (!action || action === cancel) { state.apply([{ type: "cancel" }]); return undefined; }
    if (action === finish) { state.apply([{ type: "finish" }]); break; }
    if (action === confirm) {
      for (const recommendation of request.check.recommended_combination) {
        const option = options.find(item => item.id === recommendation.option_id)!;
        const choice = option.available_choices.find(item => item.id === recommendation.choice_id)!;
        state.apply([{ type: "answer", question: option.question, answer: choice.label, option_id: option.id }]);
      }
      state.apply([{ type: "finish" }]);
      break;
    }
    const option = options[questions.indexOf(action)];
    if (option) {
      const previous = currentAnswer(option.question);
      const choices = option.available_choices.map((choice, index) => `${index + 1}. ${choice.label}`);
      const answer = await ctx.ui.select(`Wasabi · ${option.question}\nCurrent answer: ${previous ?? "Not answered"}\n\n${preview()}`,
        [...choices, "Write an answer", finish, cancel]);
      if (answer === cancel) { state.apply([{ type: "cancel" }]); return undefined; }
      if (answer === finish) { state.apply([{ type: "finish" }]); break; }
      const choice = option.available_choices[choices.indexOf(answer ?? "")];
      const text = choice?.label ?? (answer === "Write an answer"
        ? await ctx.ui.editor(`Wasabi · ${option.question} (close to return to controls)\n\n${preview()}`, previous ?? "") : undefined);
      if (text?.trim()) state.apply([{ type: "answer", question: option.question, answer: text, option_id: option.id }]);
    } else if (action === "Add clarification") {
      const answer = await ctx.ui.editor(`Wasabi · Additional clarification (close to return to controls)\n\n${preview()}`, "");
      if (answer?.trim()) state.apply([{ type: "answer", question: `Additional clarification ${state.clarification_history.length}`, answer }]);
    }
  }
  while (state.interaction_state === "reviewing") {
    const answered = new Set(state.clarification_history.map(item => item.question));
    const resolvedIds = new Set(state.clarification_history.map(item => item.option_id));
    const unresolved = [
      ...options.filter(option => !answered.has(option.question)).map(option => option.question),
      ...(request.check.option_resolutions ?? []).filter(item => item.applies_to_request && !item.confirmed
        && !resolvedIds.has(item.id) && !options.some(option => option.id === item.id))
        .map(item => item.id),
    ];
    const unresolvedDetails = startReview
      ? "Checking ended before options were assessed. Review applicable prior decisions and any remaining choices."
      : unresolved.length ? unresolved.map(question => `- ${question}`).join("\n") : "None identified.";
    const action = await ctx.ui.select(`Wasabi · Review final prompt\n\n${state.final_prompt}\n\nUnresolved options (not included in the prompt):\n${unresolvedDetails}`, [
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
