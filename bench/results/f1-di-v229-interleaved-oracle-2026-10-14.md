# F1 scenario B oracle — interleaved v2.0.29 rerun (pre-registered)

**Recorded:** 2026-10-14, before the next interleaved measurement sequence.
**Applies to:** the next complete C1/K1…C5/K5 sequence on OpenCode v2.0.29 only.
Earlier runs, including the sequential supporting pair, do not inherit this registration.

## Reference

Use the 2024 country estimates in the UN's [World Population Prospects 2024
summary](https://population.un.org/wpp/assets/Files/WPP2024_Summary-of-Results.pdf):

| Rank | Country | Reference population |
|---:|---|---:|
| 1 | India | 1,451,000,000 |
| 2 | China | 1,419,000,000 |
| 3 | United States | 345,000,000 |

## Pass criteria per run

1. `bench-run-B.md` exists and is non-empty.
2. It contains a Markdown table with one row for each country in rank order: India, China, United States.
3. Each population is stated and within ±2% of the reference above. Rounded values and equivalent units are accepted.
4. The run has no task artifact other than `bench-run-B.md`; harness `AGENTS.md` and `.pantheon/logs/hooks.log` are excluded.

Audit each of the five control outputs and five candidate outputs outside the timed interval. Correctness passes only at **5/5 in both arms**. Do not replace failed runs or outliers.
