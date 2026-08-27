---
description: "Inspect or change only OpenCode's top-level model settings"
agent: zeus
---
# /pantheon-model — Model settings

Use the deterministic `pantheon_model` tool for this command. Do not edit
`opencode.json` directly and do not modify providers, credentials, the active
preset, or agent model settings.

## Usage

- `/pantheon-model status` or `/pantheon-model show` — show `model`,
  `small_model`, each field's origin (`project`, `global`, or `default`), and
  the active preset without showing secrets.
- `/pantheon-model set --model <provider/model-id>` — set only `model`.
- `/pantheon-model set --small-model <provider/model-id>` — set only
  `small_model`.
- `/pantheon-model set --model <provider/model-id> --small-model <provider/model-id>`
  — set both fields independently.
- `/pantheon-model reset` — remove only the managed fields.

`--scope project|global` is supported by `set` and `reset`. The safe default is
`project`, so a command without `--scope` never changes the global config.
Values must use the `provider/model-id` format. Changes are backed up and
written atomically; restart OpenCode after a successful change.

The installer leaves `model`/`small_model` absent without explicit flags;
`small_model` is never used for delegates — inheritance is via the chat /
preset model.
