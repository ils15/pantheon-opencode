---
description: "Inspect or change per-agent model overrides in active-preset.json"
agent: zeus
---
# /pantheon-model — Per-agent model overrides

Use the deterministic `pantheon_model` tool for this command. Operates exclusively
on `active-preset.json` `overrides.agents[agent]` (project or global). Never
writes `.env` and never injects top-level `model`/`small_model` into `opencode.json`.

## Usage

- `/pantheon-model status` or `/pantheon-model show` — list 14 canonical agents
  (`zeus`, `athena`, `apollo`, `hermes`, `aphrodite`, `demeter`, `themis`,
  `prometheus`, `hephaestus`, `nyx`, `gaia`, `iris`, `mnemosyne`, `talos`)
  with effective `model`, `effort`, and origin (`preset` | `override` | `env` | `none`)
  and the active preset, without showing secrets.
- `/pantheon-model` (no args) — interactive wizard via `askQuestions`:
  agente → modelo (`provider/model-id`) → effort (`low`/`medium`/`high`) → scope.

- `/pantheon-model set --agent <name> --model <provider/model-id> [--effort low|medium|high] [--scope project|global]`
  — set per-agent override. Validates agent is one of the 14, `provider/model-id`
  format, `CAPABILITY_TABLE` entry via `capabilityEntry()` and clamps effort via
  `normalizeCapability()`; warns via `hasVision` for text-only models. Persists
  atomically with `.bak` backup and per-path lock. Default scope is `project`.

- `/pantheon-model reset --agent <name> [--scope project|global]` — remove the
  per-agent override from `overrides.agents[agent]`.

`--scope project|global` is supported by `set` and `reset`. Global changes require
explicit `confirm` and `authorize_global`. Values must use `provider/model-id`.
Changes are backed up (`.bak`) and written atomically; restart OpenCode after a
successful change. The tool never writes `.env` and never injects `model`/`small_model`
global keys — delegate inheritance is native (no model → inherits chat/preset model).
