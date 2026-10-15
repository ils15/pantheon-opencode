# Beta 10 final integration follow-up oracle — pre-registered

**Recorded:** 2026-10-15, before the follow-up measurement.

**Measured source commit:** `b53846fdec1112eb79c94279155c94ea5e4649e4` (`gitDirty=false`).

**Runtime:** OpenCode v2.0.29.

**Model:** `opencode-go/glm-5.3-flash`.

**Profile:** double injection (`AGENTS.global.md` + project `AGENTS.md`).

**Schedule:** five serial Zeus-control/Talos-root pairs, C1/K1 through C5/K5.

This is a new cohort after a narrowly scoped Talos instruction change prompted by
the preserved 4/5 final integration result in
[`beta10-final-integration-2026-10-15.md`](./beta10-final-integration-2026-10-15.md).
The earlier result is not replaced. The task, host runtime, model, global and
project instruction fixtures, and correctness oracle are unchanged. The
Talos agent fixture SHA-256 for this cohort is
`4d6827daa657d1eac484917098c01a2eb20548394f14b4f07968663ff63390ca`.

## Frozen task and correctness oracle

Both arms receive the unchanged scenario-B prompt from `bench/bin/bench.mjs`:

> Crie o arquivo bench-run-B.md contendo uma tabela markdown com os 3 países mais populosos do mundo e suas populações.

Use the 2024 country estimates in the UN's
[World Population Prospects 2024 summary](https://population.un.org/wpp/assets/Files/WPP2024_Summary-of-Results.pdf):

| Rank | Country | Reference population |
|---:|---|---:|
| 1 | India | 1,451,000,000 |
| 2 | China | 1,419,000,000 |
| 3 | United States | 345,000,000 |

The run audit and pass criteria are unchanged from the original
[pre-registered final integration oracle](./beta10-final-integration-oracle-2026-10-15.md):

1. Record runtime completion separately from artifact correctness.
2. Require a regular, non-symlink, non-empty UTF-8 `bench-run-B.md`, with a
   Markdown table containing exactly the three countries above in rank order,
   clear population units, and values within ±2% of the reference.
3. Require no other task-created artifact and no write outside the run
   directory; exclude only harness `AGENTS.md` and `.pantheon/logs/hooks.log`.
4. Require observed root identity and no parent: Zeus control, Talos candidate.
5. Require zero Talos children, no `subagent` call or delegation fallback, and
   available tool-call data.
6. Require exact D4 provenance for global `AGENTS.global.md` (11,410 B,
   SHA-256 `797fb47ef83ee8d5aafaee37f2c9fcd8a56137210d0f4333fd9b0045d5753eb3`)
   and project `AGENTS.md` (1,990 B, SHA-256
   `199ae5614ad5413fc14efc9cfb585383a7ef62fd360ac91c9aa27d033b37c6b0`).
7. Require token fields for every assistant message. Missing metrics remain
   unavailable, never zero.

Acceptance requires 5/5 Talos runs to pass every criterion. Preserve all
failures; do not replace or omit a run. Audit artifacts after timing. Report
wall and token results separately; claim no wall-time gain unless it exceeds
the same-day spread, and make no monetary-cost claim from token counts. If this
cohort misses 5/5, leave the final integration/F3a gate open.

## Frozen command

Run once, serially, with no other benchmark or edits during measurement.

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
