# OpenCode V2 native Decisions

**Status: one explicit production call site — the `pantheon_jev_decide` tool.**
This work targets the OpenCode V2 plugin contract, `@opencode/plugin@2.2.5`. The
native `ctx.experimental.generate.decisions({ model, input, questions })` API was
introduced in OpenCode 2.2.0. This does not claim native Decisions compatibility
with V1 or OpenCode V2.0/2.1.

The **per-turn prompt hook** remains local-only: no native call, no fetch, no
provider request, no credential read, no prompt-content change, no permission
narrowing, no agent dispatch, and no review/approval gate change. The local
per-turn advisory recommendation is unchanged. Separately, the **explicit
Zeus-only tool** below is a real, consented production call site through the
host's own provider layer.

## The explicit `pantheon_jev_decide` tool

Registered only when the host exposes BOTH the V2 model catalog
(`ctx.model.list`) and the native Decisions API; a host without either simply
does not get the tool. Execution requires the host tool context to identify the
caller as Zeus, and runs this gate chain in order — every failure is a bounded
refusal JSON, never a retry:

1. **Config gate** — the user-level `~/.config/pantheon/decision-router.json`
   must be `enabled` with `egress_consent: true`.
2. **Route gate** — the selection (explicit, or auto with exactly one eligible
   candidate) must resolve to a native route: the config candidate is mapped
   through a frozen provider table (`opencode-console-jev` → host `opencode`,
   `typesafe-jev` → host `typesafe-ai`), and the host model catalog must contain
   that `(providerID, id)` with `type: "decision"`. Direct OpenAI has no native
   route and is never substituted.
3. **Budget gate** — the budget ledger must admit a reservation for the
   candidate's accounting provider/model (confirmed period, positive monthly and
   per-decision caps). The reservation is taken **before** the call and held
   (pending, fail-closed) if the call fails or the result cannot be reconciled.
4. **Permission kill-switch** — `ctx.permission.assert` on the `decision.egress`
   action with the logical resource
   `pantheon-native-decisions://<providerID>/<id>`; a throw or explicit denial
   stops the call. A host without the permission API refuses.
5. **Payload preparer** — the request carries only the tool's `state` text
   (≤ 12,000 chars) and 1–4 typed questions (`choice` with 2–16 unique options,
   `score` with 2–10 unique levels, `predicate`), with bounded names,
   instructions, and descriptions. No files, history, system instructions,
   memory, or metadata are added. The user-supplied state text itself is carried
   verbatim — it is not a secret-scanning boundary.
6. **Host call** — exactly one `experimental.generate.decisions` invocation. The
   transport, credentials, and provider endpoints are entirely the host's; this
   code path contains no fetch.
7. **Settlement** — the host-reported `cost` (USD) and token counts mint an
   opaque reconciliation capability; absent cost is a real zero (free variants).
   Reconciliation at a cost above the reservation freezes the buckets
   (fail-closed overshoot handling).
8. **Advice consumer** — answers are validated against the prepared questions
   (one per name; choices must be from the prepared options; duplicates become
   errors) and returned as advice with `effect: 'none'`.

The tool never dispatches agents, runs skills, executes other tools, grants
permissions, or alters review gates. Its output is advisory text the calling
agent may use for delegation, decision-making, and skill-selection reasoning.

## Model routes

The recognized stock Jev route is:

| Route | Exact host model reference | Billing |
| --- | --- | --- |
| OpenCode Console Jev | `{ providerID: "opencode", id: "jev-1.13" }` | OpenCode Console |

A direct TypeSafe route is an advanced user-configured option: OpenCode's
TypeSafe Decisions implementation is `@opencode/ai/providers/typesafe-ai/decisions`;
a user may configure a custom model with `type: "decision"` in their own
`opencode.json` (the catalog id must equal the config candidate's model, e.g.
`jev-1.14.0`, to be selectable):

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

Pantheon does not create or overwrite that file and does not collect, read,
store, or log credentials. OpenCode `/connect` credentials remain owned by the
host/provider. An OpenRouter-hosted Jev model is reachable only as a
host-configured decision model, is identified and billed as OpenRouter, and has
no stock config candidate.

## Per-turn hook remains offline

The hook path's correlation contract is unchanged and still unprovable on
V2.2.5: the `SessionPrompt` event supplies `sessionID`, `messageID`, `prompt`,
and `delivery`, but no queue/activity/continuation facts, so preparation aborts
(`CORRELATION_UNAVAILABLE`). The tool surface exists precisely because an
explicit invocation needs no such proof. Wiring an automatic per-turn native
call still requires proving turn correlation in a V2.2.5 host harness, an
approved spend/overshoot policy for background calls, Themis review, and
explicit approval.

## Verification boundary

The focused tests (`tests/pantheon/jev-decisions.test.ts`,
`tests/pantheon/v2-native-decisions.test.ts`) are offline: the native API is a
typed stub, the budget ledger runs on a temp database, and the success path runs
with `globalThis.fetch` replaced by a throwing spy to prove the native route
never touches a transport. No live provider request, canary, or credential check
has been performed. The manual `pantheon_local_decision` advisory tool remains
local-only and separate.
