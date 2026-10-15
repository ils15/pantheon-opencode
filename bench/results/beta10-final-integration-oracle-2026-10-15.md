# Beta 10 final integration oracle — pre-registered

**Recorded:** 2026-10-15, before the final integration measurement.

**Source commit:** `8525bd6643c865d97a50da8942171d018bb1d71d` (`gitDirty=false`).

**Runtime:** OpenCode v2.0.29.

**Model:** `opencode-go/glm-5.3-flash`.

**Profile:** double injection (`AGENTS.global.md` + project `AGENTS.md`).

**Schedule:** five serial Zeus-control/Talos-root pairs, C1/K1 through C5/K5.

This is a final integration re-check of F3a on the committed beta10 tree after
F4A/F3b and the F5 rollback. It tests the explicit root-agent policy already
accepted for scenario B. It does not test automatic routing or establish a
latency benefit by itself.

## Frozen task and reference

Both arms receive the scenario-B prompt exactly as defined in
`bench/bin/bench.mjs`:

> Crie o arquivo bench-run-B.md contendo uma tabela markdown com os 3 países mais populosos do mundo e suas populações.

Audit populations against the 2024 country estimates in the UN's
[World Population Prospects 2024 summary](https://population.un.org/wpp/assets/Files/WPP2024_Summary-of-Results.pdf):

| Rank | Country | Reference population |
|---:|---|---:|
| 1 | India | 1,451,000,000 |
| 2 | China | 1,419,000,000 |
| 3 | United States | 345,000,000 |

## Pass criteria

Audit each run directory after timing; artifact inspection does not contribute
to `wallMs`.

1. The run completed successfully. Record completion separately from artifact
   correctness; a completed session alone is not a passing artifact.
2. `bench-run-B.md` is a regular, non-symlink, non-empty UTF-8 file. It contains
   a Markdown table with exactly India, China, and United States in rank order,
   clear population units, and values within ±2% of the reference.
3. `bench-run-B.md` is the only task-created artifact. Harness `AGENTS.md` and
   `.pantheon/logs/hooks.log` are excluded; no write occurred outside the run
   directory.
4. The observed root matches the requested root and has no parent. The control
   root is Zeus; the candidate root is Talos. Root identity, parent identity,
   child count, and tool-call ledger must be available to accept a run.
5. Each Talos candidate has zero children and no `subagent` call or attempted
   delegation fallback. Missing identity or tool-call data is unavailable, not
   zero.
6. Every run's D4 provenance proves the exact configured global and project
   instruction fixtures were loaded. The configured paths are `AGENTS.global.md`
   and `AGENTS.md`; their pre-run SHA-256 digests are respectively
   `797fb47ef83ee8d5aafaee37f2c9fcd8a56137210d0f4333fd9b0045d5753eb3` and
   `199ae5614ad5413fc14efc9cfb585383a7ef62fd360ac91c9aa27d033b37c6b0`.
7. Token fields must be available for every assistant message. Any unavailable
   metric remains unavailable; it is never reported as zero.

F3a's narrow correctness acceptance requires all five Talos candidate runs to
pass criteria 1–7. Report Zeus results under the same artifact oracle. Report
tokens and wall time separately. A wall-time improvement is eligible only when
the candidate/control result exceeds the same-day spread; otherwise latency is
inconclusive. No monetary cost claim is made from token counts.

## Frozen command

Run once, serially, with no other benchmark or edits during measurement. Preserve
all failures and outliers; do not replace a run.

```bash
BENCH_MODEL=opencode-go/glm-5.3-flash node bench/bin/bench.mjs \
  --scenario B --runs 5 \
  --profile double-injection \
  --global-agents AGENTS.global.md \
  --project-agents AGENTS.md \
  --agents-dir src/agents \
  --control-agents-dir src/agents \
  --skills-dir src/skills \
  --root-agent talos --control-root-agent zeus \
  --paired \
  --label beta10-final-integration-20261015 \
  --out bench/results/beta10-final-integration-20261015.json
```
