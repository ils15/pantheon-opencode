---
description: "Controlled iterative refinement for complex problems"
agent: zeus
---
# /pantheon-loop — Loop Engineering

**What:** Controlled iterative refinement with max 3 loops — solve, review, improve, repeat.
**Usage:** `/pantheon-loop <task> [--loops N]`
**Returns:** Refined solution with per-loop documentation

## Options
- `--loops 1-3` — Max iterations (default: 3)
- `--metric <name>` — Optimization target (speed, memory, readability)
- `--baseline-only` — Stop after first working version

Delegates to @hermes / @aphrodite / @hephaestus with `skill: loop-engineering`.
