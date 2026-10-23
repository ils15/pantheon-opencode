# Permissions, Quality Gates and Delegation — A Cross-Cutting Map

Three subsystems in this repository are each specified in more than one place, and
in each case the places are not wired to one another. A reader who takes any single
one of them as the specification will be wrong about the other two.

This document is the map. It does not restate what any single file already says —
where another document is authoritative, this one links to it. What it adds is the
cross-cutting view: which layer is load-bearing, which is decorative, where two
layers disagree, and what a reader can and cannot rely on.

Three terms are used throughout, with fixed meanings:

| Term | Meaning |
|---|---|
| **Load-bearing** | Some code path in this repository reads the value and changes behaviour because of it. |
| **Decorative** | Nothing in this repository reads the value. It documents an intent; changing it changes no behaviour. A decorative layer is not a bug by itself, but a change to it is not a change to the system. |
| **UNVERIFIED** | A claim this repository cannot settle on its own. Named explicitly, with the evidence that would settle it. See [§5](#5-open-questions-and-known-issues). |

**Scope.** Behaviour of the OpenCode host itself is out of scope for verification:
this repository does not vendor the host's source, and its own ambient type
declaration records that the agent-config surface is not typed here
([`src/opencode.d.ts:4`](https://github.com/ils15/pantheon-opencode/blob/main/src/opencode.d.ts#L4)). Where the answer lives in the host, this document says so
rather than guessing.

---

## Table of contents

1. [Quality gates](#1-quality-gates)
   - [When a review is required](#when-a-review-is-required)
2. [Agent permissions: four layers at once](#2-agent-permissions-four-layers-at-once)
   - [Which permission layer is load-bearing](#which-permission-layer-is-load-bearing)
3. [Delegation](#3-delegation)
   - [Delegation by host generation](#delegation-by-host-generation)
4. [Disagreements between layers](#4-disagreements-between-layers)
5. [Unverified, and the evidence that would settle it](#5-open-questions-and-known-issues)

---

## 1. Quality gates

### 1.1 What the reviewer role is

The reviewer is the agent whose canonical definition is [`src/agents/themis.md`](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/themis.md). Its
own file is the authoritative statement of the contract — read it there:
[IntentGate, the post-delegation check, the three review layers, the quality-gate
checklist and the four verdicts](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/themis.md) are all defined in that file
and are not repeated here.

The shared role summary is carried in [AGENTS.global.md](https://github.com/ils15/pantheon-opencode/blob/main/AGENTS.global.md)
(generated — see [§2.7](#27-the-agent-table-in-agentsglobalmd)). The project
`AGENTS.md` contains repository setup only.

### 1.2 What the reviewer enforces, and what it does not

The single most important fact about the quality gate:

> **No code path in this repository invokes the reviewer, and no code path reads a
> review verdict.**

A search for the reviewer role and for verdict identifiers across [`src/`](https://github.com/ils15/pantheon-opencode/tree/main/src) and
`scripts/` returns: the agent-name list in the model-routing table
([`src/pantheon/model-agents.ts:2`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/model-agents.ts#L2)), the agent-prefix map in the board
([`src/pantheon/background-job-board.ts:154`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/background-job-board.ts#L154)), a model-tier map in a delegation hook
(`scripts/hooks/on-subagent-delegation-start.sh:170`), the uninstall manifest, the
canonical-file existence check in the routing validator, and the hard-coded agent table
in the AGENTS.md builder. **Not one of those matches invokes the reviewer, and not one
reads a verdict.** There is no reviewer-invoking dispatcher, no verdict consumer, and no
branch anywhere that blocks on a review result.

**One artifact implements part of the contract and is wired to nothing.**
`scripts/themis_heuristic_scan.py` is a Layer-1 heuristic scanner whose own docstring
states that it "Retorna score 0-100 + blocking verdict" — it emits a blocking verdict
from code. **No gate runs it.** Its only referrer in the repository is the
`pantheon-audit` slash command (`commands/pantheon-audit.md:18`), which a model must
choose to invoke by hand. It is a code artifact implementing the scoring half of the
reviewer contract with nothing behind it, which is exactly the artifact a reader of
this section needs to know about.

**The nearest thing to an automated review check cannot block.** The stop hook
`scripts/hooks/validate-post-conditions.sh` does look for review output: it counts
`REVIEW-*` files in `.pantheon/memory-bank/.tmp` and prints a reminder to stderr if it
finds none (`scripts/hooks/validate-post-conditions.sh:15`). It then **always
`exit 0`** (`scripts/hooks/validate-post-conditions.sh:21`). It counts *filenames* and
parses no verdict, so it is a nudge, not a gate. Read the two paragraphs above together:
review-*shaped* code does exist in this repository — a scanner, and this hook — but none
of it is wired to anything that can stop a change. That is the precise form of the
claim at the top of this section.

So the review gate is a **prompt-level contract**, carried in the agent definition
and in the orchestrator's instructions, and it holds exactly as far as the models
honour it. Concretely:

**Enforced in code (a different mechanism, not the reviewer).** These are real,
failing-closed gates, but they are not the reviewer:

| Gate | Mechanism | Where |
|---|---|---|
| Read-only sessions may not mutate | `tool.execute.before` throws | [`src/pantheon/delegation-enforce.ts:181`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/delegation-enforce.ts#L181) (blocked-tool set), [`src/plugin.ts:101`](https://github.com/ils15/pantheon-opencode/blob/main/src/plugin.ts#L101) |
| A child session may not delegate again | same guard, child-session branch | [`src/pantheon/delegation-enforce.ts:353`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/delegation-enforce.ts#L353) |
| Caller/target delegation matrix | same guard, `isDelegationAllowed` (V1; V2 uses the permission hook — see [§3.5](#35-per-host-generation-what-you-can-rely-on)) | [`src/pantheon/delegation-enforce.ts:138`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/delegation-enforce.ts#L138) |
| The orchestrator may not read source | `zeusReadGuard` throws | [`src/pantheon/delegation-enforce.ts:221`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/delegation-enforce.ts#L221) |
| Code-mode scripts must be approved | SHA-256 manifest, opt-in | `scripts/install/opencode.mjs:138` |
| Routing/frontmatter consistency | repo validator script | `scripts/validate-routing.mjs:313` |
| Secrets | pre-commit gitleaks + CI scan | `.pre-commit-config.yaml:7` |

**One of those is stronger than "repo validator script" suggests — with one hole in it
(dated fact).** The routing validator runs as a named step inside the `validate` job
(`.github/workflows/ci.yml:92-93`), and the workflow triggers on `pull_request` against
`main` and `develop`. **Routing and frontmatter validity is therefore CI-enforced on
every pull request**, and a failing check fails the job. The residue is the trigger
list: the workflow has no `push:` trigger, so a commit pushed straight to `main` is
ungated. Verified 2026-10-04 at `80bac52`.

**Not enforced as a general review contract.** The repository has focused 80% gates
for Python MCP code and the V2 TypeScript plugin, but they do not make the reviewer
run or enforce every check in its prompt. The IntentGate comparison, post-delegation
review, deprecation review, and verdict handling remain prompt-level. The broad Node
coverage command is report-only; the focused gates are separate CI jobs.

**Not enforced because it is not the reviewer's to own.** The reviewer definition
requires the review to name a failing layer and blocks on it. Nothing in the
orchestrator's instructions reads that block and re-plans; the block is a message,
not a state transition.

### 1.3 Blocking versus non-blocking, in this project's terms

The project uses four verdict strings, defined in the reviewer file
([`src/agents/themis.md:154-157`](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/themis.md#L154-L157)). Grouped by what they actually do:

| Verdict | Blocking? | Meaning in this project |
|---|---|---|
| `BLOCK` | **Yes** | Work stops. Names a layer (1/2/3) and a reason. |
| `BLOCK_INTENT` | **Yes** | The IntentGate comparison failed: the code does not do what was asked. Emitted instead of `BLOCK` when the divergence is in the requirement, not the code. |
| `PASS` | No | No critical issues. |
| `PASS_WITH_NOTES` | **No** | Approved, with suggested improvements. |

The same four terms are reused as an output schema in the orchestrator's instructions
([`src/instructions/zeus-council-synthesis.instructions.md`](https://github.com/ils15/pantheon-opencode/blob/main/src/instructions/zeus-council-synthesis.instructions.md)), and `PASS_WITH_NOTES`
carries the same non-blocking weight there.

Two non-obvious consequences of this vocabulary:

- **`PASS_WITH_NOTES` is not a soft `BLOCK`.** It is a pass. The decision-tree
  criterion that decides reviewer involvement is phrased in terms of whether output
  "feeds into" review, not whether review passed — see [§1.4](#14-full-task-versus-subtask-a-qualitative-risk-decision).
- **The reviewer role itself has a separate, harder block, which is enforced.** The
  reviewer is denied `edit` at the permission layer
  ([`src/agents/themis.md:10`](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/themis.md#L10)), so a reviewer physically cannot fix what it finds.
  The `ABSOLUTE CONSTRAINT` at the top of that file ("REVIEWER ONLY") is therefore
  backed by a real permission, not only by instruction — this is the one place in
  the quality-gate system where the prompt contract and an enforcement mechanism
  agree.

A third, different vocabulary exists for the orchestrator's session-level
continuation and is unrelated to review verdicts: the injected "pending todos
remain" prompt ([`src/pantheon/todo-enforcer.ts:65`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/todo-enforcer.ts#L65)). Do not read it as a review
outcome.

## When a review is required

The reviewer role defines *what* a review checks; this section defines *when* a
review applies and how an escape hatch is recorded.

### 1.4 Full task versus subtask: a qualitative risk decision

The current decision is in the orchestrator's instructions
([`src/instructions/zeus-timeout-retry.instructions.md:76`](https://github.com/ils15/pantheon-opencode/blob/main/src/instructions/zeus-timeout-retry.instructions.md#L76)). It has no file-count or
line-count threshold. Choose the lightest route that safely meets the request by
considering uncertainty, specialist domain, dependencies, risk, and verification:

| Situation | Route |
|---|---|
| Self-contained work that needs no specialist | Do it inline; do not delegate merely to move it elsewhere |
| One bounded task needing a specific domain | One correct specialist, with relevant context and focused verification |
| Independent fronts that can proceed separately | Zeus may make separate root dispatches; dependent work stays ordered |
| Unclear, broad/material, sensitive, destructive, or high-uncertainty work | Add only the planning, review, artifact, and approval gates the risk requires |

Auth/security, data/schema, destructive or material changes, and uncertainty that
prevents safe execution retain their applicable gates. A bounded multi-file change
is not automatically a full task, and a one-line change is not automatically safe.

**What lightweight subtask mode skips** (from the same instructions): routine
planning/artifact work, separate discovery, council, and review when no such gate is
required. It does not remove required Themis or other risk-based gates. The result
format depends on the role: implementation work uses `## subtask_summary`, while
investigations, Athena plans, and council responses keep their own contracts in
[`src/instructions/agent-return-format.instructions.md`](https://github.com/ils15/pantheon-opencode/blob/main/src/instructions/agent-return-format.instructions.md).

### 1.5 Escape hatches, and what happens when they are used

Every hatch below is verified present. "Consequence" states what actually happens on
use, which is not always what the hatch's name suggests.

| Hatch | Where | Consequence on use |
|---|---|---|
| Classify as a subtask | [`src/instructions/zeus-timeout-retry.instructions.md:92`](https://github.com/ils15/pantheon-opencode/blob/main/src/instructions/zeus-timeout-retry.instructions.md#L92) | Reviewer is never invoked. Nothing downstream fails. The transcript contains no review verdict, and no code checks for one. **This is the widest hatch and the only one with no trace.** |
| `PANTHEON_TODO_ENFORCER=off` | [`src/pantheon/todo-enforcer.ts:79-84`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/todo-enforcer.ts#L79-L84) | Session-level continuation stops. The routing-matrix mirror is explicitly *not* the switch — the env var is ([`src/routing.yml:590-591`](https://github.com/ils15/pantheon-opencode/blob/main/src/routing.yml#L590-L591) says so in a comment). Read once at plugin construction, so it takes effect on the next process start, not mid-session. |
| `PANTHEON_HOOKS_LOG=1` | [`src/pantheon/logger.ts:97`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/logger.ts#L97), [`src/plugins/pantheon-hooks.ts:192`](https://github.com/ils15/pantheon-opencode/blob/main/src/plugins/pantheon-hooks.ts#L192) | Console echo of the file-only log. Does not change enforcement. |
| `PANTHEON_TOASTS=off` | [`src/plugins/pantheon-hooks.ts:76`](https://github.com/ils15/pantheon-opencode/blob/main/src/plugins/pantheon-hooks.ts#L76) | TUI notifications suppressed by category. Every suppressed toast is still written to the structured log and the hook log, so the trail stays auditable at any setting. |
| `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` | documented in [QUICKSTART](QUICKSTART.md) and [INSTALLATION](INSTALLATION.md) | May enable background child sessions only on host versions that support and document this experimental setting; verify the active runtime rather than treating it as a general prerequisite or guarantee. In the reported Beta 10 Zeus-root inventory, `subagent` was callable but `task_status`/`cancel_task` were not exposed; no tracking or recovery guarantee follows. See [§3.1](#31-two-mechanisms-and-what-each-is-for). |
| `--opencode-version v1\|v2`, `OPENCODE_VERSION`, `OPENCODE_BIN` | `scripts/install/opencode-version.mjs:213` | Pins the plugin generation. Precedence is argument, then env var, then an `opencode2` binary basename, then a `--version` probe, then a warned fallback to V1 (`scripts/install/opencode-version.mjs:223`, `scripts/install/opencode-version.mjs:288`). The fallback is the important one: it **warns and writes the V1 contract**, so an unrecognised 2.x host gets V1 plugins rather than none. |
| `git commit --no-verify` | `.pre-commit-config.yaml:7` | Skips the secret gate. The config comment names this a security violation; nothing in the repo prevents it. |
| Editing a decorative layer | see [§2.7](#27-the-agent-table-in-agentsglobalmd) | Silently no-ops. This is the failure mode most likely to waste someone's time, because it produces no error. |

---

## 2. Agent permissions: four layers at once

Agent permissions are expressed in four separate places. They are not derived from
one another, no layer validates against another at runtime, and they can disagree.

### 2.1 The four layers at a glance

| # | Layer | Location | What it actually controls | Load-bearing? |
|---|---|---|---|---|
| 1 | Per-agent frontmatter | [`src/agents/*.md`](https://github.com/ils15/pantheon-opencode/tree/main/src/agents) | A subset of keys reaches the installed config. The full block reaches the host only if the host reads the agent file. | **Partly** — see [§2.6](#26-which-layer-is-load-bearing) |
| 2 | Routing matrix + permission keys | [`src/routing.yml`](https://github.com/ils15/pantheon-opencode/blob/main/src/routing.yml) | `presets:` and `presets.<n>.agents.<a>.model` are read at runtime. **Every permission and delegation key in it is decorative** — decorative here means *no code in this repository reads it*; it does **not** mean the host ignores it ([§2.6](#26-which-layer-is-load-bearing)). One narrow CI-time exception: the validator reads `delegation.zeus` ([§2.3](#23-layer-2-routingyml-what-is-read-and-what-is-not)). | **No** — see [§2.3](#23-layer-2-routingyml-what-is-read-and-what-is-not) |
| 3 | Installed config the installer seeds | the user's `opencode.json` | The `agent.<name>.permission` blocks the host reads at session time. | **Yes** — see [§2.4](#24-layer-3-the-config-the-installer-seeds) |
| 4 | V1→V2 translation map | `scripts/install/config-migration.mjs:49-59` | Only the V2 install path. Converts layer 3's shape; keys outside the six-entry table still pass through — see [§2.5](#25-layer-4-the-v1v2-translation-map). | **Yes, on the V2 path only** |

### 2.2 Layer 1 — per-agent frontmatter

Fourteen agent files under [`src/agents/`](https://github.com/ils15/pantheon-opencode/tree/main/src/agents). Each declares a `permission:` block.
Selected examples, to show the shapes in use:

| Agent | Shape | Citation |
|---|---|---|
| `zeus` | flat allows plus `task: {"*": allow}` | [`src/agents/zeus.md:5`](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/zeus.md#L5) |
| `hermes` | flat allows plus `task: {"*": deny, apollo: allow}` | [`src/agents/hermes.md:20`](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/hermes.md#L20) |
| `mnemosyne` | scoped glob denies on `write` and `edit` | [`src/agents/mnemosyne.md:31-38`](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/mnemosyne.md#L31-L38) |
| `iris` | nested command globs under `bash` | [`src/agents/iris.md:9`](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/iris.md#L9) |
| `apollo` | flat denies **and** a separate `tools:` map | [`src/agents/apollo.md:6`](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/apollo.md#L6) |

The per-agent `delegation` intent lives in three more frontmatter-adjacent places,
and they are three different layers again: `mode:` (`subagent` / `all` / `primary`),
`visible: false`, and the `tools:` map. Only `mode` reaches the installed config
(`scripts/install/opencode.mjs:939`).

### 2.3 Layer 2 — `routing.yml`: what is read, and what is not

[`src/routing.yml`](https://github.com/ils15/pantheon-opencode/blob/main/src/routing.yml) is a large file that reads like a specification. It is not one.
Measured, per top-level block, by searching [`src/`](https://github.com/ils15/pantheon-opencode/tree/main/src) and `scripts/` for a consumer:

| Block | Runtime consumer |
|---|---|
| `presets:` | **Read.** [`src/pantheon/presets.mjs:187`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/presets.mjs#L187) |
| `presets.<n>.agents.<a>.model` | **Read.** `applyPreset`, [`src/pantheon/presets.mjs:495`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/presets.mjs#L495) (assignment at `:496`) |
| `agents:` (roles, capabilities, skills, model mapping) | Partly — the validator reads it; the plugin does not |
| `delegation:` | Partly — the validator reads it, in check G5b (`scripts/validate-routing.mjs:284`); the plugin does not |
| `permission.task:` | **None** |
| `fallback_chains:` | **None** |
| `intent_gate:` | **None** |
| `auto_continue:` | **None** |
| `background_job_board:` | **None** |
| `background_delegation:` | Comment references only, plus one parity test |
| `handoffs:` | Read by the validator, for referential integrity only |
| `todo_enforcer:`, `hashline:`, `full_auto:` | **None** — each self-describes as a doc mirror ([`src/routing.yml:590-591`](https://github.com/ils15/pantheon-opencode/blob/main/src/routing.yml#L590-L591), [`src/routing.yml:595-597`](https://github.com/ils15/pantheon-opencode/blob/main/src/routing.yml#L595-L597), [`src/routing.yml:598-600`](https://github.com/ils15/pantheon-opencode/blob/main/src/routing.yml#L598-L600)) |

Three of these deserve their own note.

**`permission.task:` is decorative and its value contradicts the frontmatter.**
[`src/routing.yml:578-580`](https://github.com/ils15/pantheon-opencode/blob/main/src/routing.yml#L578-L580) declares a single global rule, `"*": allow`. Every agent's
frontmatter instead declares `"*": deny` except the orchestrator's
(`scripts/validate-routing.mjs:314`). The module that would read the routing block
exists — `loadRoutingPermissionTask`, [`src/pantheon/presets.mjs:228`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/presets.mjs#L228) — and has **no
caller anywhere in [`src/`](https://github.com/ils15/pantheon-opencode/tree/main/src) or `scripts/`**, and no test. Editing it changes nothing.

**`background_job_board:` is decorative and its values are duplicated in code.**
[`src/routing.yml:558-559`](https://github.com/ils15/pantheon-opencode/blob/main/src/routing.yml#L558-L559) declares `max_concurrent_per_agent: 3`, a signal directory and
a persistence path. The actual values are hard-coded in the shared-board factory
([`src/pantheon/shared-board.ts:25`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/shared-board.ts#L25), [`src/pantheon/shared-board.ts:26`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/shared-board.ts#L26), [`src/pantheon/shared-board.ts:34`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/shared-board.ts#L34)) — identical today, two sources.
Changing the YAML changes nothing; changing the code changes everything.

**The two functions that read `presets.<n>.agents.<a>.model` are not interchangeable.**
The live reader is `applyPreset` ([`src/pantheon/presets.mjs:474`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/presets.mjs#L474)), which walks
`resolved.agents` at [`src/pantheon/presets.mjs:495`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/presets.mjs#L495) and writes `config.agent[a].model`
at `:498`. It is reached from the plugin through `applyActivePresetToConfig`
([`src/pantheon/presets.mjs:534`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/presets.mjs#L534)), called at [`src/plugin.ts:385`](https://github.com/ils15/pantheon-opencode/blob/main/src/plugin.ts#L385). Its sibling
`loadRoutingAgentModels` ([`src/pantheon/presets.mjs:264`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/presets.mjs#L264)) performs the same read and
**has no production caller anywhere** — only the test suite and documentation name it.
The verdict above is about the first; a reader who greps for the function name used in
`docs/INSTALLATION.md` lands on the dead one.

### 2.4 Layer 3 — the config the installer seeds

This is the layer that reaches the host, and it is produced by a deliberately narrow
extraction. The installer reads each agent file's frontmatter and copies **seven keys**
into the installed config: colour, description, mode, hidden, temperature, the
model-invocation flag, and `permission` (`scripts/install/opencode.mjs:1840-1859`).
Those seven are the whole of what provably reaches an installed config; six of them are
listed in `MANAGED_FIELDS` (`:315-322`) and are overwritten on an existing agent, while
`description` is written only for a new one (`:1894`).

Everything else in an agent's frontmatter does not reach it. The installer extracts no
`tools` map, no `skills`, no `reasoning_effort` and no `visible` flag.

`mcp_tools` is the exception, and it is not decorative. The installer reads it and folds
it into the managed `permission` field instead of writing a key of its own
(`scripts/install/opencode.mjs:1855-1859`). `deriveNativeMcpPermissions` (`:346-390`)
emits one native rule per server: `<server>_*: deny` as the baseline for every server in
the set, then `<server>_*: allow` when an entry is `all`, or `<server>_<tool>: allow` for
each named tool (`:354-387`). A bundled server an agent never lists therefore keeps only
the `deny` — unlisted means closed, which is the fail-closed default. MCP servers a user
added outside the bundled five are not in the set and are untouched (`:324-330`,
`:340-341`). The tests assert exactly this shape:
`tests/install-e2e.test.mjs:404`, `:648`, `:691`, `:743`, `:771`, and
`tests/install-opencode.test.mjs:55`.

On top of the per-agent blocks, the installer seeds a small set of **top-level**
defaults. These are declared in code rather than in a packaged template, with an
explicit contract that nothing personal may be seeded there
(`scripts/install/opencode.mjs:281-295`). What actually gets seeded, and the rule that
governs each:

| Seeded value | Rule | Citation |
|---|---|---|
| `default_agent` | only if absent — a user's choice is kept | `scripts/install/opencode.mjs:1930-1931` |
| `permission` as an object | only if absent | `scripts/install/opencode.mjs:2083` |
| `permission.skill: {"*": allow}` | only if absent, and only when the skills component is installed | `scripts/install/opencode.mjs:2102-2103` |
| `permission.bash` dev allowlist | only if absent | `scripts/install/opencode.mjs:2128-2135` |
| `permission.mcp.<server>` defaults | per server, only if absent; on V2 `allow`/`deny` are translated to `<server>_*`, `ask` emits no rule and warns | `scripts/install/opencode.mjs:966-998` |

Two properties of this layer matter for everything downstream:

- **The seed is gap-filling, never overwriting.** Every rule above is conditional on
  the user not having set the key. So this layer cannot be used to *tighten* a user's
  config, and a user value always survives an install.
- **Per-agent permissions behave the opposite way.** The per-agent merge is not
  gap-filling: for an agent that already exists, the framework-managed fields are
  overwritten from the canonical source (`scripts/install/opencode.mjs:1883-1887`). So the
  *agent-level* permissions are authoritative and the *top-level* ones defer to the
  user. Those two rules are different on purpose and it is worth knowing which side
  of the line a given setting falls on.

For a **new** agent the seed is a fresh object, with one repair step: if the
canonical permission block has no `bash` key, one is copied in
(`scripts/install/opencode.mjs:1904-1909`). That branch is unreachable for any agent that
already declares a `bash` entry, which is all of them.

### 2.5 Layer 4 — the V1→V2 translation map

This layer runs only when the installer resolves the V2 generation
(`scripts/install/opencode.mjs:2188-2190`). It converts the V1-shaped config the
merge produced into the V2 shape before writing.

The permission-action map has **six** entries
(`scripts/install/config-migration.mjs:49-59`):

| V1 key | V2 action | Kind |
|---|---|---|
| `bash` | `shell` | rename |
| `task` | `subagent` | rename |
| `write` | `edit` | alias — collapses onto `edit` |
| `edit` | `edit` | identity |
| `skill` | `skill` | identity |
| `websearch` | `websearch` | identity |

`bash` and `task` are renames; `write` is an alias of `edit`. Every measured V2
host (`2.0.22`, `2.0.30`, `2.1.0`, `2.1.2`) evaluates a `write` tool call under
the action name `edit`, so a rule emitted as `write` would never be the rule that
decides the call — both V1 keys collapse onto `edit`, and a collision is resolved by
effect restrictiveness rather than key order. The remaining three entries are
identity mappings.

Keys outside the table still pass through under their V1 spelling
(`scripts/install/config-migration.mjs:425`):

```js
const action = Object.hasOwn(V1_PERMISSION_TO_ACTION, key) ? V1_PERMISSION_TO_ACTION[key] : key
```

That passthrough is deliberate, not an oversight: only mappings confirmed against a
host are in the table, and a key with no observed action is kept rather than renamed
by guess (`scripts/install/config-migration.mjs:32-48`). `read` passes through as
`read`, which coincides with the host action measured on `2.0.22`/`2.0.30`/`2.1.x`.
For `webfetch`, `grep`, `glob` and `question` the host action was **observed and
PASS**ed on all five action-name hosts (`2.0.29`, `2.0.30`, `2.1.0`, `2.1.2`,
`2.1.3`), under the same spelling the converter emits
(`evidence/action-names/EVIDENCE.md:16-20`). Two keys that used to be in the
unverified list are now measured, and neither is an action name: `mcp` is a *server
map* that the converter translates into `<server>_*` rules — the host never evaluates
an action called `mcp` (see [MCP rules](#mcp-rules-the-form-the-host-evaluates)) — and
`hashline_edit` is a Code Mode plugin tool for which the host emits no permission
evaluation at all. `websearch` is the only key **not measured**, and no delivered
config emits it, so nothing is pending on it; it is neither confirmed nor refuted.

Current behaviour, verified by running the converter over the permission blocks this
project actually writes:

| V1 key in the config | V2 action emitted |
|---|---|
| `bash` | `shell` |
| `task` | `subagent` |
| `write`, `edit` | `edit` |
| `read` | `read` (not a map entry; the passthrough name matches the measured action) |
| `mcp` (server map) | one rule per server: `{action: "<server>_*", resource: "*"}`; `ask` emits no rule (see below) |
| `hashline_edit` | `hashline_edit` (passthrough; the host emits no evaluation for this plugin tool) |
| `webfetch`, `grep`, `glob`, `question` | the same name — identity passthrough, host action **observed, PASS** on all five hosts (`evidence/action-names/EVIDENCE.md:16-20`) |

**Collisions and ordering are part of the guarantee, not a detail.** Two different
questions, two different answers:

- **Same action and same resource:** `deny > ask > allow`. An unrecognized effect
  never replaces a known one and never downgrades a `deny`; a collision merges into
  the existing entry instead of appending a contradiction
  (`resolveEffects`, `scripts/install/config-migration.mjs:276-306`;
  `pushPermission`, `:329-340`). This is why the `write`/`edit` aliasing cannot turn
  a scoped `deny` into an `allow`.
- **Different resources: specificity decides.** The converter emits least specific
  first — `*` → glob → literal (`comparePermissions`,
  `scripts/install/config-migration.mjs:111-123`) — and the host resolves overlapping
  rules with `last-match-wins` (measured on all five hosts). The most specific rule
  for a resource is therefore emitted last and wins. A scoped `allow` **survives** a
  broader `deny` inside its own scope; outside that scope the broad `deny` still
  applies. Restrictiveness (`allow` → `ask` → unrecognized → `deny`) only breaks ties
  between rules of the *same* specificity, which is why `deny` is last within a
  specificity class rather than last for the whole action.
- **Top-level `permission` (V1) and `permissions` (V2) coexisting:** the V2 array is
  the base and is never discarded, the converted V1 rules are merged into it, and a
  conflict on the same action+resource resolves by restrictiveness
  (`resolveTopLevelPermissions`, `scripts/install/config-migration.mjs:1109-1152`;
  `mergePermissionArrays`, `:1014-1068`).

This replaces an earlier description in this document ("`allow → ask → unrecognized →
deny`, so `deny` is always emitted last for an action"). That ordering was wrong about
which rule wins when resources differ: it emitted a broad `deny` after a scoped
`allow` and concluded the scoped allow was dead. The five measured hosts do the
opposite — the later, more specific rule wins — so the correct reading of, for
example, `mnemosyne` is that its memory-bank allow is live.

**Suppression is reported, but only when it crosses a source boundary.** A `deny`
persisted in the V2 `permissions` array that an incoming V1 `allow` neutralizes in a
narrower scope — or the reverse — produces a warning naming both rules
(`warnSuppressedPermissions`, `scripts/install/config-migration.mjs:237-264`).
Intentional scoping written in one source is silent: `mnemosyne`'s `"*": deny` plus
its `allow` in the memory bank is the shipping example, and warning on it would fire
for the product's own templates.

**Residual gap — a V2 `permissions` array inside an `agents` block is still
passthrough.** When the config already carries a V2 `agents` block, its per-agent
`permissions` arrays are copied into the result **without reordering** and without
the suppression warning (`mergeManagedAgents`,
`scripts/install/config-migration.mjs:864-884`; the `agents` branch of
`migrateV1toV2` is `:1197-1205`). The specificity ordering above therefore holds for
top-level permissions and for an agent whose rules were converted from V1
(`:1186-1189`), **not** for a pre-existing V2 agent block: the order there is
whatever was on disk, and this repository does not re-sort it. Because the host
honours the *last* matching rule, a hand-written block that puts `<literal>: deny`
before `*: allow` will let the `allow` win; that is the one place where the emitted
order is not the safety property.

Two further consequences, both verified by execution rather than reading:

1. **Resource granularity survives.** A nested V1 value becomes one rule per
   resource, so the orchestrator's `"*": allow` and the scoped denies do not
   collapse into a single rule.
2. **The `mnemosyne` template is enforced by scope, not by the broad deny alone.**
   The scoped write/edit rules produce `{action: "edit", resource: "*",
   effect: "deny"}` followed by `{action: "edit", resource:
   ".pantheon/memory-bank/**", effect: "allow"}` and `{action: "edit", resource:
   ".pantheon/deepwork/**", effect: "allow"}` (the same shape for `edit`) from
   [`src/agents/mnemosyne.md:31-38`](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/mnemosyne.md#L31-L38). Under specificity ordering the two literal
   allows are emitted last and are the rules that decide writes inside those
   directories; every other path matches only the `*` deny. The template's intent
   and the host's behaviour agree.

**Framing, preserved deliberately.** This assessment was made as a **lower bound on
blast radius, not an estimate**. What is established is the shape of what remains:
the table contains only mappings confirmed against a host, so keys outside it reach
the host under their V1 spelling — `read` happens to coincide with a measured
action, `mcp` has its own server-map translation, and the rest have no observed
action at all. What is *not* established is how
many installed configs carry those unobserved keys or what a given host does with an
unrecognised action — both require inspecting installed configs and host behaviour
respectively. Treat the count of affected keys as a floor, never as a total.

**A second, documented gap on the same path.** The installer writes the V1 spelling
`permission` (`scripts/install/opencode.mjs:2083`) while V2 reads `permissions`. Both
files record this as known debt rather than fixing it
(`scripts/install/opencode.mjs:308-311`,
`scripts/install/config-migration.mjs:798-802`), because choosing a winner changes
what an install writes. The migration's own managed-field list uses the V2 name
(`scripts/install/config-migration.mjs:804-812`), and a drift guard asserts the two
managed-field lists match as sets (`scripts/install/config-migration.mjs:830-838`). So
the *field lists* are kept in sync; the *spelling the installer writes* is not.

Verified consequence: when the migration runs, the agent ends up with a single
`permissions` key and the installer's canonical value **overwrites** a user's
hand-written `permissions` on that agent — because `permissions` is
framework-managed. The user's tightening does not survive an install. This is
consistent with the managed-field contract, but it is the opposite of what "the
installer's merge is additive" suggests.

#### MCP rules: the form the host evaluates

An MCP call is not evaluated under the action `mcp`. On every 2.x host measured for
this round, the host synthesises the action **`<server>_<tool>`** and always passes
`resource: ["*"]`. The consequences are not intuitive, so they are tabulated:

| Form written in the config | What the 2.x host does |
|---|---|
| `{action: "<server>_*", resource: "*", effect: "deny"}` | **Blocks.** The tool disappears from the catalog; the model never sees it. |
| `{action: "<server>_*", resource: "*", effect: "allow"}` | **Allows** — the same gate, opposite effect. |
| `{action: "<server>_<tool>", resource: "*", effect: "deny" \| "allow"}` | Matches that one tool. This is what the installer emits from an agent's `mcp_tools` allowlist (`deriveNativeMcpPermissions`, `scripts/install/opencode.mjs:346-390`), alongside the `_*` form. |
| `{action: "<server>_*", resource: "*", effect: "ask"}` | **Not a prompt.** The host hides the tool instead. `ask` is not expressible for MCP in 2.x. |
| `permission.mcp.<server>: allow \| deny` (the V1 object shape) | **Inert to the host**, but the V2 converter rewrites it to `{action: "<server>_*", resource: "*"}` (`convertMcpPermissions`, `scripts/install/config-migration.mjs:371-401`). So the installed rule gates; the raw key alone would not. |
| `permission.mcp.<server>: ask` (the V1 object shape) | **No rule is emitted**, with a warning (`:389-396`): translating `ask` would silently hide the tool. |
| `{action: "mcp", resource: …, effect: …}` | **Inert.** The action name is never produced for an MCP call. |
| Any `resource` other than `"*"` on an MCP rule | **Inert.** The host supplies `["*"]` itself. |

The installer keeps its `permission.mcp.*` defaults for V1 compatibility
(`scripts/install/opencode.mjs:966-998`). On V2, `allow` and `deny` defaults are
translated into `<server>_*` rules, but the two servers whose default is `ask`
(`pantheon-code-mode`, `pantheon-vision`) produce **no rule**: the user is warned
that the default is unenforceable (`S.mcpAskNotEnforceable`,
`scripts/install/strings.mjs:49-52`) instead of being given a silent gate. The
enforceable form is `<server>_*` with `deny`, or disabling the server in the host's
MCP config. This is why "`permission.mcp.*` protects the tools" is only true of
`allow`/`deny`, and only because the converter rewrites them.

Two plugin tools are outside this gate entirely. `hashline_edit` and
`vision_describe` reach the model through Code Mode, and the host emits **no
permission evaluation** for those calls — a `permissions` rule naming them decides
nothing. Their protection is the plugin's own guard, not the host permission layer.
`websearch` has not been measured; this document makes no claim about it in either
direction.

## Which permission layer is load-bearing

The four layers above can disagree. This section identifies which one decides
behavior and how the generated agent table relates to the canonical files.

### 2.6 Which layer is load-bearing

Stated plainly, with the evidence.

**Layer 3, the installed config, is load-bearing.** It is the only layer the host
reads at session time, and it is built from the seven frontmatter keys in
[§2.4](#24-layer-3-the-config-the-installer-seeds). Everything the installer does
not extract is decorative *with respect to that config* — which, per §2.4, includes
the `tools` map, `skills`, `reasoning_effort` and `visible`. `mcp_tools` is **not** on
that list: it does reach the config, just never as a key of its own — it is translated
into per-server `permission` rules by `deriveNativeMcpPermissions`
(`scripts/install/opencode.mjs:346-390`, folded in at `:1855-1859`). What the host
reads there is `permission`, not `mcp_tools`.

**A qualification on "decorative", because it is easy to overread.** Decorative here
means *no code in this repository reads it*. It does not mean the host ignores it.
The agent files are installed and referenced by path, so a key the installer never
copies is still available to whatever the host chooses to parse from an agent
definition. Whether it is honoured is [UNVERIFIED](#5-open-questions-and-known-issues).
The distinction matters: the claim is about this repository's read graph, not about
the host's.

**Layer 1 (frontmatter) is load-bearing only for those seven keys.** The rest of a
frontmatter block is documentation of intent that the installer will not carry.

**Layer 2 (`routing.yml`) is decorative for permissions and delegation.** Only the
`presets:` block is read at runtime ([§2.3](#23-layer-2-routingyml-what-is-read-and-what-is-not)).
Every permission and delegation key in that file is inert *at runtime*. One narrow
exception on the CI side rather than the runtime side: `delegation.zeus` is read by the
repo validator's G5b check, which can fail the build
(`scripts/validate-routing.mjs:284`). No plugin code path reads it, so it changes no
runtime behaviour — but it is a real read, which is why [§2.3](#23-layer-2-routingyml-what-is-read-and-what-is-not)
scores that block "Partly" rather than "None".

**Layer 4 is load-bearing on the V2 path and absent on the V1 path.**

**The `tools:` map and a `permission:` block are not equivalent.** This is the
distinction that has already bitten this project, and the difference has two halves:

1. **Different reach.** The two agent files that carry a `tools:` map also carry a
   `permission:` block covering the same tool. Nothing stops a future edit from
   changing one and not the other, and no validator compares them — the routing
   validator checks `permission.task` only
   (`scripts/validate-routing.mjs:313`), and `tools:` is not in its schema.
2. **Different failure modes, and the repository's own files disagree about which
   one a deny produces.** A `permission:` deny means the call is refused. A `tools:`
   entry is a declaration about tool availability; whether it hides the tool or
   merely fails the call is a host-side question. Recorded here as **UNVERIFIED** —
   the answer is not in this repository.

The practical rule that follows, and the one to check first when an agent can do
something it should not: **`grep` for the tool name inside `permission:` in the
agent's own file.** If it is not there, the installed config does not carry it, and
no permission in this repository prevents the call.

### 2.7 The agent table in `AGENTS.global.md`

The shared role table lives in the generated [global artifact](https://github.com/ils15/pantheon-opencode/blob/main/AGENTS.global.md),
whose source is the static `GLOBAL_HEADER` string in
`scripts/build-agents-md.mjs`. It is **not rendered from** [`src/agents/*.md`](https://github.com/ils15/pantheon-opencode/tree/main/src/agents); changing
an agent's frontmatter or body will not change the table. The build check verifies the
artifact against the generator, so it detects a stale generated file but does not
compare the table with canonical agent definitions. The project `AGENTS.md` is a
separate generated artifact for repository setup and conventions.

There is also a legacy generator, `scripts/install/agents-md.mjs`, whose dynamic
frontmatter parser would omit Zeus because [`src/agents/zeus.md`](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/zeus.md) has no `name:` field.
Repository search finds no importer or installer path for that script; it remains a
packaged standalone script with its own CLI interface. The active build and installer use
`scripts/build-agents-md.mjs`, which emits both project and global artifacts and keeps
all 14 agents in the shared table. Keep the legacy CLI behavior distinct from the
active generation path when reviewing references to agent tables.

---

## 3. Delegation

### 3.1 Two mechanisms, and what each is for

There are two, they are not alternatives to each other, and only one of them
enforces anything.

**The host child-session engine.** Dispatch, child-session lifecycle and result
retrieval belong to the host. API/implementation documentation often calls this
`task()`, but in the user-reported Beta 10 Zeus-root tool inventory the callable
dispatch was `subagent`; its exact signature and background support depend on
the active runtime. Pantheon ships no separate root delegation tool. See
[Delegation](ARCHITECTURE.md#delegation-mechanics) and
[INSTALLATION](INSTALLATION.md) for the terminology distinction. Do not infer a callable root `task()` API from code or
documentation about the host engine. **The host mechanism carries delegation.**
Everything in [§3.2](#32-who-may-delegate-to-whom) concerns its enforcement.

**Observed root inventory (Beta 10 report, not a cross-host contract):** `subagent`
was callable; `task_status` and a todo-write tool were not exposed. Status/todo
capabilities are host- and runtime-dependent. Use only tools visible in the active
root schema; without an observable status result or host completion notification,
prefer synchronous dispatch. Keep an explicit conversation checklist when no
todo-write tool is exposed, and do not claim native todos were updated.

**The background job board.** A pure-TypeScript state machine
([`src/pantheon/background-job-board.ts:26`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/background-job-board.ts#L26)) with states
`running → completed | error | cancelled → reconciled` and a restricted transition
table ([`src/pantheon/background-job-board.ts:47`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/background-job-board.ts#L47)). **This mechanism does not
delegate anything.** It is a bookkeeping mirror, plus a concurrency counter. Its one
runtime entry point is a best-effort post-hoc mirror of a native dispatch
([`src/plugins/pantheon-hooks.ts:798`](https://github.com/ils15/pantheon-opencode/blob/main/src/plugins/pantheon-hooks.ts#L798)), and what the mirror is for is stated in the
source: so the finalize path writes a terminal report and the TUI tracks the child
end-to-end.

Three consequences a planner needs:

1. **The board cannot start work.** There is no dispatch path through it. Planning a
   workflow "on the board" means planning on a mechanism that only observes.
2. **The board's only admission control is concurrency** — a running-count cap per
   agent ([`src/pantheon/background-job-board.ts:507`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/background-job-board.ts#L507)), not a permissions check.
3. **Its mirror failure is silent by design.** The mirror is fire-and-forget and its
   rejection handler is an empty catch ([`src/plugins/pantheon-hooks.ts:804`](https://github.com/ils15/pantheon-opencode/blob/main/src/plugins/pantheon-hooks.ts#L804)). When
   the cap is reached the mirror throws and the catch discards it: the delegation
   still runs, and the job simply never appears on the board. Verified: the cap
   check is at [`src/pantheon/background-job-board.ts:259`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/background-job-board.ts#L259), reached only from the
   mirror.

The board methods are internal APIs, not root tools. `waitForTerminal`,
`markReconciled` and `formatForPrompt` have callers in tests and historical
instructions, but that does not make them callable by Zeus. The reported Beta 10
root inventory exposed no board tool; instructions must not ask Zeus to call
`registerLaunch`, `markReconciled`, `recoverRunningJobs` or `formatForPrompt`.
No board-based tracking or crash-recovery guarantee is available to the root
orchestrator. The host child-session lifecycle and internal board mirror are
separate mechanisms.

### 3.2 Who may delegate to whom

Three layers again, and this time they do not all agree.

| Layer | Says | Enforced by |
|---|---|---|
| Frontmatter `permission.task` | Orchestrator: `"*": allow`. `hermes`/`athena`: `"*": deny, apollo: allow`. All others: `"*": deny`. | The host, from the installed config. It reaches the config (verified, [§2.4](#24-layer-3-the-config-the-installer-seeds)), and the host applies the assumed glob semantics — **measured, PASS** on all five hosts: D1 lets `apollo` complete with 1 child session, D2 denies `demeter` with 0 child sessions ([`bench/results/p05-permission-matrix-2026-10-22.md:75-76`](https://github.com/ils15/pantheon-opencode/blob/main/bench/results/p05-permission-matrix-2026-10-22.md#L75-L76); [§5](#5-open-questions-and-known-issues) row 5) |
| Routing matrix (`agents.<a>.subagent_can_delegate_to`) | Same intent, per agent. Enforced as a consistency invariant by the repo validator (`scripts/validate-routing.mjs:236`) and `can_delegate` by `scripts/validate-routing.mjs:214`. | The validator, not the runtime |
| Runtime matrix (`isDelegationAllowed`) | Orchestrator → anyone; `athena`/`hermes` → `apollo` only; **everything else denied** ([`src/pantheon/delegation-enforce.ts:138`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/delegation-enforce.ts#L138)) | **The plugin's tool hook** |

The runtime matrix is a hard-coded two-line function, not a table read from
`routing.yml`. Its glob gate is dead in the plugin: the guard is constructed without
the option that supplies the globs ([`src/plugin.ts:101`](https://github.com/ils15/pantheon-opencode/blob/main/src/plugin.ts#L101)), so the glob check
short-circuits on its fail-open branch ([`src/pantheon/permission-globs.ts:60`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/permission-globs.ts#L60)).

**Where the two execution paths stand.** The native path and the board path do not
share a permission source. The native path consults the runtime matrix; the board path
consults a concurrency count. They produce the same answer today — but only because
the orchestrator is the only caller either admits, and because the matrix allows the
orchestrator anything. **A caller that could reach the board without going through the
native path would face a concurrency cap and no permission check at all.** This is the
disagreement worth knowing about: the routing matrix is enforced by exactly one of the
two paths, and that path is the one that depends on the host supporting native
delegation.

### 3.3 The fallback chain

Defined once, in the orchestrator's instructions
([`src/instructions/zeus-timeout-retry.instructions.md:42-47`](https://github.com/ils15/pantheon-opencode/blob/main/src/instructions/zeus-timeout-retry.instructions.md#L42-L47)): a per-agent ordered list
of substitutes, plus a per-role table of timeouts and retry counts, plus an
escalation protocol.

**Nothing in the repository executes it.** The routing-matrix validator does not read
`fallback_chains`; a repo-wide search for a consumer returns nothing. The chain is
model-executed text. Two consequences:

- **The timeouts in the routing file are decorative.** `background_delegation.timeout_ms`
  ([`src/routing.yml:562-563`](https://github.com/ils15/pantheon-opencode/blob/main/src/routing.yml#L562-L563)) has no consumer; the table that is actually presented to the
  orchestrator is in the instructions file. Where the two disagree, the instructions
  win because they are what the model reads.
- **No chain step invokes anything.** Every entry is a decision the orchestrator
  makes, including the terminal ones. For the reviewer, the GitHub operator and the
  memory-bank owner the chain terminates at the orchestrator itself
  ([`src/routing.yml:522-523`](https://github.com/ils15/pantheon-opencode/blob/main/src/routing.yml#L522-L523), [`src/routing.yml:534-535`](https://github.com/ils15/pantheon-opencode/blob/main/src/routing.yml#L534-L535), [`src/routing.yml:536-537`](https://github.com/ils15/pantheon-opencode/blob/main/src/routing.yml#L536-L537)), so those
  three have no route out of the chain except a message to the user.

One part of the chain has a code analogue, and it is worth not confusing the two:
the empty-result guard ([`src/pantheon/task-result-guard.ts:14`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/task-result-guard.ts#L14)) converts an empty
delegation result into an explicit error so the caller sees a failure rather than
silence. That is a *failure detector*, not a fallback — it triggers no substitute
agent.

### 3.4 Session reuse

The reuse protocol is in the instructions
([`src/instructions/zeus-timeout-retry.instructions.md:68`](https://github.com/ils15/pantheon-opencode/blob/main/src/instructions/zeus-timeout-retry.instructions.md#L68)): before dispatching,
check for a prior session with that agent and continue it, passing the files already
examined. The retention count is `background_delegation.session_max`
([`src/routing.yml:567`](https://github.com/ils15/pantheon-opencode/blob/main/src/routing.yml#L567)) — **decorative**; no consumer. So the numeric bound is
whatever the instructions say, and the YAML value is not the limit.

Two reuse mechanisms exist and are unrelated to each other: host-level session
continuation for subagent conversations, and the persistence MCP's checkpoint store
for orchestrator state. A planner should not assume reusing one reuses the other.

## Delegation by host generation

The delegation mechanics above apply to both contracts; what a planner can rely
on depends on the host generation selected at install time.

### 3.5 Per host generation: what you can rely on

**This section is conditional by construction.** "V1" and "V2" here mean the two
plugin contracts Pantheon ships, selected at install time by a generation gate
(`scripts/install/opencode-version.mjs:213`). They are not statements about any
particular host build. The installer registers a different plugin set per contract
and strips the other's entries (`scripts/install/opencode.mjs:1075`, `scripts/install/opencode.mjs:1106`), so
this is a genuine fork, not a preference.

The V2 adapter maintains an explicit list of what it does not implement, seeded in a
plain-`.mjs` module so the plugin, the installer and `doctor` all read the same
strings ([`src/pantheon/v2-unsupported.mjs:55`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/v2-unsupported.mjs#L55)). Two of those entries decide what a
planner may rely on.

#### Delegation: available on both contracts, but with a different enforcement floor

Native delegation is available on both contracts — it is the host's engine.

| Relied-on property | V1 contract | V2 contract |
|---|---|---|
| Native delegation available | Yes | Yes |
| Read-only agents blocked from mutating tools | Yes | Yes |
| Depth-2 for read-only agents | Yes | Yes |
| **Caller/target matrix enforced** | **Yes** | **Conditional — Yes when the host exposes `ctx.permission.hook`; otherwise unavailable** |

The V1 cell is enforced by the V1 tool hook (`createEnforcementGuard`), not by
the `permission.ask` hook. **`permission.ask` does not fire on OpenCode 1.19.x**:
on `1.19.4` (measured 2026-10-22) the V1 probe recorded zero `permission.ask`
invocations. The generations differ in the **mechanism**, not in the string: the
exact `permission.ask` string is absent from both binaries, while V2 evaluates
the request in `permission.evaluate` (proved by the V2 matrix). On that host the
read-only guarantee is **config-level** — with `bash`/`write`/`edit: deny` and
`read: allow`, the host makes `bash` and `write` unavailable and produces no side
effect, while `read` keeps working. The permission request goes to the client
instead (`permission.asked`, `GET /permission`,
`POST /permission/{id}/reply`), where a client `reject` does block. The probe is
[`tests/canary/run-v1-permission-proof.sh`](https://github.com/ils15/pantheon-opencode/blob/main/tests/canary/run-v1-permission-proof.sh) driving
[`tests/canary/v1-permission-canary.test.mjs`](https://github.com/ils15/pantheon-opencode/blob/main/tests/canary/v1-permission-canary.test.mjs); results are in the
[permission-matrix evidence](https://github.com/ils15/pantheon-opencode/blob/main/bench/results/p05-permission-matrix-2026-10-22.md).

The V2 matrix is implemented by `registerV2PermissionHook`
([`src/plugin-v2.ts:1528-1658`](https://github.com/ils15/pantheon-opencode/blob/main/src/plugin-v2.ts#L1528-L1658), registered best-effort at [`src/plugin-v2.ts:1856`](https://github.com/ils15/pantheon-opencode/blob/main/src/plugin-v2.ts#L1856)),
which calls `evaluateV2Delegation`
([`src/pantheon/v2-delegation-enforce.ts:170-213`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/v2-delegation-enforce.ts#L170-L213)). That decision is: Zeus may
target any Pantheon agent; Athena and Hermes may target Apollo only; every other
Pantheon caller is denied; a child session is denied. It is **not** implemented
by `createEnforcementGuard`.

The guard is built without `getSessionAgent`, `isRootSession` or
`isChildSession` ([`src/plugin-v2.ts:1323-1325`](https://github.com/ils15/pantheon-opencode/blob/main/src/plugin-v2.ts#L1323-L1325)), for two reasons that are easy to
conflate:

1. **Missing `getSessionAgent` — wiring.** V2 learns the active agent from the
   `execute.before` event itself and keeps no session→agent map, so there is no
   lookup to hand the guard: it would call
   `isDelegationAllowed(undefined, target)`, which returns `false` for an
   undefined caller ([`src/pantheon/delegation-enforce.ts:145`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/delegation-enforce.ts#L145)) and throw *caller
   agent is unavailable*. This branch is skipped entirely when `isRootSession`
   is undefined.
2. **Unwired hierarchy — design.** `SessionHierarchyRegistry` gates exactly two
   things: the depth-2 child deny and the root-session gate. Left unseeded,
   `isChild` is `false` for every session, so depth-2 would never fire on a
   genuine child. An unseeded session reports as a *root*, and `true` **passes**
   the root gate ([`src/pantheon/delegation-enforce.ts:109-116`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/delegation-enforce.ts#L109-L116)) — it does not deny.

**Unwired, not impossible.** V2's `session.created` event carries
`properties.info.parentID`, so live sessions could be seeded in
`onSessionCreated`; what V2 lacks is V1's `client.session.list()` startup seed,
because `PluginContext` exposes no `client`. Whether a live host populates
`info.parentID` on that event is not measured by the repository.

The consequence is narrower than a missing matrix: the guard still denies
mutating tools in a read-only session (`task` included), but it does not carry
the caller→target policy. The matrix lives in the permission hook, and that hook
exists only when the host exposes `ctx.permission.hook`. If the host lacks it or
registration fails, `markUnsupported('permission-hook')`
([`src/plugin-v2.ts:1535-1536`](https://github.com/ils15/pantheon-opencode/blob/main/src/plugin-v2.ts#L1535-L1536)) and the matrix is **unavailable**; host
permissions remain in control.

**Runtime evidence.** The runtime canary on OpenCode `v2.0.29` proves both sides:
an allowed Zeus→Apollo root dispatch is admitted, while a matrix-valid
Athena→Apollo call from a child is denied and creates no grandchild; an invalid
Athena→Demeter root dispatch is denied without a child or extra model request
([the runtime admission evidence](https://github.com/ils15/pantheon-opencode/blob/main/bench/results/f4a-v229-admission-identity-2026-10-14.md)).
Reproduce with `bash tests/canary/run-v2-permission-proof.sh`.

**What this means for planning:** on the V2 contract, the restriction "only the
orchestrator and the two read-only scouts may delegate" is a **control when the
host registers the permission hook**, and a **convention when it does not**.
Read the install's unsupported markers and `doctor` output before relying on it;
the remaining read-only restriction (apollo/gaia cannot delegate) holds because
the delegation tool is in their blocked-tool list.

#### The board: available on V1, absent on V2

This is the part with no existing documentation, and the part whose absence is now
**announced** rather than silent — at install time and in `doctor`.

**On the V2 contract there is no board.** Not "a reduced board" — the state machine,
the store and the client it needs are all reachable only from the V1 plugin, which
the V2 contract does not register. The adapter lists the goal tooling as absent for
exactly this reason: it needs a store, a loop client and a board, none of which the
V2 plugin context exposes ([`src/pantheon/v2-unsupported.mjs:71`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/v2-unsupported.mjs#L71)).

The bridge that would carry them across exists and is never wired. The bridge factory
and the context accessor are both implemented
([`src/pantheon/v2-bridge.ts:89`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/v2-bridge.ts#L89), [`src/pantheon/v2-bridge.ts:110`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/v2-bridge.ts#L110)), and **no production code path calls the
factory** — its only callers are in the test suite. So the V2 accessor returns null
in every real configuration, and that null is handled by *not registering the
dependent tools* rather than by registering them as non-functional. **Absent, not
broken** still describes the board itself — but "absent" no longer means "unnoticed":
the reduction carries a marker (`goal-tools`, [`src/pantheon/v2-unsupported.mjs:70-75`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/v2-unsupported.mjs#L70-L75)),
and two surfaces report it.

| Board capability | V1 contract | V2 contract |
|---|---|---|
| Dispatch mirrored onto the board | Yes | No |
| Terminal audit log | Yes | No |
| Periodic pruning of old jobs | Yes | No |
| Restart handling for persisted `running` records (marks errored; does not resume work) | Yes | No |
| `markReconciled` / `formatForPrompt` / `waitForTerminal` | Internal API; no root-callable tool observed | Not applicable to the V2 plugin state described above |

**Planning against the board on the V2 contract still produces no error and no failed
dispatch** — the work runs, because the work runs on the native engine, and the
board-shaped bookkeeping simply does not happen. A workflow whose step is "register the
job, then poll the board for completion" still hangs on the poll with a job that was
never registered.

What changed is the **notice**, not the capability. Two surfaces now state the
reduction instead of leaving a planner to infer it from silence:

- **At install.** A V2-generation install prints the unsupported-feature list next to
  the existing V2 target notice (`scripts/install/opencode.mjs:546`).
- **In `doctor`.** The reduction is a standing health finding, section H4, at `warn`
  level when the V2 generation is registered (`scripts/doctor.mjs:1560`). It never
  changes the exit code: a V2 install is a supported configuration, not a broken one.

Both read the same frozen seed the plugin builds its live list from
([`src/pantheon/v2-unsupported.mjs:55`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/v2-unsupported.mjs#L55)), so the two surfaces cannot report a reduction
the plugin does not, or miss one it does. Neither surface helps a workflow *mid-flight*:
the notice arrives before you depend on the board, not when a dispatch goes unrecorded.

Two V1-specific behaviours worth stating conditionally as well, since both are
recorded as observations of specific host builds rather than as guarantees:

- **Restart handling (not job recovery).** On restart, jobs left in `running` are marked errored
  ([`src/plugin.ts:55`](https://github.com/ils15/pantheon-opencode/blob/main/src/plugin.ts#L55)). Old jobs are not resumed and child work is not restarted.
  The persisted reports remain historical records. See
  [INSTALLATION](INSTALLATION.md).
- **Background completion observability.** The finalize path is driven by an idle
  event plus a periodic scan. Whether a background child's completion is observable
  at all is recorded in the source as host-build-dependent
  ([`src/plugins/pantheon-hooks.ts:1359`](https://github.com/ils15/pantheon-opencode/blob/main/src/plugins/pantheon-hooks.ts#L1359)). Plan completion detection on the idle path
  and treat an absent completion as possible.

**The reader's rule:** before planning on the job board, on goal tools, or on any
caller/target restriction, establish which contract the target install resolved. All
three are safe on V1; none of the three is available on V2.

### 3.6 Proportionality and overhead evaluation

For a clear, bounded, reversible, low-uncertainty, non-sensitive task, route to one
correct domain specialist when delegation is needed. That specialist inspects the
necessary local context, implements and verifies the change. Do not add a routine
plan, separate discovery pass, council, or Themis review. Keep applicable planning,
review, and human-approval gates for broad/material or high-uncertainty work, auth or
security, data/schema, destructive operations, and user-visible API changes. The
operational rules are in [`src/agents/zeus.md`](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/zeus.md) and
[`src/instructions/zeus-timeout-retry.instructions.md`](https://github.com/ils15/pantheon-opencode/blob/main/src/instructions/zeus-timeout-retry.instructions.md).
Specialist roles remain available on demand; a single task is not evidence to remove
an agent.

When evaluating orchestration overhead, compare multiple similar tasks with similar
scope, risk, and acceptance criteria. Record observed elapsed time, tokens per
phase/agent when available, number of handoffs, and rework/quality signals (such as
verification failures or corrections needed). Mark unavailable measures as unknown;
do not add telemetry or tool APIs for this comparison. Do not set thresholds or infer
that a single task proves or disproves YAGNI; use the observations as evidence for a
later policy decision, alongside whether the work met its acceptance criteria.

---

## 4. Disagreements between layers

These are surfaced, not resolved. The load-bearing consequence is noted; the
layers themselves are described in section 2.

| Disagreement | Consequence |
|---|---|
| `routing.yml` global `permission.task` vs per-agent frontmatter | The YAML reads as a global default but is decorative; frontmatter and the installed config carry the rule. |
| `routing.yml` board settings vs the shared-board factory | Same values, two sources; editing the YAML no-ops. |
| `routing.yml` timeouts vs the instructions timeout table | Two independent sources; the instructions table is what the model sees. |
| `permission:` vs `tools:` | Two mechanisms, no validator comparing them, different failure modes. |
| Installer writes `permission` (V1) vs V2 reads `permissions` | Known debt: on V2 the installer value overwrites a user's hand-written `permissions` on a managed agent. |
| Translation map vs emitted action vocabulary | Only host-confirmed mappings are carried; keys outside the table keep the V1 spelling. |
| INSTALLATION's V2 permission example vs the converter | The example is stale; the converter emits `{action, resource, effect}`. |
| INSTALLATION's V2 MCP example vs the merge | The wrapper form is normalised away by the converter. |
| Routing matrix vs board path | The matrix is enforced on the native path only. |
| Board concurrency cap vs root dispatch | The per-agent cap is internal and does not bound root `subagent` concurrency. |
| Orchestrator depth counter vs session hierarchy | The plugin's parent-child hierarchy is the enforced mechanism. |
| `AGENTS.global.md` role table vs canonical agents | The table is a generator string, not rendered. |
| Broad coverage report vs focused gates | The broad report is report-only; Python MCP and V2 plugin have separate 80% gates. |
| `permission.mcp.*` vs what the host evaluates | The host evaluates `<server>_<tool>`; the V2 converter rewrites allow/deny and drops `ask`. |

## 5. Open questions and known issues

The permission model's remaining questions are host-side, population-side, or
product limitations. They are not silently `UNVERIFIED`:

- **Measured and recorded:** action-name coverage, the MCP action form,
  last-match-wins specificity, and the `permission.task` glob on every matrix
  host. `2.0.22` is outside the action-name matrix because it lacks the V2
  surface, not because it failed.
- **Verifiable in this release:** whether `tools` and `permission` interact by
  hiding or failing; whether `mcp_tools`, `visible`, `skills`, and
  `reasoning_effort` are honoured; whether a blocking status tool exists on a
  given runtime; whether background completion is observable.
- **Known Issues:** `ask` is not expressible for MCP on 2.x, so the installer
  warns per server; `hashline_edit` and `vision_describe` have no host
  permission gate; the number of installed configs affected by the incomplete
  translation map is covered by remediation, not by a GO gate.
- **Explicitly not measured:** whether `websearch` is gated. No delivered
  config emits it; a `permission.evaluate` probe would settle it.

The full evidence bundle, per-host matrices, and measurement records live in the
[benchmark evidence](https://github.com/ils15/pantheon-opencode/tree/main/bench/results)
and the release evidence, not in this guide. The three closed holes and their
fixes are in section 2.

## See also

Where another document is authoritative, this one defers to it:

- Shared role summary — [AGENTS.global.md](https://github.com/ils15/pantheon-opencode/blob/main/AGENTS.global.md); canonical capabilities — [`src/agents/`](https://github.com/ils15/pantheon-opencode/tree/main/src/agents)
- Reviewer contract, layers, verdicts — the reviewer agent's own file
- Delegation engine contract and its removal — [Architecture](ARCHITECTURE.md#delegation-mechanics)
- Install, generation pinning, background delegation setup — [INSTALLATION](INSTALLATION.md)
- Per-generation behaviour differences and the V2 conditional enforcement — [UPGRADING](UPGRADING.md)
- Design rationale for delegation, sync and memory tiers — [ARCHITECTURE](ARCHITECTURE.md)
- Orchestrator protocol: timeouts, fallback chains, the subtask decision tree,
  session reuse — the orchestrator's instructions, consolidated into `AGENTS.global.md`
- Per-agent model routing — [reference/model-routing.md](reference/model-routing.md)
