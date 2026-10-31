# Local decision recommendation API

The `pantheon-opencode/local-decision-router` export is an opt-in, deterministic
local advisory API. `PANTHEON_LOCAL_DECISION_ROUTER=1` enables only that local
selector. A separate, private per-turn selector can narrow the Pantheon skill
catalog and recommend at most one specialist for a V2 prompt. It is not a public
package export and never dispatches, changes grants, authorizes shell, or relaxes
a review/approval gate.
OpenCode V1 and V2 expose a separate
`pantheon_local_decision` advisory tool, but it does not intercept or replace
the native `subagent` child-session dispatch. An abstention or recommendation
does not start work, change grants, authorize shell, or relax a review/approval
gate.

Remote egress is fail-closed, and the user-level plugin configuration is the
source of truth. The private adapter requires all of: `enabled: true`,
`egress_consent: true`, exactly one enabled and cap-valid direct provider/model,
positive user/provider/model caps, a confirmed UTC budget period, a fixed
eligible endpoint, and a usable credential. Any missing item means zero
requests. The host's `ctx.permission.assert` is asked only after those checks
pass, as an additional kill-switch: the host is never asked to approve a request
the user's own configuration already forbids. A host that does not expose
`ctx.permission.assert` is treated as unavailable: the adapter returns
`PERMISSION_UNAVAILABLE` and makes zero requests.

`permission.assert` is a kill-switch, not consent:

- Deny is observable. An explicit `deny` rule makes the host throw
  (`Permission denied: decision.egress` unless the rule or an evaluate hook
  supplied a message) or resolve that denial message; both are a block.
- Allow has no positive value, and it is not the same as "no rule". On the
  measured v2.2.0 host an assertion with no rule for `decision.egress` resolved
  allow, so a resolved assertion means only "the host did not block it". The
  configuration above remains the authority for whether egress is authorized.

`assert` is called by the plugin in the same process it protects; it is not a
boundary against hostile same-process code. The fixed endpoints, `redirect:
"error"`, the 5-second timeout, the response-size cap, and the SQLite ledger are
the real protections against an accidental or over-broad egress.

The request uses `source: { type: 'tool', id, messageID }`; the host rejects
`source: { type: 'prompt', messageID }` with `SchemaError: Expected
Permission.Source`. The `id` is a namespaced synthetic value
(`pantheon-decision:<sessionID>:<messageID>`), not a real tool-call id; it only
identifies the internal assertion flow. The action is not `webfetch`; no native
webfetch rule is reused. The request carries `agent` only when the caller knows
the current agent; it is never fabricated.

`decision.egress` has no bundled default rule, and the host is **not**
deny-by-default for it: an assertion with no matching rule resolved allow on the
measured host. The config/consent gate above — not the host — therefore keeps
egress off until the user opts in, and an explicit `deny` rule is the
kill-switch. The plugin never bypasses a denial; to block it, add an explicit
`deny` rule (syntax verified on the current canary host):

```json
{
  "permission": {
    "decision.egress": {
      "https://api.typesafe.ai/v1/systemone": "deny"
    }
  }
}
```

An `allow` entry is equivalent to having no rule on the measured host; only
`deny` changes the outcome.

The host accepts that action rule under root `permission` or `permissions`, and
under `agents.<id>.permissions`; the singular `agents.<id>.permission` map is
ignored. The value is `allow | deny | ask` per resource pattern, and the other
eligible pattern is `https://api.openai.com/v1/decisions`. A `deny` rule — or a
host gate that throws — still means zero requests. The plugin configuration
alone is not a sandbox, and it never asks the host to authorize what the user's
own configuration forbids.

The plugin's `permission.hook('evaluate')` handler does NOT decide
`decision.egress`: it passes the event through untouched. The v2.2.0 canary
observed that the hook runs on the allow path of `permission.assert` and is not
invoked for an explicit `deny`; requiring the hook would have made egress inert,
and deciding in it could not block what the host already denied. The
delegation/subagent matrix in the same hook is unchanged.

