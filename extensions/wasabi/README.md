# Wasabi dedicated model

Use `/wasabi-model` to choose a lightweight model from Pi's authenticated models,
or `/wasabi-model provider/model-id` to select one explicitly. The user decides
which model is lightweight; no model IDs or performance thresholds are imposed.

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
first-turn requests can also receive concrete proposed alternatives.
Each option includes a concrete question, distinct choices, and exact supporting
quotes from the current input or conversation. Invalid evidence or incomplete recommendations are rejected.
Wasabi shows all choices and a recommended combination. The user must explicitly
confirm that combination or choose alternatives; dismissing the dialog confirms
nothing. These decisions are kept privately in the checker, never appended to the
main conversation. Requests with no missing options continue normally.

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
and explicit “use …” decisions (such as “Use Kotlin for this task”) without waiting
for the checker or relying on a fixed list of implementation languages. It retains
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

Each checker call has a 30-second timeout. For calls lasting over 200ms, a waiting
selection offers **Stop waiting** (Esc also stops) and **Finish clarification and
review prompt**. Finishing opens review immediately with the original request,
without another model call or unconfirmed suggestions. Settling or invalidating
the call closes the waiting dialog.
Timeouts, interruption, invalid responses, and provider errors show the preserved
original request with **Retry**, **Send original unchanged**, and **Cancel request**.
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
