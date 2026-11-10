# Wasabi dedicated model

## Model-call audit log

Every actual dedicated-model invocation automatically appends `wasabi-model-call`
custom entries to Pi's session JSONL (not the RPC stdout event log). Session
persistence must be enabled, and benchmark runners must retain the session file.
These entries are excluded from main-model conversation context.

- `phase: "start"`: schema `version: 1`, Pi `sessionId`, unique `callId`, provider, model and timestamp.
- `phase: "end"`: same identity, timestamp, `durationMs`, status
  (`success`, `error`, `aborted`), and the complete SDK `response`, including
  content, usage, stop reason and provider error fields when supplied. Thrown
  failures instead record an `error` message.

Count **start entries**, not UI answers or both phases. Each retry is a new call.
Selection/authentication failures before invocation are not counted. This counts
SDK invocations, not transport-level retries inside a provider. Success means the
provider returned normally, not that the checker accepted its output: malformed
checker JSON is retained in full. A start without an end means an unknown outcome
(e.g. process termination or session replacement), not a successful response.
Late results after session replacement are not appended to the new Pi session,
but are retained in the original session's optional dedicated log.

```sh
# Actual Wasabi invocation count across the retained session file
jq -s '[.[] | select(.type == "custom" and .customType == "wasabi-model-call"
  and .data.phase == "start")] | length' session.jsonl

# Outputs and failures, correlated by callId
jq 'select(.type == "custom" and .customType == "wasabi-model-call"
  and .data.phase == "end") | .data' session.jsonl
```

Whole-file counts include abandoned branches; filter by the active branch if
that is the desired metric. Existing sessions cannot recover outputs from calls
made before this feature was loaded. Reload/restart with the updated extension
before collecting new runs. No API keys, request headers, environment, or input
prompts are deliberately logged, but **outputs and provider error messages may
contain sensitive data**; treat session files as private benchmark artifacts.
Logs are untruncated and increase session size. Logging failures warn without
retrying the model call. This feature does not count main-agent or simulator calls.

### Optional per-session files

Set `WASABI_LOG_DIR` before starting Pi to also append standalone JSONL records:

```sh
WASABI_LOG_DIR=runs/aes38-first10/wasabi pi ...
```

Relative directories resolve against the calling session's `ctx.cwd`. Each file
is named `<sessionId>.wasabi.jsonl` (the ID is URL-encoded for safe filenames).
The directory is created on the first write. New directories/files request
permissions 0700/0600; permissions on existing paths are not changed.
Unset or blank `WASABI_LOG_DIR` leaves file logging disabled.

Each line is the same data object stored in the Pi custom entry, without the
Pi `type`/`customType`/`data` wrapper. Both sinks share `sessionId` and `callId`;
do not double-count when combining them. The session ID, destination and call ID
are captured before invocation, so late successes and failures remain in the
original file even after switching sessions or changing the environment variable.
Independent sessions write different files; do not run multiple processes writing
the same session ID. Writes are synchronous append operations, not a transactional
or fsync-backed audit store. A write failure warns without stopping the other
sink or retrying the provider call. Dedicated files also work when Pi session
persistence is disabled.

```sh
# Count actual invocations across dedicated session files
jq -s '[.[] | select(.phase == "start")] | length' runs/aes38-first10/wasabi/*.jsonl
# Inspect each response with session and call identity
jq 'select(.phase == "end")' runs/aes38-first10/wasabi/*.jsonl
```

Benchmark runners should retain these files and record `taskId -> sessionId`
mappings in their results (allow multiple sessions per task). Wasabi does not
infer task IDs or modify the benchmark harness. Resuming a session appends to its
existing file; use a different log directory to separate benchmark runs.

## Model selection

Use `/wasabi-model` to choose a lightweight model from Pi's authenticated models,
or `/wasabi-model provider/model-id` to select one explicitly. The user decides
which model is lightweight; no model IDs or performance thresholds are imposed.
The interactive chooser shows at most ten models (fewer in a short terminal).
Type to fuzzy-search provider, model ID, or display name, use Up/Down to scroll,
Enter to select, and Esc to cancel, as in Pi's `/model` chooser. RPC clients use
their standard selection dialog.

The first ordinary input asks for this selection and enables automatic checking
after a successful choice. Cancelling selection leaves checking disabled. Use
`/wasabi off` to disable automatic checking and `/wasabi on` to enable it again.
Turning it on requires a dedicated model; cancelling that choice does not enable
checking. Choosing another model after `/wasabi off` preserves the off setting.
The toggle is stored as a `wasabi-automation` custom session configuration entry
and restored with the dedicated model when opening or switching sessions.
The first `/wasabi-model` selection also enables checking unless `/wasabi off`
was explicitly chosen. `enabled` stays false until a model is selected;
`activation_pending` separately records a first-use or `/wasabi on` activation
waiting for selection. `initial_setup_completed` records successful first setup
and is restored from the session's dedicated model selection. Reselecting a
model after setup preserves the existing toggle, including an explicit off
chosen before the first model selection.

