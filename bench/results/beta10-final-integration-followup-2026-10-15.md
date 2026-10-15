# Beta 10 final integration follow-up — Zeus control vs Talos root

**Date:** 2026-10-15
**Runtime:** OpenCode v2.0.29
**Model:** `opencode-go/glm-5.3-flash`
**Source commit:** `b53846f` (Talos artifact-completion instruction and its installed-prompt contract test)
**Measurement commit:** `116cd23` (`gitDirty=false`; preregistration only after the source commit)
**Protocol:** five serial, interleaved Zeus-control/Talos-root pairs (C1/K1…C5/K5); no edits or concurrent benchmark during measurement.
**Profile:** global + project instruction injection (D4).
**Pre-registered oracle:** [`beta10-final-integration-followup-oracle-2026-10-15.md`](./beta10-final-integration-followup-oracle-2026-10-15.md)
**Raw per-run record:** [`beta10-final-integration-followup-20261015.json`](./beta10-final-integration-followup-20261015.json)

This is a new cohort after the first final integration re-check recorded in
[`beta10-final-integration-2026-10-15.md`](./beta10-final-integration-2026-10-15.md).
That prior cohort remains preserved at 4/5 Talos artifacts; no run was replaced
or omitted. After K1 in that cohort stopped without writing its requested file,
Talos gained a narrowly scoped instruction to use native file tools for named
artifacts and not mistake MCP tool discovery for the native tool catalog. The
new task prompt, host runtime, model, fixtures, and pass criteria stayed the
same.

## Acceptance audit

- All ten sessions completed and were harness-eligible: Zeus 5/5, Talos 5/5.
- The artifact oracle passed **5/5 Zeus controls** and **5/5 Talos candidates**. Every output was a regular, non-symlink, non-empty UTF-8 Markdown file with exactly India, China, and the United States in rank order and values within ±2% of the frozen UN WPP 2024 references.
- Each run directory contained only the task artifact plus harness `AGENTS.md` and `.pantheon/logs/hooks.log`. The read-only session ledger showed each native `write` targeted that run's `bench-run-B.md`; the two Zeus `pantheon_bounded_read` calls were read-only. No write outside a run directory was observed.
- D4 provenance passed **10/10**: global `AGENTS.global.md`, 11,410 B, SHA-256 `797fb47ef83ee8d5aafaee37f2c9fcd8a56137210d0f4333fd9b0045d5753eb3`; project `AGENTS.md`, 1,990 B, SHA-256 `199ae5614ad5413fc14efc9cfb585383a7ef62fd360ac91c9aa27d033b37c6b0`.
- Root identity matched in 10/10 with no parent. Zeus created one child per control; Talos created **zero children in 5/5** and made no `subagent` call or delegation fallback in 5/5.
- Token fields were present for every assistant message in all ten runs. No unavailable metric was reported as zero.

**Disposition:** this follow-up passes the pre-registered final integration oracle, including F3a's 5/5 Talos artifact criterion. The earlier 4/5 cohort remains part of the evidence and is not hidden. Together, the two cohorts show why the artifact-completion guidance was needed and that the corrected Talos prompt passed one new independent N=5 cohort. This supports only the explicit Talos-root scenario B behavior; it does not establish automatic routing or general reliability for other tasks.

## Descriptive measurements

| Metric | Zeus control | Talos candidate | Interpretation |
|---|---:|---:|---|
| Completed sessions | 5/5 | 5/5 | All sessions completed |
| Artifact oracle | 5/5 | 5/5 | Both arms passed |
| Wall median | 69.239 s | 68.668 s | −0.8%; inconclusive |
| Wall p80 | 71.565 s | 111.476 s | Candidate tail is higher |
| Wall range | 30.198–100.681 s | 16.449–152.467 s | Large spread: 3.33× / 9.27× |
| Input tokens, five-run total | 150,680 | 114,332 | Descriptive; distributions overlap |
| Input tokens, per-run median | 31,444 | 24,314 | −22.7%, descriptive only |
| Output tokens, five-run total | 6,416 | 5,731 | Descriptive only |
| Cache-read tokens, five-run total | 228,224 | 128,256 | Billing semantics not measured |
| First-request context proxy, median | 13,009 | 9,675 | −3,334 (−25.6%), confirmed against same-arm spread |

The first-request proxy was stable in both arms: Zeus values were 13,009–13,023
(14-token spread), and all Talos runs were 9,675. Tree-total input ranges
overlap; only the first-request context proxy is called confirmed here. Wall
distributions overlap widely, with the candidate p80 higher, so latency is
**inconclusive**. Token counts do not establish monetary savings.

## Reproduction

The v2.0.29 binary was pinned through the isolated sandbox install. The exact
benchmark invocation was:

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
  --label beta10-final-integration-followup-20261015 \
  --out bench/results/beta10-final-integration-followup-20261015.json
```
