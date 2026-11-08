---
name: code-review-checklist
description: "Systematic code review with quality gates, security audit, and parallel checks. Use for structured feedback on pull requests."
---

# Code Review Checklist

Systematic code review combining quality gates, security audit (OWASP Top 10), and parallel checks for comprehensive validation.

---

## Review Scope

- Review **ONLY changed files** (check diff, not entire file)
- Check related commits
- Link to related PRs/issues

---

## Automated Quality Checks (Run FIRST)

**Before any manual review, run automated checks:**

```bash
# Python
ruff check --select F,E,W,UP,B,SIM --output-format concise <files> && ruff format --check <files>

# TypeScript/JavaScript
biome check --write --unsafe <files>
```

**Block review if checks fail.** Return NEEDS_REVISION with specific violations.

---

## Review Checklist

Run the itemized pass (Correctness, Code Quality, Testing, Security/OWASP, Documentation) and the SOLID check from [references/review-checklists.md](references/review-checklists.md) before issuing a verdict.

---

## Feedback Format

```
## Verdict: APPROVED | NEEDS_REVISION | FAILED

### Issues
- CRITICAL: X | HIGH: Y | MEDIUM: Z | LOW: W

### Details
- [CRITICAL] file.py:42 — SQL injection risk, use parameterized queries
- [HIGH] component.tsx:15 — Missing input validation
- [MEDIUM] test_utils.py:8 — Edge case not covered

### 🔍 Human Review Focus
1. [Item AI cannot fully validate — e.g., business logic correctness]
2. [Item 2 — e.g., UX flow matches requirements]
```

---

## Parallel Review Pattern

For comprehensive reviews, run 5 checks simultaneously:

| Check | Focus | Agent |
|-------|-------|-------|
| **Goal** | Does it meet requirements? | Themis |
| **Quality** | Code quality, SOLID, DRY | Themis |
| **Security** | OWASP Top 10, secrets | Themis |
| **QA** | Tests, coverage, edge cases | Themis |
| **Context** | Fits architecture, no regressions | Themis |

---

## Severity Definitions

| Level | Action | Example |
|-------|--------|---------|
| **CRITICAL** | Block merge | Security vulnerability, data loss risk |
| **HIGH** | Must fix before merge | Missing auth, broken error handling |
| **MEDIUM** | Should fix soon | Missing tests, code duplication |
| **LOW** | Nice to have | Naming, formatting, minor docs |

---

## Anti-Patterns

- ❌ Reviewing entire file instead of diff
- ❌ Approving without running tests
- ❌ Ignoring security implications
- ❌ Vague feedback ("looks good", "needs work")
- ❌ Nitpicking style over substance

---

## Routing

| Action / trigger | Reference |
|---|---|
| Executing the itemized review pass (Correctness, Quality, Testing, Security, Documentation) or the SOLID check | [references/review-checklists.md](references/review-checklists.md) |

A missing reference interrupts the action — read nothing in its place, never improvise from memory.
