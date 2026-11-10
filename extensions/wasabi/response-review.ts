import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Raw model text is reference material only; never a draft or session message. */
export async function reviewFailedResponse(
  ctx: ExtensionContext, original: string, raw: string | undefined, failure: string,
  active: () => boolean,
): Promise<string | undefined> {
  const reference = `Wasabi response (unvalidated; may be incorrect; not included in the prompt):\n${raw || "No model response was received."}`;
  let draft = original;
  while (active()) {
    const edited = await ctx.ui.editor(
      `Wasabi · Review response and edit prompt\n${failure}\n\n${reference}\n\nOnly your edited prompt will be sent after approval.`, draft);
    if (!active() || edited === undefined) return undefined;
    draft = edited;
    if (!draft.trim()) {
      ctx.ui.notify("The final prompt must not be empty.", "warning");
      continue;
    }
    const action = await ctx.ui.select(`Wasabi · Review final prompt (manual recovery)\n\n${draft}`,
      ["Approve and send", "Edit final prompt", "Cancel request"]);
    if (!active()) return undefined;
    if (action === "Approve and send") return draft;
    if (action !== "Edit final prompt") return undefined;
  }
  return undefined;
}
