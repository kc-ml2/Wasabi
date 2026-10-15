import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WasabiIndicator } from "./indicator.ts";
import { selectWasabiModel } from "./model-selector.ts";

export const MODEL_ENTRY_TYPE = "wasabi-model";

/** One explicitly selected model shared by checking and clarification calls. */
export class WasabiModel {
  private key: string | undefined;
  private selection: Promise<boolean> | undefined;
  private selectionGeneration = 0;
  private leaveSelection: (() => void) | undefined;

  private readonly pi: Pick<ExtensionAPI, "appendEntry">;
  private readonly invoke: typeof complete;
  private readonly indicator: WasabiIndicator;

  constructor(
    pi: Pick<ExtensionAPI, "appendEntry">,
    invoke: typeof complete = complete,
    indicator = new WasabiIndicator(),
  ) {
    this.pi = pi;
    this.invoke = invoke;
    this.indicator = indicator;
  }

  get selectedKey(): string | undefined { return this.key; }

  restore(ctx: ExtensionContext): void {
    this.leaveSelection?.();
    this.leaveSelection = undefined;
    this.selectionGeneration++;
    this.selection = undefined;
    this.key = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== MODEL_ENTRY_TYPE) continue;
      const data = entry.data as { key?: unknown } | undefined;
      if (typeof data?.key === "string") this.key = data.key;
    }
  }

  async select(ctx: ExtensionContext, requested = ""): Promise<boolean> {
    // Ordinary inputs share the pending chooser instead of opening competing dialogs.
    if (!requested.trim() && this.selection) return this.selection;
    this.leaveSelection?.();
    this.leaveSelection = undefined;
    const generation = ++this.selectionGeneration;
    const pending = this.choose(ctx, requested, generation);
    this.selection = pending;
    try { return await pending; }
    finally { if (this.selection === pending) this.selection = undefined; }
  }

  private async choose(ctx: ExtensionContext, requested: string, generation: number): Promise<boolean> {
    const keys = ctx.modelRegistry.getAvailable().map(model => `${model.provider}/${model.id}`);
    if (!keys.length) {
      ctx.ui.notify("No authenticated models are available for Wasabi.", "error");
      return false;
    }
    const explicit = requested.trim();
    if (!explicit && !ctx.hasUI) return false;
    let choice: string | undefined = explicit;
    if (!explicit) {
      const leave = this.indicator.enter(ctx, "Wasabi · Selecting dedicated model · Main session paused");
      this.leaveSelection = leave;
      try {
        choice = await selectWasabiModel(ctx, this.key);
      } finally {
        leave();
        if (this.leaveSelection === leave) this.leaveSelection = undefined;
      }
    }
    if (generation !== this.selectionGeneration) return false;
    if (!choice) return false;
    if (!keys.includes(choice)) {
      ctx.ui.notify(`Wasabi model is not available: ${choice}`, "error");
      return false;
    }
    this.key = choice;
    this.pi.appendEntry(MODEL_ENTRY_TYPE, { key: choice });
    ctx.ui.notify(`Wasabi model: ${choice}`, "info");
    return true;
  }

  async complete(
    ctx: ExtensionContext,
    conversation: Parameters<typeof complete>[1],
    options: Parameters<typeof complete>[2] = {},
  ): ReturnType<typeof complete> {
    if (!this.key && !await this.select(ctx)) {
      throw new Error("Select a dedicated Wasabi model before checking or clarification.");
    }
    const model = ctx.modelRegistry.getAvailable().find(candidate =>
      `${candidate.provider}/${candidate.id}` === this.key,
    );
    if (!model) throw new Error(`Selected Wasabi model is unavailable: ${this.key}`);
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error("Authentication unavailable for the selected Wasabi model.");
    if (options?.signal?.aborted) throw new Error("Wasabi call invalidated.");
    return this.invoke(model, conversation, {
      ...options,
      apiKey: auth.apiKey,
      headers: { ...options?.headers, ...auth.headers },
      env: auth.env,
    });
  }
}
