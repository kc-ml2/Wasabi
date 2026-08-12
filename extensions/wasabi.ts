import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function wasabi(pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Verify that the Wasabi extension is loaded",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Hello! Wasabi is running.", "info");
    },
  });
}
