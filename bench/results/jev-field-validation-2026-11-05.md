# Jev field validation — 2026-11-05

Scope: investigate whether everything works on the current line, and whether
the surface can expand. Operator-run; live calls billed to the configured
route (OpenRouter, `typesafe/jev-1.13`). Installed version at the end of this
validation: **1.6.3-beta.10** (global, with the unreleased holds-release
feature from this branch).

## Sandbox (isolated install, real-user path)

- `npm pack` → global install in `~/pantheon-sandbox` (own HOME/prefix/XDG):
  version **1.6.3-beta.10** ✓
- `init --yes --headless --force --components agents,skills,instructions,runtime`:
  **the `runtime` component is what installs MCP + venv; the headless default
  does not include it** (five servers absent until requested explicitly).
- `doctor`: **28 passed, 0 warnings, 0 errors** ✓
- MCP smoke over stdio JSON-RPC (the `opencode mcp list` CLI reports
  "No MCP servers configured" in this build **even in the working real
  environment** — display quirk, documented): all five servers start and
  answer — memory 9 tools, resources 4 top-level resources, code-mode 2,
  persistence 6, vision 3 ✓
- Decision layer in sandbox: `setup-model typesafe-jev/jev-1.14.0` +
  caps → `--ping` resolves config-only ✓, `status` shows consent on,
  ledger v3 clean ✓

## Live field probes (real route)

- **Scorecard (16 scenarios)**: **14/16 exact**; the 8 zero-dispatch-agent
  scenarios hit 8/8 (reform evidence holds). The 2 misses are the same
  domain-adjacent judgment calls as the 2026-11-04 run (webhook→hermes vs
  apollo; migration→demeter vs athena). Cost column reads 0 — OpenRouter
  does not populate `cost` for this model (reporting gap, not a regression).
- **N4 re-test (`USAGE_UNRECONCILED 100%` from the field report) — verdict:
  dead.** A real delegation decide through the plugin gate chain returned
  `advisory:true` with reconciled usage (`costUsd:0.000017136`,
  tokens 408/132, `frozen:false`); ledger reservations 46→47 with holds
  unchanged — the new call reconciled, no new hold. The symptom belonged to
  the old build (the global install was 1.6.3-beta.4).
- **Verify mode (v3.1)**: field-verified — envelope accepted, live call
  reconciled (reservations 47→48, holds unchanged), verdicts flow. The
  hostility scan rejected path-shaped claims (fail-closed by design), and
  machine-fact claims correctly FAIL when the supplied state cannot carry
  them. A pre-restart attempt returned `PRESET_INVALID` — the running
  service still had the old plugin in memory; restart is required after a
  plugin upgrade (already in the setup checklist).
- **Refusal contract in the field**: a wrong-envelope call
  (`question`/`candidateAgents` instead of `state`) refused precisely
  (`STATE_INVALID`) before reserving anything — the ledger did not move
  (N1/N6 class verified).

## Field bugs found and resolved during validation

1. **Dangling plugin registration (fixed)** — the host config pointed the v2
   plugin at a recycled npx cache path; the entire plugin (structural tools,
   J-series gates, TUI glue) never loaded in any session. The beta.7 init
   preflight exists for exactly this; `init` re-registered to the real
   install, and the global package was upgraded beta.4 → beta.10 (the exact
   build the field report blamed).
2. **Dead-route holds froze the budget (fixed in this branch)** — 43 holds
   ($4.30 of the $5 monthly user cap): 33 openrouter from the old-build era
   plus 10 `jev-free` fossils of the removed free route. The ledger had no
   release path ("recovery never releases"), so dead holds froze budget
   forever — the mechanical story behind the mid-month Jev die-offs. This
   branch adds `decision-router holds release --provider <dead> --reason`
   (schema v4 archive; live providers are refused — their holds roll off
   with the period). Applied: the 10 jev-free holds released, $1.00 freed;
   the 33 openrouter holds stay for the period roll (conservative).
3. `opencode.json` + `opencode.jsonc` coexist in the user config; the host
   merges them and `.jsonc` scalars win (init warning; hazard documented —
   plugin entries in the `.jsonc` are invisible to the installer).
4. The V1 `plugin` key entries (file paths) are ignored by the V2 loader —
   left in place, warned by the installer.

## Can it expand? (verdicts, details in docs/reference/native-decisions.md)

- Jev as MCP-call arbiter: **no** — a paid call gating a free local call is
  negative economics.
- Jev as the vision spend gate: **defer** — permission `ask` + usage policy
  cover it; revisit only if the audit shows abuse.
- Rank cap 8→20 (P4/P11): product decision pending; winner+fit does not
  scale past ~10 candidates (one scalar per question) — a redesign
  (tiered/tournament) is implied, documented.
- Callers/routes: sufficient (`PANTHEON_JEV_SPECIALIST_CALLERS` CSV + 5
  routes); no expansion now.

## Follow-ups

- The sandbox runner's `opencode mcp list` gate (5/5) needs a note: this CLI
  build reports none even when servers are live; the stdio smoke is the
  real check.
- Re-run the MCP usage audit after a few sessions of the new usage policy.
- Schema v4 ledger: installed-CLI readers older than this branch report
  `unsupported-schema` until upgraded (this machine's global was upgraded
  during this validation).
