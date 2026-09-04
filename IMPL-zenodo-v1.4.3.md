# IMPL-zenodo-v1.4.3
**Date:** 2026-09-04  **Status:** Awaiting Themis Review

## What Was Implemented
- `.github/workflows/zenodo.yml` — archives the checked-out `v1.4.3` commit explicitly, records SHA-256, validates the remote file checksum, updates an existing draft with `PUT`, and leaves it draft unless publication is explicitly requested.
- `scripts/zenodo-artifact.mjs` — deterministic checksum and fail-closed Zenodo file validation helpers.
- `tests/zenodo-workflow.test.mjs` — offline coverage for checksum mismatch, duplicate filenames, tooling checkout, idempotent markers, and draft publication gating.

## Safety Properties
- No DOI is required while a deposition remains a draft; publication still requires a DOI response.
- A matching release marker is reused, and a same-name file with a different checksum fails instead of uploading a duplicate.
- The token remains a secret-scoped environment value and is never written to release metadata or artifacts.

## Tests
- ✅ `node --test tests/zenodo-workflow.test.mjs tests/validate-zenodo-release.test.mjs`
- ✅ `python3 scripts/ci-validate-yaml.py`
- ✅ workflow shell blocks validated by the deterministic Node test suite
- ✅ `git diff --check`
- ✅ Biome check on all changed files
- ✅ `npm audit --audit-level=high` (0 vulnerabilities)
- ✅ secret scan passed
- ✅ `npm test` (247 passed, 1 skipped) and `npm run test:node` (247 passed)
