---
description: "Test economy — write smaller, focused suites; heavy install/E2E suites are opt-in, never per-phase."
name: "Test Economy"
---

Write the smallest test that proves the behavior: one behavior → one focused
test, never the same coverage duplicated across suites or files.

- Do NOT add E2E, full-install, or network-dependent tests unless the change
  actually alters that end-to-end path. Prefer unit or integration tests.
- Do not assert on copy/format strings redundantly, and do not write
  assertions that only restate the implementation ("test the test").
- Heavy or slow suites (e.g. real install/E2E) MUST be opt-in via a separate
  script/tier. Never run them per edit or per phase; run only the affected
  subset.
- Respect a per-phase validation time budget: if a suite takes minutes,
  justify running it and prefer the targeted subset. Reserve the full heavy
  suites for release gates.
- Fixing a bug: add one targeted regression test, not a broad new suite.
- This economy rule does NOT weaken stronger gates: auth, security,
  data-integrity, and required coverage thresholds stay mandatory.
