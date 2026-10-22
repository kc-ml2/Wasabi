# Wasabi

Wasabi is a [Pi](https://github.com/earendil-works/pi) extension package with private prompt clarification, session cropping, LiteLLM session tracking, and Crunch file-change review. Each extension can be enabled independently with `pi config`.

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

## Clarify a request with Wasabi

[Wasabi prompt clarification](extensions/wasabi/README.md) checks ordinary inputs
against the existing conversation using a separately selected model. The first
input opens the dedicated model chooser; `/wasabi-model` changes that selection.
Use `/wasabi off` and `/wasabi on` to control automatic checking. Clarification
questions stay private, and the final prompt is reviewed before sending.

## Other sub-extensions

- [Crop](extensions/crop/README.md) copies a selected user turn and its suffix into a new session with `/crop`.
- [Crunch](extensions/crunch/README.md) reviews proposed file changes with `/crunch on` and a separate `/crunch-model`.
- [LiteLLM session tracking](extensions/litellm-session/README.md) groups provider requests by Pi session ID.
