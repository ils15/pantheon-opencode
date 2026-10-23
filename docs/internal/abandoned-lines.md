> Internal record of abandoned release branches — kept so no security-relevant commit disappears silently.

# Abandoned release branches

The canonical 1.6.0 line is `release/v1.6.0`. The branches recorded here were abandoned by
maintainer decision on 2026-10-23. `release/1.6.0-stable` was removed from origin after this
record was committed; the remaining branches were left in place and are recorded only so their
commits stay traceable.

A commit counts as **unique** when it is reachable from the branch but from neither
`release/v1.6.0` nor `origin/main`. Patch equivalence was checked with
`git cherry release/v1.6.0 <branch>`: a commit listed as patch-equivalent already exists on the
canonical line under a different SHA.

## Summary

| Branch | Tip | Unique commits | Status |
|---|---|---|---|
| `release/1.6.0-stable` | `50b8fd7` | 14 — all patch-unique | abandoned, deleted from origin |
| `release/1.6.0-beta.7` | `af19c66` | 15 — all patch-unique | abandoned, retained |
| `release/beta-13-prep` | `ad0bae0` | 2 — all patch-unique | abandoned, retained |
| `release/beta-12-prep-rebuilt` | `a804431` | 1 — patch-unique | abandoned, retained |
| `release/1.6.0-beta.7-candidate` | `a619efe` | 1 — patch-unique | abandoned, retained |
| `release/1.6.0-beta.10` | `21736c0` | 0 — 3 commits, all patch-equivalent | abandoned, retained |

`release/1.6.0-beta.10` carries no unique content: its three commits exist on the canonical line
under different SHAs. `release/beta-13-prep` contains `a804431`, the tip of
`release/beta-12-prep-rebuilt`, which is why that commit appears in both lists.

## `release/1.6.0-stable`

Removed from origin. These commits are the reason this file exists: they include the v1.6.0
secret-scanner follow-ups and the TUI usage-timer fixes, and none of them are patch-equivalent to
anything on `release/v1.6.0` or `origin/main`, so the abandonment drops that work rather than
folding it in. The SHAs stay recoverable from any clone that fetched the branch before removal.

| SHA | Date | Subject |
|---|---|---|
| `50b8fd7` | 2026-10-10 | fix: close v1.6.0 installer and docs blockers |
| `055f866` | 2026-10-10 | perf: simplify agent orchestration |
| `7398dc3` | 2026-10-10 | test: close v1.6.0 stable validation gaps |
| `0b919ef` | 2026-10-10 | fix: preflight secret scanner payload size |
| `82666b4` | 2026-10-10 | docs: update secret scanner roadmap references |
| `31564ef` | 2026-10-09 | fix: fail closed on V2 scanner hook registration |
| `6f03f73` | 2026-10-09 | test(tui): cover active usage timer disposal |
| `5db0cbe` | 2026-10-09 | perf: move runtime secret scanning in-process |
| `0442f90` | 2026-10-09 | fix: guard sandbox config rewrite and reset paths |
| `2678474` | 2026-10-09 | docs: update quickstart stable release label |
| `4565700` | 2026-10-09 | fix(tui): defer usage polling until slot registration |
| `20fd427` | 2026-10-09 | docs: update installation guide release label |
| `2a9b176` | 2026-10-09 | fix(tui): fail open and dispose usage timers |
| `17ede2b` | 2026-10-09 | fix: harden stable sandbox and sync 1.6.0 metadata |

## `release/1.6.0-beta.7`

| SHA | Date | Subject |
|---|---|---|
| `af19c66` | 2026-10-10 | chore(release): prepare 1.6.0-beta.7 |
| `160a2ad` | 2026-10-10 | fix: close v1.6.0 installer and docs blockers |
| `0f3747b` | 2026-10-10 | perf: simplify agent orchestration |
| `916094a` | 2026-10-10 | test: close v1.6.0 stable validation gaps |
| `9410429` | 2026-10-10 | fix: preflight secret scanner payload size |
| `78ad3c7` | 2026-10-10 | docs: update secret scanner roadmap references |
| `f55bc1e` | 2026-10-09 | fix: fail closed on V2 scanner hook registration |
| `1c31c5b` | 2026-10-09 | test(tui): cover active usage timer disposal |
| `eac32a6` | 2026-10-09 | perf: move runtime secret scanning in-process |
| `9c579cc` | 2026-10-09 | fix: guard sandbox config rewrite and reset paths |
| `90c9655` | 2026-10-09 | docs: update quickstart stable release label |
| `9470f0a` | 2026-10-09 | fix(tui): defer usage polling until slot registration |
| `4da21d9` | 2026-10-09 | docs: update installation guide release label |
| `334f3ab` | 2026-10-09 | fix(tui): fail open and dispose usage timers |
| `a07c6a6` | 2026-10-09 | fix: harden stable sandbox and sync 1.6.0 metadata |

## `release/beta-13-prep`

| SHA | Date | Subject |
|---|---|---|
| `ad0bae0` | 2026-10-17 | chore(release): prepare v1.6.0-beta.13 |
| `a804431` | 2026-10-17 | chore(release): prepare v1.6.0-beta.12 |

## `release/beta-12-prep-rebuilt`

| SHA | Date | Subject |
|---|---|---|
| `a804431` | 2026-10-17 | chore(release): prepare v1.6.0-beta.12 |

## `release/1.6.0-beta.7-candidate`

| SHA | Date | Subject |
|---|---|---|
| `a619efe` | 2026-10-07 | chore(release): prepare v1.6.0-beta.7 candidate |

## `release/1.6.0-beta.10`

No unique commits — the three commits reachable from the branch and not from `release/v1.6.0`
(`21736c0`, `1fed283`, `05af670`) are all patch-equivalent to the canonical line; the same
changes ship as `637089e`, `61f14eb` and `1568895`.
