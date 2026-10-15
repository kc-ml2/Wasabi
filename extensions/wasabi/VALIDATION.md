# Wasabi validation record

## AC 2: partial clarification, repeated edits and explicit final approval

Revalidated on 2026-10-15 with `npm run check`: TypeScript and all
11 suites / 225 tests passed. `git diff --check` passed. No production
change was needed for this criterion.

Added three input-handler scenarios with one explicit nonrecommended answer,
one unanswered option and an applicable prior Kotlin instruction. Finishing
clarification builds a review draft from the original, prior instruction and
explicit answer, excluding the unapproved recommendation. The unanswered option
appears separately. After two edits, the input remains pending until the user
approves, cancels or dismisses review. Approval returns only the current edited
prompt; cancellation and dismissal consume the input. Exactly one model call
occurs, and no private questions, answers or drafts are appended or sent to the
session. The interaction indicator clears after each outcome.

Existing recovery tests exercise finish before any model reply or final draft,
abort and generation invalidation without waiting for provider cancellation,
preservation of applicable prior instructions, edited drafts held for approval,
and ignored late successes/failures. Existing clarification tests exercise more
than 100 question revisits, explicit answers with remaining unresolved options,
approval invalidation on edit and at-most-once forwarding across action batches.

These checks use mocked Pi contexts and providers. Live Pi, real-model calls and
the independent acceptance harness were not executed in this run. The existing
`.ouroboros/context_pack.json` change and `src/.README.md.swp` were preserved
and excluded from the commit.

## AC 1: conversation-only checking and settled versus missing options

Revalidated on 2026-10-15 with `npm run check`: TypeScript and all
11 suites / 222 tests passed. `git diff --check` passed. No production
change was needed for this criterion.

Added coding and research input-handler scenarios with an omitted but settled
option, a genuinely undecided option supported by an assistant proposal, and an
unrelated prior decision. Only the undecided option is offered as a question.
The user chooses the nonrecommended alternative, finishes clarification, then
approves the prompt containing the applicable prior decision and explicit answer.
The unrelated decision and unapproved recommendation are excluded. Both tests
verify one provider call, conversation-only input fields, no model tools, and no
private clarification persisted or sent as session messages. The fixture rejects
access to the working directory. An initial check run was stopped because the
new UI mock kept revisiting its question; the mock now explicitly finishes after
answering, and the complete rerun passed.

Existing tests separately cover fully settled requests without clarification,
every interactive/RPC input while enabled, empty conversations, malformed or
ungrounded evidence, conflicting confirmed/missing options, assistant proposals,
and recommendations left unconfirmed. The checker prompt explicitly requires
considering both current input and prior conversation, current-input precedence,
and concrete questions even when intent can be inferred.

These are mocked provider/Pi contract tests. They verify data flow, validation,
and user controls, not a real model's semantic accuracy. Live Pi, real-model calls,
and the independent acceptance harness were not executed in this run.
The pre-existing `.ouroboros/context_pack.json` change and `src/.README.md.swp`
were preserved and excluded from the commit.

## AC 7: recovery revalidation and authoritative gate evidence

Revalidated commit `81120c8` on 2026-10-15 with Node v25.8.1 and npm 11.11.0.
The package-loading and directory-layout repairs are already present in
`7310c08` and `19a0000`; no further production change was needed.

### Failures reproduced in this run

- Extracted `extensions/wasabi/model.ts` from `7310c08^` into a temporary
  directory and imported it with native Node. Exit 1 reproduced
  `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` for a constructor parameter property.
  Native imports of the current `model.ts` and Wasabi entry point exited 0.
- Inspected `19a0000^:package.json`. Its LiteLLM, Crop and Crunch registrations
  are flat `.ts` paths rather than `extensions/<name>/index.ts`. The current
  package regression test validates all four registrations, colocated READMEs
  and tests, native imports, and command registration.
- Exported `81120c8` with `git archive` into a temporary directory without
  `node_modules`. `npm run check` exited 127 with `tsc: command not found`,
  reproducing the dependency-setup failure in the generation-1 gate record.
  Ran the documented `npm ci --no-audit --no-fund` there: exit 0, 532 packages
  installed. Then `npm run check` exited 0: TypeScript and all 11 suites /
  220 tests passed. Temporary files were removed without changing this
  worktree's dependency tree or lockfile.

### Independent check-package records inspected

The earlier "not executed" notes below describe those workers' actions. This
run additionally found authoritative boundary receipts under
`~/.ouroboros/boundary/`:

