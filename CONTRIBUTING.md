# Contributing to Wasabi

Wasabi is an extension package built on top of Pi Agent. It contains independently configurable sub-extensions, each responsible for a focused feature.

Wasabi is at an early and rapidly evolving stage. Contributions do not need to be polished from the beginning, but changes should remain small, reviewable, and easy to test through Pi.

## Ways to Contribute

You can contribute by:

- Implementing or improving features
- Fixing bugs
- Testing Wasabi through daily use
- Reporting unexpected behavior
- Suggesting features or architectural changes
- Improving documentation and test cases

Non-code contributions are welcome.

## Before Starting

For a small fix or documentation change, you may start directly.

For a larger feature, architectural change, or behavior change, first create or comment on a GitHub Issue so that contributors do not work on conflicting approaches.

Experimental ideas may begin as a `spike/*` branch. A spike is exploratory and is not expected to be merged directly into `main`.

## Branches

Create branches from the latest `main`.

Use short-lived branches with names such as:

```
feat/42-context-envelope
fix/51-session-header
compat/pi-0.84
docs/architecture-overview
spike/local-policy-engine
```

`main` is the integrated dogfooding branch. Avoid direct pushes to `main`; submit changes through a pull request.

## Sub-Extension Structure

Keep each sub-extension in its own directory under `extensions/<extension-name>/`, with its entry point, implementation, tests, and README together. This follows the [directory-organization discussion in PR #4](https://github.com/kc-ml2/Wasabi/pull/4#discussion_r3953908293).

Use the following layout for new sub-extensions and when reorganizing existing ones:

```text
extensions/
  crop/
    index.ts
    crop.ts
    crop.test.ts
    README.md
  litellm-session/
    index.ts
    README.md
package.json
```

- Use `index.ts` as the Pi entry point. Keep feature-specific helpers and supporting files inside the same directory; a small extension may keep its implementation in `index.ts`.
- Register each entry point separately in the root `package.json` under `pi.extensions`, for example `"./extensions/crop/index.ts"`, so users can enable or disable sub-extensions individually through `pi config`.
- Keep behavioral tests alongside the implementation. When adding or moving tests, update Jest discovery and TypeScript configuration as needed so `npm run check` covers them. The current Jest configuration only discovers tests under the root `test/` directory.
- Give each sub-extension a `README.md` describing its purpose, commands, configuration, usage, and limitations as applicable. Keep package installation and an overview with links to these READMEs in the root `README.md`.
- Keep sub-extensions self-contained. Extract shared code only when multiple sub-extensions need it, and document the shared boundary without coupling one sub-extension to another's internal implementation.

Existing extensions currently use flat files under `extensions/`. Migrate them in a focused refactoring change, updating imports, manifest entries, tests, and documentation together.

## Development

Install dependencies:

```bash
npm ci
```

Run the available checks:

```bash
npm run check
```

Also test the affected behavior manually in Pi when applicable.

Keep each pull request focused on one logical change. Avoid combining a Pi upgrade, architectural refactoring, and an unrelated feature in the same pull request.

## Pull Requests

A pull request should briefly describe:

- What changed
- Why the change is needed
- How it was tested
- Any known limitations
- The related Issue, when one exists

Draft pull requests are encouraged for early feedback.

At least one other core contributor should review non-trivial changes. The preferred merge method is rebase merge, followed by deletion of the branch.

## Architecture Changes

Architecture documentation should use editable, version-controlled text formats such as Mermaid in Markdown.

When changing an architectural boundary or major data flow:

- Update the relevant architecture document
- Clearly distinguish current, proposed, and experimental components
- Preserve stable component identifiers where possible
- Record the reason for an important decision in a short Architecture Decision Record when necessary

Do not manually edit generated SVG or PNG files.

## Bug and Dogfooding Reports

Please include enough information to reproduce the problem:

- Wasabi commit SHA or tag
- Pi version
- Node.js version
- Model provider and model, when relevant
- Minimal reproduction steps
- Expected behavior
- Actual behavior
- Relevant logs or screenshots, when available

Incomplete reports are still useful, but reproducible reports are easier to act on.

## Project Direction

Wasabi's feature list and architecture are expected to evolve. Prefer small, reversible changes over large speculative implementations, and treat current decisions as revisable when dogfooding provides better evidence.
