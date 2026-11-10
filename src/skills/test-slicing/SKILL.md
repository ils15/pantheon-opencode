---
name: test-slicing
description: "Targeted test execution — map changed files directly to their narrow test slice instead of running full suites."
---

# Test Slicing

> **Never run the entire repository test suite for an isolated micro-edit. Map modified files directly to their narrow test slice to save time, tokens, and context window.**

---

## When to Use

- Verifying bug fixes, refactors, or feature additions touching <= 3 files.
- Running focused checks during TDD (RED → GREEN → REFACTOR).
- CI-like broad suites (`npm test`, `pytest`) are reserved exclusively for:
  - User explicitly asks to run full test suite.
  - Final pre-release or pre-PR validation.
  - Changes affecting core cross-cutting infrastructure, migrations, or auth.

---

## Slicing Rules by Ecosystem

| Runtime / Framework | Changed Source File | Sliced Test Command |
|---|---|---|
| **Node.js (Built-in test runner)** | `src/foo.ts` / `src/foo.js` | `node --test tests/foo.test.mjs` (or `npm test -- tests/foo.test.mjs`) |
| **Vitest** | `src/components/Button.tsx` | `npx vitest run src/components/Button.test.tsx` |
| **Jest** | `src/utils/calc.ts` | `npx jest src/utils/calc.test.ts` |
| **Pytest** | `src/service/auth.py` | `pytest tests/test_auth.py -k <test_func>` |
| **Playwright / E2E** | `src/pages/login.tsx` | Run single spec file only when UI contract changes |

---

## Execution Guardrails

1. **Timeout Budget:** A sliced check must complete in < 10 seconds. If a test hangs or takes > 30s, abort immediately and check background task/locks.
2. **Failure Isolation:** When a test fails in the slice:
   - Read the exact assertion failure and stack trace.
   - Do NOT run unrelated test suites hoping for clues.
   - Fix the targeted failure and re-run only the failing slice.
3. **No Flaky Re-runs:** Do not blindly re-run the same failing test in a loop without inspecting code or diffs.
4. **Token Economy:** Pass flags that suppress noise:
   - Node: `node --test tests/foo.test.mjs` (clean output).
   - Pytest: `pytest tests/test_foo.py -q --tb=short`.
   - Jest/Vitest: `--bail --silent`.