| Execution | Receipt SHA-256 / filename stem | AC 7 result |
| --- | --- | --- |
| `evolve:ralph-wasabi-recovery-20261015:generation:1` | `82b9a032d8548c3906444a892d9555bddd07b204643f5c31fc56651d7431fb76` | `r7_package_validation.py`: exit 1, missing `tsc` |
| Same generation | `53db9d407c8a0bf3b9d54070a9c9b5140ce2703758690314ea913d23b0a4b083` | `r7_package_validation.py`: exit 0, `reason=passed`; package verdict `pass` |
| `evolve:ralph-wasabi-recovery-20261015:generation:2` | `e7e2996e0a2fdf8e7da9f590f69c7df470f11c8a59b74009c44fac66ec4e78df` | `c7_package_validation.py`: exit 0, `reason=preservation_passed`; admission verdict `admitted` |

The successful generation-2 admission ran native Node validation and
`npm run check` (178 tests at that revision). An admission result is not a
post-implementation gate result. These are existing receipts inspected during
this run, not newly executed independent checks. The workspace's package records
contain redacted manifests without executable check files, and the independent
runner was not rerun here. Its current-revision verdict remains for the parent
workflow; unavailable checks are not counted as newly passed.

### Checks executed against the current implementation

| Check | Result |
| --- | --- |
| `npm run check` in this worktree | Exit 0; TypeScript, 11 suites / 220 tests passed |
| `npm ci --no-audit --no-fund` then `npm run check` in a clean export | Both exit 0; TypeScript, 11 suites / 220 tests passed |
| Native imports of current Wasabi model and entry point | Exit 0 |
| All registered extensions' layout, docs, tests and native registration | Passed by `extensions/wasabi/package.test.ts` in both check runs |
| `npm pack --dry-run --json` | Exit 0; all four extension directories and shared helper included; no tarball created |
| `git diff --check` | Exit 0 |

The documented sub-extension layout, root README links, Jest discovery and
TypeScript inclusion remain satisfied. npm emitted dependency deprecation notices
and the pack command's `.gitignore` fallback warning; neither check failed.
Live Pi UI and real-model calls were not exercised and are not counted as passed.
The existing `.ouroboros/context_pack.json` modification and `src/.README.md.swp`
were preserved. This run changes only this validation record.

## AC 6: automatic checking activation and explicit off preference

Validated on 2026-10-15 with `npm run check`: TypeScript passed and all
11 Jest suites / 220 tests passed, including 20 automation tests.
No production change was needed for this criterion.

Added five cases: first selection through ordinary input, `/wasabi on`, and
`/wasabi-model`; explicit off after successful setup followed by pending model
reselection, main-model changes, session resume and reactivation; and overlapping
on/off/on commands sharing one pending chooser. No authentication or provider
call occurs before first selection. Each first-use path enables later inputs;
only the dedicated model is invoked. After setup, off prevents calls both during
and after reselection and survives resume. Explicit on reactivates checking with
the newly selected dedicated model without another chooser. A superseded on
request cannot override off or the latest on request.

Existing automation tests directly verify `enabled=false` and
`activation_pending=true` before selection, successful first setup, dismissal,
off before first selection and during each pending activation path, separate
initial-setup tracking, and restoration of explicit preferences. Together these
cover both configuration state and actual input/command behavior.

These checks use mocked Pi contexts and providers. Live Pi UI, real-model calls
and the independent acceptance harness were not executed by this worker.
The pre-existing `.ouroboros/context_pack.json` modification is preserved and
excluded from the commit.

## AC 5: dedicated model selection and main-model independence

Validated on 2026-10-15 with `npm run check`: TypeScript passed and all
11 Jest suites / 215 tests passed. The focused model suite passed all 20 tests.
`git diff --check` passed. No production change was needed for this criterion.

Added six integration cases covering interactive and RPC inputs held by a
pending `/wasabi on` model chooser, dismissed first-use selection followed by
another input, and recovery from unavailable-model or authentication failures.
While selection is pending, neither authentication nor provider invocation nor
configuration persistence occurs. After selection, held and subsequent inputs
use the dedicated model despite a main-model change. Dismissal makes no checker
call and leaves the next input to request selection again. Model failures open
recovery without a fallback invocation; retry after changing the main model still
authenticates and invokes only the originally selected dedicated model.

Existing tests cover a pending model command, direct first-use inputs, private
clarification and session resume across main-model changes, direct checking and
clarification calls, stale selection after session replacement, headless setup,
and explicit off preferences. Any authenticated model can be selected, including
a different provider; no model-name, speed, size or benchmark heuristic is used.
These checks use mocked Pi contexts and providers. Live Pi UI and real-model
calls were not exercised; the independent acceptance harness was not run here.
The pre-existing `.ouroboros/context_pack.json` modification is preserved and
excluded from the commit.

