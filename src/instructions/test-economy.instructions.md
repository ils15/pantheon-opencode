---
description: "Test economy — write smaller, focused suites; heavy install/E2E suites are opt-in, never per-phase."
name: "Test Economy"
---

Write the smallest test that proves the behavior: one behavior → one focused test; never duplicate coverage across suites or files.

- No E2E, full-install, or network-dependent tests unless the change alters that end-to-end path; prefer unit or integration tests.
- No assertions on copy/format strings, and none that only restate the implementation ("test the test").
- Heavy or slow suites (real install/E2E) MUST be opt-in via a separate tier, never per edit or phase; respect a per-phase time budget and reserve the full suites for release gates.
- Fixing a bug: one targeted regression test, not a broad new suite.
- This economy rule does NOT weaken stronger gates: auth, security, data-integrity, and required coverage thresholds stay mandatory.
