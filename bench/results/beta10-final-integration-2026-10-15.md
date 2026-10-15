# Beta 10 final integration — Zeus control vs Talos root

**Date:** 2026-10-15
**Runtime:** OpenCode v2.0.29
**Model:** `opencode-go/glm-5.3-flash`
**Measured source:** `9c6de9e` (`gitDirty=false`)
**Protocol:** five serial, interleaved Zeus-control/Talos-root pairs (C1/K1…C5/K5); no edits or concurrent benchmark during measurement.
**Profile:** global + project instruction injection (D4).
**Pre-registered oracle:** [`beta10-final-integration-oracle-2026-10-15.md`](./beta10-final-integration-oracle-2026-10-15.md)
**Raw per-run record:** [`beta10-final-integration-20261015.json`](./beta10-final-integration-20261015.json)

## Acceptance audit

- All ten sessions completed and were harness-eligible: control 5/5, candidate 5/5. Completion and harness eligibility do not imply artifact correctness.
- The artifact oracle passed **5/5 Zeus controls** and **4/5 Talos candidates** (9/10 artifacts total). The four Talos files and all five Zeus files were regular, non-symlink, non-empty UTF-8 Markdown files with India, China, and the United States in rank order. Their population values were within ±2% of the frozen UN WPP 2024 references. There were no extra task-created files in any run directory.
- Candidate run K1 (run 02) completed but created no `bench-run-B.md` and made no `write` call. Its final response said it could not create the file after inspecting the tool catalog. Since the other four Talos runs used the native `write` tool successfully, the session is recorded as an artifact failure; it is not evidence that the host lacked write capability. This run was preserved and not replaced.
- D4 provenance passed **10/10**: each run loaded the expected global fixture (11,410 B, SHA-256 `797fb47ef83ee8d5aafaee37f2c9fcd8a56137210d0f4333fd9b0045d5753eb3`) and project fixture (1,990 B, SHA-256 `199ae5614ad5413fc14efc9cfb585383a7ef62fd360ac91c9aa27d033b37c6b0`).
- Root identity matched in 10/10, with no parent. Zeus created one child in each control. Talos created **zero children in 5/5** and issued no `subagent` call or delegation fallback in 5/5.
- Token fields were available for every assistant message in all ten runs. No missing metric was treated as zero.

**Disposition:** this pre-registered final integration re-check does **not** meet the F3a 5/5 artifact correctness threshold. The earlier F3a sample remains in its own report as a separate 5/5 result; it does not replace or erase this integration failure. The final integration gate remains open pending a reviewed disposition and, if appropriate, a new pre-registered run after any change. No F3a correctness claim is made from this run.

## Descriptive measurements

| Metric | Zeus control | Talos candidate | Interpretation |
|---|---:|---:|---|
| Completed sessions | 5/5 | 5/5 | All sessions completed |
| Artifact oracle | 5/5 | 4/5 | Candidate did not meet acceptance |
| Wall median | 98.493 s | 66.590 s | Distributions overlap; no latency claim |
| Wall p80 | 142.041 s | 93.632 s | Descriptive only |
| Wall range | 61.995–205.644 s | 20.642–117.679 s | Same-day spread is large (3.32× / 5.70×) |
| Input tokens, five-run total | 193,411 | 143,044 | Descriptive; includes the failed-artifact run |
| Input tokens, per-run median | 41,658 | 32,503 | Descriptive; no cost claim |
| Output tokens, five-run total | 7,115 | 4,582 | Descriptive; no cost claim |
| Cache-read tokens, five-run total | 187,520 | 254,400 | Cache billing semantics not measured |
| First-request context proxy, median | 13,009 | 9,568 | Descriptive only; not an acceptance claim |

The wall distributions overlap widely, and their ranges are much larger than the median difference. Wall-time improvement is therefore **inconclusive**. Token counts do not establish monetary savings. Because the candidate artifact gate failed, token differences are not used to claim an accepted optimization.

## Reproduction

The v2.0.29 binary was pinned through the isolated sandbox install. The exact benchmark invocation was:

```bash
PATH="$HOME/pantheon-sandbox/home/.npm-global/bin:$PATH" \
BENCH_MODEL=opencode-go/glm-5.3-flash \
node bench/bin/bench.mjs \
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
