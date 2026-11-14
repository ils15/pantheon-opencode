---
name: test-slicing
description: "Targeted test execution — map changed files directly to their narrow test slice instead of running full suites."
---

# Test Slicing (Observable & Enforceable)

> **Never run unconstrained repository-wide test suites for isolated edits. Map modified files directly to their narrow, sub-10s test slice to eliminate test fatigue, conserve tokens, and maintain high developer velocity.**

---

## Core Rules & Protocol (Issue #437)

### 1. Repository-First Selector Discovery
Always prefer the repository's own focused selector or diff-aware command over guessing paths:
1. Inspect `package.json` / `pyproject.toml` / `Makefile` for focused slice runners:
   - Node/TypeScript: `npm run test:quick`, `npm run test:slice`, `npm run test:fast`, `node scripts/test-slice.mjs`
   - Python: `pytest -k <selector>`, `pytest tests/test_<slice>.py`
2. If a project-defined focused selector exists, execute it directly.
3. If absent, map the modified file directly to its corresponding test file.

### 2. Scope Escalation & Risk-Based Protocol (Issue #444)
- **Focused Slice First:** Identify affected files/behaviors and run the narrowest slice (<10s).
- **Triggers for Package-Level Expansion:** Broaden beyond the local slice ONLY when changes:
  1. Cross module/package boundaries
  2. Alter public API/contracts or data schemas/migrations
  3. Touch authentication, authorization, or security boundaries
- **Broad Suite Distinction:** When running a broad suite, state explicitly whether it is an agent recommendation or a mandatory repository/CI gate.
- **Never Delete Tests to Speed Up:** Propose test removal only with concrete evidence of duplication, flakiness, or zero detection value.
- **CLI vs Code Execution:** Execute CLI binaries (`opencode-quota`, `git`, `npm`, `pytest`) via `shell`/`bash`, never JS eval (`execute`); on failure, never glob `~/.config`.
- **Mapping Gap Handling:** If a modified file has no direct test counterpart:
  1. Report the mapping gap explicitly: `[Test Mapping Gap] No direct test file for <file>.`
  2. Execute a bounded risk-appropriate fallback (static lint/typecheck gate plus closest slice).
  3. DO NOT escalate to running the entire repository test suite.

### 3. Failure/Fix Loop (Rerun Only Failed Tests)
- After an initial edit, run only the selected slice.
- When an assertion or test fails:
  1. Diagnose and apply the fix to the target file.
  2. **Rerun ONLY the failed test** (e.g. `pytest tests/test_foo.py -k <failing_func>` or `node --test tests/foo.test.mjs --test-name-pattern="<failing_test>"`).
  3. **DO NOT rerun checks that already passed** when their covered code did not change.
  4. Once the targeted test passes, rerun the single slice file once to confirm no regressions within the file.

### 4. Observable Task Receipt Summary (Issue #444)
Every implementation specialist MUST include the detailed test receipt in `subtask_summary`, distinguishing agent-executed tests from CI gates and pending validations:
```markdown
**tests:** [PASS | WARN | FAIL] `<command>` (targets: N, duration: <X>s, selection: <reason or repo selector>)
**validation_scope:** focused_slice | package_suite | ci_gate_required
**pending_validation:** none | [deferred broad suites / CI gates]
```
*Example:*
`**tests:** [PASS] npx tsx tests/pantheon/auto-permissions.test.ts (targets: 10, duration: 0.12s, selection: direct file slice for auto-permissions.ts)`

### 5. Preserving CI and Release Gates
- Full-suite checks (`npm test`, unconstrained `pytest`, full CI pipelines) remain required and intact for release gates and PR validations.
- Developer loops run narrow slices exclusively.

---

## Slicing Rules by Ecosystem

| Runtime / Framework | Changed Source File | Sliced Test Command |
|---|---|---|
| **Node.js (Built-in test runner)** | `src/foo.ts` / `src/foo.js` | `node --test tests/foo.test.mjs` (or `npm test -- tests/foo.test.mjs`) |
| **Pantheon Engine** | `src/pantheon/<module>.ts` | `npx tsx tests/pantheon/<module>.test.ts` or `npm run test:quick` |
| **Vitest** | `src/components/Button.tsx` | `npx vitest run src/components/Button.test.tsx` |
| **Jest** | `src/utils/calc.ts` | `npx jest src/utils/calc.test.ts` |
| **Pytest** | `src/service/auth.py` | `pytest tests/test_auth.py -k <test_func>` |
| **Playwright / E2E** | `src/pages/login.tsx` | Run single spec file only when UI contract changes |

---

## Lint-First Fast Gate (< 50ms)

Before launching the test runner, run a static syntax/linter check on the modified file:
- **Python:** `ruff check <file>` (~20ms)
- **TypeScript / JavaScript:** `npx biome check <file>` (~30ms) or `tsc --noEmit`

Catching syntax errors, missing imports, and broken brackets at the lint gate saves test loop latency and avoids test runner crashes.

---

## Execution Guardrails

1. **Timeout Budget:** A sliced check must complete in < 10 seconds. If a test hangs or takes > 30s, abort immediately and check background task/locks.
2. **Failure Isolation:** Read the exact assertion failure and stack trace. Do NOT run unrelated test suites hoping for clues.
3. **No Flaky Re-runs:** Do not blindly re-run the same failing test in a loop without inspecting code or diffs.
4. **Token Economy:** Pass flags that suppress noise:
   - Node: `node --test tests/foo.test.mjs` (clean output).
   - Pytest: `pytest tests/test_foo.py -q --tb=short`.
   - Jest/Vitest: `--bail --silent`.