While first-use model selection is pending, inputs wait without authenticating or
calling a model. Concurrent first-use inputs share the chooser. Wasabi identifies
this selection in the status area. Turning checking off while selection is pending
preserves the off setting even if the choice completes later; use `/wasabi on` to
reactivate. A choice from a previous session cannot configure the current session.

The model client prompts for selection before its first checking or clarification
call. Dismissing selection prevents the call. It never falls back to the main
session model, including when the selected model becomes unavailable or loses
authentication. Both kinds of call use the same dedicated client and Pi's existing
authentication. Changing the main session model does not alter this selection.

Selection is stored in a `wasabi-model` custom session entry and restored when
opening or switching sessions. This entry is configuration, not a conversation
message. The model module supplies model selection and invocation only; the
clarification workflow is separate.

## Conversation-based request checking

When checking is enabled, every ordinary interactive or RPC input is checked by
the dedicated model against user and assistant text in the current session branch.
Extension-originated inputs bypass checking to avoid checking forwarded prompts
again. No local files are read, no tools are supplied, and tool results, thinking,
tool calls, and configuration entries are excluded. `InformationSource` provides
the boundary for future sources; v1 registers only `conversationSource`.

The checker asks about required options that remain undecided even when the
intent can be inferred. It reuses applicable decisions from the conversation when
the current input omits them; current explicit decisions override older ones.
Unrelated prior decisions and assistant suggestions do not establish user choices.
Grounded `option_resolutions` record applicability, confirmation, value, and an
exact evidence quote. Confirmed applicable resolutions are included in review
without asking again; an option cannot be both confirmed and missing.
Evidence uses a zero-based conversation index, or -1 for the current input, so
first-turn requests can also receive concrete proposed alternatives. Each message
in the model input carries an explicit `message_index` to copy into citations;
indices refer to the filtered conversation text, not raw session entries. Wrong
indices are still rejected, never silently relocated to matching text elsewhere.
The checker is instructed that questions do not confirm the facts they ask about,
and assistant-described implementation facts are not confirmed user decisions.
These semantic distinctions are model instructions, not a semantic proof enforced
by the exact-quote validator.
Users need not list alternatives: for example, **Build a task manager** can prompt
questions about intended users or interface, and **Research caching** can prompt
questions about research objective or scope. The model identifies ambiguities
whose answers materially change the result, considering prior decisions and
explicitly delegated choices rather than asking about every omitted detail.
Each question includes an exact quote identifying the ambiguous part of the
request. Choices may be new proposals generated from task knowledge; their labels
need not occur in the conversation. They are shown as **Suggested choices (not
confirmed)**. Optional choice evidence, when supplied, must be an exact quote;
evidence for existing decisions remains mandatory. Invalid evidence or incomplete
recommendations are rejected.
Wasabi shows all choices and a recommended combination. The user must explicitly
confirm that combination or choose alternatives; dismissing the dialog confirms
nothing. These decisions are kept privately in the checker, never appended to the
main conversation. Requests with no missing options continue normally.

## Checker diagnostics (opt-in)

Evidence validation errors identify the JSON field and distinguish invalid message
indices, unavailable sources, and non-verbatim quotes. These are errors in the
checker's output, not a claim that the user supplied insufficient evidence.
Validation and retry behavior are unchanged.

To capture a reproduction, start Pi with an absolute log path (the parent directory
must already exist):

```bash
WASABI_DIAGNOSTIC_LOG="$HOME/wasabi-checks.jsonl" pi
```

Logging is disabled unless this variable is set. Each JSONL event includes a
request ID and timestamp. Events record checker input (including conversation and
system prompt), each model response (including format-regeneration responses),
and success or error. Provider responses include model/provider identifiers when
available. API credentials and request headers are not logged.

**Logs contain private conversation text and model output.** Review/redact before
sharing, do not commit them, and delete them after diagnosis. Files are restricted
to owner read/write (0600); existing log permissions are also tightened. There is
no automatic rotation. Logging is best-effort: an unwritable destination does not
block or bypass checking. Unset the variable and restart Pi to disable logging.

## Private clarification and final review

Wasabi offers the recommended combination, individual choices, and free-form
clarifications. Questions can be revisited and more details added without a fixed
question limit. The latest answer to each question is used in the final draft.
Choose **Finish clarification and review prompt** at any question to review early;
unconfirmed recommendations are excluded. Closing an answer editor returns to
the controls. Closing a selection dialog or choosing **Cancel request** sends nothing.