Egress therefore remains off by default because the local configuration is closed
by default: `enabled` and `egress_consent` are false, and no provider call is
made unless every gate above holds. A host without
`assert` gets zero requests. OpenCode Console Jev, Jev Free, and Bifrost are
ineligible and never reach transport.

## Per-turn selection (V2)

When the user-level config has `enabled: true`, the V2 `session.hook('prompt')`
callback receives the current admission. It reads only the user's current
request text, asks the local selector for a small allowlisted skill set, and —
only when the request contains a local delegation signal — asks for at most one
eligible specialist ID. There is at most one provider call per
session/message pair; a repeated admission reuses the cached decision. Each
session/message pair, including a child session, may therefore issue at most one
POST, still bounded by the configured caps and budget period. The
caller's permission gate is asserted once per gate identity: the same (possibly
interactive) `permission.assert` is not prompted again for that cached turn, while
a different gate or a missing one is evaluated before reuse and can still deny.
The user-level config/consent gate is re-read on every cached reuse (local config
and ledger reads, no network), so revoking consent, disabling the router, or
dropping caps takes effect immediately instead of at cache expiry. Deny is a
throw or an explicit denial marker — including the host's returned
`Permission denied: decision.egress` message; a resolved assertion is the host's
allow path, so reuse needs no freshly minted token. A host that caches the assert
result for the synthetic action simply resolves it again.
The in-process decision cache holds at most 128 entries for 10 minutes; after
FIFO eviction, a late repeated admission for the same turn may perform the
single allowed request again, still bounded by the configured caps.

The hook rewrites `prompt.skills` only when the host exposes a non-empty array of
stable skill identifiers, the advisory selection is non-empty, and that selection
intersects the host list. Otherwise the host list is left untouched, so an empty
or non-matching advisory selection never erases skills chosen by the host or user.
It never claims a token saving: the host may ignore the rewrite, and this
repository has not measured a catalog-size reduction. A compact
`<!-- pantheon-decision-router:v1 ... -->` marker carries the advisory IDs so the
model can see them. The marker contains no request text, files, paths, memory, or
credentials.

The hook uses the canonical agent IDs plus `routing.yml` grants and
`permission.task` to narrow candidates. It does not receive a host-native
availability list: the prompt hook has no proven host API for native subagent
availability, so Zeus (or the caller of the advisory tool) validates the
recommendation against currently available native targets and performs the
native `subagent` call; the selector never dispatches, handoffs, or loops.

Because the hook awaits the local selector and, only when every gate passes, the
provider request, it can block admission for up to the fixed 5-second provider
timeout. It never starts an unsafe background request; disabling consent or
selecting Local keeps the hook local-only and non-blocking on network I/O.

V1 has no equivalent pre-resolution hook in this repository. V1 remains
local-only and does not call a provider. The `pantheon_local_decision` tool is
unchanged.

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

Per-turn selection is separately disabled unless the user-level config file has
`enabled: true`. `decision-router enable` (no arguments) enables turn selection;
`decision-router disable` disables it. `enable <provider> <model>` still toggles a
single candidate. Enabling never implies consent, caps, or eligibility.

## User-level provider configuration and budget

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

Provider/model selection, enabling a candidate, recording an egress-consent setting, each of
the user/provider/model caps, and budget-period confirmation are separate actions.
There are no default caps or automatic period rollover. The month confirmation is
an explicit user command, never model/tool input. **Admission caps are local
best-effort controls, not invoice guarantees**: provider pricing, billing, token
rounding, and external account activity remain outside Pantheon's control.

These settings are necessary for provider egress but are not sufficient on
their own: the host permission gate (`assert` must not deny; add an explicit
host rule if your host denies the custom action),
one eligible provider, the current budget period, a reconcilable usage response,
and current-turn deduplication must all hold. The `pantheon_local_decision` tool
itself remains local; it never reads
provider credentials, reserves a provider request, or calls Fetch. The private
per-turn adapter is the only egress path, and it is not a package export.

