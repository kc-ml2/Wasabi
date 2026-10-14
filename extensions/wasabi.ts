import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WasabiModel } from "./wasabi/model.ts";

export default function wasabi(pi: ExtensionAPI) {
  const model = new WasabiModel(pi);
  pi.on("session_start", async (_event, ctx) => { model.restore(ctx); });
  pi.registerCommand("wasabi-model", {
    description: "Choose Wasabi's dedicated lightweight checking and clarification model",
    handler: async (args, ctx) => { await model.select(ctx, args); },
  });
  pi.registerCommand("hello", {
    description: "Verify that the Wasabi extension is loaded",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Hello! Wasabi is running.", "info");
    },
  });
}
