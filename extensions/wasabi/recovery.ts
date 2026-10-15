import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CALL_TIMEOUT_MS = 30_000;
let nextRequest = 0;

export class WasabiReviewRequested extends Error {
  constructor() { super("Wasabi clarification finished."); }
}

type InteractionState = "idle" | "checking" | "clarifying" | "reviewing" | "recovering" | "forwarding" | "cancelled";
type FailureKind = "error" | "timeout" | "interrupted";
export interface ActiveCall {
  request_id: string;
  call_generation: number;
  kind: "checking" | "clarifying";
  deadline: number;
  controller: AbortController;
}

/** A request survives retries; only the current call generation may settle it. */
export class WasabiRequest {
  readonly request_id = `wasabi-${++nextRequest}`;
  call_generation = 0;
  forwarded = false;
  cancelled = false;
  interaction_state: InteractionState = "idle";
  active_call: ActiveCall | null = null;
  failure: (Error & { kind: FailureKind; request_id: string; call_generation: number }) | undefined;

  readonly original_prompt: string;

  constructor(original_prompt: string) {
    this.original_prompt = original_prompt;
  }

  invalidate(): void {
    const obsolete = this.active_call;
    this.active_call = null;
    this.call_generation++;
    // Revoke authority before requesting cancellation; never await the provider.
    obsolete?.controller.abort();
  }

  finish(): void {
    if (this.cancelled || this.forwarded) return;
    this.invalidate();
    this.failure = undefined;
    this.interaction_state = "reviewing";
  }

  cancel(): void {
    this.cancelled = true;
    this.interaction_state = "cancelled";
    this.failure = undefined;
    this.invalidate();
  }

  /** Caller supplies only a user-approved draft or an explicit send-original choice. */
  forward(prompt: string): string | undefined {
    if (this.cancelled || this.forwarded) return undefined;
    this.forwarded = true;
    this.interaction_state = "forwarding";
    this.failure = undefined;
    this.invalidate();
    return prompt;
  }

  async call<T>(ctx: ExtensionContext, work: (signal: AbortSignal) => Promise<T>,
    timeoutMs = CALL_TIMEOUT_MS, kind: ActiveCall["kind"] = "checking"): Promise<T> {
    this.invalidate();
    if (this.cancelled || this.forwarded) throw new Error("Wasabi request is closed.");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Wasabi timeout must be finite and positive.");
    this.failure = undefined;
    this.interaction_state = kind;
    const call: ActiveCall = { request_id: this.request_id, call_generation: this.call_generation,
      kind, deadline: Date.now() + timeoutMs, controller: new AbortController() };
    this.active_call = call;
    const current = () => this.active_call === call && call.request_id === this.request_id
      && call.call_generation === this.call_generation && this.interaction_state === kind
      && !this.cancelled && !this.forwarded;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let wait: ReturnType<typeof setTimeout> | undefined;
    const dialog = new AbortController();
    let failureKind: FailureKind = "error";
    let finishing = false;
    const interrupted = new Promise<never>((_, reject) => {
      call.controller.signal.addEventListener("abort", () => reject(finishing
        ? new WasabiReviewRequested() : new Error("Wasabi waiting stopped.")), { once: true });
      const stop = (reason: "timeout" | "interrupted" | "finish") => {
        if (!current()) return;
        finishing = reason === "finish";
        if (reason === "finish") this.finish();
        else {
          failureKind = reason;
          this.failure = Object.assign(new Error(reason === "timeout"
            ? "Wasabi call timed out; waiting stopped." : "Wasabi waiting stopped by user."), {
            kind: failureKind, request_id: call.request_id, call_generation: call.call_generation,
          });
          this.interaction_state = "recovering";
          this.invalidate();
        }
      };
      timeout = setTimeout(() => stop("timeout"), timeoutMs);
      if (ctx.hasUI) wait = setTimeout(() => {
        void ctx.ui.select(`Wasabi · ${kind === "checking" ? "Checking request" : "Clarifying request"} (Esc to stop waiting)`,
          ["Stop waiting", "Finish clarification and review prompt"], { signal: dialog.signal }).then(action => {
          if (!dialog.signal.aborted) stop(action === "Finish clarification and review prompt" ? "finish" : "interrupted");
        }, () => { if (!dialog.signal.aborted) stop("interrupted"); });
      }, 200);
    });
    try {
      // Capture synchronous provider failures as well, so the cancellation race is always observed.
      const run = async () => work(call.controller.signal);
      const value = await Promise.race([run(), interrupted]);
      if (!current() || call.controller.signal.aborted) throw new Error("Wasabi call invalidated.");
      // A busy event loop may let a provider's microtask run before the timeout
      // callback. The recorded deadline, not timer callback order, bounds authority.
      if (Date.now() >= call.deadline) {
        failureKind = "timeout";
        throw new Error("Wasabi call timed out; waiting stopped.");
      }
      this.invalidate();
      this.interaction_state = "clarifying";
      return value;
    } catch (error) {
      // An obsolete call must never overwrite a newer call, review, cancellation, or failure.
      if (current()) {
        this.invalidate();
        this.interaction_state = "recovering";
        this.failure = Object.assign(error instanceof Error ? error : new Error(String(error)), {
          kind: failureKind, request_id: call.request_id, call_generation: call.call_generation,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      clearTimeout(wait);
      dialog.abort();
    }
  }
}
