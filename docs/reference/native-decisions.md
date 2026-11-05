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

Decision models are **not chat models**: they never appear in the host model
catalog (`opencode models`) at all — field-measured on 2.2.5 (561 catalog
entries, zero jev models, while the decisions API answers the same model ref
directly). Route resolution therefore reads only your Pantheon config, never
the catalog. Pantheon never maps or switches providers on your behalf.

| Decision model | Config candidate | Host reference | Billing / auth | Route requirement |
| --- | --- | --- | --- | --- |
| OpenCode Console Jev | `opencode-console-jev` / `jev-1.13` | `{ providerID: "opencode", id: "jev-1.13" }` | Zen workspace credits, via `OPENCODE_API_KEY` (a Go subscription does not include Jev — the host answers 404 without the workspace key) | `OPENCODE_API_KEY` — host-native |
| TypeSafe Jev direct | `typesafe-jev` / `jev-1.14.0` | `{ providerID: "typesafe-ai", id: "jev-1.14.0" }` | Your TypeSafe key | `setup-model` merges the complete custom provider entry into `opencode.json` (adapter, baseURL, `apiKey: "{env:TYPESAFE_API_KEY}"`, type `"decision"`); then `export TYPESAFE_API_KEY=<your key>` and restart. **`/connect` and `opencode auth login` do not carry custom providers** — models.dev has no typesafe-ai entry |
| OpenRouter-hosted Jev | `openrouter-jev` / `typesafe/jev-1.13` | `{ providerID: "openrouter", id: "typesafe/jev-1.13" }` | OpenRouter credits (`OPENROUTER_API_KEY`; host-native models.dev provider — `/connect` supports it) | None — host-native |
| Vercel AI Gateway Jev | `vercel-gateway-jev` / `typesafe-ai/jev` | `{ providerID: "vercel-ai-gateway", id: "typesafe-ai/jev" }` | Vercel AI Gateway (`AI_GATEWAY_API_KEY`; host-native models.dev provider) | None — host-native |
| Cloudflare Workers AI (Clef) | `cloudflare-workers-jev` / `clef` | `{ providerID: "cloudflare-workers-ai", id: "clef" }` | Workers AI (`CLOUDFLARE_API_TOKEN`, scoped) | Custom entry with your accountId — models.dev does not carry it; the Calibrated-Jev calibration does not transfer to Clef |

Setup in one command (state lives in `~/.config/pantheon/decision-router.json`,
budget in `~/.local/state/pantheon/decision-budget.sqlite`; the command requires
explicit caps — there are no defaults):

```sh
npx pantheon-opencode decision-router setup-model opencode-console-jev/jev-1.13 \
  --monthly-usd 5 --per-decision-usd 0.10
npx pantheon-opencode decision-router doctor   # read-only verification with fixes
```

`setup-model` performs select + enable + consent + caps (user, provider, model)
+ period confirmation in one write and prints the verification checklist — and
for the TypeSafe route it also merges the host provider entry into
`opencode.json` (additive, idempotent). `--no-consent` configures everything
except egress consent. `doctor` walks the whole native route — config, consent,
selection, budget admission, unresolved holds, and a route-aware native-route
check (host-native pass for the Console routes; provider-entry check for
TypeSafe) — and prints the exact command to run for each failing gate. The
per-command fallbacks (`select`, `enable`, `consent`, `caps`, `period`) remain
for one-change-at-a-time edits.

### Ready-to-copy provider examples

The stock route needs no `opencode.json` change. The others do — merge (never
replace) into your own config:

