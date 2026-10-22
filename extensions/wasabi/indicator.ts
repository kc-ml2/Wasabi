import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Shared ownership prevents one private interaction from hiding another. */
export class WasabiIndicator {
  private readonly owners = new Map<object, { ctx: ExtensionContext; text: string }>();

  enter(ctx: ExtensionContext, text: string): () => void {
    if (!ctx.hasUI) return () => {};
    const owner = {};
    this.owners.set(owner, { ctx, text });
    ctx.ui.setStatus("wasabi", text);
    return () => {
      const current = [...this.owners.keys()].at(-1);
      if (!this.owners.delete(owner) || current !== owner) return;
      const previous = [...this.owners.values()].at(-1);
      (previous?.ctx ?? ctx).ui.setStatus("wasabi", previous?.text);
    };
  }

  reset(): void {
    const current = [...this.owners.values()].at(-1);
    this.owners.clear();
    current?.ctx.ui.setStatus("wasabi", undefined);
  }
}
