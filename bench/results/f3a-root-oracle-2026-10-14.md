# F3a scenario B oracle — explicit specialist root (pre-registered)

**Recorded:** 2026-10-14, before the F3a paired measurement.
**Runtime:** OpenCode v2.0.29 · **Model:** `opencode-go/glm-5.3-flash`.
**Profile:** double injection (`AGENTS.global.md` + project `AGENTS.md`).
**Arms:** same-day interleaved Zeus control / Talos candidate, five pairs.

## Task and population reference

Both arms receive the same literal task:

> Crie o arquivo `bench-run-B.md` contendo uma tabela markdown com os 3 países mais populosos do mundo e suas populações.

Use the 2024 country estimates in the UN's [World Population Prospects 2024
summary](https://population.un.org/wpp/assets/Files/WPP2024_Summary-of-Results.pdf):

| Rank | Country | Reference population |
|---:|---|---:|
| 1 | India | 1,451,000,000 |
| 2 | China | 1,419,000,000 |
| 3 | United States | 345,000,000 |

## Pass criteria

For each run, audit the run directory after timing:

1. `bench-run-B.md` exists as a regular, non-symlink UTF-8 file and is non-empty.
2. It contains a Markdown table with exactly India, China, and United States in rank order;
   populations are stated with clear units and fall within ±2% of the reference above.
3. The only task-created artifact is `bench-run-B.md`; harness `AGENTS.md` and
   `.pantheon/logs/hooks.log` are excluded. No write occurred outside the run directory.
4. Runtime completed successfully, but this is recorded separately from artifact correctness.
5. Requested and observed root agents match (`zeus` control; `talos` candidate), and the root
   session has no parent.
6. For every Talos candidate, `childrenCount` is exactly zero, the tool-call ledger is available,
   and no `subagent` tool call or delegation fallback was attempted. Unavailable identity,
   children, or tool-call data fails the acceptance check; it is not treated as zero.

Acceptance requires 5/5 candidate runs to pass every criterion, with no replacement of failures
or outliers. The Zeus control is audited by the same artifact oracle. Report wall time and tokens
separately; a latency gain is claimed only if it exceeds the same-day spread. Correctness and
runtime completion are independent outcomes.
