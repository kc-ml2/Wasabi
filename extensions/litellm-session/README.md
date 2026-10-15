# LiteLLM session tracking

Adds `x-litellm-session-id` to main conversation requests for the `centinels`
and `openai` providers. Other providers and existing authentication headers are
left unchanged. Enable or disable this sub-extension through `pi config`;
there is no additional configuration.

Run `/litellm-session` to display the current Pi session ID. Requests in the
same session share that ID; `/new` and `/fork` create a new ID, while `/resume`
restores the selected session's ID.

The shared, pure header policy lives in `../../src/litellm-session.ts`. Both
this conversation hook and Crunch's independent summary requests use it without
importing each other's implementation. Header tracking does not add summaries
to conversation history or account for their usage in Pi session totals.
The provider must support the header for it to affect server-side tracking.
