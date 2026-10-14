import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CALL_TIMEOUT_MS = 30_000;
let nextRequest = 0;

/** A request survives retries; only the current call generation may settle it. */
export class WasabiRequest {
  readonly request_id = `wasabi-${++nextRequest}`;
  call_generation = 0;
  forwarded = false;
  cancelled = false;
  failure: Error | undefined;
  private controller: AbortController | undefined;

  constructor(readonly original_prompt: string) {}

  invalidate(): void {
    this.call_generation++;
    this.controller?.abort();
    this.controller = undefined;
  }

  cancel(): void {
    this.cancelled = true;
    this.failure = undefined;
    this.invalidate();
  }

  /** Caller supplies only a user-approved draft or an explicit send-original choice. */
  forward(prompt: string): string | undefined {
    if (this.cancelled || this.forwarded) return undefined;
    this.forwarded = true;
    this.failure = undefined;
    this.invalidate();
    return prompt;
  }

  async call<T>(ctx: ExtensionContext, work: (signal: AbortSignal) => Promise<T>,
    timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
    this.invalidate();
    if (this.cancelled || this.forwarded) throw new Error("Wasabi request is closed.");
    this.failure = undefined;
    const generation = this.call_generation;
    const controller = new AbortController();
    this.controller = controller;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let wait: ReturnType<typeof setTimeout> | undefined;
    const dialog = new AbortController();
    const interrupted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("Wasabi waiting stopped.")), { once: true });
      timeout = setTimeout(() => controller.abort(), timeoutMs);
      // Fast calls need no waiting dialog. AbortSignal closes the dialog when the call settles.
      if (ctx.hasUI) wait = setTimeout(() => {
        void ctx.ui.select("Wasabi · Checking request (Esc to stop waiting)", ["Stop waiting"],
          { signal: dialog.signal }).then(() => {
          if (!dialog.signal.aborted) controller.abort();
        }, () => { if (!dialog.signal.aborted) controller.abort(); });
      }, 200);
    });
    try {
      const value = await Promise.race([work(controller.signal), interrupted]);
      if (generation !== this.call_generation || this.cancelled || this.forwarded || controller.signal.aborted) {
        throw new Error("Wasabi call invalidated.");
      }
      return value;
    } catch (error) {
      if (generation === this.call_generation && !this.cancelled && !this.forwarded) {
        this.failure = error instanceof Error ? error : new Error(String(error));
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      clearTimeout(wait);
      dialog.abort();
      if (generation === this.call_generation) this.invalidate();
    }
  }
}
