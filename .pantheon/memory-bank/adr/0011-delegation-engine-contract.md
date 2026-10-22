# ADR-0011: Delegation Engine Contract — Legacy vs Native

**Status:** Accepted
**Date:** 2026-09-13
**Approval:** Ratified 2026-09-13

## Context

Pantheon v1.5.0-beta.6 ships two coexisting delegation engines:

1. **Legacy** (`src/pantheon/delegation.ts`) — the original `pantheon_delegate` tool, exposed via `plugin.ts:582`. Default engine.
2. **Native** (`src/pantheon/delegate-manager.ts`) — uses OpenCode's native `task()` API. Opt-in via `PANTHEON_DELEGATE_MODE=native`.

`resolveDelegateMode` (`delegate-manager.ts:132-136`) defaults to `legacy`.

Key asymmetries between engines:

| Dimension | Legacy | Native |
|-----------|--------|--------|
| Board hygiene (prune/cap) | Not called | `pruneCompleted` + `enforceEntryCap` (delegate-manager.ts:304-305) |
| Atomic concurrency | Race on concurrent adds | Atomic board registration |
| Kill-switch `PANTHEON_DELEGATION=off` | Only covers native path | Covered |
| Read-only bypass on retry | Bug at `delegation.ts:970` | Clean |
| Signal leak / auto-wake dead | Bug at `auto-wake.ts:51` | Clean |

Initiative #143 (branch `fix/remove-pantheon-delegate-1.4.3`, commit `2d7a8c7`) attempted to remove `pantheon_delegate` and promote native as the sole engine. The branch was **deleted without merge** — no ADR or CHANGELOG entry documents the reason. `main` still registers the legacy tool.

## Decision

**Option A: Keep legacy as default for 1.5.x; mark native as experimental; migrate to native in 1.6.**

Rationale:
- Legacy is the battle-tested default — changing the default in a beta series risks regressions for all existing users.
- The legacy P0/P1 bugs are independent of this decision and are being fixed in parallel.
- A phased migration gives time to validate native in production before flipping the default.

### Sub-decisions

- **D1** — Legacy remains default through v1.5.x. `resolveDelegateMode` keeps returning `legacy` without env var.
- **D2** — Native stays opt-in experimental; not promoted to default until v1.6. README/CHANGELOG explicitly mark it experimental.
- **D3** — Branch `fix/remove-pantheon-delegate-1.4.3` (commit `2d7a8c7`) stays archived, not revived.
- **D4** — P0/P1 legacy bugs (read-only retry bypass `delegation.ts:970`, signal leak `auto-wake.ts:51`) are fixed on legacy regardless of this decision.
- **D5** — Migration: flip default in v1.6 only after (1) native in production ≥2 minor releases, (2) zero P0/P1 regressions from native, (3) `pantheon_delegate` removed (revive #143), (4) an Accepted ADR supersedes this one.

## Alternatives Considered

| Option | Verdict | Reason |
|--------|---------|--------|
| B — Revive 2d7a8c7, promote native immediately | Rejected | Native lacks battle-testing at scale; flipping default in beta risks silent regressions |
| C — Remove legacy immediately, native-only | Rejected | Same as B, plus breaks `pantheon_delegate` for existing workflows |
| D — Keep both engines indefinitely | Rejected | Dual maintenance cost; legacy bugs stay unfixed; contributor confusion |

## Consequences

### Positive
- Zero risk to existing users — default unchanged.
- Legacy P0/P1 bugs fixed independently.
- Native keeps getting validation in opt-in mode.

### Negative
- Dual-engine maintenance cost persists through 1.5.x.
- Legacy latent bugs (prune, atomicity) affect default users until fixed/v1.6.
- Contributor confusion — two engines require clear docs.

## Risks & Rollback

- Risk: native regressions found too late → mitigate with experimental labeling + telemetry.
- Risk: legacy bugs hit production before fix → mitigated by the parallel bug-fix track.
- Rollback: default stays legacy — no action needed.
- Prohibited: never flip the default without meeting D5 prerequisites.

## References

- Initiative #143 (branch `fix/remove-pantheon-delegate-1.4.3`, commit `2d7a8c7` — dangling)
- `src/pantheon/delegation.ts`, `src/pantheon/delegate-manager.ts`, `src/plugin.ts:582`
- `src/pantheon/background-job-board.ts:649,667`, `src/pantheon/auto-wake.ts:51`
