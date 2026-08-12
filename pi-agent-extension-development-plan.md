# Wasabi Pi Extension — MVP Development Plan

## Goal

Build the smallest useful Pi extension package in the existing Wasabi repository:

> Load Wasabi through its package manifest, run `/hello`, and receive a greeting from the extension.

The MVP validates the repository layout, dependency setup, TypeScript configuration, Pi package loading, and command registration. It does not add model-callable tools, persistent state, background services, custom UI components, automated tests, or distribution automation.

## Repository Structure

```text
Wasabi/
├── extensions/
│   └── wasabi.ts
├── .gitignore
├── package.json
├── package-lock.json
├── pi-agent-extension-development-plan.md
├── README.md
└── tsconfig.json
```

The existing Wasabi Git repository and its `origin` are preserved. Do not create a nested repository. Directories such as `src/` and `test/` should be added only when they contain real implementation or test files.

## Package and TypeScript Configuration

Configure a private ESM package named `pi-wasabi` at version `0.0.1` with:

- The `pi-package` keyword.
- `pi.extensions` pointing to `./extensions/wasabi.ts`.
- Node.js `>=22.19.0`.
- `@earendil-works/pi-coding-agent` as a `"*"` peer dependency.
- TypeScript 5.9.x as a development dependency.
- `typecheck` and `check` scripts that run `tsc --noEmit`.

Commit `package-lock.json` so a fresh checkout can use `npm ci`. Do not add `typebox` until an extension tool needs a parameter schema.

TypeScript should target ES2022, use ESNext modules with Bundler resolution, enable strict checking, emit no files, and include only `extensions/**/*.ts` for this milestone.

## Extension Interface

`extensions/wasabi.ts` exports a default extension factory and registers one command:

- Command: `/hello`
- Arguments: ignored
- Behavior: display an informational notification
- Exact message: `Hello! Wasabi is running.`

The handler performs no model call and stores no state.

## Documentation

`README.md` documents:

- Required Node.js and Pi versions.
- Fresh-checkout installation with `npm ci`.
- Static checking with `npm run check`.
- Package-root loading with `pi --offline --no-session --no-extensions -e .`.
- The `/hello` interaction and exact expected output.

## Verification

The MVP is complete when all of the following pass:

1. `node --version`, `npm --version`, and `pi --version` confirm the required tools are available.
2. `npm ci` installs the locked dependencies.
3. `npm run check` passes without emitting build files.
4. `pi --offline --no-session --no-extensions -e .` starts without an extension-loading error.
5. Running `/hello` displays exactly `Hello! Wasabi is running.`
6. The intended files are committed and `git status --short` is empty.

Loading `./extensions/wasabi.ts` directly may be used for diagnosis, but it does not replace the package-root test because it bypasses the `pi.extensions` manifest.

## Deferred Work

After the MVP is stable, add capabilities one at a time: a model-callable tool, a lifecycle event, reusable logic under `src/`, automated tests under `test/`, package installation, and distribution. None are part of this baseline.
