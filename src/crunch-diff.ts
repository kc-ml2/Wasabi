import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { Box, Text, type Component } from "@earendil-works/pi-tui";
import {
  createEditToolDefinition, keyHint, renderDiff,
  type EditToolDetails, type EditToolInput, type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export type DiffExcerpt = { excerpt: string; omitted: number };
type Highlight = DiffExcerpt & { argsKey: string; fullDiff: string };

/** Only indices are model-generated. Every displayed code row comes from diff. */
export function selectDiffExcerpt(diff: string, ranges: unknown): DiffExcerpt | undefined {
  if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > 3) return;
  const lines = diff.split("\n");
  const selected = new Set<number>();
  for (const range of ranges) {
    if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) ||
        range.start < 1 || range.end < range.start || range.end > lines.length ||
        range.end - range.start + 1 > 12) return;
    for (let i = range.start - 1; i < range.end; i++) selected.add(i);
  }
  if (selected.size > 12 || selected.size >= lines.length) return;
  const indices = [...selected].sort((a, b) => a - b);
  if (!indices.some(i => /^[+-]/.test(lines[i]))) return;
  const excerpt: string[] = [];
  let previous = -1;
  for (const i of indices) {
    if (i > previous + 1) excerpt.push("...");
    excerpt.push(lines[i]);
    previous = i;
  }
  if (previous < lines.length - 1) excerpt.push("...");
  return { excerpt: excerpt.join("\n"), omitted: lines.length - selected.size };
}

// Public built-in matching/diff algorithm, with an intentionally no-op writer.
// Unlike an actual edit, preview generation never changes the target file.
export async function previewEdit(input: EditToolInput, ctx: ExtensionContext): Promise<string> {
  const preview = createEditToolDefinition(ctx.cwd, {
    operations: {
      access: path => access(path, constants.R_OK | constants.W_OK),
      readFile: path => readFile(path),
      writeFile: async () => {},
    },
  });
  const result = await preview.execute("crunch-preview", input, ctx.signal, undefined, ctx);
  if (!result.details) throw new Error("Edit preview did not return a diff");
  return result.details.diff;
}

/** No tool override at load time or while initially OFF. Never replace an
 * existing non-builtin edit (SSH, sandbox, or another extension). Pi has no
 * unregisterTool API: once installed, OFF uses the unchanged builtin execution
 * and renderer until /reload reconstructs the extension runtime. */
export function createDiffHighlights(pi: ExtensionAPI, isEnabled: () => boolean) {
  const highlights = new Map<string, Highlight>();
  const invalidators = new Map<string, () => void>();
  let installed = false;
  let warned = false;

  return {
    clear() {
      highlights.clear();
      invalidators.clear();
    },
    set(id: string, args: unknown, fullDiff: string, selection: DiffExcerpt) {
      highlights.set(id, { ...selection, fullDiff, argsKey: JSON.stringify(args) });
      if (highlights.size > 100) highlights.delete(highlights.keys().next().value!);
      invalidators.get(id)?.();
    },
    ensureInstalled(ctx: ExtensionContext): boolean {
      if (!isEnabled() || ctx.mode !== "tui") return false;
      if (installed) return true;
      const edit = pi.getAllTools().find(tool => tool.name === "edit");
      if (!edit || edit.sourceInfo.source !== "builtin") {
        if (!warned) {
          ctx.ui.notify("Crunch will keep the existing edit tool. AI-selected diffs require the built-in local edit tool.", "warning");
          warned = true;
        }
        return false;
      }

      const baseEdit = createEditToolDefinition(ctx.cwd);
      pi.registerTool<typeof baseEdit.parameters, EditToolDetails | undefined>({
        ...baseEdit,
        // Preserve schema, prompt metadata, matching, mutation queue and results.
        execute: (id, args, signal, onUpdate, toolCtx) =>
          createEditToolDefinition(toolCtx.cwd).execute(id, args, signal, onUpdate, toolCtx),
        renderCall(args, theme, context) {
          const base: Component = baseEdit.renderCall!(args, theme, {
            ...context, lastComponent: context.state.crunchBaseCall,
          });
          context.state.crunchBaseCall = base;
          invalidators.set(context.toolCallId, context.invalidate);
          if (invalidators.size > 100) invalidators.delete(invalidators.keys().next().value!);
          return {
            render(width) {
              const highlight = highlights.get(context.toolCallId);
              if (!isEnabled() || context.expanded || context.isError || !highlight ||
                  highlight.argsKey !== JSON.stringify(args)) return base.render(width);
              const bg = context.state.crunchCompleted ? "toolSuccessBg" : "toolPendingBg";
              const box = new Box(1, 1, text => theme.bg(bg, text));
              box.addChild(new Text(`${theme.fg("toolTitle", theme.bold("edit"))} ${String(args.path ?? "").replace(/\s+/g, " ")}`, 0, 0));
              box.addChild(new Text(theme.fg("muted", "Key diff · AI-selected"), 0, 0));
              box.addChild(new Text(renderDiff(highlight.excerpt), 0, 0));
              box.addChild(new Text(theme.fg("dim", `${highlight.omitted} diff row(s) omitted · ${keyHint("app.tools.expand", "for full diff")}`), 0, 0));
              return box.render(width);
            },
            invalidate: () => base.invalidate(),
          };
        },
        renderResult(result, options, theme, context) {
          context.state.crunchCompleted = !options.isPartial && !context.isError;
          const highlight = highlights.get(context.toolCallId);
          // Never conceal an error or an execution diff different from the preview.
          if (highlight && (context.isError || result.details?.diff !== highlight.fullDiff)) {
            highlights.delete(context.toolCallId);
          }
          return baseEdit.renderResult!(result, options, theme, context);
        },
      });
      installed = true;
      return true;
    },
  };
}