The review displays the original request plus applicable confirmed conversation
decisions and explicitly supplied answers. Question text stays private; only the
latest explicit answer to each question enters the draft. Additional free-form
details accumulate.
Unresolved questions appear separately and are never silently filled from
recommendations. If checking is ended before a result exists, review explicitly
marks the options as unassessed rather than claiming nothing is missing. A
synchronous conversation snapshot preserves direct response-language instructions
and explicit “use …” decisions (such as “Use Kotlin for this task”), as well as
task-scoped option declarations such as “The output format for this task is JSON
Lines” or “For this request, the deployment target is Cloud Run”, without waiting
for the checker or relying on a fixed list of option values. Declarations for the
same option use the latest value, including current-input overrides. It retains
exact user wording, ignores assistant suggestions and ambiguous or conditional
directives, and gives current instructions for the same scope precedence. Empty or
partial model resolutions do not erase this evidence; an explicit model assessment
of the same evidence takes precedence. Other task-specific decisions require the
checker to assess applicability; when interrupted, review leaves unassessed choices
visible for user editing.
**Edit final prompt** opens Pi's editor and returns to review; editing removes any
previous approval. Each draft generation or edit increments `prompt_revision`;
approval records `approved_revision`, which must match before forwarding.
**Approve and send** approves the currently displayed text and
passes it to Pi as the transformed input exactly once. Empty drafts cannot be sent.
Recommendation confirmation alone never approves the final prompt. Clarification
questions, answers, and review history stay in memory and are never appended to
the main session. Headless requests with missing options remain held. Invalid
checker responses also hold the input rather than passing an unchecked request on.

During clarification, the controls show each question's latest confirmed answer
and the current prompt draft. The same draft is visible above individual answer
and additional-clarification editors, so earlier choices and free-form details
remain visible while writing. Reopening **Write an answer** prefills the previous
answer. Draft previews include only applicable confirmed decisions and explicit
answers; viewing them never approves or sends the request.

During model selection Pi shows **Wasabi · Selecting dedicated model · Main session paused**.
While Wasabi checks a request, asks questions, reviews the final prompt, recovers
from a failure, or forwards an approved prompt, Pi
shows **Wasabi · Private clarification · Main session paused** in its status area.
The indicator clears before returning control to the main session, including
approval, cancellation, requests needing no clarification, and completed error
recovery. Opening or closing a model chooser during a held request preserves the
request's indicator. First-use input keeps the indicator continuously visible from
model selection through checking and final review until the request returns to
the main session. Switching sessions clears the old interaction's indicator;
late cleanup cannot clear a new interaction. Dialog and editor titles also
identify Wasabi.

## Interrupted calls and recovery

Each checker call has a 30-second timeout. Responses must also arrive before the
recorded deadline, even if a busy event loop delays the timeout callback.
For calls lasting over 200ms, a waiting
selection offers **Stop waiting** (Esc also stops) and **Finish clarification and
review prompt**. Finishing opens review immediately with the original request,
without another model call or unconfirmed suggestions. Settling or invalidating
the call closes the waiting dialog.
Timeouts, interruption, invalid responses, and provider errors show the preserved
original request with **Retry**, **Send original unchanged**, and **Cancel request**.
If the checking model returns malformed or truncated JSON, Wasabi privately asks
it to regenerate once within the same 30-second deadline. Complete JSON wrapped
in a Markdown code block is accepted; incomplete data is never guessed or used.
If regeneration also fails, recovery explains the response-format problem rather
than showing a raw JSON parser exception. Evidence and recommendation validation
still apply to every accepted response.
Retry retains the same request identity. Sending the original is an explicit
approval; cancellation sends nothing. Without UI, a failure reports the original
and holds the input.

Errors, timeouts, interruption, retries, cancellation, finishing clarification,
and completion invalidate the previous call generation and request provider
cancellation. Even if a provider ignores cancellation, late
results cannot update the checker, recovery state, or forward input. Each active
call records its request ID, generation, kind, deadline, and cancellation controller;
only responses matching that call and its permitted state are accepted. A request
claims forwarding only once, before returning its approved input to Pi. Authentication finishing
after cancellation cannot start an obsolete provider call.

## Development checks

Run `npm run check` from the package root for TypeScript and all colocated Jest
tests. `package.test.ts` also loads and registers the entry point in a fresh Node
process without a transpiler, matching the independent check package's native
TypeScript loading path. Keep runtime syntax erasable by Node; constructor
parameter properties require transformation and fail in that path.

Run `npm pack --dry-run --json` to inspect package contents. Live Pi interaction
and provider calls require separate manual validation; mocked tests and package
loading do not establish that those checks passed.
