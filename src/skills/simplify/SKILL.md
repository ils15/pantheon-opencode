---
name: simplify
description: Behavior-preserving code simplification for readability, maintainability, and reduced complexity
---

# Simplify

Simplify code while preserving its exact behavior. Focus on reducing complexity without changing semantics.

## When to Use

- Functions with high cyclomatic complexity
- Deeply nested conditionals
- Overly abstracted code (YAGNI violations)
- Duplicated logic that can be consolidated
- Over-engineered solutions

## Simplification Patterns

| Pattern | Before | After |
|---------|--------|-------|
| Extract method | Large function | Focused functions |
| Consolidate conditionals | Nested ifs | Guard clauses |
| Remove dead code | Unused params/vars | Clean signatures |
| Inline abstraction | 1-use wrappers | Direct calls |
| Simplify state | Mutable state | Pure functions |

## Verification

After each simplification:
1. Run tests (`pytest`, `npm test`)
2. Verify no behavior change
3. If no tests exist: add minimal characterization tests first

## Rules
- Never change public API signatures without explicit approval
- One simplification pass per function, then verify
- If tests fail: revert and try a different approach
- Escalate to @themis if simplification touches 5+ files