## AC 4: cancellation authority and overlapping retries

Validated on 2026-10-15 with `npm run check`: TypeScript passed and all
11 Jest suites / 209 tests passed. The focused recovery suite passed all
51 tests. No production change was needed for this criterion.

Added eight cases covering checking and clarifying calls, timeout and user
interruption, and obsolete provider success and failure. Each uses a model
promise that ignores cancellation and remains pending while recovery starts.
The abort listener verifies that active-call authority is already removed and
the generation advanced when cancellation is requested. A retry keeps the same
request ID with a newer generation. Settling the obsolete provider while the
retry is pending cannot settle that retry, replace its active call, publish a
checker result, change its state, or forward the original. Only the current
provider result becomes available; forwarding is claimed at most once.

Existing recovery tests cover finite deadlines (including a busy event loop),
synchronous errors, recovery's retry/send-original/cancel choices, original
preservation, early finish without waiting for cancellation, late replies and
failures during review, and session replacement. Response handling checks the
active call identity, request ID, generation and permitted state before
returning a result. These checks use mocked Pi contexts and providers. Live Pi
and real-provider cancellation were not manually exercised; the independent
Ouroboros acceptance harness was not run by this worker.

## AC 3: interaction indicator lifetime

Validated on 2026-10-15 with `npm run check`: TypeScript passed and all
11 Jest suites / 201 tests passed. `git diff --check` passed.

The indicator integration tests observe `select_model`, `checking`,
`clarifying`, `reviewing`, `recovering`, and `forwarding`. Added two complete
first-use flows through a failed check, recovery, retry, clarification and
review, ending in approval or cancellation. Assertions at actual request and
clarification state transitions verify that the Wasabi status remains visible,
including during forwarding and cancellation cleanup. The final status clear
occurs only when the input handler returns to the main session.

Existing tests also cover review editing, recovery send-original, timeout,
stop-waiting, early finish, dismissed dialogs, overlapping model selection and
session reset. No production change was needed for this criterion. These are
mocked Pi/provider checks; live Pi UI was not manually exercised.

## AC 2: early finish and current-draft approval

Validated on 2026-10-15 with `npm run check`: TypeScript passed and all
11 Jest suites / 183 tests passed. `git diff --check` also passed.

The clarification tests cover unlimited question revisits, finish without a
draft, explicit answers plus applicable prior decisions, exclusion of unapproved
recommendations, separately displayed unresolved options, revision approval
invalidation, and single forwarding. Corrected review reconciliation so an
explicitly answered option is no longer listed as unresolved through its older
unconfirmed resolution; unresolved entries represented by questions are not
duplicated by ID.

The input/recovery tests cover a nonresponsive provider, immediate cancellation
on finish, retained prior decisions, editing before approval, and late provider
responses. Added both approval and cancellation paths while an edited draft is
waiting for a decision: a late provider rejection and elapsed timeout cannot
settle the input, open recovery, or persist private dialogs. Only approval
returns the edited prompt through the input transform; cancellation consumes
the input. These are mocked Pi/provider tests, not live Pi or real-model checks.

## AC 7: package loading

Executed on 2026-10-15 with Node v25.8.1 in the
`ralph-wasabi-recovery-20261015` worktree.

## Reproduced package-loader failure

The existing `.ouroboros_eval_artifact.md` reports a failed `check_package`,
including `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` while loading `model.ts`.
Before this repair, running:

```sh
node --input-type=module -e 'await import("./extensions/wasabi/model.ts")'
```

exited 1 with the same error: constructor parameter properties are unsupported
in Node's strip-only mode. Jest's TypeScript transformation had hidden this
failure. Replaced parameter properties in all five Wasabi classes with explicit
field declarations and constructor assignments, preserving their behavior.

After the repair, the same import and an import of
`./extensions/wasabi/index.ts` both exited 0. All four manifest entry points also
loaded successfully using native Node imports.

The colocated `package.test.ts` starts a fresh Node process, imports the actual
manifest-registered Wasabi entry point and its dependency graph, and verifies
input/session handler and command registration without model calls or persisted
configuration. It runs as part of the normal check command.

## Executed checks

| Check | Result |
| --- | --- |
| `npm run check` | Exit 0; TypeScript passed; 11 Jest suites, 178 tests passed |
| Native Wasabi entry-point import | Exit 0 |
| Native import of all four `pi.extensions` entries | Exit 0 |
| `npm pack --dry-run --json` | Exit 0; Wasabi entry point, helpers, README and tests included |
| `git diff --check` | Exit 0 |

