# Wasabi

Wasabi is a collection of [Pi](https://github.com/earendil-works/pi) workflow
extensions. It currently provides a load check, LiteLLM session tracking,
session cropping, and opt-in prompt auditing.

## Requirements

- Node.js 22.19.0 or newer
- npm
- Pi 0.84.2 or newer from `@earendil-works/pi-coding-agent`

## Install and verify

```bash
npm ci
npm run check
```

Install all Wasabi extensions from GitHub:

```bash
pi install git:github.com/kc-ml2/Wasabi
```

Use `pi config` to enable or disable individual extensions. For local
development, load the package root directly:

```bash
pi --no-extensions -e .
```

## Load check

Run `/hello` to verify that Wasabi loaded. It displays
`Hello! Wasabi is running.` without calling a model or changing the session.

## LiteLLM session tracking

Wasabi adds the current Pi session ID as `x-litellm-session-id` to requests sent
through the configured LiteLLM providers. Run `/litellm-session` to display the
ID.

## Crop a session branch

`/crop` creates and switches to a new session containing the selected **user
turn** and every entry after it on the active branch. It is the suffix
counterpart to `/clone`; the original session remains unchanged.

```text
/crop
/crop 3
/crop a1b2c3d4
```

Cropping is restricted to user-turn boundaries so a new session cannot start
between an assistant tool call and its result. Model and thinking-level changes,
extension messages, and branch summaries after the selected turn are copied.
Labels, session names, and compaction checkpoints are not copied.

## Prompt audit

Prompt audit is **off by default**. Enable advisory review for the active
session branch with:

```text
/audit on
```

Before an eligible prompt reaches the target agent, Wasabi asks a separately
invoked model to identify material ambiguity, contradictions, missing targets,
consequential typos, and meaning-changing English errors. Clear prompts pass
silently. A risky prompt opens a short review where you can apply or edit a
suggestion, send the original in advisory mode, or cancel.

The audit call has no tools and is not added to the target conversation. It uses
the active model by default. During local development, select another configured
model with:

```bash
pi --no-extensions -e . --audit-model openai/gpt-5.2
```

### Commands

- `/audit on` — enable advisory review
- `/audit off` — disable auditing
- `/audit strict` — require edits for high-impact findings
- `/audit dev` — advisory review plus raw, opt-in dataset capture
- `/audit experiment` — compare the next prompt and its revision on sibling branches
- `/audit bypass-next` — skip the next eligible prompt
- `/audit status` or `/audit-status` — show effective state
- `/audit-english next` — polish only the next eligible prompt
- `/audit-english semantic` — correct only meaning-changing English errors
- `/audit-english always` — opt in to routine English polishing
- `/audit-english off` — audit meaning without English correction

Advisory/strict enablement and English settings are stored as branch-local Pi
custom entries and restored after reload, resume, and tree navigation. Raw dev
capture and one-shot options are intentionally not persisted.

### Eligibility and context

Mid-stream steering and extension-injected input bypass auditing. Queued
follow-ups are audited. Skill and prompt-template invocations are skipped because
Pi's `input` event runs before their expansion.

The `frontier-v1` context profile can provide the prompt, submission metadata,
recent active-branch exchanges, the latest compaction summary, a bounded system
prompt digest, active tool descriptions, target-model identity, working
directory, runtime mode, and local policy metadata. The planner enforces a
12,000-token request ceiling, respects project trust, and never scans project
files.

### Privacy

Normal audit records contain a SHA-256 prompt hash, finding scores, model usage,
latency, the decision, and a content-free context manifest. They do not contain
raw prompt or context text.

`/audit dev` additionally stores raw prompts, auditor responses, reports, and
selected or edited text in the current Pi session. This data may contain secrets.
Enabling the mode displays a warning; use `/audit on`, `/audit strict`, or
`/audit off` to stop raw capture. Attached image payloads are never stored.

`/audit experiment` enables raw capture for one eligible prompt and runs the
target agent twice: the non-selected alternative first, then the selected one on
a sibling branch. The selected branch remains active. Conversation context is
isolated, but filesystem, network, and other tool side effects are shared. Use
experiments only for read-only work or provide external isolation.

### Failure behavior

Authentication failures, model errors, timeouts, malformed output after one
repair attempt, and context-planning failures warn and send the original prompt
by default. Headless modes also fail open.

### Implementation map

- `extensions/prompt-audit.ts` — package entry point
- `src/prompt-audit/index.ts` — Pi events and commands
- `src/prompt-audit/context/` — bounded context planning and materialization
- `src/prompt-audit/engines/` — model adapter and report validation
- `src/prompt-audit/host-policy.ts` — deterministic intervention thresholds
- `src/prompt-audit/storage.ts` — privacy-preserving and opt-in raw records
- `test/*.test.mjs` — policy, privacy, timeout, and integration coverage
