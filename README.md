# Wasabi

Wasabi is a [Pi](https://github.com/earendil-works/pi) extension package with session cropping, LiteLLM session tracking, and Crunch file-change review. Each extension can be enabled independently with `pi config`.

## Requirements

- Node.js 22.19.0 or newer
- npm
- Pi 0.84.4 or newer, installed from `@earendil-works/pi-coding-agent`

Development dependencies pin Pi's core packages to 0.84.4, the tested baseline.
Runtime core packages are peers supplied by Pi, not separately bundled.

## Install

From a fresh checkout, install the locked dependencies:

```bash
npm ci
```

Use `npm install` instead when intentionally updating dependencies and the lockfile.

## Check and test

```bash
npm run check
```

`check` runs static TypeScript checking and the Jest test suite. Run only the
behavioral tests with `npm test`. Tests use mocked model responses and Pi contexts;
no API credentials or network calls are needed. Crunch diff tests exercise the
actual built-in edit execution and renderers against temporary fixture files.
Crop tests verify the copied suffix without creating real session files.

## Install in Pi

Install all Wasabi extensions from GitHub:

```bash
pi install git:github.com/kc-ml2/Wasabi
```

After installation, use `pi config` to enable or disable individual extensions.

## Run

Load the package root so Pi validates the extension declaration in `package.json`:

```bash
pi --offline --no-session --no-extensions -e .
```

At the Pi prompt, run:

```text
/hello
```

Pi should display:

```text
Hello! Wasabi is running.
```

This command does not call a model or persist session state.

## Crop a session branch

`/crop` creates and switches to a new session containing the selected **user
turn** and every entry after it on the current active branch. It is the suffix
counterpart to `/clone`, so earlier turns are not copied into the new session.
The original session remains unchanged.

```text
/crop
```

Choose the user turn where the new session should start. The picker displays a
number, entry ID, and preview for each user turn on the active branch. You can
also use that number or full entry ID directly, which is useful without an
interactive picker:

```text
/crop 3
/crop a1b2c3d4
```

Cropping is intentionally restricted to user-turn boundaries. This prevents a
new session from starting between an assistant tool call and its tool result.
Model changes, thinking-level changes, extension messages, and branch summaries
after the selected turn are copied. Labels, session names, and compaction
checkpoints are not copied: they are source-session metadata, and a compaction
checkpoint can point to entries that were intentionally removed by the crop.

## Crunch focus mode

Crunch is a **human approval step before Pi executes an `edit` or `write`
tool call**. Its main purpose is to explain what a proposed file change means
and let the user approve it or provide feedback before it is applied.

```text
Pi proposes an edit/write call
  -> Crunch explains the proposed change
  -> Approve: execute this call
  -> Reject: block this call
  -> Feedback: reconsider this change or stop the batch and revise the plan
```

AI-selected diff rows are a secondary review aid, not the main purpose. Crunch
is **not a rollback/checkpoint tool** and does not split source code into new
execution batches. A "batch" means the tool calls Pi already proposed together
in one assistant message. One `edit` call may contain several replacement
blocks; approving/rejecting it applies to the whole call, not selected blocks.

It is **OFF by default**. Run these commands before starting a task:

```text
/crunch on
/crunch off
/crunch-model
/crunch-model current
/crunch-model <provider>/<model-id>
```

`/crunch` without an argument only shows usage; it does not toggle the mode.
`/crunch-model` opens the summary-model picker. Mode and model choices are saved
on the active session branch and restored on reload/resume.

### Review and feedback

- A single-call batch offers `Approve`, `Reject`, and
  `Reject this change with feedback`.
- Multi-call batches additionally offer `Stop all with feedback`. The dialog
  lists sibling file changes and their review/completion states, plus the count
  of other tools. An approved call is not necessarily executed yet.
- `Reject` rejects only this call, without aborting the agent. Per-call feedback
  in a multi-call batch also lets siblings proceed.
- `Stop all with feedback` requests an abort **even if the feedback editor is
  cancelled or left empty**. The single-call feedback choice uses the same stop
  flow. Empty feedback stops without an automatic restart.
- With feedback, Crunch waits for the agent to settle, then requests a short
  review of the previous approach, feedback interpretation, and revised plan
  before work resumes. Files that finish while stopping are included in the
  verification instructions.

Stopping is cooperative; already-running tools may finish. Completed changes
are **not rolled back**, and the review is not a sandbox: shell commands and
other mutation tools are not subject to Crunch's approval gate. Headless modes
without UI do not prompt or enforce the gate.

### AI-selected edit diffs

In TUI mode, a collapsed local `edit` shows up to 12 real diff rows selected by
the summary model, labeled `Key diff · AI-selected`, with the omitted-row count.
The model returns row indices, never replacement code. Use **Ctrl+O** (or your
configured expand-tools binding) to see the complete diff, including while the
approval picker is open. `write` retains its existing display.

Malformed selections, oversized diffs, unavailable models, summary errors, and
execution diffs that differ from the preview fall back to the built-in display.
Summary requests time out after 30 seconds; failure does not bypass approval.
Excerpts are a bounded, in-memory UI cache, not edits to the tool result or
session history. Reloading restores the normal full-diff display for old calls.

### Compatibility and model requests

- Initially OFF, Crunch registers no `edit` override. When enabled in TUI mode,
  it installs its renderer only if `edit` is the built-in local tool. Existing
  SSH, sandbox, SDK, or extension-provided edits are left intact; their calls can
  still be reviewed, but AI-selected diffs are disabled.
- Pi does not expose `unregisterTool`. After the renderer has been installed,
  `/crunch off` restores built-in rendering and execution behavior, but the
  wrapper remains registered until `/reload`. Disable and reload Crunch before
  switching to a different edit-tool extension. Pi may report that `edit` was
  overridden when the renderer is activated.
- RPC supports summaries and approval dialogs, but no custom diff rendering.
- Menus and notifications are English; generated summaries are Korean.
- Each reviewed change can make an additional model request, with extra latency
  and provider cost. File paths, proposed code, and possibly nearby diff context
  are sent to the selected summary provider. Pick an appropriate provider for
  sensitive source code. The normal Pi footer still shows the **conversation**
  model, not the separate summary model; Crunch displays `Summarizing…`.
- Nested summaries do not pass through Pi's provider hooks. Crunch explicitly
  applies Wasabi's shared `x-litellm-session-id` policy to `centinels` and `openai`
  summary providers, while preserving other authentication headers. PR #1 added
  the conversation hook, and PR #2 added `openai` support. Crunch reuses that
  policy for its separate summary calls; the existing conversation behavior is
  unchanged. The shared helper is in `src/litellm-session.ts`. The header groups
  provider requests in LiteLLM; it does not add summaries to Pi's conversation
  history or account for their usage in Pi's session totals.

### Local testing

To load only this package for local testing:

```bash
pi --offline --no-session --no-extensions -e .
```

Run `/crunch on`, then review a small `edit` call. A configured model is needed
for AI summaries; without one, the approval gate uses a plain fallback summary.
