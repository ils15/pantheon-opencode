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

## Themis follow-up

- Added the Zenodo release integration guidance to `README.pt-BR.md`, matching
  the English README without changing workflow behavior.
- Applied Biome formatting to `scripts/zenodo-release-state.mjs` only.
- Removed the evident Ruff violations from
  `tests/test_mcp_resources_server.py`: unused imports and imports inside
  functions; pre-existing MCP-related test changes were preserved.

## Follow-up verification

- Ruff targeted check: passed.
- Biome check for `scripts/zenodo-release-state.mjs`: passed.
- Affected tests: **43 passed, 1 skipped**.
- `git diff --check`: passed.

## Lint gate follow-up

- Applied Biome's mechanical formatting and import organization fixes to the
  files reported by the complete gate, without changing runtime behavior.
- Removed only genuinely unused bindings: `skipped` in `scripts/sync-tui.mjs`,
  `silentLogger` in `src/pantheon/model-command.ts`, and unused test imports.
- Changed the single-assignment declaration in
  `scripts/install/model-picker.mjs` to `const`.

## Lint gate verification

- `npm run lint`: passed with 0 errors (117 existing warnings and 34 infos).
- Affected TypeScript tests: **52 + 9 + 83 passed**, 0 failed.
- Affected Node tests: **51 + 1 passed**, 0 failed.
- `git diff --check`: passed.

## README parity follow-up

- Aligned `README.pt-BR.md` with the current canonical `README.md` structure:
  quick start, documentation links, beta releases, contribution guidance,
  Zenodo integration, project limits, and license/citation.
- Kept the English README canonical while using natural Portuguese headings and
  prose; documented only behavior and integrations present in the repository.
- Reviewed heading levels and local link targets in both README files to reduce
  future semantic drift. Workflow files were not changed.

## README verification

- Local markdown link and heading-level parity check: passed.
- `node scripts/version-check.mjs`: passed (all manifests at v1.4.3).
- `node --test tests/version-check.test.mjs`: **11/11 passed**.
- `node --test tests/release-workflow-security.test.mjs`: **24/24 passed**.
- `git diff --check`: passed.
- Markdown CLI checks were attempted, but `markdownlint-cli2` and
  `markdown-link-check` are not installed and `npx --no-install` correctly
  refused to fetch them; the repository-local link check passed instead.

## Ruff gate follow-up

- Classified the initial 116 findings against the feature diff: **0 introduced**
  findings; the reported Python violations were legacy findings in existing
  scripts, MCP implementation copies, vector-memory utilities, and tests.
- Applied only mechanical, behavior-preserving fixes: import organization and
  removal of unused bindings, `datetime.UTC`, context-managed file access,
  explicit subprocess status handling, safe iterator/comparison simplifications,
  and a raw regex pattern.
- Preserved all MCP changes, including `scripts/mcp_resources_server.py`,
  `src/mcp/mcp_resources_server.py`, and their tests. Version remains strictly
  **1.4.3**.
- Kept intentional lazy imports, legacy hyphenated script module names, broad
  public signatures, complexity, and fixture/test magic values out of the gate
  through explicit per-file Ruff scope in `pyproject.toml`; these were not
  refactored because doing so could alter behavior or test intent.

## Ruff gate verification

- `ruff check .`: **passed with 0 errors**.
- `python3 -m pytest tests/ -q --tb=short`: **247 passed, 1 skipped**.
- `node scripts/version-check.mjs`: passed; all manifests remain at **1.4.3**.
- `git diff --check`: passed.
