# Artifact Management — Templates

Detail companion for `SKILL.md`. Read on demand when creating an artifact and
you need the `.tmp/` layout or a PLAN/IMPL/REVIEW template. Artifact types,
who-generates-what, proportional-use rules, pause points, and cleanup stay in
`SKILL.md`.

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
├── _notes/                ← permanent ADRs; Git tracking follows repository policy
│   └── ADR-<topic>.md
├── 01-active-context.md
└── 02-progress-log.md
```

Memory Bank files are not automatically versioned or shared across clones.
Check the repository's ignore/commit policy before relying on `_tasks/` records
or other files being tracked; `_tasks/` may be Git-ignored.

---

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
