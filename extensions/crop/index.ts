import type {
  ExtensionAPI,
  SessionEntry,
  SessionManager,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

/**
 * A crop always begins at a user message. This keeps an assistant tool call and
 * each of its tool results together in the new session.
 */
type CropCandidate = SessionMessageEntry & {
  message: Extract<SessionMessageEntry["message"], { role: "user" }>;
};

function userText(entry: CropCandidate): string {
  const { content } = entry.message;
  const text = typeof content === "string"
    ? content
    : content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(" ");

  return text.replace(/\s+/g, " ").trim() || "(no text)";
}

function cropOptions(candidates: CropCandidate[]): string[] {
  return candidates.map((entry, index) => {
    const preview = userText(entry);
    const shortened = preview.length > 100 ? `${preview.slice(0, 97)}...` : preview;
    return `${index + 1}. ${entry.id}  ${shortened}`;
  });
}

/** Copy entries using SessionManager's public append API, deliberately omitting
 * labels, names, and compactions. Labels/names are source-session metadata;
 * compaction entries can refer to entry IDs outside the crop. The raw entries
 * after the selected user turn are retained, so omitting a compaction does not
 * discard any cropped conversation content. */
function copyEntry(destination: SessionManager, entry: SessionEntry): void {
  switch (entry.type) {
    case "message": {
      const { message } = entry;
      // SessionManager stores summaries as top-level entries. Retain this guard
      // for older or externally-written sessions that stored one as a message.
      if (message.role !== "branchSummary" && message.role !== "compactionSummary") {
        destination.appendMessage(message);
      }
      return;
    }
    case "model_change":
      destination.appendModelChange(entry.provider, entry.modelId);
      return;
    case "thinking_level_change":
      destination.appendThinkingLevelChange(entry.thinkingLevel);
      return;
    case "custom":
      destination.appendCustomEntry(entry.customType, entry.data);
      return;
    case "custom_message":
      destination.appendCustomMessageEntry(
        entry.customType,
        entry.content,
        entry.display,
        entry.details,
      );
      return;
    case "branch_summary":
      // A branch summary participates in context, unlike labels and names.
      destination.branchWithSummary(destination.getLeafId(), entry.summary, entry.details, entry.fromHook, entry.usage);
      return;
    case "compaction":
    case "label":
    case "session_info":
      return;
  }
}

export default function cropExtension(pi: ExtensionAPI) {
  pi.registerCommand("crop", {
    description: "Create a new session from a selected user turn through the current leaf",
    handler: async (args, ctx) => {
      // Commands may be invoked while a turn is running. Copy only a settled,
      // complete branch so tool-call/result pairs cannot be split.
      await ctx.waitForIdle();

      const branch = ctx.sessionManager.getBranch();
      const candidates = branch.filter(
        (entry): entry is CropCandidate => entry.type === "message" && entry.message.role === "user",
      );

      if (candidates.length === 0) {
        ctx.ui.notify("Crop needs a user message on the current branch.", "warning");
        return;
      }

      const requested = args.trim();
      let selected: CropCandidate | undefined;

      if (requested) {
        selected = candidates.find((entry) => entry.id === requested)
          ?? (/^\d+$/.test(requested) ? candidates[Number.parseInt(requested, 10) - 1] : undefined);
        if (!selected) {
          ctx.ui.notify("Use a user-turn number or entry ID from /crop.", "warning");
          return;
        }
      } else if (!ctx.hasUI) {
        ctx.ui.notify("Run /crop <user-turn number or entry ID> when no picker is available.", "warning");
        return;
      } else {
        const options = cropOptions(candidates);
        const choice = await ctx.ui.select("Crop from user turn", options);
        if (!choice) return;
        selected = candidates[options.indexOf(choice)];
      }

      if (!selected) return;

      const firstEntry = branch.indexOf(selected);
      const entriesToCopy = branch.slice(firstEntry);
      const parentSession = ctx.sessionManager.getSessionFile();
      const result = await ctx.newSession({
        parentSession,
        setup: async (destination) => {
          for (const entry of entriesToCopy) copyEntry(destination, entry);
        },
        withSession: async (newCtx) => {
          newCtx.ui.notify(
            `Created a cropped session from ${entriesToCopy.length} source entries.`,
            "info",
          );
        },
      });

      if (result.cancelled) {
        ctx.ui.notify("Crop cancelled.", "info");
      }
    },
  });
}
