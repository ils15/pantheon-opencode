---
name: tdd-with-agents
description: "TDD enforcement with RED→GREEN→REFACTOR cycle and advanced testing patterns. Use for test-driven development across all layers."
---

# TDD with Agents

Use RED → GREEN → REFACTOR for behavior-changing implementation where a meaningful test can express the change. Keep verification proportional to the changed surface and risk; advanced testing patterns are reserved for changes that warrant them.

---

## Core Principle

> **For testable behavior changes, write the focused test first, observe RED, implement minimally, then refactor.**

## Proportional TDD

- Use the complete RED → GREEN → REFACTOR cycle for new or changed behavior when a focused test is practical. Include a focused regression check for bug fixes.
- For typo, formatting, documentation-only, or otherwise non-behavioral edits, do not invent a test; inspect the diff and run the narrowest relevant validation.
- Run targeted tests for a small change. Run broader suites when the changed surface, integration boundaries, or risk make them useful; do not run the whole suite solely because one line changed.
- If a relevant existing test already captures the behavior, use it instead of adding a duplicate. If no automated check can express the change, report the manual or static verification performed.
- Auth, security, payment, data-integrity, and schema/migration changes retain focused RED/GREEN tests, required regression coverage, and Themis review. Do not weaken a project-specific required safety gate.

---

## Batched Suite Implementation vs Micro-Iterative TDD

- **Single Bug / Regression:** Use strict micro-iterative RED -> GREEN -> REFACTOR (write 1 test, confirm RED, write fix, confirm GREEN).
- **Complete Feature Suites / Multi-Endpoint Modules:** Do NOT repeat a 3-turn RED-wait-GREEN loop for every single function (which causes turn explosion and sluggishness). Instead:
  1. Author the cohesive test specification covering the new contract/suite.
  2. Implement the module components satisfying that contract.
  3. Run the targeted test slice ONCE via `test-slicing` (< 100ms).
  4. Iterate only on assertions that fail.
- **Lint-First Fast Gate:** Run static syntax/lint checks (`biome check`, `ruff check`) before launching test runners. Fixing typos and missing imports at the lint gate saves up to 80% of test turnaround time.

---

## TDD Cycle (RED → GREEN → REFACTOR)

### RED — Write Failing Test
- Write test for the behavior you want
- Run it → **must fail** (confirms test works)
- Test should be specific: one assertion per test

### GREEN — Make It Pass
- Write **minimal** code to pass the test
- No extra features, no premature optimization
- If it feels hard → design problem; refactor test

### REFACTOR — Improve Without Breaking
- Clean up code while tests stay green
- Extract functions, rename, remove duplication
- Tests are your safety net

---

## Coverage Rules

- Follow a repository's explicit coverage threshold when the changed code is in its measurement scope; do not manufacture a coverage target for docs, formatting, or a tiny isolated edit.
- **Critical paths:** preserve project-required coverage and tests for auth, payments, and data integrity.
- **No snapshot testing** — test behavior, not output shape
- **Test edge cases**: empty input, null, boundary values, errors

---

## Workflow

```
1. Use a plan/spec only when scope, risk, or ambiguity warrants it; a bounded fix may proceed directly
2. Author test specification (RED)
3. Implement minimal code (GREEN)
4. Refactor and optimize (REFACTOR)
5. Run targeted test slice via test-slicing (< 100ms)
6. Themis reviews sensitive or material changes, checking changed behavior and applicable quality gates
7. Escalate unmet repository or safety-critical test requirements
```

---

## Anti-Patterns

- Proibido: escrever codigo de producao sem teste correspondente
- Anti-pattern: testar detalhes de implementacao privada ou acoplamento excessivo
- Anti-pattern: mocking excessivo de I/O em vez de testes de integracao direta
- Anti-pattern: ignorar falhas de teste sem diagnosticar o diff
- Anti-pattern: executar a suite inteira para mudancas locais delimitadas

---

## Routing

| Action / trigger | Reference |
|---|---|
| Writing tests for a specific layer (Hermes/Aphrodite/Demeter) or assigning per-agent test duties | [references/testing-by-layer.md](references/testing-by-layer.md) |
| When risk or surface warrants E2E, load, contract, mutation, or visual-regression testing | [references/advanced-testing-patterns.md](references/advanced-testing-patterns.md) |

A missing reference interrupts the action — read nothing in its place, never improvise from memory.