A v2.2.0 host canary measured the `permission.assert` contract for this action:
the accepted `source` shape, that an assertion with no rule for `decision.egress`
resolved allow rather than deny, that the `permission.hook('evaluate')` handler
runs on that allow path and is skipped for an explicit `deny`, and which rule
locations the host honors — root `permission`/`permissions` and
`agents.<id>.permissions` are accepted, while the singular
`agents.<id>.permission` map is ignored. The canary made no provider request. No
live provider request was made for this change.
OpenCode Console Jev and Jev Free remain ineligible for usage reconciliation; do
not treat Jev Free as guaranteed `$0`.

## Provider eligibility and payload

| Provider | Model | Egress |
|---|---|---|
| `openai-decisions` | `gpt-6-luna` | Eligible; usage/cost documented |
| `typesafe-jev` | `jev-1.14.0` | Eligible; usage/cost documented |
| `opencode-console-jev` | `jev-1.13` | Ineligible; usage/cost not reconcilable |
| `opencode-console-jev-free` | `jev-1.13-free` | Ineligible; not assumed free |

The provider payload is exactly the current user request text (outer whitespace
trimmed) sent verbatim, the 20 allowlisted skill IDs with one-line descriptions,
and — only when delegation is under consideration — the eligible specialist IDs
with one-line descriptions. It never adds the transcript, prior messages, files,
source, paths, full agent/skill instructions, memory/resources, outputs, or logs.
Secret rejection is **best-effort**: a regex refuses high-confidence credential
shapes. For the `sk-` family it requires a token boundary plus a structured
prefix or a long bare token (`sk-proj-…`, `sk-svcacct-…`, `sk-admin-…`,
`sk-ant-…`), so prose such as `task-force-…`, `disk-usage-…`, or
`desk-organization-…` is not mistaken for a key; other families cover
cloud/SaaS tokens, JWTs, bearer values, `password=…`, and `api_key=…`. It is not
a secret scanner and may miss other formats. The request is otherwise verbatim, so **do not consent to egress while a
possible secret is present in the prompt** and do not paste credentials into task
text. The request must be 12,000 characters or fewer; otherwise the turn stays
local.

## Provider protocol

Each adapter uses a fixed endpoint, model, credential variable, timeout, and
response-size limit. The private runner performs one POST with `redirect: 'error'`
and no retry, failover, or fan-out. A response is accepted only when its documented
usage fields reconcile to the reservation; otherwise the hold stays unresolved and
the turn falls back to the local selector. OpenCode Console usage is treated as
unknown even when a proxy response resembles a usage object. Abstention is an
explicit `abstain` choice or low confidence; answer confidence and the selected
probability must both be at least `0.80`.

**The endpoint URLs are retained inert and are UNWIRED in the decision-layer
surface.** `https://api.openai.com/v1/decisions` and
`https://api.typesafe.ai/v1/systemone` (plus the two ineligible Console endpoints)
remain in the private matrix as fixed strings, and `v2-decision-egress.ts` declares
`wireStatus: 'unwired'` with no transport of its own. This is a statement about
wiring, not about removal: nothing here claims the transport was deleted. Bifrost
is not a decision-router provider, model, or budget row, and a test asserts its
absence from both maps.

**Dated documentation snapshot (2026-10-30):** OpenAI GPT-6 Luna standard rates
are $0.10/1M input and $0.50/1M output tokens; its documentation separately lists
cached-input and cache-write rates. Because those special rates are not modeled, any
cached or cache-write input leaves the hold unresolved. TypeSafe Jev 1.14 lists $0.042/1M
input tokens and free output tokens. OpenCode Console lists Jev 1.13 at $0.042/1M
input and free output, and Jev 1.13 Free as free for a limited time; neither Console
model is eligible for reconciliation. Jev Free is not treated as a durable zero-price
guarantee.



