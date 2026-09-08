const PROVIDER_IDS = new Set(["centinels", "openai"]);

/** Also used by nested Crunch calls, which do not pass through Pi's hooks. */
export function liteLLMSessionHeaders(provider: string | undefined, sessionId: string): Record<string, string> {
  return provider && PROVIDER_IDS.has(provider)
    ? { "x-litellm-session-id": sessionId }
    : {};
}
