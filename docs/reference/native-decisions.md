# Native Decisions (Jev)

**Status: one explicit production call site — the `pantheon_jev_decide` tool.**
This targets the OpenCode host native Decisions API,
`ctx.experimental.generate.decisions({ model, input, questions })`, available
from OpenCode 2.2.0 and exercised on 2.2.5. Pantheon targets current OpenCode
hosts only; a host without the API simply does not register the tool. All
Pantheon features are built for the current host generation — there is no
legacy plugin line to consider.

The **per-turn prompt hook** remains local-only: no native call, no fetch, no
provider request, no credential read, no prompt-content change, no permission
narrowing, no agent dispatch, and no review/approval gate change. The local
per-turn advisory recommendation is unchanged. The **explicit Zeus-only tool**
below is the one consented production call site, running entirely through the
host's own provider layer.

## Setup and decision models

Decision models are ordinary host models with `type: "decision"` in the host
catalog. Pantheon never maps or switches providers on your behalf: the config
candidate you select must exist in the host catalog under the mapping below.

| Decision model | Config candidate | Host reference | Billing / auth |
| --- | --- | --- | --- |
| OpenCode Console Jev (stock) | `opencode-console-jev` / `jev-1.13` | `{ providerID: "opencode", id: "jev-1.13" }` | OpenCode Console, host-owned auth |
| OpenCode Console Jev free variant | `opencode-console-jev-free` / `jev-1.13-free` | `{ providerID: "opencode", id: "jev-1.13-free" }` | OpenCode Console, host-owned auth |
| TypeSafe Jev via a custom provider | `typesafe-jev` / `jev-1.14.0` | `{ providerID: "typesafe-ai", id: <catalog id> }` | Your TypeSafe key, via OpenCode `/connect` |
| OpenRouter-hosted Jev | none in the matrix | host-configured model | OpenRouter |

Setup recipe (state lives in `~/.config/pantheon/decision-router.json`, budget
in `~/.local/state/pantheon/decision-budget.sqlite`):

```sh
npx pantheon-opencode decision-router select opencode-console-jev/jev-1.13
npx pantheon-opencode decision-router enable opencode-console-jev jev-1.13
npx pantheon-opencode decision-router enable          # turn selection on
npx pantheon-opencode decision-router consent yes     # explicit egress consent
npx pantheon-opencode decision-router caps user --monthly-usd 5 --per-decision-usd 0.10
npx pantheon-opencode decision-router caps provider opencode-console-jev --monthly-usd 5 --per-decision-usd 0.10
npx pantheon-opencode decision-router caps model opencode-console-jev jev-1.13 --monthly-usd 5 --per-decision-usd 0.10
npx pantheon-opencode decision-router period confirm --current none --next 2026-11
npx pantheon-opencode decision-router status          # read-only check
```

For a custom TypeSafe model, merge (never replace) a `type: "decision"` entry
into your own `opencode.json`; the catalog id must equal the config candidate's
model (here `jev-1.14.0`):

```json
{
  "providers": {
    "typesafe-ai": {
      "models": {
        "jev-1.14.0": {
          "name": "Jev Latest (custom)",
          "modelID": "jev-latest",
          "type": "decision"
        }
      }
    }
  }
}
```

Who can invoke: only the orchestrator (`zeus`) today. Widening the caller
matrix to more agents is a deliberate, separately reviewed change — not a
config toggle — because each allowed caller multiplies consented egress. Cost
controls are the caps above (no defaults), the confirmed UTC period, and the
host permission kill-switch on `decision.egress`.

## The explicit `pantheon_jev_decide` tool

Registered only when the host exposes BOTH the model catalog
(`ctx.model.list`) and the native Decisions API. Execution requires the host
tool context to identify the caller as Zeus, and runs this gate chain in
order — every failure is a bounded refusal JSON, never a retry:

1. **Config gate** — the user-level decision-router config must be `enabled`
   with `egress_consent: true`.
2. **Route gate** — the selection (explicit, or auto with exactly one eligible
   candidate) must resolve to a native route through the frozen provider
   table, and the host catalog must contain that `(providerID, id)` with
   `type: "decision"`. Direct OpenAI has no native route and is never
   substituted.
3. **Budget gate** — the ledger must admit a reservation (confirmed period,
   positive monthly and per-decision caps). The reservation is taken before
   the call and held (pending, fail-closed) if the call fails or the result
   cannot be reconciled.
4. **Permission kill-switch** — `ctx.permission.assert` on `decision.egress`
   with the logical resource `pantheon-native-decisions://<providerID>/<id>`;
   a throw or explicit denial stops the call.
5. **Payload preparer** — exactly one of:
   - a **preset**: `mode: "skills"` (stack skills for the state text — the
     local prefilter shortlist when it matches, the whole catalog otherwise)
     or `mode: "delegation"` (every canonical specialist except Zeus); or
   - **explicit questions**: 1–4 typed questions (`choice` with 2–24 unique
     options, `score` with 2–10 unique levels, `predicate`), with bounded
     names, instructions, and descriptions.

   The request carries only the `state` text (≤ 12,000 chars) as one text
   part. No files, history, system instructions, memory, or metadata are
   added. The state text is carried verbatim — it is not a secret-scanning
   boundary.
6. **Host call** — exactly one native Decisions invocation. Transport,
   credentials, and endpoints are entirely the host's; this path contains no
   fetch.
7. **Settlement** — the host-reported `cost` (USD) and token counts mint an
   opaque reconciliation capability; absent cost is a real zero (free
   variants). Cost above the reservation freezes the buckets.
8. **Advice consumer** — answers are validated against the prepared questions
   (one per name; choices must be from the prepared options; duplicates become
   errors) and returned with `effect: 'none'`.

The tool never dispatches agents, runs skills, executes other tools, grants
permissions, or alters review gates.

## Fast decision paths

The decision layers are ordered by cost; use the cheapest one that answers:

| Layer | Cost | Use for |
| --- | --- | --- |
| Local deterministic selector | free, no network | per-turn skill/specialist prefilter, marker, skill-array narrowing |
| Jev preset (`mode: "skills"` / `"delegation"`) | one typed call (~150 ms class) | stacking skills for a task, picking a specialist with probabilities and confidence, on demand |
| Explicit typed questions | one typed call | any bounded choice/score/yes-no the orchestrator wants judged |
| Main chat model | full model call | open-ended reasoning — never replaced by the layers above |

Not built yet (mapped, deliberately unwired): council analysis through Jev,
gating memory-MCP calls on a typed predicate, and per-agent decision
affordances beyond Zeus. Each needs its own carrier measurement, consent
policy, and review before wiring.

## Verification boundary

The focused tests (`tests/pantheon/jev-decisions.test.ts`,
`tests/pantheon/v2-native-decisions.test.ts`) are offline: the native API is a
typed stub, the budget ledger runs on a temp database, and the success path
runs with `globalThis.fetch` replaced by a throwing spy to prove the native
route never touches a transport. A real-host canary asserts the tool's
registration. No live provider request, canary, or credential check has been
performed. The manual `pantheon_local_decision` advisory tool remains
local-only and separate.
