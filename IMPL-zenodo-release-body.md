# Implementation: Zenodo release body handoff and crash recovery

**Date:** 2026-09-03  **Status:** Awaiting Themis Review

## What Was Implemented

- `.github/workflows/zenodo.yml` — persists the release-body file path through
  `GITHUB_ENV` and reads it in the later publication step. The Zenodo token
  remains step-scoped and is not written to the environment file or logs.
- `scripts/recover-zenodo-deposition.mjs` — searches the existing configured
  `ZENODO_DEPOSITIONS_URL` with its `q` parameter for a unique release/tag
  marker in deposition metadata. Exactly one match is adopted; zero or
  ambiguous matches fail closed before any duplicate POST.
- `tests/zenodo-workflow.test.mjs` — verifies the cross-step handoff and
  deterministically covers successful `published` + DOI persistence followed by
  an idempotent rerun with no additional creation/publication calls, plus
  deterministic crash, zero-match, and multiple-match recovery cases.
- HIGH blocker fix — the workflow now validates recovered `{id, doi}`, writes
  those values back into the state file, and does not overwrite them with the
  original `pending` state. Recovery remains `created` so the real publication
  step fetches, uploads if needed, publishes, and updates the release marker.
- Pagination is fail-closed: all paginated pages are followed, totals must be
  stable and complete, and pagination links must remain on the configured HTTPS
  Zenodo origin.

## Operational Requirement

The configured Zenodo collection URL must support authenticated GET search via
its existing `q` query parameter and return records containing the release
marker in `metadata.description`. The workflow does not invent a new endpoint;
this search capability must be provided by the configured URL/API.

## Tests

- ✅ Targeted Node tests: **13/13 passed** (`node --test
  tests/zenodo-workflow.test.mjs tests/validate-zenodo-release.test.mjs`).
- ✅ Biome: changed files pass (`npx biome check
  .github/workflows/zenodo.yml tests/zenodo-workflow.test.mjs
  IMPL-zenodo-release-body.md`).
- ✅ YAML validation: **14/14 agents valid** (`python3 scripts/ci-validate-yaml.py`).
- ✅ `git diff --check`.
- ⚠️ `npm audit --audit-level=high` was attempted with a 120-second timeout;
  it timed out (exit 124) without producing a report, so audit success is not
  claimed.
