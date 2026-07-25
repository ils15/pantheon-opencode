---
description: "Simplify code while preserving behavior"
agent: zeus
---
# /pantheon-simplify — Code Simplification

**What:** Behavior-preserving code simplification for readability and maintainability.
**Usage:** `/pantheon-simplify <file-or-pattern>`
**Returns:** Simplified code + verification that behavior is preserved

## Options
- `--check` — Only report simplification opportunities, don't change
- `--function <name>` — Simplify specific function only
- `--dry-run` — Show changes without applying

Delegates to @themis + @talos with `skill: simplify`.
