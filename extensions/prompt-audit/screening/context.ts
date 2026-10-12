import type { Config, ContextInput, Envelope } from "./types.ts";

/** Character budgets are conservative bounds, not token counts. Never truncate the subject. */
export function buildEnvelope(input: ContextInput, config: Config): Envelope {
  if (input.prompt.length > config.context.maxPromptChars) throw new Error("Prompt exceeds the configured audit limit; it was not truncated");
  let remaining = config.context.maxContextChars;
  const truncated = new Set<string>();
  const omitted = new Set<string>(["projectFiles", "toolResults", "imagePixels", "taskPhase", "nextAuthorizedStep"]);
  const take = (value: string | undefined, label: string, limit = remaining): string | undefined => {
    if (!value) return undefined;
    const count = Math.min(remaining, limit);
    const part = value.slice(0, count);
    remaining -= part.length;
    if (part.length < value.length) truncated.add(label);
    return part || undefined;
  };
  const recentMessages: Envelope["recentMessages"] = [];
  // Reserve half the context budget for the newest conversation before manifests or
  // conventions can crowd it out. Keep room for a summary and capability evidence.
  let conversationBudget = Math.floor(config.context.maxContextChars / 2);
  if (config.context.includeConversation && config.context.recentMessages > 0) {
    const eligible = (input.recentMessages ?? []).filter(m => m.role === "user" || m.role === "assistant");
    if (eligible.length > config.context.recentMessages) truncated.add("olderConversation");
    for (const message of eligible.slice(-config.context.recentMessages).reverse()) {
      const text = take(message.text, "recentMessages", Math.min(2400, conversationBudget));
      conversationBudget -= text?.length ?? 0;
      if (text) recentMessages.unshift({ role: message.role, text });
    }
  } else omitted.add("recentMessages");
  const summary = config.context.includeConversation ? take(input.summary, "summary", 3000) : undefined;
  if (!config.context.includeConversation) omitted.add("summary");
  const approvedConventions = config.approvedConventions.map(x => take(x, "approvedConventions", 2000)).filter((x): x is string => !!x);
  const tools = (input.tools ?? []).slice(0, 40).map(t => ({ name: take(t.name, "tools", 100) ?? "", description: take(t.description, "tools", 160) ?? "" })).filter(t => t.name);
  if ((input.tools?.length ?? 0) > 40) truncated.add("tools");
  const systemPrompt = config.context.includeSystemPrompt ? take(input.systemPrompt, "systemPrompt", 2400) : undefined;
  if (!config.context.includeSystemPrompt) omitted.add("systemPrompt");
  const cwd = config.context.includeCwd ? take(input.cwd, "cwd", 500) : undefined;
  if (!config.context.includeCwd) omitted.add("cwd");
  const model = take(input.model, "model", 200);
  const imageCount = Math.max(0, Math.floor(input.imageCount ?? 0));
  return {
    profile: "jev-screen-v1", prompt: input.prompt, recentMessages, summary, systemPrompt, tools, model, cwd, approvedConventions,
    runtime: { source: input.source ?? "interactive", streamingBehavior: input.streamingBehavior, imageCount },
    coverage: { truncated: [...truncated], omitted: [...omitted], contextChars: config.context.maxContextChars - remaining, promptChars: input.prompt.length, imagesInspected: false },
    provenance: { prompt: "current-user-input", recentMessages: "active-session-branch-untrusted-text", summary: "active-compaction-summary-untrusted-text", tools: "pi-active-tool-manifest", approvedConventions: "user-global-configuration", systemPrompt: "pi-system-prompt" },
  };
}
