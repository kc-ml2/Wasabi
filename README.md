# Wasabi

Wasabi is a minimal [Pi](https://github.com/earendil-works/pi) extension package. Its first milestone registers a single `/hello` command so the repository structure, package manifest, and local development loop can be verified before any larger features are added.

## Requirements

- Node.js 22.19.0 or newer
- npm
- Pi 0.80.10 or newer, installed from `@earendil-works/pi-coding-agent`

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
behavioral tests with `npm test`. The crop tests use a small mock of Pi's command
context and destination `SessionManager`; they verify the suffix copied into the
replacement session without creating real session files.

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
