---
name: incremental-implementation
description: "Implement in thin vertical slices — one commit per task, testable, rollback-safe"
---

# Incremental Implementation

Build in thin, testable vertical slices. One commit per task.

## Rules
1. Each slice delivers independently testable value.
2. One commit per slice with tests passing.
3. If a slice exceeds 50 changed lines, split it into smaller tasks.
4. Rolling back a slice must not break previous slices.

## Slice Pattern
```
Slice 1 — Schema and data model (migration up/down tested)
Slice 2 — API endpoint (test -> implementation -> refactor)
Slice 3 — Frontend component (mock API -> UI -> integration)
Slice N — E2E integration (happy path + edge cases)
```

## Anti-Patterns
- Horizontal slicing (building the entire backend before touching frontend).
- Mega-commits of 500+ lines.
- Implementing changes without prior test verification (RED -> GREEN).
