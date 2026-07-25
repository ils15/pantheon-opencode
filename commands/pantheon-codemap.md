---
description: "Generate hierarchical codebase map for structure understanding"
agent: zeus
---
# /pantheon-codemap — Codebase Map

**What:** Generates a hierarchical repository map so agents understand codebase structure without re-reading every file.
**Usage:** `/pantheon-codemap [path]`
**Returns:** Structured markdown map with modules, entry points, and data flow

## Options
- `--full` — Include implementation details (max 4 levels)
- `--quick` — Just top-level structure (2 levels)
- `--focus <module>` — Map only a specific module

Delegates to @athena with `skill: codemap`.
