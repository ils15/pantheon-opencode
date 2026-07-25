---
name: loop-engineering
description: Iterative refinement pattern for complex problems — solve, review, improve, repeat in controlled cycles
---

# Loop Engineering

Controlled iterative refinement for complex problems. Each loop tightens the solution without expanding scope.

## When to Use

- Algorithm design with multiple valid approaches
- Performance optimization (measure → change → measure)
- API design that needs ergonomic feedback
- Complex business logic with edge cases
- UI/UX refinement cycles

## Loop Structure

```
Loop 1: Baseline → Implement simplest working version
   ↓ review
Loop 2: Improve → Optimize for <metric>
   ↓ review  
Loop 3: Polish → Edge cases, error handling, DX
   ↓ review
Done
```

## Per-Loop Rules

| Phase | Max Duration | Focus | Skip If |
|-------|-------------|-------|---------|
| Baseline | 3 turns | Working solution | Problem is well-understood |
| Improve | 5 turns | Performance/quality | Baseline meets requirements |
| Polish | 3 turns | Edge cases, DX | Change is internal/non-user-facing |

## Termination Conditions

Stop looping when:
- Acceptance criteria are met
- 3 loops completed
- Diminishing returns: last loop improved < 10%
- @themis blocks and recommends a different approach

## Rules
- Max 3 loops per task (hard limit)
- Each loop must have a clear success/fail gate
- After loop 3: stop and deliver regardless of perfection
- Escalate to @zeus if task needs more than 3 loops
- Document what was learned in each loop for @mnemosyne
