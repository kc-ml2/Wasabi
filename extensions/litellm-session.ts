import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "centinels";
const SESSION_HEADER = "x-litellm-session-id";

export default function litellmSession(pi: ExtensionAPI) {
  pi.on("before_provider_headers", (event, ctx) => {
    // All requests in the same Pi session receive the same ID. /new and /fork
    // create a new ID, while /resume restores the selected session's ID.
    if (ctx.model?.provider !== PROVIDER_ID) return;

    event.headers[SESSION_HEADER] = ctx.sessionManager.getSessionId();
  });

  pi.registerCommand("litellm-session", {
    description: "Show the Pi session ID sent to LiteLLM",
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      ctx.ui.notify(`LiteLLM session: ${sessionId}`, "info");
    },
  });
}
