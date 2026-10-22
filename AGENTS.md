# Ouroboros commit preferences

Apply these instructions when implementing code through Ouroboros, including coding workers launched by `ooo run` and any subsequent repair iterations. The coordinating agent must include this commit policy in delegated coding tasks.

- Plan logical commit boundaries before implementation and adjust them as the work becomes clearer. Each commit should represent one coherent, reviewable change; do not impose an arbitrary commit count or combine an entire multi-part implementation into one final commit.
- Keep implementation, directly related tests, and necessary documentation together when they serve the same behavior. Separate unrelated refactors, formatting, and dependency changes.
- Create commits as coherent units are completed. Keep each commit working where practical and run the relevant checks before committing. Report any checks that cannot run or any known failure accurately.
- Follow the repository's commit-message conventions. Otherwise use a concise imperative subject that describes the change, with a body explaining the reason when useful.
- Inspect the initial Git status and preserve pre-existing user changes. Stage only the files or hunks belonging to the intended commit, and review the staged diff before committing.
- When multiple workers share a checkout, designate one coordinating agent to stage and commit. Other workers report their changes and checks to that agent. Workers in separate checkouts may commit their own work; preserve the logical boundaries during integration.
- Do not rewrite existing history or push commits unless the user explicitly requests it. Follow repository branch and contribution instructions.
- Before reporting the run complete, check for uncommitted task changes and list the created commits with their short hashes, purposes, and validation results. Explain anything intentionally left uncommitted.

Read `CONTRIBUTING.md` for sub-extension layout and validation requirements.

For the current Wasabi Seed execution, the parent chat agent coordinates staging and commits in the original checkout. Workers in isolated checkouts may create coherent commits as above. Workers sharing the original checkout must report completed units and validation to the coordinator without staging or committing. Preserve the pre-existing `.ouroboros/` artifacts and `src/.README.md.swp`.
