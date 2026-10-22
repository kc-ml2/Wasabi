import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WasabiModel } from "./model.ts";

export const AUTOMATION_ENTRY_TYPE = "wasabi-automation";

/** Session configuration, separate from the main model and conversation. */
export class WasabiAutomation {
  private preference: boolean | undefined;
  private activationGeneration = 0;
  activation_pending = false;
  initial_setup_completed = false;

  private readonly pi: Pick<ExtensionAPI, "appendEntry">;
  private readonly model: WasabiModel;

  constructor(pi: Pick<ExtensionAPI, "appendEntry">, model: WasabiModel) {
    this.pi = pi;
    this.model = model;
  }

  get enabled(): boolean {
    return this.preference === true && this.model.selectedKey !== undefined;
  }

  /** Includes first-use setup, but excludes an explicit off preference. */
  get checkingRequested(): boolean { return this.preference !== false; }

  restore(ctx: ExtensionContext): void {
    this.activationGeneration++;
    this.activation_pending = false;
    this.model.restore(ctx);
    this.initial_setup_completed = this.model.selectedKey !== undefined;
    this.preference = this.model.selectedKey ? true : undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== AUTOMATION_ENTRY_TYPE) continue;
      const data = entry.data as { enabled?: unknown } | undefined;
      if (typeof data?.enabled === "boolean") this.preference = data.enabled;
    }
  }

  private save(enabled: boolean): void {
    this.preference = enabled;
    this.pi.appendEntry(AUTOMATION_ENTRY_TYPE, { enabled });
  }

  async selectModel(ctx: ExtensionContext, requested = ""): Promise<boolean> {
    const generation = this.activationGeneration;
    // Direct first-use selection also represents an activation request. An
    // explicit off preference must survive both first selection and reselection.
    if (!this.model.selectedKey && this.preference !== false) this.activation_pending = true;
    try {
      if (!await this.model.select(ctx, requested)) return false;
      this.initial_setup_completed = true;
      if (generation === this.activationGeneration && this.preference === undefined) this.save(true);
      return true;
    } finally {
      if (generation === this.activationGeneration) this.activation_pending = false;
    }
  }

  /** First ordinary input initializes checking only after explicit selection. */
  async shouldCheck(ctx: ExtensionContext): Promise<boolean> {
    if (this.preference === false) return false;
    if (!this.model.selectedKey) {
      const generation = this.activationGeneration;
      this.activation_pending = true;
      try {
        if (!await this.selectModel(ctx) || generation !== this.activationGeneration) return false;
      } finally {
        if (generation === this.activationGeneration) this.activation_pending = false;
      }
    }
    if (this.preference === undefined) this.save(true);
    return this.enabled;
  }

  async setEnabled(ctx: ExtensionContext, enabled: boolean): Promise<boolean> {
    const generation = ++this.activationGeneration;
    this.activation_pending = enabled && !this.model.selectedKey;
    try {
      if (this.activation_pending && !await this.selectModel(ctx)) return false;
      if (generation !== this.activationGeneration) return false;
    } finally {
      if (generation === this.activationGeneration) this.activation_pending = false;
    }
    this.save(enabled);
    ctx.ui.notify(`Wasabi automatic checking: ${enabled ? "on" : "off"}`, "info");
    return true;
  }
}
