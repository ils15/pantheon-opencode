# F1 v2.0.29 double-injection pair — preliminary

**Date:** 2026-10-14 · **Model:** `opencode-go/glm-5.3-flash` · **Scenario:** B · **N:** 5 per arm
**Profile:** `double-injection` · **Runtime:** OpenCode v2.0.29 · **Plugin:** repo V2
**Source:** commit `736ebaf` plus working-tree diff `7a10193a0942d2e045e49a9dd99456a145b2311a0cb596c8a5fa07d61c336004`

This pair is retained as preliminary evidence. A separate v2.0.27 candidate benchmark overlapped
with the v2.0.29 candidate arm. The pre-registered correctness oracle was created after this pair,
so its outputs are only eligible for a post-run audit, not formal acceptance. A clean serial pair is
required before closing F1.

## D4 and first-request context

All 10 runs report exactly two loaded instruction files with the expected fixture identities.
Control loaded 22,350 B total (11,175 B global + 11,175 B project); candidate loaded 13,400 B
(11,410 B global + 1,990 B project), a difference of 8,950 B (−40.0%).

| Metric | Control | Candidate | Change | Classification |
|---|---:|---:|---:|---|
| First-request context tokens | median 17,555; range 17,555–17,569 | median 15,485; range 15,485–15,499 | −2,070 (−11.8%) | preliminary; clean replication pending |
| Tree-total input tokens | median 42,898 | median 33,751 | −9,147 (−21.3%) | ≤30k candidate hypothesis not met |
| Wall time | median 16.049 s; range 9.141–28.330 s | median 11.992 s; range 11.076–96.957 s | −4.057 s | inconclusive; overlap and high spread |

All roots were Zeus and completed. The candidate arm had one run with two children; the other nine
runs had one child. This pair does not establish a wall-time gain or the inherited ≤30k total-input
hypothesis.

## Artifacts

- `f1-di-v229-control-736ebaf.json`
- `f1-di-v229-candidate-736ebaf.json`
- `f1-di-v229-oracle-2026-10-14.md` — registered after this pair; applies only to the next clean pair.
