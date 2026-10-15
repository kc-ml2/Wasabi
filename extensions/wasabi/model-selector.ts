import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, getKeybindings, Input, SelectList, truncateToWidth } from "@earendil-works/pi-tui";
import type { SelectItem, TUI } from "@earendil-works/pi-tui";

type ModelChoice = { provider: string; id: string; name?: string };

/** Uses Pi's input, fuzzy search and scrolling list without changing its main model. */
export class WasabiModelSelector {
  private readonly input = new Input();
  private readonly models: ModelChoice[];
  private readonly tui: Pick<TUI, "terminal" | "requestRender">;
  private readonly theme: Pick<Theme, "fg">;
  private readonly done: (key: string | undefined) => void;
  private list!: SelectList;
  private items: SelectItem[] = [];
  private maxVisible = 0;

  constructor(models: ModelChoice[], current: string | undefined,
    tui: Pick<TUI, "terminal" | "requestRender">, theme: Pick<Theme, "fg">,
    done: (key: string | undefined) => void) {
    this.models = [...models].sort((a, b) =>
      Number(`${b.provider}/${b.id}` === current) - Number(`${a.provider}/${a.id}` === current)
      || a.provider.localeCompare(b.provider));
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.filter();
  }

  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }

  private filter(): void {
    // Match /model's provider, ID and display-name search using Pi's fuzzy matcher.
    const models = fuzzyFilter(this.models, this.input.getValue(), model =>
      `${model.provider} ${model.provider}/${model.id} ${model.provider} ${model.id} ${model.name ?? ""}`);
    this.items = models.map(model => ({ value: `${model.provider}/${model.id}`,
      label: `${model.id} [${model.provider}]` }));
    this.buildList();
  }

  private buildList(selected?: string): void {
    this.maxVisible = Math.max(1, Math.min(10, this.tui.terminal.rows - 7));
    this.list = new SelectList(this.items, this.maxVisible, {
      selectedPrefix: text => this.theme.fg("accent", text),
      selectedText: text => this.theme.fg("accent", text),
      description: text => this.theme.fg("muted", text),
      scrollInfo: text => this.theme.fg("muted", text),
      noMatch: () => this.theme.fg("muted", "  No matching models"),
    });
    this.list.onSelect = item => this.done(item.value);
    this.list.onCancel = () => this.done(undefined);
    if (selected) this.list.setSelectedIndex(this.items.findIndex(item => item.value === selected));
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if ((["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const)
      .some(action => kb.matches(data, action))) {
      this.list.handleInput(data);
    } else {
      this.input.handleInput(data);
      this.filter();
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const visible = Math.max(1, Math.min(10, this.tui.terminal.rows - 7));
    if (visible !== this.maxVisible) this.buildList(this.list.getSelectedItem()?.value);
    return [
      truncateToWidth(this.theme.fg("accent", "Wasabi · Choose a lightweight checking model"), width),
      "", ...this.input.render(width), "", ...this.list.render(width), "",
      truncateToWidth(this.theme.fg("dim", "Type to search · ↑/↓ to scroll · Enter to select · Esc to cancel"), width),
    ];
  }

  invalidate(): void { this.input.invalidate(); this.list.invalidate(); }
}

export async function selectWasabiModel(ctx: ExtensionContext, current?: string): Promise<string | undefined> {
  const models = ctx.modelRegistry.getAvailable();
  let opened = false;
  if (ctx.ui.custom) {
    const choice = await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
      opened = true;
      return new WasabiModelSelector(models, current, tui, theme, done);
    });
    if (opened) return choice;
  }
  // RPC clients support standard dialogs but cannot render custom TUI components.
  return ctx.ui.select("Wasabi · Choose a lightweight model for checking and clarification",
    models.map(model => `${model.provider}/${model.id}`));
}
