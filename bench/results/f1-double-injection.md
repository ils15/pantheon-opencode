# F1 exploratory evidence — OpenCode v2.0.27 double-injection profile

**Date:** 2026-10-14 · **Branch:** `perf/beta10-latency` · **Model:** `opencode-go/glm-5.3-flash`
**Host:** opencode v2.0.27, repo plugin v2 · **Commit:** `736ebaf` (dirty) · **Profile:** `double-injection`
**Runs:** N=5 per arm, same-day, scenario B (the claim scenario). Scenario A is not re-measured —
it performs real web research and its wall is explicitly **not** a claim metric (F-13).

## Why this measurement exists

The F1 carve (`112409a`) splits one AGENTS.md into a global artifact (`AGENTS.global.md`) and a
repo-only project artifact (`AGENTS.md`). Its effect only exists where **both** surfaces are loaded
— the in-repo "double injection". The original F1 bench (`f1-112409a.json`) ran the **host** profile
(empty run dirs, global only), so it never loaded the duplicate the carve removes. This run fixes
that: the harness now materializes the project `AGENTS.md` inside every run directory and records,
per run, the identity of every instruction file the session actually loaded (D4).

## D4 fidelity proof (read from `instruction_state` / `instruction_blob`)

Every run of both arms loaded **exactly two** instruction files — the global surface and the project
surface — with the intended identities:

| arm | global file | project file | total loaded |
|---|---|---|---|
| control (pre-carve) | 11175 B (`f1-pre-carve-agents.md`) | 11175 B (same artifact) | **22350 B** |
| candidate (carved) | 11410 B (`AGENTS.global.md`) | 1990 B (`AGENTS.md`) | **13400 B** |

Payload removed by the carve: **8950 B (−40.0%)**. This is what makes the run auditable: the report
proves the intended artifacts were loaded instead of assuming the host injected them.

## Results (scenario B)

| metric | control (pre-carve) | candidate (carved) | Δ median | noise | classification |
|---|---|---|---|---|---|
| **first-request context tokens** (`input`+`cache.read`) | 17555 (17555–17569) | 15489 (15489–15503) | **−2066 (−11.8%)** | 14 | **exploratory; target v2.0.29 clean pair supersedes this result** |
| tree-total input tokens | 49939 (34034–106746) | 28907 (22678–36261) | −21032 (−42.1%) | 84068 | inconclusive |
| wall ms | 22881 (15225–98468, 6.47×) | 30127 (17136–42127, 2.46×) | +7246 | 83243 | inconclusive |

**First-request proxy — exploratory.** The instruction payload only lands on the first request; the
tree-total metric sums every turn and is dominated by session-length variance. This host-v2.0.27
pair showed a stable −2066-token shift, but it is not the target v2.0.29 run and its candidate arm
overlapped with a separate benchmark. The clean serial v2.0.29 result is recorded in
[`f1-di-v229-clean-2026-10-14.md`](./f1-di-v229-clean-2026-10-14.md).

**Tree-total input — inconclusive.** The direction is consistent (all five control runs exceed all
five candidate runs), but the pooled spread (84068) dwarfs the effect, and the effect is ~10× the
single-payload byte delta, so it cannot be attributed to the carve alone. Recorded as inconclusive.

**Wall — inconclusive.** Candidate median is slower, not faster; within-arm ratios reach 6.47×.
Wall is not a claim metric here.

## Caveats

- Both arms ran at `736ebaf` (dirty) with an identical working-tree hash
  (`7a10193a0942d2e045e49a9dd99456a145b2311a0cb596c8a5fa07d61c336004`).
- Concurrent bench activity was observed during the candidate arm (a separate process produced
  `f1-di-v229-*`). Treat the entire pair as exploratory; it is not used to claim target-runtime
  performance.
- Scenario A was not re-measured (network variance; F-13).

## Artifacts

- `bench/results/f1-di-control-736ebaf.json` — control arm (pre-carve fixtures).
- `bench/results/f1-di-candidate-736ebaf.json` — candidate arm (carved fixtures).
- `bench/fixtures/f1-pre-carve-agents.md` — frozen pre-carve artifact (11175 B).

Reproduce:

```bash
node bench/bin/bench.mjs --scenarios B --profile double-injection \
  --global-agents bench/fixtures/f1-pre-carve-agents.md \
  --project-agents bench/fixtures/f1-pre-carve-agents.md --label f1-di-control
node bench/bin/bench.mjs --scenarios B --profile double-injection \
  --global-agents AGENTS.global.md --project-agents AGENTS.md --label f1-di-candidate
```
