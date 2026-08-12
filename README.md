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

## Check

```bash
npm run check
```

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
