# Implementation: commitlint `opencode-v2` scope hotfix

## Change

- Added the explicit `opencode-v2` scope to `commitlint.config.cjs`.
- Added focused Node tests covering the merged squash title and rejection of
  arbitrary scopes, invalid types, and empty subjects.
- Documented the release-validation behavior in the README.

## Verification plan

```text
node --test tests/commitlint-config.test.mjs
npm run version:check
npm run secret-scan
npx biome ci commitlint.config.cjs tests/commitlint-config.test.mjs
```

The hotfix must be opened as a new branch/PR and must not merge, publish, tag,
or rewrite `main` history.
