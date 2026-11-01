# Local decision recommendation API

> **Current status:** Deterministic local per-turn recommendations are active in
> the V2 prompt hook when the user-level `enabled` preference is true. They are
> advisory: the hook can add a local marker and only narrow an existing skill
> array when identifiable IDs overlap; it never dispatches agents or changes
> permissions or approvals. The former direct-provider branch is detached and
> inactive regardless of legacy consent, caps, provider selection, or credentials.
> Native Decisions have exactly one production call site: the explicit, Zeus-only
> `pantheon_jev_decide` tool through the host's native API, behind the full
> consent/budget/permission chain. The per-turn hook makes no native call. See the
> [V2 native Decisions status](v2-native-decisions.md).

The `pantheon-opencode/local-decision-router` export is an opt-in, deterministic
local advisory API. `PANTHEON_LOCAL_DECISION_ROUTER=1` enables only that local
selector. OpenCode V1 and V2 expose a separate `pantheon_local_decision` advisory
tool; it does not intercept or replace native `subagent` dispatch. An abstention
or recommendation does not start work, change grants, authorize shell, or relax a
review/approval gate.

## Per-turn local recommendation (active)

When the user-level `enabled` preference is true, the production V2 prompt hook
uses the deterministic local skill selector and current local routing policy on
the user's current request text. It may append a `pantheon-decision-router:v1`
advisory marker and narrow `prompt.skills` only when the host supplies a non-empty
array containing identifiable skill IDs that overlap the selection; absent,
empty, unidentifiable, or disjoint lists are left intact. This selector does not
require provider consent, credentials, caps, a permission assertion, or a network
request. Its agent recommendation is advisory only and never dispatches a
specialist, changes grants, authorizes shell, or relaxes an approval gate. The
manual advisory API/tool remain separate.

## Historical direct-provider route (inactive)

Earlier revisions also documented direct-provider calls from the prompt path.
That branch is detached: the production hook does not call its provider selector
or transport. Legacy consent, caps, period, provider selection, credentials, and
permission settings do not wire it back in. Old provider cache, payload,
permission, and transport tests describe retained helper code only; they are not a
current route, live-provider guarantee, or native Decisions fallback.

## Local orchestration advisory

The Zeus-context-gated tool accepts only structured candidate agent/skill/
resource IDs, a nullable exact specialist domain, complexity dimensions, a
gate status, and a boolean indicating whether prior history may matter. It
reads local `routing.yml` metadata (parsed once per process; read failures are
not cached and retry on the next call) and returns a typed recommendation or
abstention. Candidate agents are intersected with Zeus's current routing list,
`permission.task` rules, canonical agent IDs, and the caller-supplied set of
currently available native `subagent` targets. Skills are intersected with the
selected agent's routing skill list; resource recommendations are restricted to
known Pantheon resource IDs. The caller must supply candidates from the live
host schema and currently available skill/resource set; the tool does not
inspect or grant host permissions. V1/V2 plugin tool registration is global and
does not expose per-agent visibility; therefore the tool checks the host-supplied
`context.agent` at execution and returns abstention for every non-Zeus or
identity-missing call. The selector is never an authorization boundary for the
native dispatch.

Use it selectively for genuinely ambiguous delegation choices. Obvious work
goes directly to the native `subagent` tool without calling this selector,
Jev, council, or Athena planning solely for confirmation. A result is advisory:
Zeus validates it again and builds the Brief locally. The boolean may prompt a
single selective local `pantheon-memory` search, but the tool performs no
search and receives no task text, transcript, memory/resource contents, files,
credentials, or secrets. Memory search, read-only resources, and persistence
checkpoints remain distinct systems. The selector may recommend a skill/resource
ID but never invokes it. The adapter does not replace native delegation.

## Enablement

The standalone local API is disabled unless `PANTHEON_LOCAL_DECISION_ROUTER=1` is
present when the process calls it. Unset, empty, and any other value leave it
disabled. When disabled, it returns `decision: "abstain"` and
`reasonCode: "DISABLED"`.

The user-level `enabled` flag and `decision-router enable`/`disable` commands
control the local per-turn recommendation only. They do not activate direct-
provider egress; no combination of legacy provider/consent/budget settings does.

