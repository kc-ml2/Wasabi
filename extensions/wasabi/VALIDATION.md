# AC 7 validation record

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
Existing flat extensions were not reorganized as part of this focused repair.

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
