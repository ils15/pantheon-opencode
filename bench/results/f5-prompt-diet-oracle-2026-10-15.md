# F5 — Zeus prompt diet oracle (pre-registered)

Recorded before the paired measurement on 2026-10-15.

## Arms and controls

- Runtime: installable OpenCode v2.0.29, V2 plugin from the measured commit.
- Model: `opencode-go/glm-5.3-flash`.
- Task: scenario B, identical prompt and workspace setup for both arms.
- Root identity: Zeus in both arms.
- Order: five serial, interleaved pairs `control,candidate` (C1/K1 … C5/K5).
- Control Zeus prompt: frozen generated installed-form prompt
  `bench/fixtures/f5-control-zeus.md`, produced from commit `0ec09fb` before the
  prompt diet. Candidate: generated installed-form prompt from the measured
  source commit. Every non-Zeus agent prompt is generated from the same source
  for both arms.
- Global and project `AGENTS.md` fixtures, skills, plugin, configuration,
  permissions, timeout, and runtime are identical. Every run must prove the two
  expected instruction blobs with D4. No concurrent benches or edits during
  measurement; no failed or outlier run is replaced.

## Correctness oracle

Each run must complete and create only `bench-run-B.md` as a task artifact in
its own run directory. The file must be a regular, non-symlink UTF-8 Markdown
file with a table listing India, China, and United States in rank order and
2024 UN population estimates within ±2% of 1.451B, 1.419B, and 345M. Completion
and artifact correctness are audited separately.

## Routing oracle

Each run must have observed root agent Zeus, no root parent, available session
agent identities, and an available tool-call ledger. For each numbered pair,
the control and candidate must have identical descendant route trees after
normalizing session IDs to `(parent depth, agent)` and identical `subagent`
call counts. Missing route or tool evidence is unavailable and cannot pass.
This strict pairwise comparison detects routing changes, not just successful
completion.

## Improvement threshold

The primary metric is the median `firstRequest.contextTokens` per eligible run,
where the collector records `tokens.input + tokens.cache.read`. F5 is confirmed
only if the candidate median is at least 10% lower than control and the absolute
median shift exceeds the larger arm range (`max - min`). If the 10% threshold is
met but the shift does not exceed that same-day spread, classify the result as
inconclusive. F5 passes only with a confirmed shift, all five runs per arm
having complete first-request fields, all ten artifacts passing, and every pair
passing the routing oracle. Report input, cache-read, and context-token medians
and ranges separately. Wall time is a separate claim and only counts if its
difference exceeds the same-day spread. Monetary cost is unavailable unless
pricing and cache semantics can be verified.
