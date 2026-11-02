# Performance and tuning

Measured costs of the orchestration layer and the knobs that change them.
Nothing here changes security semantics; every gate keeps its default.

## Where the time goes

| Cost | Status | Notes |
|---|---|---|
| Secret scan per tool call | **in-process since beta.8** | Was one `bash` spawn per tool call (`scan-secrets.sh`); now pattern matching inside the plugin (`v2-hook-engine.ts`), same exit-code contract and fail-closed classifier. |
| Delegation audit per dispatch | **in-process since beta.8** | The start/stop bash scripts (which also spawned `python3` each) now write the same `delegations.log` JSON lines directly. |
| Post-write formatting | spawns only when applicable | `format-multi-language.sh` runs only for `edit`/`write`/`hashline_edit` on formattable extensions (and `bash`); every other tool call skips it. |
| Todo-enforcer idle check | idle-time only | Queries `session.children()` on idle events with a 30 s post-user-message quiet window. Kill-switch: `PANTHEON_TODO_ENFORCER=off`. |
| Prompt admission hook | cheap | Local deterministic selection (routing.yml parsed once per process), P1/P2 shadow records in memory. |
| Compaction hook | shadow | Observes the carrier; injects nothing. |

## Prompt budget (per turn / per dispatch)

| Payload | Size | Knob |
|---|---|---|
| Zeus system prompt | ~17 KB | Kept lean by pruning release history; behavior detail lives in skills loaded on demand. |
| Specialist system prompts | 3–12 KB | Two-tier verification (`src/agents/*.md`): small bounded fix → one targeted proof; material change → full test discipline. |
| AGENTS.md injection | ~1.8 KB | Project-owned; regenerated region is install metadata. |

Skill stacking is the intended lever: `pantheon_jev_decide` `mode: "skills"`
picks what to load per task instead of carrying everything always.

## Decision latency

- Obvious route → dispatch directly (no decision call).
- Ambiguous route/skill stack → one typed `pantheon_jev_decide` call
  (consent- and budget-gated) instead of open-ended orchestrator reasoning.
- Model tiers: phase reviews on the flash tier; the pro tier reserved for the
  final gate (`routing.yml` / `set-tier`).

## Context growth (long sessions)

The deterministic context pruner exists but is **off by default** (per-request
pruning invalidates the provider prompt cache; enabling it trades cache hits
for smaller payloads). Enable explicitly when sessions routinely outgrow the
window; compaction remains the host's own mechanism.
