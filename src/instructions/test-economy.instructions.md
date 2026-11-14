---
description: "Test economy — sub-10s test slicing; heavy suites are opt-in."
name: "Test Economy"
---

Write one focused test per behavior; do not duplicate coverage.

- **Test Slicing**: In dev loops, run ONLY the narrowest slice (<10s) for changed code (`node --test <slice>`, `pytest -k`); avoid unconstrained suites.
- **Repo Selector First**: Prefer repo selectors (`test:quick`, `test:slice`) over manual path guessing.
- **Observable Receipt**: `subtask_summary` `tests:` records command, targets, duration, and selection reason.
- **Failure/Fix Loops**: Rerun ONLY failed checks; never rerun passing tests without code changes.
- **Mapping Gaps**: If a file lacks tests, run static check fallback plus nearest slice.
- Slow install/E2E suites are opt-in, never per edit; reserve for release gates.
- Test economy does NOT weaken stronger gates: auth, security, data-integrity, and required coverage.