Official sources: [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions),
[OpenAI Decisions API reference](https://developers.openai.com/api/reference/resources/decisions/methods/create),
[GPT-6 Luna model/pricing](https://developers.openai.com/api/docs/models/gpt-6-luna.md),
[TypeSafe models](https://docs.typesafe.ai/models),
[TypeSafe System One API](https://docs.typesafe.ai/api/system-one),
[TypeSafe state](https://docs.typesafe.ai/concepts/state.md), and
[OpenCode Console models](https://opencode.ai/v2/docs/console/models/#jev).

Usage normalization is separate from request/response parsing. The internal ledger
accounting code accepts only strict OpenAI Decisions or TypeSafe direct usage evidence
and mints an opaque, in-memory capability bound to the reservation ID, provider, model,
and period.
Costs are calculated from the dated rates using integer arithmetic and ceiling
rounding; zero-cost, malformed, negative, Console, and unknown usage cannot mint a
capability. The caller cannot supply an amount or pricing marker. This module is
internal and is not a public package export or a user/tool input. As with any
same-process API, this is not a security boundary against malicious application code.

The ledger's internal `reconcileVerified(reservationId, evidence)` checks that bound
identity against the pending/uncertain reservation and atomically records actual cost.
An overrun persists its cost and freezes the user/provider/model buckets in the same
transaction. Invalid or unknown usage leaves the hold intact. No unknown-cost hold is
released. OpenCode Console
Jev/Jev Free remain ineligible, even when explicitly selected and enabled.

## User-level local budget ledger

The internal `src/pantheon/local-decision-budget.ts` module provides local
accounting and capability-gated reconciliation. It is not a public package export.
The private adapter lives in
`src/pantheon/local-decision-provider.internal.ts`; it is not a package export and
accepts no caller-supplied fetch, base URL, config, environment, or ledger.
Configuration, consent, provider/model enablement, period confirmation, a
credential, and a reservation are necessary but not sufficient: the host
permission gate and current-turn deduplication are also required.
Protocol tests stub Fetch with synthetic responses and make no live calls.
The SQLite database is separate from `opencode.db` and project install state. Its
default user-level path is `$XDG_STATE_HOME/pantheon/decision-budget.sqlite`, or
`~/.local/state/pantheon/decision-budget.sqlite` when `XDG_STATE_HOME` is not an
absolute path. It stores only provider/model keys, explicit UTC budget period,
integer USD micros, reservation state/ID, and timestamps; it stores no payload,
response, credential, or raw error. New DBs have neither caps nor an active period,
so admission is denied. Schema v3 migrates v1 through v2 and v2 through v3 in
transactions, preserving caps and reservations. Because old reconciliation evidence
was forgeable, old `reconciled` rows become `uncertain`; their retained hold is the
greater of the reserved amount and previously reported actual amount. Legacy `jev`
rows map to the TypeSafe Jev model pinned by the v1 adapter.
Rollback leaves the DB untouched; older code rejects schema v3 and fails closed.

The v3 active budget period is explicit persisted state, not the maximum month ever
seen on the wall clock. Crossing a calendar month never advances it automatically.
`confirmBudgetPeriod(expectedCurrentPeriod, targetPeriod)` initializes it with a
null expected value or advances it by exactly one month, using an atomic expected/
target comparison; it rejects stale, backwards, skipped, or wall-clock-mismatched
updates. Reservations require a confirmed period equal to the current wall-clock
month; missing confirmation or divergence denies admission. Future-dated v2 holds
are conservatively included in active and later period totals until the active period
passes their month. A monotonic clock detects in-process regressions only; it does
not decide UTC or authorize period advancement. Human confirmation is an
administrative assertion, not a trusted clock source, and must only be given after
independently checking the month. No period default is assumed.

Path resolution retains XDG behavior, but opening the DB fails closed unless every
directory ancestor is a non-symlink, owned by the current user or root, and not
group/other-writable (except root-owned sticky directories such as `/tmp`). The
ledger directory/file are tightened to `0700`/`0600`. Windows and platforms without
POSIX ownership checks are currently unsupported and fail closed; symlinked XDG
paths also fail closed.

Admission requires explicit positive monthly and per-decision caps in all three
dimensions: per-user (the account-wide DB), provider, and provider/model. The
provider keys below are local configuration/accounting identifiers only; they do
not imply production provider support or enable remote decision calls. Keys may be
`openai-decisions`, `typesafe-jev`, `opencode-console`, and `jev-free`; model keys are
explicit configuration keys, not provider defaults. OpenCode Console variants
remain visible in configuration for administration but are ineligible for egress.
They each need a model cap and also share the `opencode-console` provider cap. All values are non-negative integer USD micros; absent, malformed, or
zero caps deny admission. There are no default caps; only the dated rates above are
used by the internal usage verifier.

The user-level admin CLI and internal library setters configure caps. The setters
are `configureUserCaps(caps)`, `configureProviderCaps(provider, caps)`, and
`configureModelCaps(provider, model, caps)`, each persisting
`{ monthlyCapMicros, perDecisionCapMicros }`. They are not a model-callable tool.
Cap changes are local admin actions and are never accepted from a decision/provider
request. `reserve(provider, model)`
accepts neither an estimate nor cap overrides: it atomically reserves the model's
configured maximum per-decision amount against all three monthly buckets. A
wider-scope per-decision cap below that maximum denies admission. Reservations
survive restart; unknown usage, timeout, error, or undocumented pricing retains the
entire hold. Pruning uses the explicitly active period, never an auto-advanced clock,
and retains unresolved reservations.

`decision-router holds` lists every `pending`/`uncertain` hold (`status`,
`provider`, `model`, `period`, `reserved_micros`, and reservation ID). It never
releases cost or changes reservation rows; the only writes an open can perform are
creating a missing database and the forward-only schema migration noted above.
Holds from an earlier period are not auto-resolved, are not pruned, and keep that
period's resolved rows and freezes from being pruned; they stay visible until an
explicit reconciliation/resolution (or a database-level administrative
intervention). Inspect and resolve them before advancing or cleaning periods; do
not assume a new month clears them.

The internal reconciler accepts only an opaque capability minted by the strict
OpenAI Decisions/TypeSafe direct usage verifier; request/model/tool input cannot
submit a cost, evidence marker, or zero-cost claim. Unknown/unverified pricing or
usage, and all OpenCode Console usage, leave the complete hold pending. Same-process
code is not a security boundary against malicious code. Local admission also cannot
guarantee the provider invoice: local state can be modified/deleted and billing
semantics can differ. A successful local reservation does not by itself authorize
a provider call; the host permission gate and current-turn deduplication must also
pass.

## Measured coverage and unmeasured surfaces (V2 decision layer)

The registry reports coverage as measured, premise, advisory, or deferred, and
`measured` never means "effect measured". What that means in practice:

| Point | Surface | Status | What is NOT covered |
|---|---|---|---|
| P7 (loop) | `session.execution.succeeded` | Behind `PANTHEON_V2_P7_LOOP`, off by default. The 12-execution cap (`P7_LOOP_MAX_EXECUTIONS`) is **advisory**: `reset()` is caller-supplied, no measured host surface signals a user turn, and the streak is not claimed to reset on any event. | Effects are unmeasured (C6); nested depth ≥ 2, failed/interrupted child executions and image jobs were not exercised. Never describe this as working loop enforcement. |
| P2 (skill) | `session.hook('prompt')` | **Advisory only**: an empirical no-op on the default path, because the host sends `prompt.skills` absent. | P2b filtering was cancelled by measurement, not emulated; no token reduction is claimed. |
| P9 (compaction) | `session.hook('compaction')` | Measured on **top-level sessions only**. | Child-session compaction, `reason: "overflow"`, and the `messages` channel are UNKNOWN. |
| P8 (guardrail) | `permission.evaluate` | **Off**; activation is blocked pending its review conditions (C11–C15) and it starts off, never shadow. | `permission.evaluate` was registered and never fired; payload shape, write honouring and ordering are unmeasured. `execute.before` remains the only hard barrier. |

Budget facts are the same story: caps are local admission controls computed from
explicit configuration, and they are not invoice guarantees. There are no default
caps, no automatic period rollover, and no admission from a missing ledger.

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
