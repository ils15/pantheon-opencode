---
description: "Clone and inspect dependency source for debugging"
agent: zeus
---
# /pantheon-deps — Dependency Inspector

**What:** Clones dependency source locally so agents can inspect library internals and debug integration issues.
**Usage:** `/pantheon-deps <package-name>`
**Returns:** Summary of dependency structure and findings

## Options
- `--deep` — Full clone (not shallow)
- `--search <term>` — Search dependency source for specific pattern
- `--check-security` — Quick vulnerability assessment

Delegates to @hermes or @hephaestus with `skill: clonedeps`.
