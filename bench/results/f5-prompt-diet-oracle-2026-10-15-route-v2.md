# F5 — pre-registered oracle: one-owner composite task

Registered before measurement on 2026-10-15. This is a new, independent
measurement. It does not replace, omit, or amend either earlier F5 result.

## Frozen task and correctness oracle

- Task fixture: `bench/fixtures/f5-task-2024-un.md`, 414 bytes, SHA-256
  `e6cee2f4af984a9063d19724a74c509a7d38f04f4252b31d88671464e5b758ae`.
- Source: United Nations Population Division, *World Population Prospects
  2024*, figure 4.4. Required 2024 order and values: India (1,451 million),
  China (1,419 million), and the United States of America (345 million), each
  within ±2%. Source document:
  [WPP 2024 Summary of Results](https://population.un.org/wpp/assets/Files/WPP2024_Summary-of-Results.pdf).
- Every run must complete and create only `bench-run-B.md` as its task
  artifact. It must be a regular non-symlink UTF-8 Markdown file, name WPP
  2024, and give the three countries in rank order within tolerance.
  Completion, artifact correctness, and routing are independent checks.

## Arms and provenance

- Runtime: isolated installable OpenCode v2.0.29, repository V2 plugin;
  model `opencode-go/glm-5.3-flash`; scenario B; `double-injection` profile.
- Five serial, interleaved pairs C1/K1 through C5/K5. No concurrent bench or
  edits during measurement. Failed or outlier runs are retained; none may be
  replaced, repaired, or omitted.
- Intervention source is Pantheon commit `ad17806`, which adds the
  one-owner rule for composite research-and-deliverable tasks. Control and
  candidate differ only in Zeus prompt content. The measurement checkout is
  the clean oracle-recording commit; all other runtime/configuration inputs
  remain fixed.
- Control Zeus: `bench/fixtures/f5-control-zeus.md`, 29,477 bytes, SHA-256
  `11c79c4e69922bb30fba2f54e5cb39f7d83971c747502457f104fd82009d2c0b`.
- Candidate Zeus generated from `ad17806`: 22,037 bytes, SHA-256
  `bc6273cfad82571d012b52cfadda5bd70803c7121f15f033364cda935c5de2ef`.
  It includes one specialist owning this bounded research-and-deliverable
  task end-to-end, with splitting allowed only for independent expertise.
- Global `AGENTS.md`: 11,410 bytes, SHA-256
  `797fb47ef83ee8d5aafaee37f2c9fcd8a56137210d0f4333fd9b0045d5753eb3`.
  Project `AGENTS.md`: 1,990 bytes, SHA-256
  `199ae5614ad5413fc14efc9cfb585383a7ef62fd360ac91c9aa27d033b37c6b0`.
  All non-Zeus agent definitions, skills, plugin, config, permissions, task
  fixture, and runtime are identical between arms. Every run must prove both
  instruction fixtures through D4. The task is supplied with `--prompt-file`;
  its relative path, byte count, and SHA-256 must appear in the report.

## Routing oracle

Every run must expose Zeus as root with no parent and provide session-agent
identities plus the tool-call ledger. Each paired control/candidate descendant
tree must match after normalizing session IDs to parent depth and agent name;
the `subagent` tool-call counts must also match. All five pairs must pass.
Missing routing evidence is unavailable and cannot pass.

## Metrics and acceptance

- Primary metric: median `firstRequest.contextTokens` per eligible run, equal
  to first assistant request `tokens.input + tokens.cache.read`.
- Confirm the context signal only if candidate median is at least 10% below
  control and the absolute median shift exceeds the larger arm's max-minus-min
  range. Otherwise classify it as inconclusive.
- F5 passes only if all five runs per arm have complete first-request fields,
  D4 passes in every run, all ten artifacts pass, all five routing pairs pass,
  and the primary metric is confirmed. Report input, cache-read, context, and
  wall medians/ranges separately, including all failures and unavailable data.
- Wall is a distinct claim and counts only if the difference exceeds the
  same-day spread. Monetary cost remains unavailable absent verified model
  pricing and cache billing semantics.