## User-level settings and budget tooling

The provider, model, consent, cap, period, and ledger commands manage stored
administrative state. The `enabled` preference alone is consulted by the local
per-turn recommendation. The remaining state additionally gates the explicit
native `pantheon_jev_decide` tool: egress requires `enabled`, `egress_consent`,
exactly one cap-valid native candidate, and a confirmed budget period in the
ledger. Those settings still do not activate any per-turn provider egress.
Native candidate mapping and the full gate chain are documented in
[V2 native Decisions](v2-native-decisions.md).

Runtime preferences and caps are user-level, not project-level and not OpenCode
global configuration. The non-secret JSON file is
`$XDG_CONFIG_HOME/pantheon/decision-router.json` (default
`~/.config/pantheon/decision-router.json`) and is written with mode `0600` under a
private `0700` Pantheon directory. The separate SQLite admission ledger is
`$XDG_STATE_HOME/pantheon/decision-budget.sqlite` (default
`~/.local/state/pantheon/decision-budget.sqlite`), also user-owned/private. Neither
file stores API credentials. The installer may retain a legacy target preference;
it is not runtime authority. Only this user-level configuration is consulted.

```sh
npx pantheon-opencode decision-router help
npx pantheon-opencode decision-router status [--target <dir>]
npx pantheon-opencode decision-router setup [--apply] [--json] [--target <dir>] [--selection <value>] [--accept-migration]
npx pantheon-opencode decision-router preview
npx pantheon-opencode decision-router select openai-decisions/gpt-6-luna
npx pantheon-opencode decision-router enable openai-decisions gpt-6-luna
npx pantheon-opencode decision-router enable
npx pantheon-opencode decision-router consent yes
npx pantheon-opencode decision-router caps user --monthly-usd 5 --per-decision-usd 0.10
npx pantheon-opencode decision-router caps provider openai-decisions --monthly-usd 5 --per-decision-usd 0.10
npx pantheon-opencode decision-router caps model openai-decisions gpt-6-luna --monthly-usd 5 --per-decision-usd 0.10
npx pantheon-opencode decision-router period confirm --current none --next 2026-10
npx pantheon-opencode decision-router holds
```

`help`, `status`, `setup`/`preview` and `holds` are **read-only**: they do not
create, migrate, or write the config or the SQLite ledger. They open the ledger
through a separate read-only surface (`node:sqlite` with `readOnly: true`), so an
absent database stays absent and an unknown schema is reported instead of being
migrated. `holds` never reserves, reconciles, releases, or prunes. Earlier
revisions opened the ledger for write from `status` and `holds`; that is fixed
here and pinned by tests.

`select` records a preference and nothing else: it never enables the router, never
records consent, never opens the ledger, and never changes which candidates are
enabled. Moving the selection to a different provider/model **revokes** the
consent recorded for the previous target, because that consent did not cover the
new one. Selecting the same target again leaves consent untouched.

### Computed artifact preview (not a change plan)

`setup` prints a diff of the artifacts this layer owns, and `preview` is the same
command with `--apply` refused:

- the user-level config `$XDG_CONFIG_HOME/pantheon/decision-router.json`;
- with `--target <dir>`, that target's `.pantheon/install-state.json` when it
  already exists (no state is ever fabricated for an unmanaged target).

The comparison is content-based, using the snapshot method of the idempotency
probe: `lstat` + SHA-256 + size + mode of the current file against the exact bytes
the writer would produce (preview and writer share one serializer). Each artifact
is therefore `create` (missing), `unchanged` (same hash) or `update` (different
hash), and changed fields are listed by name with the value of an allowlisted set
of activation flags only — never file contents or hashes.

This deliberately is **not** the installer's "Change plan". A measured second
idempotent apply announced `112 create` and created nothing, because the
announcement described what writers were asked to do rather than what the target
bytes are. The property a test pins here is the opposite: preview → `--apply` →
preview reports `0 create · 0 update`, and a byte-level edit flips exactly the
field that changed. `--apply` re-reads every artifact first and refuses the whole
plan if anything moved since the preview.

