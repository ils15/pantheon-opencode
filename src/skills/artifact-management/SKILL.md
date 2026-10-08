---
name: artifact-management
description: "Structured artifacts for planned, multi-phase, or materially risky implementation work."
context: fork
globs: []
alwaysApply: false
---

# Artifact Management

Structured artifact trail for planned, multi-phase, or materially risky implementation work. Artifacts are not a prerequisite for simple fixes or read-only investigation.

---

## Temp Folder

All ephemeral artifacts live in `.pantheon/memory-bank/.tmp/` — gitignored and wiped on sprint close.

```
.pantheon/memory-bank/
├── .tmp/                  ← GITIGNORED — ephemeral artifacts
│   ├── PLAN-<feature>.md
│   ├── IMPL-phase1-hermes.md
│   ├── IMPL-phase1-aphrodite.md
│   └── REVIEW-<feature>.md
├── _notes/                ← COMMITTED — permanent ADRs
│   └── ADR-<topic>.md
├── 01-active-context.md
└── 02-progress-log.md
```

---

## Artifact Types

| Prefix | Location | Ephemeral? | Produced by |
|--------|----------|------------|-------------|
| `PLAN-` | `.tmp/` | ✅ | Athena |
| `IMPL-` | `.tmp/` | ✅ | Hermes/Aphrodite/Demeter |
| `REVIEW-` | `.tmp/` | ✅ | Themis |
| `DISC-` | `.tmp/` | ✅ | Apollo |
| `ADR-` | `_notes/` | ❌ Permanent | Any → Mnemosyne |

---

## Who Generates

| Situation | Agent | Artifact |
|-----------|-------|----------|
| Planning | Athena | `PLAN-<feature>.md` |
| Implementation | Worker | `IMPL-phase<N>-<agent>.md` |
| Review | Themis | `REVIEW-<feature>.md` |
| Discovery | Apollo | `DISC-<topic>.md` |
| Decision | Any → Mnemosyne | `ADR-<topic>.md` |

> **Zeus does NOT generate artifacts.** He orchestrates agents that generate them.

## Proportional Use

- Create PLAN/IMPL/REVIEW artifacts for planned multi-phase work or when risk, auditability, or an explicit request needs a durable phase trail.
- A bounded, reversible fix should be investigated only as far as needed, implemented, verified with focused checks, and returned as a concise summary. Do not create PLAN, IMPL, or REVIEW artifacts for it.
- Read-only lookup or trivial discovery needs no DISC artifact; use one only when findings are broad enough to be reused or drive a material decision.
- The absence of an artifact never waives Themis review or human approval for auth/security, data/schema/migrations, production-impacting work, or sensitive actions.

---

## Templates

### PLAN
```markdown
# PLAN-<feature>
**Date:** YYYY-MM-DD  **Status:** Awaiting Approval

## Goal
[One sentence]

## Phases
1. Phase 1 — @hermes
2. Phase 2 — @aphrodite

## Risks
- [Risk]
```

### IMPL
```markdown
# IMPL-<phase>-<agent>
**Date:** YYYY-MM-DD  **Status:** Awaiting Themis Review

## What Was Implemented
- [file] — [what changed]

## Tests
- ✅ X tests / Coverage: Y%
```

### REVIEW
```markdown
# REVIEW-<feature>
**Status:** APPROVED | NEEDS_REVISION | FAILED

## Verdict
[APPROVED | NEEDS_REVISION | FAILED]

## Issues
- CRITICAL: X / HIGH: Y / MEDIUM: Z
```

---

## Human Pause Points

1. **After a required PLAN** → pause only when a material scope/risk decision needs approval.
2. **After required REVIEW** → preserve auth/security/data/schema and other sensitive approval gates.
3. **Before commit/push/merge/deploy or destructive/global action** → require explicit human approval.

---

## Cleanup

```
@mnemosyne Close sprint    # Wipes entire .tmp/
@mnemosyne Clean tmp       # Wipes .tmp/ without closing sprint
@mnemosyne List artifacts  # Check what's in .tmp/
```
