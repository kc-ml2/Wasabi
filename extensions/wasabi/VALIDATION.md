# Wasabi validation record

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