`--accept-migration` exists for one case only: rewriting a legacy-schema config
that would migrate to `enabled: true`. Without the flag the plan is `BLOCKED` and
nothing is written, so a preview/apply can never activate turn selection as a
side effect.

### No extra backup, and why that matters

Installer backup sets accumulate one directory per application and contain
credential-bearing material (API keys/tokens) by the installer's own log. The
decision-layer setup path creates **no** backup and **no** copy: it writes only
the artifacts in the preview and says so in its output.

### Install-state consistency

`.pantheon/install-state.json` keeps a target-specific preference record
(`provider`, `egress_consent`). It is not runtime authority. Its only legal value
is the projection of the user-level config (`projectDecisionRouterInstallState`),
so the two surfaces cannot disagree about consent: the record never asserts
consent the config does not have. `status --target <dir>` reports `consistent` or
the exact divergent fields, and `setup --target <dir> --apply` reconciles them
without touching `updated_at`. `typesafe-jev` is accepted as a canonical provider
id so a projected record survives a read/write round trip instead of resetting to
Local.

File-ownership tracking is **partial and asymmetric**: `file_inventory` holds 53
of 106 project artifacts and 0 of 107 global artifacts, and it covers neither
`opencode.json` nor `AGENTS.md`. This preview therefore makes no claim about
"everything the installer owns"; it compares the decision-layer artifacts.

Legacy provider/model selection, consent, caps, and period commands only manage
stored administrative state. They do not authorize or activate a production
provider request. The manual `pantheon_local_decision` tool remains local: it
does not read provider credentials, reserve provider usage, or call Fetch. The
historical canary and test records describe old adapter assumptions only; they do
not establish a current host permission contract, provider eligibility, or
egress safety.

## Historical provider eligibility, payload, protocol, and ledger (inert)

Provider/model eligibility tables, endpoint and payload descriptions, pricing,
permission assertions, and admission/reconciliation requirements from previous
revisions are historical documentation, not a current runtime contract. The old
private provider adapter and local budget helpers remain in source, but the V2
production prompt hook does not invoke them and the package does not export the
provider runner. Offline tests that stub `fetch` exercise helper code only; they
do not demonstrate or authorize production egress.

There is no active per-turn provider allowlist or route in this subsystem. The
explicit `pantheon_jev_decide` tool is the only native egress surface; it is
invoked on demand, never in the background, and carries its own consent, budget,
and permission chain. Do not rely on old caps, consent flags, permission checks,
or secret-pattern filters as an egress or payload-safety boundary beyond that
tool. Any future per-turn wiring requires a new consent/payload policy, proven
current-turn correlation, spend/overshoot controls, Themis review, and explicit
approval. Native Decisions status is documented in
[V2 native Decisions](v2-native-decisions.md).

## Measured coverage and unmeasured surfaces (V2 decision layer)

The registry reports coverage as measured, premise, advisory, or deferred, and
`measured` never means "effect measured". What that means in practice: **P7 and
P8 are wired behind flags (both off by default), P1 and P2 are wired in shadow at
the prompt hook, P3 is wired in shadow at its declared `tool.invoke`, P9 is wired
in shadow on the measured compaction carrier, P11 is wired in shadow inside
`ctx.tool.transform`, and P4, P5, P6 and P10 are library code with no production
call site**:

The local per-turn recommendation marker described above is separate from these
P1/P2 shadow telemetry points; its advisory effect does not activate or
strengthen those decision-layer points.

