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

## MCP servers (measured)

| Cost | Number | Note |
| --- | --- | --- |
| `fastmcp` import per server | 0.5–0.8 s | Paid once per host session at server spawn (5 servers ⇒ ~2.5–4 s of Python imports at startup); per-CALL costs are sqlite-local and fast. Startup parallelization is host-side. |
| Memory search | FTS5 (BM25) | SQLite-side keyword search with freshness decay; the vector pipeline (sqlite-vec + fastembed) is documented as not active — no embedding fallback exists, so storage shape matters (see MEMORY.md). |
| Vision deps | heavy (separate venv) | Installed only with the `runtime` component; the vision server is the reason `--no-mcp` exists. |

Improvement queue (deliberately not done): an embeddings pipeline for memory
(needs model + storage decisions), and host-side server warm-start. Neither is
a per-call latency problem today.

## Skill discovery (designed, unwired)

The three-tier skill provenance search — installed / registry / ecosystem,
with Jev ranking annotated candidates and trust staying outside the model —
is specified in [Skill search design](skill-search-design.md). Tier 1 (local
only) could ship without any new consent surface; tiers 2–3 need the egress
class described there.

## Context growth (long sessions)

The deterministic context pruner exists but is **off by default** (per-request
pruning invalidates the provider prompt cache; enabling it trades cache hits
for smaller payloads). Enable explicitly when sessions routinely outgrow the
window; compaction remains the host's own mechanism.
