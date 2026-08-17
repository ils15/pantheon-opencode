# Implementation: beta recovery cleanup

## Scope

- Normalize GitHub tag API object and peeled commit SHAs to lowercase,
  canonical 40-hex values before exact target comparison.
- Document that only the exact `release:beta` label triggers beta releases;
  next-version intent is handled by workflow inputs/logic.
- Add focused regression coverage for lightweight and annotated tags, SHA
  normalization, label semantics, and the verified focused test count.

## Verification

- Workflow-equivalent Node tests: **139/139 passed** (`node --test tests/*.mjs`).
- Full `node --test` baseline: **150 passed, 1 unrelated TSX loader failure**
  (`tests/pantheon/tui-delegations.test.ts`); this is not the release gate.
- Pytest: **98 passed, 1 skipped** (`python3 -m pytest tests/ -q --tb=short`).
- Focused release set: **55/55 passed** (`node --test
  tests/release-workflow-security.test.mjs tests/release-beta-version.test.mjs
  tests/release-notes.test.mjs`), including **23** workflow-security tests and
  **4** beta-version tests.
- Version check: passed (`node scripts/version-check.mjs`).
- Secret scan: passed (`node scripts/secret-scan.mjs`).
- YAML verification: **15/15 agents valid** (`python3 scripts/ci-validate-yaml.py`).
- Biome: **fails on pre-existing repository-wide lint/format findings** (118
  errors, 128 warnings, 68 infos); no unrelated source cleanup was performed.

## Safety

No publish, tag, merge, or label operation was performed.
