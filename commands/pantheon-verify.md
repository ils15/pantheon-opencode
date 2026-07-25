---
description: "Create verification plan before non-trivial changes"
agent: zeus
---
# /pantheon-verify — Verification Planning

**What:** Plans an evidence path before non-trivial changes, defining how to verify correctness.
**Usage:** `/pantheon-verify <change-description>`
**Returns:** Verification plan with strategy, rollback, and acceptance criteria

## When to Use
- Before changes touching 3+ files
- Before DB migrations or schema changes
- Before API contract changes
- Before dependency upgrades

Delegates to @themis + @athena with `skill: verification-planning`.
