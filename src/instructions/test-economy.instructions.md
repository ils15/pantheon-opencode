---
description: "Test economy — write smaller, focused suites; heavy install/E2E suites are opt-in, never per-phase."
name: "Test Economy"
---

Write one focused test per behavior; do not duplicate coverage.

- Prefer unit/integration checks; use E2E, install, or network tests only when a change affects that path.
- Avoid assertions on copy/formatting or tests that merely restate the implementation.
- Default to focused tests; run the full suite only for scope, risk, or CI/release gates. Bug fixes need one regression test unless existing coverage catches them.
- Keep slow install/E2E suites opt-in, never per edit or phase; reserve them for release gates.
- Test economy does NOT weaken stronger gates: auth, security, data-integrity, and required coverage.
