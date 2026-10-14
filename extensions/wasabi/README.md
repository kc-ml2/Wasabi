# Wasabi dedicated model

Use `/wasabi-model` to choose a lightweight model from Pi's authenticated models,
or `/wasabi-model provider/model-id` to select one explicitly. The user decides
which model is lightweight; no model IDs or performance thresholds are imposed.

The model client prompts for selection before its first checking or clarification
call. Dismissing selection prevents the call. It never falls back to the main
session model, including when the selected model becomes unavailable or loses
authentication. Both kinds of call use the same dedicated client and Pi's existing
authentication. Changing the main session model does not alter this selection.

Selection is stored in a `wasabi-model` custom session entry and restored when
opening or switching sessions. This entry is configuration, not a conversation
message. The model module supplies model selection and invocation only; the
clarification workflow is separate.
