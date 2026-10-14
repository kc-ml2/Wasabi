import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WasabiModel } from "./model.ts";

export const AUTOMATION_ENTRY_TYPE = "wasabi-automation";

/** Session configuration, separate from the main model and conversation. */
export class WasabiAutomation {
  private preference: boolean | undefined;
  private activationGeneration = 0;
  activation_pending = false;

  constructor(
    private readonly pi: Pick<ExtensionAPI, "appendEntry">,
    private readonly model: WasabiModel,
  ) {}

  get enabled(): boolean {
    return this.preference === true && this.model.selectedKey !== undefined;
  }

  restore(ctx: ExtensionContext): void {
    this.activationGeneration++;
    this.activation_pending = false;
    this.model.restore(ctx);
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
    if (!await this.model.select(ctx, requested)) return false;
    if (this.preference === undefined) this.save(true);
    return true;
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