| Point | Surface | Status | What is NOT covered |
|---|---|---|---|
| P1 (agent), P2 (skill) | `session.hook('prompt')` | Registered in **shadow**: they observe a content-free projection of the admission payload and record `effect: none`. P2 is **advisory only** — an empirical no-op on the default path, because the host sends `prompt.skills` absent. | No effect was measured, and records are in-memory and unread in production (test-visible only). P1 activation still waits on PM-07. P2b filtering was cancelled by measurement, not emulated; no token reduction is claimed. |
| P3 (complexity) | `tool.invoke` | Registered in **shadow** at `pantheon_local_decision`: the tool hands the adapter its own input, which carries `complexity` and `gateStatus`, so it classifies when invoked and applies nothing. | No tool call was ever measured (PM-09), and records are in-memory and unread in production. |
| P7 (loop) | `session.execution.succeeded` | Behind `PANTHEON_V2_P7_LOOP`, off by default. The 12-execution cap (`P7_LOOP_MAX_EXECUTIONS`) is **advisory**: `reset()` is caller-supplied, no measured host surface signals a user turn, and the streak is not claimed to reset on any event. | Effect is `none` and unmeasured (C6 is closed by PROBE-E; no P7 effect was observed); nested depth ≥ 2, failed/interrupted child executions and image jobs were not exercised. Never describe this as working loop enforcement. |
| P9 (compaction) | `session.hook('compaction')` | Registered in **shadow** on the measured carrier: the top-level `sessionID` and the `system` part array. The record carries the decision key and the payload shape; nothing is pushed, so the injected context is unchanged. Measured on top-level **and child** sessions: PROBE-G fired the hook in a real child 3/3 with the child's `sessionID` at top level and the same 7-key payload (`system` array of 4), so there is no child-specific branch. | `reason: "overflow"` was **not inducible** in 6 error shapes (PROBE-G §3.2) and its carrier is UNKNOWN; the checkpoint summary/reinjection inside a child was not exercised; the `messages` channel remains UNKNOWN. A payload whose only id is a nested `session.id` produces **no decision**, and no measured surface carries the memory candidate list, so the record names that absence and claims no retention or priority. |
| P11 (catalog) | `tool.transform` | Registered in **shadow** inside the `ctx.tool.transform` callback: it reads the draft the host hands it and calls none of its mutators. | Shadow has no responder, so the record is the validated `choice` question over the draft ids (`catalog.no.answer`), never a selection. `ctx.model`/`ctx.provider` were not exercised as catalogue sources (PM-08), and no host catalogue (`ctx.catalog`) exists at any measured point. |
| P8 (guardrail) | `permission.evaluate` | **Not activatable by measurement**; recorded as `advisory`, starts off and never shadow. PROBE-F delivered 24 real events and measured delivery, payload, order and write honouring — but no declared rule matched any payload (valid `action` token, `sessionID` always present), an unrecognised effect is resolved as `ask` and executed, and `permission.evaluate.egress` is unreachable. The current rule set narrows nothing. | P8 itself was never enabled, so no narrowing was observed; the inert verdict comes from the measured payload matched against the declared rules. `execute.before` remains the only hard barrier (a `throw` there denies; a `throw` in `permission.evaluate` does not). |

P6 and P10 are **unwired**: they declared the prompt hook, but that payload
carries neither council candidates nor counsellor claims, so constructing them
there would only record a permanent refusal. P4 and P5 are **unwired** for the
same reason: the measured `context` payload carries `system` text parts and no
memory candidate array for P4 to rank, and the `execute.after` event carries no
declared `{ requirements, responses }` pair for P5 to verify.

Budget facts are the same story: caps are local admission controls computed from
explicit configuration, and they are not invoice guarantees. There are no default
caps, no automatic period rollover, and no admission from a missing ledger.

### Offline harness calibration (run 2026-10-31)

The registry above records what each point *is*; this section records what the
offline harness actually exercised. It is a contract calibration, not a
performance benchmark.

| Field | Recorded value |
|---|---|
| Command | `npx tsx tests/pantheon/v2-decision-harness.test.ts` |
| Runtime | Node 26.4.0, no provider, no network, synthetic fixtures |
| Result | exit `0` — `V2 decision harness: 264 cases (132 normal, 66 refusal, 66 adversarial) across 11 points` |
| Per point | 24 cases: 12 normal, 6 refusal, 6 adversarial; the suite asserts ≥ 20 total, ≥ 5 refusal and ≥ 5 adversarial per point |
| Pass rate | 264/264 cases passed; the script exits non-zero on the first failed assertion |

What the 264 cases check: policy admission per declared mode and status (shadow
admitted with `effect: none`, `off` and `migration` points never admitted as
shadow, `deferred` never admitted), deterministic replay, shadow no-op including a
mutation attempted inside the isolated payload, the telemetry allowlist under
hostile field names and injected secrets, budget exhaustion, closed gates, unknown
points, the `ask`/`rank`/`verify` contracts and their refusals, the frozen
registry against tampering, consumption of `session.execution.succeeded` from the
measured envelope fixture, and an offline assertion that no `v2-decision-*` module
references `node:http`, `node:https`, `node:net`, `undici`, `fetch` or Bifrost.

