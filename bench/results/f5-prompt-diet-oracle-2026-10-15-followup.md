# F5 — follow-up oracle: source-aligned task (pre-registered)

Recorded before the follow-up measurement on 2026-10-15. This is an independent
measurement; it does not replace or amend
[`f5-prompt-diet-2026-10-15.md`](./f5-prompt-diet-2026-10-15.md).

## Frozen task and source

- Task fixture: `bench/fixtures/f5-task-2024-un.md`, 414 bytes,
  SHA-256 `e6cee2f4af984a9063d19724a74c509a7d38f04f4252b31d88671464e5b758ae`.
- The task names only the United Nations Population Division's *World
  Population Prospects 2024*. Its 2024 top-three table gives India (1,451
  million), China (1,419 million), and the United States of America (345
  million), in that order. Source: [WPP 2024 Summary of Results, figure 4.4](https://population.un.org/wpp/assets/Files/WPP2024_Summary-of-Results.pdf).
- Each run must complete and create only `bench-run-B.md` as a task artifact in
  its own run directory. The file must be a regular, non-symlink UTF-8 Markdown
  file with a table listing those three countries in rank order and the stated
  values within ±2%. It must name WPP 2024 as its source. Completion and
  artifact correctness are audited separately.

## Arms and controls

- Runtime: installable OpenCode v2.0.29, isolated binary; repo V2 plugin at the
  measurement commit.
- Model: `opencode-go/glm-5.3-flash`; scenario B; five serial, interleaved
  `control,candidate` pairs C1/K1 through C5/K5.
- Same Zeus root in both arms. Control prompt fixture:
  `bench/fixtures/f5-control-zeus.md`, 29,477 bytes, SHA-256
  `11c79c4e69922bb30fba2f54e5cb39f7d83971c747502457f104fd82009d2c0b`.
  Candidate Zeus prompt: 21,808 bytes, SHA-256
  `0ba6b120c557a483cb0c364b6f2cd8ebcd264ec0b1ef519dfdf19f0888c20c8b`.
- Global `AGENTS.md` fixture: 11,410 bytes, SHA-256
  `797fb47ef83ee8d5aafaee37f2c9fcd8a56137210d0f4333fd9b0045d5753eb3`.
  Project `AGENTS.md` fixture: 1,990 bytes, SHA-256
  `199ae5614ad5413fc14efc9cfb585383a7ef62fd360ac91c9aa27d033b37c6b0`.
  All remaining agent definitions, skills, plugin, config, permissions and
  runtime are identical across arms. Every run must prove both instruction
  fixtures loaded through D4. The paired task prompt is supplied through
  `--prompt-file`; its path, byte count and SHA-256 must be present in the
  report.
- No concurrent benches or edits during measurement. Do not replace, repair,
  or omit a failed or outlier run.

## Routing oracle

Every run must have observed root agent Zeus with no parent, and available
session-agent identities and tool-call ledger. For each pair, the control and
candidate descendant trees must match after normalizing session IDs to parent
depth and agent name; `subagent` tool-call counts must also match. Missing
routing evidence is unavailable and cannot pass.

## Improvement and acceptance thresholds

- Primary metric: median `firstRequest.contextTokens` per eligible run, equal
  to first assistant request `tokens.input + tokens.cache.read`.
- Confirm the context signal only if the candidate median is at least 10% below
  control and the absolute median shift exceeds the larger arm range (`max-min`).
  If the shift does not exceed that spread, classify the metric as inconclusive.
- F5 passes only if the metric is confirmed, all five runs per arm have complete
  first-request fields, all ten artifacts pass the frozen task oracle, and all
  five pairs pass routing parity. Report input, cache-read and context medians
  and ranges separately.
- Wall time is a separate claim and counts only if its difference exceeds the
  same-day spread. Monetary cost remains unavailable unless model pricing and
  cache billing semantics are verified.
