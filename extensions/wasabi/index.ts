import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WasabiModel } from "./model.ts";
import { WasabiAutomation } from "./automation.ts";
import { conversationSource, WasabiChecker } from "./checker.ts";
import { complete } from "@earendil-works/pi-ai/compat";
import { WasabiRequest, WasabiReviewRequested } from "./recovery.ts";
import { reviewClarification } from "./clarification.ts";

export default function wasabi(pi: ExtensionAPI, invoke: typeof complete = complete) {
  const model = new WasabiModel(pi, invoke);
  const automation = new WasabiAutomation(pi, model);
  const checker = new WasabiChecker(model);
  let active: WasabiRequest | undefined;
  pi.on("session_start", async (_event, ctx) => { active?.cancel(); automation.restore(ctx); });
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || !await automation.shouldCheck(ctx)) return { action: "continue" };
    active?.cancel();
    const state = new WasabiRequest(event.text);
    active = state;
    try {
      if (ctx.hasUI) ctx.ui.setStatus("wasabi", "Wasabi · Private clarification · Main session paused");
      while (!state.cancelled && !state.forwarded) {
        try {
          const request = await state.call(ctx, signal => checker.check(ctx, state.original_prompt, signal));
          if (!request.check.missing_options.length) {
            if (state.forward(state.original_prompt) !== undefined) return { action: "continue" };
            break;
          }
          state.invalidate();
          state.interaction_state = "clarifying";
          const finalPrompt = await reviewClarification(ctx, request);
          if (finalPrompt !== undefined) {
            const claimed = state.forward(finalPrompt);
            if (claimed !== undefined) return { action: "transform", text: claimed, images: event.images };
          }
          state.cancel();
        } catch (error) {
          if (state.cancelled || state.forwarded) break;
          if (error instanceof WasabiReviewRequested) {
            const finalPrompt = await reviewClarification(ctx, { check: {
              original_prompt: state.original_prompt,
              conversation_context: conversationSource.read(ctx), information_sources: [conversationSource.name],
              missing_options: [], recommended_combination: [],
            } }, true);
            if (finalPrompt !== undefined) {
              const claimed = state.forward(finalPrompt);
              if (claimed !== undefined) return { action: "transform", text: claimed, images: event.images };
            }
            state.cancel();
            break;
          }
          state.interaction_state = "recovering";
          if (!ctx.hasUI) {
            ctx.ui.notify(`Wasabi · Original request not sent; preserved: ${state.original_prompt}\n${String(error)}`, "error");
            state.cancel();
            break;
          }
          const action = await ctx.ui.select(
            `Wasabi · Recovery\n${state.failure?.message ?? String(error)}\n\nOriginal request:\n${state.original_prompt}`,
            ["Retry", "Send original unchanged", "Cancel request"],
          );
          if (state.cancelled || state.forwarded) break;
          state.invalidate();
          if (action === "Retry") continue;
          if (action === "Send original unchanged") {
            const claimed = state.forward(state.original_prompt);
            if (claimed !== undefined) return { action: "transform", text: claimed, images: event.images };
          }
          state.cancel();
        }
      }
      return { action: "handled" };
    } finally {
      if (ctx.hasUI && active === state) ctx.ui.setStatus("wasabi", undefined);
    }
  });
  pi.registerCommand("wasabi", {
    description: "Turn Wasabi automatic checking on or off",
    handler: async (args, ctx) => {
      const mode = args.trim();
      if (mode !== "on" && mode !== "off") {
        ctx.ui.notify("Usage: /wasabi on | /wasabi off", "info");
        return;
      }
      await automation.setEnabled(ctx, mode === "on");
    },
  });
  pi.registerCommand("wasabi-model", {
    description: "Choose Wasabi's dedicated lightweight checking and clarification model",
    handler: async (args, ctx) => { await automation.selectModel(ctx, args); },
  });
  pi.registerCommand("hello", {
    description: "Verify that the Wasabi extension is loaded",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Hello! Wasabi is running.", "info");
    },
  });
}
