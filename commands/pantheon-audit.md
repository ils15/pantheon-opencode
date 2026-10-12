---
description: "Audit: heuristic scan (zero LLM) + Themis review. Usage: /pantheon-audit [--light|--full|--plan]"
agent: "zeus"
---
# /pantheon-audit — Quality & Security Audit

**What:** Layer 1 heuristic scan (zero tokens, <2s). If BLOCKING, returns score. If APPROVED, Themis deep review.

**Usage:**
- `/pantheon-audit` — Full audit (Layer 1 → 2 → 3)
- `/pantheon-audit --light` — Layer 1 only (quick scan)
- `/pantheon-audit --full` — Force full review
- `/pantheon-audit --plan` — Verification planning only

## Layers

### Layer 1 — Heuristic Scan
Resolve the installed helper first (do not assume the current project contains
Pantheon source). Check, in order: `$OPENCODE_CONFIG_DIR/.opencode/scripts/`,
`$OPENCODE_CONFIG_DIR/scripts/`, `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/scripts/`,
`$HOME/.opencode/scripts/`, `.opencode/scripts/`, then
`$(npm root -g)/pantheon-opencode/scripts/`. Resolve the first existing file to
an absolute path and run `python3 "$helper" --path="$PWD"`; if none exists,
report the helper as missing and stop Layer 1 rather than claiming it passed.
Zero tokens, <2s. Checks: ruff, biome, anti-pattern slop, anti-overengineering (YAGNI), hash-anchored edits. Returns score 0-100 + APPROVED/BLOCKING.

### Layer 2 — Themis Deep Review
~500 tokens. Confidence scoring, regression prediction, OWASP Top 10.

### Layer 3 — Verification Planning
For N>5 file changes. Sugere plano de verificação antes de implementar.
