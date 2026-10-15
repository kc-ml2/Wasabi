# Crop a session branch

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

Crop has no model or provider configuration. It requires an existing session
branch; an interactive picker requires Pi UI.
