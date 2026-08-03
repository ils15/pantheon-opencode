---
name: Pull Request
about: Standard pull request for pantheon-opencode
title: 'feat(scope): <short imperative summary>'
---

<!--
Title convention — Conventional Commits, in English:
  feat(scope): ...   new feature        fix(scope): ...   bug fix
  chore(scope): ...  maintenance        refactor(scope): ...  no behavior change
  docs(scope): ...   documentation      test(scope): ...  tests only
  release: ...       version/release PR
  Scope examples: vision, plugin, mcp, presets, tui, ci, install
-->

## Summary
<!-- 2-3 sentences: what this PR does, why, and the outcome. -->

## Changes
<!-- List by area (e.g. core, plugin, mcp, tests, docs). Bullet points. -->

## Root causes fixed
<!-- If this PR fixes bugs, fill the table. Otherwise delete this section. -->

| Issue | Root cause | Fix |
|-------|-----------|-----|
| | | |

## Testing
<!-- Commands run + results. Examples:
- `python3 -m pytest tests/ -q` — N passed
- `node tests/test_plugin_vision.mjs` — N asserts
- `npm run typecheck` — 0 errors
- `npm run lint` — clean
- `npm run secret-scan` — clean
-->

## Files changed
<!-- List of files, one per line. -->

## Notes
<!-- Blockers, decisions, follow-ups, external dependencies. -->

## Quality checklist
- [ ] Tests pass locally
- [ ] Lint clean (`npm run lint`)
- [ ] Typecheck clean (`npm run typecheck`)
- [ ] Secret scan clean (`npm run secret-scan`)
- [ ] No new dependencies without justification
- [ ] No secrets or credentials committed
