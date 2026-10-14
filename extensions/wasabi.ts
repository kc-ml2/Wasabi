import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WasabiModel } from "./wasabi/model.ts";
import { WasabiAutomation } from "./wasabi/automation.ts";

export default function wasabi(pi: ExtensionAPI) {
  const model = new WasabiModel(pi);
  const automation = new WasabiAutomation(pi, model);
  pi.on("session_start", async (_event, ctx) => { automation.restore(ctx); });
  pi.on("input", async (event, ctx) => {
    if (event.source !== "extension") await automation.shouldCheck(ctx);
    return { action: "continue" };
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
