# F3a — Zeus control vs Talos root, scenario B

**Date:** 2026-10-14 (local)\
**Runtime:** OpenCode v2.0.29\
**Model:** `opencode-go/glm-5.3-flash`\
**Commit:** `ee37fbb` (`gitDirty=false`)\
**Profile:** double-injection, with D4 provenance in every run\
**Protocol:** five serial control/candidate pairs (`C1,K1,…,C5,K5`); no code or config edits during measurement.\
**Full per-run record:** [`phase3-root-paired-20261014.json`](./phase3-root-paired-20261014.json)\
**Pre-registered oracle:** [`f3a-root-oracle-2026-10-14.md`](./f3a-root-oracle-2026-10-14.md)

## Acceptance audit

- Both arms completed **5/5** runs and passed the artifact oracle **5/5**. Each run created only `bench-run-B.md` plus the harness-provided `AGENTS.md` and hook log in its run directory. The artifact was a regular, non-symlink UTF-8 file with a three-country Markdown table in the required rank order; populations were within the oracle's ±2% tolerance against UN WPP 2024.
- D4 recorded exactly the configured global and project instruction fixtures in all 10 runs: global `AGENTS.global.md`, 11,410 bytes, SHA-256 `797fb47ef83ee8d5aafaee37f2c9fcd8a56137210d0f4333fd9b0045d5753eb3`; project `AGENTS.md`, 1,990 bytes, SHA-256 `199ae5614ad5413fc14efc9cfb585383a7ef62fd360ac91c9aa27d033b37c6b0`.
- The control observed Zeus at the root with no parent and created one child in each run. The candidate observed Talos at the root with no parent, created **zero children in 5/5**, and made **zero `subagent` calls in 5/5**. All token fields were available for every assistant message in every run.
- All 10 run directories are retained under `/tmp/opencode/bench-1792031859236/` for direct artifact inspection. The earlier v2.0.27 preflight was interrupted after its first Zeus run when the runtime mismatch was detected; it has no result JSON and is excluded from this sample.

## Results

| Metric | Zeus control | Talos candidate | Change / interpretation |
|---|---:|---:|---|
| Wall median | 31.893 s | 30.347 s | −4.8%; inconclusive within same-day spread |
| Wall p80 | 35.460 s | 44.558 s | Candidate tail is higher |
| Wall range | 21.393–37.160 s | 7.631–67.957 s | High variance; no latency claim |
| Input tokens, total over five runs | 163,607 | 76,655 | −53.1% observed |
| Input tokens, per-run median | 33,301 | 16,171 | −51.4% observed |
| Cache-read tokens, total | 136,832 | 56,576 | −58.7% observed; monetary cost not inferred |
| First-request context proxy, per-run median | 12,882 | 9,440 | −26.7% observed |
| Root children | 5 total | 0 total | Candidate met the no-child criterion in 5/5 |

The scenario-B result supports the narrow F3a claim that explicitly starting Talos as the root can produce the requested artifact without a child session in five of five runs, with lower observed token use. This does not establish a wall-time improvement: the wall-time distributions overlap widely, and cost in money remains unavailable because provider pricing and cache billing semantics were not part of this measurement. It is not a general routing claim for other tasks or agents.
