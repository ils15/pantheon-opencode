---
description: "Test economy — strict sub-10s test slicing; whole-repo test suites are strictly forbidden in dev loops."
name: "Test Economy"
---

## Strict Test Slicing & Anti-Fatigue Mandate

In active development, bug-fixing, refactoring, and implementation loops, agents MUST run ONLY the narrowest, sub-10-second test slice covering the changed code.

### 🚫 STRICTLY FORBIDDEN IN DEV TURNS
- **NEVER run unconstrained repository-wide test suites** during implementation or review turns.
  - FORBIDDEN: `npm test`, `npm run test:all`, `pytest` (without `-k` or file argument), `cargo test` (unfiltered), `vitest run` (unfiltered).
  - Running unconstrained suites causes massive timeouts, context window exhaustion, and destructive token burn.

### ✅ MANDATORY SLICED CHECKS (<10s)
- **Repo Selector First**: Always prefer the repository's own focused selector (e.g. `npm run test:quick`, `node scripts/test-slice.mjs`, `pytest -k`) over path guessing.
- **Node.js / TS**: `node --test tests/<slice>.test.mjs`, `npx tsx tests/<slice>.test.ts`, or `npm run test:quick`
- **Python**: `pytest tests/test_<slice>.py -k <func_name>`
- **Failure/Fix Loops**: Rerun ONLY the failed test (`-k <func>` or `--test-name-pattern`). DO NOT rerun checks that already passed when their covered code did not change.
- **Mapping Gaps**: If a modified file has no direct unit test, report the mapping gap and run static lint/typecheck fallback (`npx biome check <file>` or `ruff check <file>`) plus nearest slice; NEVER silently escalate to full suites.
- **Visible Scope Justification**: Any broader-than-focused run MUST state visible rationale: `[Test Scope Expansion] Scope: <files> | Selected: <tests> | Reason: <concrete risk>`.
- **Observable Receipt**: Include command, target count, duration, and selection reason in task summary.
- Bug fixes require exactly ONE focused regression check.
- Never assert on cosmetic formatting, copy text, or internal implementation details.

### ⏱️ FULL SUITES ARE CI/RELEASE GATES ONLY
- The global test suite (`npm test`) is strictly opt-in and may ONLY be run when explicitly commanded by the user or as the single final gate immediately prior to tagging a release or opening a PR.
- Test economy does NOT weaken correctness, security, or data integrity: it ensures high velocity and eliminates test fatigue.
