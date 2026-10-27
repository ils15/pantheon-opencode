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

For each simplification:
1. Choose the smallest existing test or static check that covers the changed behavior.
2. For a behavior change, add one focused regression test when the existing suite does not cover it; run that test and verify the behavior.
3. Run a broader suite only when the change crosses layers, touches a strong safety gate, affects required coverage, or a CI/release gate calls for it. `npm test` is the full repository suite, not the default after every simplification.
4. For documentation-only or formatting-only changes, inspect the diff and run the narrowest relevant check instead of inventing a test.

## Rules
- Never change public API signatures without explicit approval
- One simplification pass per function, then verify
- If tests fail: revert and try a different approach
- Escalate to @themis if simplification touches 5+ files