**TypeSafe direct** (your TypeSafe key; the catalog id must equal the config
candidate's model). `setup-model` merges exactly this — or merge manually:

```json
{
  "providers": {
    "typesafe-ai": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "TypeSafe AI",
      "options": {
        "baseURL": "https://api.typesafe.ai/v1",
        "apiKey": "{env:TYPESAFE_API_KEY}"
      },
      "models": {
        "jev-1.14.0": { "name": "Jev (TypeSafe direct)", "modelID": "jev-latest", "type": "decision" }
      }
    }
  }
}
```

Then: `export TYPESAFE_API_KEY=<your key>`, restart OpenCode, and
`decision-router setup-model typesafe-jev/jev-1.14.0 --monthly-usd 3 --per-decision-usd 0.05`.
A models-only entry (no adapter/baseURL/apiKey) is inert: the host cannot
resolve the provider and the decisions call 404s. `/connect` and
`opencode auth login` list only registry (models.dev) providers — TypeSafe
is not one.

**OpenRouter-hosted Jev** (billed by OpenRouter; the config candidate is not in
Pantheon's matrix, so set an explicit selection through the host):

```json
{
  "providers": {
    "openrouter": {
      "models": {
        "typesafe/jev-1.13": { "name": "Jev (OpenRouter)", "type": "decision" }
      }
    }
  }
}
```

Who can invoke: the orchestrator (`zeus`) always; allowlisted specialists for
**explicit typed questions only** (owner/skill selection and result scoring
stay orchestrator-owned). The allowlist comes from
`PANTHEON_JEV_SPECIALIST_CALLERS` (CSV of agent ids, default empty = Zeus
only; read at plugin registration). The permission assertion and the success
output carry the real caller. Cost controls are the caps above (no defaults),
the confirmed UTC period, and the host permission kill-switch on
`decision.egress` — caps are enforced per call regardless of caller, so the
allowlist is a consent-concentration policy, not a technical boundary.

## The explicit `pantheon_jev_decide` tool

Registered only when the host exposes BOTH the model catalog
(`ctx.model.list`) and the native Decisions API. Execution requires the host
tool context to identify the caller as Zeus, and runs this gate chain in
order — every failure is a bounded refusal JSON, never a retry:

1. **Config gate** — the user-level decision-router config must be `enabled`
   with `egress_consent: true`.
2. **Route gate** — the selection (explicit, or auto with exactly one eligible
   candidate) must resolve to a native route through the frozen provider
   table. The host chat catalog is deliberately NOT consulted (decision
   models are not chat models); an unknown model surfaces as the host's own
   call error. Direct OpenAI has no native route and is never substituted.
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
     or `mode: "delegation"` (every canonical specialist except Zeus);
   - the **review mode**: `mode: "review"` (J4 output-quality scoring — shape
     metrics and named criteria in, a quality score and a needs-review flag
     out, advisory only; detailed below);
   - the **rank mode**: `mode: "rank"` (v3.1 primitive — pick the best of
     2–8 named candidates for the state; detailed below);
   - the **verify mode**: `mode: "verify"` (v3.1 primitive — check 1–4 named
     claims; detailed below); or
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

## J1 risk-score gate (shadow)

A second, opt-in consumer of the same gate chain: when
`PANTHEON_J1_RISK_SCORE` is set to `1`, `on`, or `true` (anything else, or
unset, leaves it off — and off means zero overhead: no sink, no observer, no
per-call work), the plugin's `execute.before` hook fires ONE bounded native
Decisions call per **write/execute** tool call — bash/shell and webfetch
(execute), file writes (write). Read-only tools are never observed, and the
target list intersects the secret scan's own exfil-capable gate, so a tool the
scan never inspects is never observed either.

Each observation runs the exact chain the `pantheon_jev_decide` tool runs —
config `enabled` + `egress_consent`, route via the budget ledger's admission
check, the `decision.egress` permission kill-switch, one reservation, one host
call, cost reconciliation — through the shared runner
(`runGatedNativeJevCall`); no gate logic is duplicated. The request asks two
questions only: one **score** ("risk of this tool call for the current task",
2–10 levels) and one **predicate** ("is this call consistent with the current
task intent?").

**Sanitization contract.** The request carries NO user content: no task text,
no file paths, no tool input values. The state text is a fixed template over
three fields — the tool name (accepted only as a bounded `[A-Za-z0-9._:-]`
token; paths, shell metacharacters, injection prose and oversize strings are
rejected outright, never scrubbed), the scope class, and the sha256 of the
serialized tool input (an opaque correlation value). The telemetry record
carries the outcome as one bounded reason token, e.g. `risk-3-intent-yes` or
`skip-timeout`.

**Fail-open and fail-silent.** Every failure mode — config disabled, consent
missing, route or ledger denied, permission denied, the host call throwing,
usage unreconciled, or the 2-second deadline — records a single
`skip-…` reason and moves on. The hook fires the observation WITHOUT awaiting
it: the tool call's latency is unchanged, the observer bounds its own wait at
2s (AbortController), abandoned calls settle their own ledger reservation in
the background, and nothing is ever retried or queued.

**Shadow never blocks.** The only verdict this phase can produce is
`observe`, recorded as a shadow record (`point: 'J1'`, `mode: 'shadow'`,
`effect: 'none'`) in the in-memory, bounded decision telemetry collector the
plugin never reads back. A high risk score changes the recorded reason and
nothing else. The `flag` verdict is a named constant reserved for a future
active phase and is unreachable; there is no deny path, no ask path, and no
permission narrowing on this surface.

## J2 skill-selection scorecard (offline harness)

The skill-selection surface — the P2 local prefilter plus the
`mode: "skills"` preset — is measured by a dated, rerunnable scorecard
(`bench/results/j2-skill-selection-scorecard-2026-11-03.md`), produced by the
offline harness `tests/pantheon/j2-skill-selection-scorecard.test.ts` with its
scenario catalog and canned-reply table in
`tests/pantheon/j2-fixtures.ts`. Every scenario runs BOTH paths: the
deterministic prefilter (`selectPantheonSkills`) and the full preset through
the real gate chain (config → consent → budget reservation → permission
kill-switch → one host call → settlement) on a sandboxed HOME, with
`globalThis.fetch` a throwing spy.

**Replies are faked offline.** Every Jev answer in the harness comes from a
canned, per-scenario table (successes, low confidence, refusals, duplicates,
out-of-pool choices, timeouts, malformed payloads) — the harness measures the
plumbing (preparation, gating, consumption, telemetry at point `J2`), not
model quality. The states are synthetic by construction and the harness
asserts injection prose planted in a state never escapes the state slot into
the option pool, the question, the advice, the permission request, or
telemetry (leak count 0), and that refusals and timeouts are handled without
retrying or throwing into the host.

**Activation gate.** This phase measures only. The gate is: shadow → 2
consecutive scorecards with the activation criterion met → then, and only
then, discuss activation as a separately reviewed change. The criterion is
deliberately not defined numerically here, and an offline scorecard proves
nothing about the live model — a live, consented, clock-bounded scorecard is
a future run.

**Question-phrasing finding.** One sentence distinguishing required vs
preferred attributes measurably doubled answer accuracy in the source
measurement (the `writing-a-jev-question` guide in the
awesome-typesafe-jev repository, where the finding originates); apply it
when phrasing or revising the `mode: "skills"` preset instructions.

## J3 turn-complexity escalation (shadow)

A third, opt-in consumer of the gate chain — and the first Jev uplift surface
that computes (but does not apply) a routing decision. When
`PANTHEON_J3_ESCALATION` is set to `1`, `on`, or `true` (anything else, or
unset, leaves it off — off means zero overhead: no sink, no observer, no
per-dispatch work), the plugin's `execute.before` hook fires ONE bounded
native Jev decision per **delegate dispatch** — the native `subagent` tool
assembling the Brief — through the same shared runner
(`runGatedNativeJevCall`): config `enabled` + `egress_consent`, budget-ledger
admission, the `decision.egress` permission kill-switch, one host call,
settlement.

**Classification.** The request asks ONE **score** question — "complexity of
this delegation for the current task" — over the full 2..10 level bound
(labels `trivial` … `sprawling`). The consumer takes the reported score at
face value under the tool's own strict validation (name and type must match
the prepared question, score non-negative and finite, duplicates refused);
anything else is `null`, never a guess.

**Sanitization contract (identical to J1).** The request carries NO user
content: no Brief text, no task description, no paths. The state text is the
exact bounded template over four structural fields — the delegate id
(accepted only as a canonical Pantheon agent token; anything else is
`INPUT_INVALID`), the sha256 of the Brief text, its character length, and the
local risk-word boolean. The Brief text itself never leaves this machine.

**Rails (all local, no Jev call).** Three independent local rails force the
verdict to the main model regardless of the reported score:

1. **Risk words** — the Brief mentioning any of `deploy`, `migrate`, `drop`,
   `delete`, `prod`, `production`, `payment`, `secret`, `credential` never
   goes cheap (case-insensitive substring match on purpose: inflections and
   plurals rail too, and over-matching biases to the safe direction).
2. **User-pinned model** — an explicit per-agent override for the delegate in
   the project model configuration (the same file `pantheon_model` writes)
   is never overridden; a configuration that cannot be read counts as pinned.
3. **Context length** — a Brief longer than 8,000 chars never downgrades.

**Verdict policy.** Pure and fail-safe: complexity ≤ 4 (the documented cheap
threshold — the lower third of the offered scale, deliberately conservative
because a wrong `cheap` costs task quality while a wrong `main` only costs
tokens) AND no rail tripped → `cheap`; anything else — including every
unsure, malformed, refused or timed-out classification — → `main`. The main
model is never downgraded by uncertainty.

**Shadow contract.** In this phase the verdict NEVER changes the dispatched
model. The record (`point: 'J3'`, `mode: 'shadow'`, `effect: 'none'`, reason
tokens like `esc-cheap-c2`, `esc-main-c7`, `esc-main-c-na`, `skip-timeout`)
is the whole effect. The activation mechanism — set the per-agent override
for the delegate BEFORE dispatch through the existing model-override
mechanism (`v2-model-overrides`), restore the previous model after — exists
in `jev-escalation.ts` (`applyEscalationOverride` / `clearEscalationOverride`)
but the shadow observer has no path to it; the plugin wiring carries no
reference to it (asserted structurally by the contract test). The mechanism
is proved by direct test exercise only: a cheap override resolves to the
documented cheap model (`opencode/mimo-v2.6-flash`, a supported chat model
validated by the same capability table the override mechanism uses — decision
models are not chat models and are never escalation targets, and the host
catalog is never consulted), and clears to the exact previous model. The
parent model is never touched by any of this: escalation applies only to
delegate dispatches, explicitly.

**No delay.** Fired without awaiting the hook; self-bounded at 2s
(AbortController); on timeout records `skip-timeout`. In an active phase the
same deadline is the dispatch rule: a classification still in flight when the
dispatch resolves the model is `main` — dispatch is never delayed. Exactly
one call per dispatch: no retry, no queue.

**Activation prerequisites.** This phase measures only. Before anything
activates: a measured baseline scorecard from replayed synthetic scenarios
(the offline harness `tests/pantheon/jev-escalation.test.ts` proves the
plumbing and the rails; it does NOT measure model quality — the request
carries structural fields only, so the live classifier's accuracy against
real Briefs is unknown until replayed with consented live replies), the
shadow-record distribution reviewed, and the activation itself is a
separately reviewed change. A quiet log proves nothing — the hermes gate this
series adopts.

## J4 output quality scoring (advisory, on demand)

A fourth consumer of the gate chain — and the first with no flag and no hook:
`pantheon_jev_decide` gains `mode: "review"`, and the review runs ONLY when
Zeus explicitly requests it after a delegation completes. That is the
reference design's (jev-dsh-decision) on-demand shape: one consented call site
(the existing tool, unchanged Zeus-only caller contract and gate chain), one
typed round-trip, no automatic observation of delegation traffic.

**The review.** The request asks TWO questions in the single round-trip: one
**score** — "quality of this delegated result against the criteria", over the
full 2..10 rubric bound — and one **predicate** (`noul`), "does this result
need human review?". The consumer reuses the tool's strict validation (name
and type must match the prepared questions, duplicates become errors);
anything else is `null`, never a guess.

**Sanitization: criteria in, content never out.** The result itself NEVER
leaves the machine — the request has no content field at all (structural, not
a scrub). The state text is a fixed bounded template over shape metrics only:
the delegate id (a canonical Pantheon agent token), the result kind
(`ok` / `empty` / `error`), the output character count, the task duration
(`na` when unknown), and the criteria count. The criteria are the ONLY free
text admitted, riding the score question's instructions: they are
caller-provided instruction strings from the tool schema (never user text),
1–120 chars each. Hostile shapes — paths and path separators, credential
assignments and key material (`password=…`, PEM headers, AWS/SDK/Git token
literals, `*.key` files), control characters, over-length — are rejected
`CRITERIA_INVALID` outright, never sanitized on the way in; any other
malformed review input is `REVIEW_INPUT_INVALID`, refused before any gate work
is spent.

**DSH hard caps, mirrored.** At most 4 criteria per review; bounded
instruction strings; exactly ONE call per review (the shared settlement
contract: no retry, no queue, fail-closed reservation); redacted errors
everywhere — refusals carry reason codes, and a failing host call surfaces the
error CLASS only (`TypeError`, `RangeError`), never host message text.

**Verdict semantics: advisory flag only.** The pure verdict
(`qualityVerdict`) is `recorded` or `flag-for-review`. An affirmative
`noul` answer is the ONE flagging condition; the flag is advisory telemetry
plus a `verdict` field in the tool output Zeus may weigh — it NEVER blocks,
retries, or alters the delegated result. A low quality score with an explicit
no-review answer records without flagging: the score is surfaced for Zeus,
not enforced. An unsure, malformed, or refused review records `na` and never
flags on a hunch.

**Telemetry.** One shadow record per review run (`point: 'J4'`,
`mode: 'shadow'`, `effect: 'none'`) with a bounded reason token —
`q-7-review-yes`, `q-na-review-na`, or a `skip-…` token for every refusal
path — into the in-memory, bounded decision telemetry collector the tool path
never reads back.

**P10 direction.** The review's score and flag are the raw material the
future P10 counselor-claims layer needs (per-counselor quality claims fed by
on-demand reviews). This release wires nothing of the council: no claim is
recorded, no counselor reads J4 records, and connecting the two is a
separately reviewed change with its own consent surface.

## Rank and verify (v3.1 primitives)

Two further tool modes on `pantheon_jev_decide` — both built after the
review-mode pattern (bounded request built before any gate work, the same
shared gate chain, the same refusal contract, the tool's strict answer
consumer) and both advisory only: `effect` stays `none`, nothing is blocked,
dispatched, or altered, and neither mode has a telemetry point (they are tool
modes, not shadow gates). Both stay orchestrator-owned: an allowlisted
specialist may ask bounded typed questions only.

### `mode: "rank"` — pick the best candidate

Input: `{ schemaVersion: 1, mode: "rank", state, candidates }` where `state`
is the usual bounded state text (≤ 12,000 chars, carried verbatim) and
`candidates` is 2–8 records `{ id, description? }` — `id` a strict bounded
token (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`, unique), `description` optional
bounded prose (≤ 500 chars). The request asks TWO questions in the single
round-trip: one **choice** question (`winner`) over the candidate ids, and one
**score** question (`fit`, the 2..10 rubric bound) rating the winner's fit.
The tool returns `{ winner, winnerFit }` (each `null` when the answer is
missing, mistyped, duplicated, or an error) plus the usual `answers`,
`missing`, `usage`, and `frozen` fields.

**The honest limitation.** Rank does NOT return a full ordering, a runner-up,
or per-candidate scores. The host Decisions API answers one scalar per
question — one score question per candidate would break the 4-question bound
above four candidates, and one ambiguous "score each candidate" question has
no per-candidate answer structure to pair back. The winner + fit pair is what
one typed round-trip can express truthfully; a caller that needs a deeper
order uses the explicit-questions mode with its own typed questions.

Sanitization: candidate ids are strict tokens (they become choice values);
descriptions are the same sanitization class as J4 criteria — paths, control
characters, credential assignments and key material are rejected
`CANDIDATE_INVALID`, never scrubbed; a malformed envelope (unknown keys,
missing candidates, count outside 2–8) is `RANK_INPUT_INVALID`; an invalid
state keeps the shared `STATE_INVALID` token.

### `mode: "verify"` — check named claims, fail-closed

Input: `{ schemaVersion: 1, mode: "verify", claims }` where `claims` is 1–4
records `{ name, claim }` — `name` a strict bounded token (it becomes the
predicate question's name, unique), `claim` a bounded 1–200-char instruction
string. The verify mode takes NO state text (like review); the request's only
input part is a fixed template, and each claim text rides its own predicate
question's instructions. The tool returns `results`, one verdict per claim
name:

- probability ≥ 0.5 → `PASS`;
- probability < 0.5 → `FAIL`;
- a host refusal answer, a timeout (missing answer), a duplicate, or any
  malformed/out-of-range probability → `BLOCK`.

`BLOCK` is the fail-closed direction: an unanswered mandatory claim must never
read as verified (or as refuted — an unverifiable claim is unverifiable, not
false). The tool itself never acts on a verdict; a caller that REQUIRES a
verdict (mandatory verification) treats every gate-chain refusal — which never
reaches the consumer — as `BLOCK` at its own call site. Sanitization is the
J4 criteria class: hostile claim shapes (paths, control characters,
credential assignments, key material) are rejected `CLAIM_INVALID`, never
scrubbed; a malformed envelope is `VERIFY_INPUT_INVALID`.

## Fast decision paths

The decision layers are ordered by cost; use the cheapest one that answers:

| Layer | Cost | Use for |
| --- | --- | --- |
| Local deterministic selector | free, no network | per-turn skill/specialist prefilter, marker, skill-array narrowing |
| Jev preset (`mode: "skills"` / `"delegation"`) | one typed call (~150 ms class) | stacking skills for a task, picking a specialist with probabilities and confidence, on demand |
| Explicit typed questions | one typed call | any bounded choice/score/yes-no the orchestrator wants judged |
| Main chat model | full model call | open-ended reasoning — never replaced by the layers above |

### Candidate expansions (mapped, deliberately unwired)

Each row names the decision, the Jev question, and what must be proven before
wiring. None is authorized by this release; every one needs its own carrier
measurement, consent/payload policy, and review — the same bar the tool
itself went through.

| Candidate | Jev question | Why it could help | Must be proven first |
| --- | --- | --- | --- |
| Memory persistence advisory | predicate: "is this state worth a durable entry?" | fewer missed saves and less noise | the measured save-moment carrier; the advisory must never relax the explicit request/authorization rule |
| Council pre-ranking | choice over counselors | cheaper assembly for genuinely multi-perspective work | a real council carrier (the council point is still unwired) |
| Vision-call gating | predicate before `vision_describe` | probably none — vision already fires only for image jobs; an extra decision adds latency | a measured case of vision invoked without an image driver |
| Per-agent affordances | specialists' own typed questions | parallel small decisions off the main model | caller-matrix policy, per-agent consent, review |
| Skill discovery tool | search the ecosystem from the session | removes the manual `npx skills find` step | its own networked-egress consent surface and a registry trust policy |

Until one of these is wired, the flow stays: local prefilter → Jev preset
(consented) → main model, with MCP calls governed by their own documented
policies (memory: explicit request/authorization; vision: image-driven;
persistence: explicit checkpoints).

### Provider matrix (measured on the 2.2.5 host binary)

The host embeds decision modules for exactly 8 providerIDs: `opencode`,
`typesafe-ai`, `openrouter`, `vercel-ai-gateway`, `cloudflare-workers-ai`,
`cloudflare-ai-gateway`, `baseten`, `digitalocean`. **There is no `openai`,
`zen`, `microsoft` or `laya` module** — those backends are only reachable via
a plugin's own transport (the OpenAI Decisions protocol is a different one;
the host does not speak it). Decision models are not chat models: none of the
jev models appear in `opencode models` regardless of provider. Expansion is
table-only on Pantheon's side — the host normalizes every embedded provider
behind the same decisions call.

### Candidate expansions (2026-11-04, mapped, deliberately unwired)

- **OpenAI Decisions protocol** — the host 2.2.5 has **no** openai decisions
  module; OpenAI speaks a different protocol (`POST
  api.openai.com/v1/decisions`, model `gpt-6-luna`, up to 400 questions,
  refusal as an answer type). Wiring it means Pantheon running its own
  transport for the first time — breaks the "egress only via the host native
  route" principle. Deliberately unwired.
- **What's-new window** — a one-time TUI notice on version change surfacing
  the changelog highlights (the extractor exists:
  `scripts/changelog-extract.mjs`). Planned.

### Specialist callers (shipped)

`PANTHEON_JEV_SPECIALIST_CALLERS` (CSV, default empty = Zeus only) allowlists
agents to call `pantheon_jev_decide` with explicit typed questions; preset
modes (skills/delegation/review/rank/verify) stay orchestrator-owned. The
permission assertion and the success output carry the real caller; caps and
the `decision.egress` kill-switch are enforced per call regardless of caller.

## Skill ecosystem (hybrid, on-demand)

The stacking preset is open: its pool is the Pantheon catalog **plus every
skill the host has installed** (`ctx.skill.list()`). Anything following the
open Agent Skills format (`SKILL.md`) — Pantheon's own or third-party —
becomes decidable the moment it is installed, with no Pantheon change.

Division of labor; trusting an install is never the model's job:

- **Install** — manual and reviewed. `npx skills add <repo> -a opencode`
  (the open skills ecosystem CLI) places the skill in the host's skill
  directories (project `.opencode/skills/` or global). Pantheon never
  installs, updates, or removes skills, and there is no auto-update.
  Third-party skills are untrusted instructions: review the `SKILL.md` and
  any scripts before installing, prefer pinned versions, and keep production
  servers off ad-hoc installs.
- **Decide** — with the pool installed, `mode: "skills"` pre-filters local
  candidates (or offers the whole pool) and Jev picks what to stack for the
  current task in one typed call; the answer is advisory and loads nothing.
- **Share** — a private skills repository (for example `ils15/pantheon-skills`)
  becomes the approved, versioned library other projects pull from; the
  skills CLI resolves private repositories with existing git credentials.

The **discovery pipeline** binds these steps into one measured ladder
(zeus.md carries the same rules):

1. `mode: "skills"` answers over the installed pool — the Jev call that
   decides within existing skills.
2. Only on a gap: one read-only search across the **trust cascade** —
   `node scripts/skill-search.mjs "<query>" --limit 5` queries, in order:
   the **canonical Anthropic catalog** (`anthropics/skills` — curated
   upstream; checked first so the canonical `pdf`/`docx`/`mcp-builder`
   skills outrank the third-party clones that popularity ranking surfaces),
   the **skills.sh index** (breadth with install-count signal, unreviewed),
   and **raw GitHub** `filename:SKILL.md` code search (orders of magnitude
   wider — 8,480 hits for "satellite" where the skills.sh index offered
   three — and the weakest trust). Output is the merged parseable contract
   (`{skill, installs, url, source}` JSON; pinned by
   `tests/skill-search.test.mjs`), tier-ordered. The search is networked
   egress by the agent, priced by attention — never a Jev question by
   itself, and at most one per need.
3. One typed Jev choice question ranks the returned candidates
   (descriptions + install counts as choice text; "none of these fit" is a
   valid answer). Only names, counts and short descriptions cross the
   boundary — skill contents are untrusted and never enter a Jev call.
4. The winning candidate is PROPOSED to the user with its URL and the exact
   command (`npx skills add <owner/repo@skill> -a opencode` — project-scoped
   by default). Pantheon never installs; the review is the user's, and the
   installed skill joins the pool that step 1 answers over.

## Verification boundary

The focused tests (`tests/pantheon/jev-decisions.test.ts`,
`tests/pantheon/v2-native-decisions.test.ts`,
`tests/pantheon/jev-rank-verify.test.ts`) are offline: the native API is a
typed stub, the budget ledger runs on a temp database, and the success path
runs with `globalThis.fetch` replaced by a throwing spy to prove the native
route never touches a transport. A real-host canary asserts the tool's
registration. No live provider request, canary, or credential check has been
performed. The manual `pantheon_local_decision` advisory tool remains
local-only and separate. Field validation evidence lives in dated records
under `bench/results/` (see `jev-field-validation-2026-11-05.md` for the
sandbox install, the live scorecard, the N4 re-test, and the verify field
run).

## Expansion verdicts (measured, 2026-11-05)

Each expansion direction was weighed against the measured gate chain and the
field validation; the verdicts below are the current standing answer, not a
ban — new field evidence reopens them.

- **Jev as the arbiter of native-MCP calls (memory recall/store, checkpoints,
  code-mode reads): no.** The economics are negative — a decide call reserves
  budget and spends a live route round-trip to gate a free, local, instant
  call. Where the answer is a rule, the rule wins: usage policy lives in the
  agent instructions (zeus first, then the roster reform), measured by the
  MCP usage audit, not by paid arbitration.
- **Jev as the spend gate for `pantheon-vision`: defer.** Vision is the only
  gateway-costed native MCP, but volume is small (84 execute blocks, 54
  calls over the whole field history) and the V1 permission tier (`ask`)
  plus the one-pass-per-image usage policy already bound it. Revisit only if
  the audit shows repeated abuse that rules cannot hold.
- **Rank cap 8→20 (P4/P11 need 20+ candidates): blocked on a design change,
  not a constant.** The host answers one scalar per question, so
  winner-with-fit-score does not scale past roughly 10 candidates — at 20+
  the single question cannot discriminate. Expansion implies a tiered or
  tournament shape (two rounds of 8, or a shortlist round followed by a
  winner round), each round its own reserved call; that doubles latency and
  cost per decision, so it must be its own measured change, not a cap bump.
- **Callers and routes: sufficient.** `PANTHEON_JEV_SPECIALIST_CALLERS`
  (typed questions for allowlisted specialists), Zeus-only presets, and the
  five supported routes cover the current usage; no evidence of demand for
  more.
- **Dead-route holds: releasable, narrowly.** `decision-router holds release
  --provider <p> --reason` archives and releases unresolved holds of
  providers that no longer exist (they can never reconcile and would freeze
  budget forever). Live providers are refused; their holds settle by
  reconciliation or roll off with the period.
