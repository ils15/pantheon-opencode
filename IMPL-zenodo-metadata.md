# Implementation: Zenodo metadata for v1.4.3

**Date:** 2026-09-04  **Status:** Ready for review

## Scope

Prepared reproducible deposition metadata for the existing `v1.4.3` tag
without changing the project version or inventing a DOI.

## Changes

- Added `.zenodo.json` with the release URL, canonical repository, author,
  version, MIT software license, English metadata language, and a factual
  English/Portuguese description.
- Updated `CITATION.cff` with the full author name, release URL, canonical
  repository, version, MIT license, and a factual bilingual abstract.
- Corrected the v1.4.3 changelog entry so it records only the manifest version
  synchronization present in tag `v1.4.3`; post-tag documentation changes are
  not attributed to that release.

## Validation

- JSON parsing: passed (`python3 -m json.tool .zenodo.json`).
- YAML/CFF structural parsing: passed with PyYAML; no `cffconvert` validator
  was installed in the environment.
- Version consistency: passed (`node scripts/version-check.mjs`), all manifests
  remain at `1.4.3`.
- Relevant Node tests: passed, 39/39 (`tests/validate-zenodo-release.test.mjs`
  and `tests/release-notes.test.mjs`).
- `git diff --check`: passed.
