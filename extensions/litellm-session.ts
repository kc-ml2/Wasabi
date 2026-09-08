import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { liteLLMSessionHeaders } from "../src/litellm-session.ts";

export default function litellmSession(pi: ExtensionAPI) {
  pi.on("before_provider_headers", (event, ctx) => {
    // All requests in the same Pi session receive the same ID. /new and /fork
    // create a new ID, while /resume restores the selected session's ID.
    Object.assign(event.headers, liteLLMSessionHeaders(ctx.model?.provider, ctx.sessionManager.getSessionId()));
  });

  pi.registerCommand("litellm-session", {
    description: "Show the Pi session ID sent to LiteLLM",
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      ctx.ui.notify(`LiteLLM session: ${sessionId}`, "info");
    },
  });
}
