# Validation record

Validated on 2026-09-22 with Node 22.22.1 and Pi core packages 0.84.4.

- `npm run check`: TypeScript checking passed; all 123 tests across 15 suites passed, including existing Crop, Crunch, and LiteLLM tests.
- `npm run audit:smoke`: Pi's real loader loaded the compatibility entry and the full package; one auditor registered the existing commands and flag alongside Crop and Crunch.
- `npm run audit:evaluate`: 24 synthetic fixtures validated (12 English, 7 Korean, 5 mixed); no provider requests or model-quality measurements.

The auditor tests cover the preserved report, context, settings, review, English,
raw-capture, and experiment workflows, plus JEV transport and policy, automatic
second-stage routing, credential/configuration fallback, context exclusions,
image preservation, diagnostics failures, and cancellation during screening,
review, dialogs, and experiment navigation. HTTP tests mock fetch and stream
responses, including stalled bodies and caller cancellation. UI flows use a
simulated Pi context; the loader smoke uses the actual Pi extension loader.

Live JEV inference, reviewer quality, and an interactive terminal walkthrough
were not run. The included labels and thresholds are initial expectations,
not evidence of classifier accuracy, rewrite fidelity, or production latency.
