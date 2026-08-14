const PROVIDER_IDS = new Set(["centinels", "openai"]);

/** Used by nested extension calls, which do not pass through Pi's provider hooks. */
export function liteLLMSessionHeaders(provider: string | undefined, sessionId: string): Record<string, string> {
  return provider && PROVIDER_IDS.has(provider)
    ? { "x-litellm-session-id": sessionId }
    : {};
}