The pack command emitted npm's informational `.gitignore` fallback warning.
It did not create a tarball.

## Contribution layout

Wasabi's entry point, implementation, behavioral tests and README are together
under `extensions/wasabi/`. The root manifest registers its entry point
individually, and the root README links to its usage documentation. Jest discovers
colocated tests and TypeScript includes the extension directory. Updated the stale
test-discovery sentence in CONTRIBUTING.md to match those configurations.
At that revision, existing flat extensions were not reorganized. The retry below
addresses the subsequent layout counterexample.

## Checks not executed

The independent Ouroboros `check_package` as a whole was not rerun by this worker.
The available package records expose redacted manifests rather than executable
check files or a standalone runner command. The native loader failure recorded
in its previous output was reproduced and fixed, but this does **not** establish
that every independent check passes. The coordinating workflow must run its
authoritative gate against this revision; its verdict remains pending here.

Live Pi UI behavior and real provider calls were not manually exercised. They
are not counted as passed. The tests use mocked Pi contexts and provider replies.

The pre-existing `.ouroboros/context_pack.json` modification is intentionally
left uncommitted and unchanged by this task.

## AC 7 retry: registered sub-extension layout

The frozen check package subsequently reported `r7_package_validation`:
`Expected: Every registered sub-extension uses extensions/<name>/index.ts`;
`Observed: ./extensions/litellm-session.ts`. Reproduced locally before editing
with the following command (exit 1 at the same manifest entry):

```sh
node --input-type=module -e 'import assert from "node:assert/strict"; import fs from "node:fs"; const p=JSON.parse(fs.readFileSync("package.json","utf8")); for (const entry of p.pi.extensions) assert.match(entry, /^\.\/extensions\/[^/]+\/index\.ts$/, `Invalid registered sub-extension: ${entry}`);'
```

Moved LiteLLM, Crop and Crunch into their respective sub-extension directories,
including behavioral tests, Crunch's diff implementation and test harness, and
per-extension usage documentation. Updated manifest entries and imports. The root
README links to each extension's documentation. The pure LiteLLM header policy
remains shared in `src/litellm-session.ts`, used by both LiteLLM and Crunch; its
boundary is documented in both extensions. Existing Jest and TypeScript glob
patterns already cover the migrated files and needed no configuration changes.

Executed after this repair on 2026-10-15, Node v25.8.1:

| Check | Result |
| --- | --- |
| Same manifest layout reproduction command | Exit 0 for all four entries |
| Native imports of all registered entry points | Exit 0 |
| `npm run check` | Exit 0; TypeScript passed; 11 suites, 178 tests passed |
| Package regression test (included in check) | All registered entries match the required path, have colocated documentation/tests, load natively and register commands |
| `npm pack --dry-run --json` | Exit 0; all four extension directories and shared helper included; no tarball created |
| `git diff --check` | Exit 0 |

The independent frozen `check_package` runner is not present in this workspace
and was not executed here. These results establish that the reported layout
counterexample is repaired, not that the entire independent gate passed. Live
Pi UI and real model calls were not exercised or counted as passed. Existing
`.ouroboros/context_pack.json` changes and `src/.README.md.swp` are preserved.

## AC 2 retry: preserve reported settlements before a model reply

Validated on 2026-10-15 with `npm run check`: TypeScript passed and all
11 suites / 243 tests passed. `git diff --check` passed.

The supplied check-package counterexample reported a persistence-layer draft
that lost the settled storage option when checking ended before a model reply.
Reproduced the same omission locally with explicit user statements such as
"We agreed on SQLite for storage for this task" and "The storage backend for
this task has been confirmed as SQLite". Before repair, eight assertions failed
across synchronous snapshot and full input-handler tests.

Extended the synchronous conversation snapshot to retain reported user
settlements as verbatim evidence even when they are not phrased as a `use`
command or a simple `is` declaration. No extra model call or file source was
introduced. Added negative cases for proposals, consideration, negation,
other-task decisions and assistant assertions, plus current-input precedence
without dropping independent options.

Five added input-handler cases finish while the cancellation-ignoring provider
has supplied no draft. The tests check that abort is requested immediately,
the settled option appears in both review and editor, unresolved assessment is
shown separately, editing remains private until approval, late responses cannot
replace the edited draft, and only the approved current text is transformed.
The existing tests also cover unlimited question revisits, explicit answers,
unapproved recommendations, approval revocation on edit and single forwarding.

These are mocked Pi/provider tests. The independent frozen check package and
live Pi/real-model behavior were not executed here; no independent gate success
is claimed. The pre-existing `.ouroboros/context_pack.json` modification and
`src/.README.md.swp` were preserved and excluded from the commit.