Refusal behaviour is a pass, not an error, and it is asserted in the 66 refusal
cases: an unknown point returns `UNKNOWN_POINT`; an exhausted budget returns
`BUDGET_EXHAUSTED`; a closed gate returns `GATE_CLOSED`; malformed telemetry is
rejected; a primitive that answers `refusal` is accepted as a success while a
missing answer is `FAILED_TO_RESPOND`; mandatory verification without a verdict is
`BLOCK`, and optional verification with only a `confidence` value is `FAIL`; `rank`
with no candidates returns `NO_CANDIDATES` and duplicate ids return
`DUPLICATE_ID`; the heuristic returns `refusal` rather than inventing a winner.

**Not measured by this harness — no claim may be derived from it:** token counts,
token savings, answer quality, latency or cost; any effect inside a host turn
(effect remains unmeasured for every point, and P7 records `effect: 'none'`);
`permission.evaluate` delivery, payload shape or write honouring; and the
embeddings-versus-BM25 comparison, which is **not run** (offline environment, no
embedding model), leaving BM25 as the baseline with no numeric result in either
direction.

## Loading the standalone export

`pantheon-opencode/local-decision-router` resolves to
`src/pantheon/local-decision-router.ts` — TypeScript source, not JavaScript. It
loads inside the OpenCode host, which transpiles package exports, or under an
explicit transpiler such as `tsx`:

```sh
npx tsx -e "import('pantheon-opencode/local-decision-router').then((m) => console.log(Object.keys(m)))"
```

Plain Node cannot import TypeScript from `node_modules` and fails with
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, so this subpath is not a
plain-Node JavaScript entry point. The published CLI avoids it by importing a
committed ESM ledger bundle; the build command and drift gate live in
[CONTRIBUTING](https://github.com/ils15/pantheon-opencode/blob/main/CONTRIBUTING.md).

```ts
import { recommendLocalDecision } from 'pantheon-opencode/local-decision-router'

const recommendation = recommendLocalDecision({
  schemaVersion: 1,
  domains: ['hermes'],
  complexity: {
    boundedness: 0,
    reversibility: 0,
    dependencies: 0,
    uncertainty: 0,
    verification: 0,
  },
  gateStatus: 'none',
})
```

## Input and route behavior

Input schema version `1` accepts only structured fields: `domains`, `complexity`,
and `gateStatus`. Extra fields (including free-form task text) make the input
invalid; the router does not parse text, infer keywords, or call a model.

`domains` contains exact canonical specialist role IDs from Pantheon's existing
agent set, not newly invented aliases. Exactly one allowlisted specialist ID
produces a `route` recommendation; an empty, unknown, unsupported, or multi-role
domain abstains. `zeus` is not a routable target. These IDs are advisory labels;
the host's existing dispatch remains authoritative.

The result includes `schemaVersion`, `policyVersion`, `decision` (`route` or
`abstain`), `agent` (null on abstention), and a stable `reasonCode`. Complexity is
reported independently in `complexity.label` and
`complexity.reasonCode`.

## Structured complexity and gates

Each of the five dimensions—`boundedness`, `reversibility`, `dependencies`,
`uncertainty`, and `verification`—must be an integer from 0 to 2, following the
proposed dimension definitions in the [offline evaluation protocol](offline-evaluation.md).
The classification is deterministic: all zeroes yield `low`; any 1 and no 2
yields `medium`; any 2 yields `high`. Missing, malformed, or out-of-range
dimensions yield `abstain` for complexity.

`gateStatus` is carried separately as `none`, `review_required`,
`human_approval_required`, or `unresolved`. It is not a complexity dimension: a
low complexity label cannot clear, reduce, or replace a security, data-integrity,
review, or authorization gate. Invalid gate values become `unresolved` and cause
the overall decision to abstain (`agent: null`). Invalid complexity dimensions
also abstain before routing; malformed input or internal validation failures
never produce a route recommendation.
