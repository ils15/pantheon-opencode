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
| **UNVERIFIED** | A claim this repository cannot settle on its own. Named explicitly, with the evidence that would settle it. See [§5](#5-unverified-and-the-evidence-that-would-settle-it). |

**Scope.** Behaviour of the OpenCode host itself is out of scope for verification:
this repository does not vendor the host's source, and its own ambient type
declaration records that the agent-config surface is not typed here
(`src/opencode.d.ts:4`). Where the answer lives in the host, this document says so
rather than guessing.

---

## Table of contents

1. [Quality gates](#1-quality-gates)
2. [Agent permissions: four layers at once](#2-agent-permissions-four-layers-at-once)
3. [Delegation](#3-delegation)
4. [Disagreements between layers](#4-disagreements-between-layers)
5. [Unverified, and the evidence that would settle it](#5-unverified-and-the-evidence-that-would-settle-it)

---

## 1. Quality gates

### 1.1 What the reviewer role is

The reviewer is the agent whose canonical definition is `src/agents/themis.md`. Its
own file is the authoritative statement of the contract — read it there:
[IntentGate, the post-delegation check, the three review layers, the quality-gate
checklist and the four verdicts](../src/agents/themis.md) are all defined in that file
and are not repeated here.

The role summary is carried in [AGENTS.md](../AGENTS.md) (generated — see
[§2.7](#27-a-fifth-copy-the-agent-table-in-agentsmd)).

### 1.2 What the reviewer enforces, and what it does not

The single most important fact about the quality gate:

> **No code path in this repository invokes the reviewer, and no code path reads a
> review verdict.**

A search for the reviewer role and for verdict identifiers across `src/` and
`scripts/` returns: the agent-name list in the model-routing table
(`src/pantheon/model-command.ts:41`), the agent-prefix map in the board
(`src/pantheon/background-job-board.ts:154`), a model-tier map in a delegation hook
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
| Read-only sessions may not mutate | `tool.execute.before` throws | `src/pantheon/delegation-enforce.ts:181` (blocked-tool set), `src/plugin.ts:101` |
| A child session may not delegate again | same guard, child-session branch | `src/pantheon/delegation-enforce.ts:353` |
| Caller/target delegation matrix | same guard, `isDelegationAllowed` | `src/pantheon/delegation-enforce.ts:138` |
| The orchestrator may not read source | `zeusReadGuard` throws | `src/pantheon/delegation-enforce.ts:221` |
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

**Not enforced anywhere.** Everything the reviewer file asserts as a gate: the
IntentGate comparison, the post-delegation check, layers 1–3, the coverage
threshold, the "all tests pass" requirement, the deprecation check, and the
verdicts themselves. Note also the inversion between the reviewer file and
`AGENTS.md`/`biome.json`: the reviewer is told to check coverage, and the repository
itself states that no coverage threshold is enforced.

**Not enforced because it is not the reviewer's to own.** The reviewer definition
requires the review to name a failing layer and blocks on it. Nothing in the
orchestrator's instructions reads that block and re-plans; the block is a message,
not a state transition.

### 1.3 Blocking versus non-blocking, in this project's terms

The project uses four verdict strings, defined in the reviewer file
(`src/agents/themis.md:153`). Grouped by what they actually do:

| Verdict | Blocking? | Meaning in this project |
|---|---|---|
| `BLOCK` | **Yes** | Work stops. Names a layer (1/2/3) and a reason. |
| `BLOCK_INTENT` | **Yes** | The IntentGate comparison failed: the code does not do what was asked. Emitted instead of `BLOCK` when the divergence is in the requirement, not the code. |
| `PASS` | No | No critical issues. |
| `PASS_WITH_NOTES` | **No** | Approved, with suggested improvements. |

The same four terms are reused as an output schema in the orchestrator's instructions
(`src/instructions/zeus-council-synthesis.instructions.md`), and `PASS_WITH_NOTES`
carries the same non-blocking weight there.

Two non-obvious consequences of this vocabulary:

- **`PASS_WITH_NOTES` is not a soft `BLOCK`.** It is a pass. The decision-tree
  criterion that decides reviewer involvement is phrased in terms of whether output
  "feeds into" review, not whether review passed — see [§1.4](#14-full-task-versus-subtask-the-decision-that-decides-whether-a-reviewer-exists).
- **The reviewer role itself has a separate, harder block, which is enforced.** The
  reviewer is denied `edit` at the permission layer
  (`src/agents/themis.md:10`), so a reviewer physically cannot fix what it finds.
  The `ABSOLUTE CONSTRAINT` at the top of that file ("REVIEWER ONLY") is therefore
  backed by a real permission, not only by instruction — this is the one place in
  the quality-gate system where the prompt contract and an enforcement mechanism
  agree.

A third, different vocabulary exists for the orchestrator's session-level
continuation and is unrelated to review verdicts: the injected "pending todos
remain" prompt (`src/pantheon/todo-enforcer.ts:65`). Do not read it as a review
outcome.

### 1.4 Full task versus subtask: the decision that decides whether a reviewer exists

The reviewer is not always in the loop, and the decision that removes it lives in
exactly one place: the subtask decision tree in the orchestrator's instructions
(`src/instructions/zeus-timeout-retry.instructions.md:89`). Five criteria, all of
which must hold; any one failing forces a full task:

| # | Criterion |
|---|---|
| 1 | Scope: at most 2 files and at most 10 lines changed |
| 2 | Risk: no schema change, no security impact |
| 3 | Auth: no authentication or authorization logic |
| 4 | Data: no data-loss risk, no migration |
| 5 | Review: the output does not feed into a review |

The first four are objectively checkable. **The fifth is the load-bearing one and it
is the least objective**: it is a statement about the *orchestrator's own intent*.
Classifying a change as a subtask is the move that removes the reviewer, so the
fifth criterion is the one doing all the work, and it is the one that cannot be
mechanically checked by anything outside the orchestrator's judgement.

The gold rule stated above the tree is a bias toward the expensive path: when in
doubt, use a full task.

**What a subtask skips** (from the same file): the implementation artifact, and the
reviewer. Those are the only two things. The orchestrator still receives a
`subtask_summary`; the return format is identical
(`src/instructions/zeus-timeout-retry.instructions.md:129`), so a reader of the transcript
cannot distinguish a reviewed task from an unreviewed subtask by its shape — only by
whether a review verdict appears earlier in the session.

### 1.5 Escape hatches, and what happens when they are used

Every hatch below is verified present. "Consequence" states what actually happens on
use, which is not always what the hatch's name suggests.

| Hatch | Where | Consequence on use |
|---|---|---|
| Classify as a subtask | `src/instructions/zeus-timeout-retry.instructions.md:92` | Reviewer is never invoked. Nothing downstream fails. The transcript contains no review verdict, and no code checks for one. **This is the widest hatch and the only one with no trace.** |
| `PANTHEON_TODO_ENFORCER=off` | `src/pantheon/todo-enforcer.ts:80` | Session-level continuation stops. The routing-matrix mirror is explicitly *not* the switch — the env var is (`src/routing.yml:543` says so in a comment). Read once at plugin construction, so it takes effect on the next process start, not mid-session. |
| `PANTHEON_HOOKS_LOG=1` | `src/pantheon/logger.ts:97`, `src/plugins/pantheon-hooks.ts:192` | Console echo of the file-only log. Does not change enforcement. |
| `PANTHEON_TOASTS=off` | `src/plugins/pantheon-hooks.ts:76` | TUI notifications suppressed by category. Every suppressed toast is still written to the structured log and the hook log, so the trail stays auditable at any setting. |
| `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` | documented in [QUICKSTART](../README.md) and [INSTALLATION](INSTALLATION.md) | Enables the host's background child sessions. Without it, background dispatch is unavailable — see [§3.1](#31-two-mechanisms-and-what-each-is-for). |
| `--opencode-version v1\|v2`, `OPENCODE_VERSION`, `OPENCODE_BIN` | `scripts/install/opencode-version.mjs:213` | Pins the plugin generation. Precedence is argument, then env var, then an `opencode2` binary basename, then a `--version` probe, then a warned fallback to V1 (`scripts/install/opencode-version.mjs:223`, `scripts/install/opencode-version.mjs:288`). The fallback is the important one: it **warns and writes the V1 contract**, so an unrecognised 2.x host gets V1 plugins rather than none. |
| `git commit --no-verify` | `.pre-commit-config.yaml:7` | Skips the secret gate. The config comment names this a security violation; nothing in the repo prevents it. |
| Editing a decorative layer | see [§2.7](#27-a-fifth-copy-the-agent-table-in-agentsmd) | Silently no-ops. This is the failure mode most likely to waste someone's time, because it produces no error. |

---

## 2. Agent permissions: four layers at once

Agent permissions are expressed in four separate places. They are not derived from
one another, no layer validates against another at runtime, and they can disagree.

### 2.1 The four layers at a glance

| # | Layer | Location | What it actually controls | Load-bearing? |
|---|---|---|---|---|
| 1 | Per-agent frontmatter | `src/agents/*.md` | A subset of keys reaches the installed config. The full block reaches the host only if the host reads the agent file. | **Partly** — see [§2.6](#26-which-layer-is-load-bearing) |
| 2 | Routing matrix + permission keys | `src/routing.yml` | `presets:` and `presets.<n>.agents.<a>.model` are read at runtime. **Every permission and delegation key in it is decorative** — decorative here means *no code in this repository reads it*; it does **not** mean the host ignores it ([§2.6](#26-which-layer-is-load-bearing)). One narrow CI-time exception: the validator reads `delegation.zeus` ([§2.3](#23-layer-2-routingyml-what-is-read-and-what-is-not)). | **No** — see [§2.3](#23-layer-2-routingyml-what-is-read-and-what-is-not) |
| 3 | Installed config the installer seeds | the user's `opencode.json` | The `agent.<name>.permission` blocks the host reads at session time. | **Yes** — see [§2.4](#24-layer-3-the-config-the-installer-seeds) |
| 4 | V1→V2 translation map | `scripts/install/config-migration.mjs:33` | Only the V2 install path. Converts layer 3's shape; incomplete — see [§2.5](#25-layer-4-the-v1v2-translation-map). | **Yes, on the V2 path only** |

### 2.2 Layer 1 — per-agent frontmatter

Fourteen agent files under `src/agents/`. Each declares a `permission:` block.
Selected examples, to show the shapes in use:

| Agent | Shape | Citation |
|---|---|---|
| `zeus` | flat allows plus `task: {"*": allow}` | `src/agents/zeus.md:5` |
| `hermes` | flat allows plus `task: {"*": deny, apollo: allow}` | `src/agents/hermes.md:20` |
| `mnemosyne` | scoped glob denies on `write` and `edit` | `src/agents/mnemosyne.md:39` |
| `iris` | nested command globs under `bash` | `src/agents/iris.md:9` |
| `apollo` | flat denies **and** a separate `tools:` map | `src/agents/apollo.md:6` |

The per-agent `delegation` intent lives in three more frontmatter-adjacent places,
and they are three different layers again: `mode:` (`subagent` / `all` / `primary`),
`visible: false`, and the `tools:` map. Only `mode` reaches the installed config
(`scripts/install/opencode.mjs:939`).

### 2.3 Layer 2 — `routing.yml`: what is read, and what is not

`src/routing.yml` is a large file that reads like a specification. It is not one.
Measured, per top-level block, by searching `src/` and `scripts/` for a consumer:

| Block | Runtime consumer |
|---|---|
| `presets:` | **Read.** `src/pantheon/presets.mjs:185` |
| `presets.<n>.agents.<a>.model` | **Read.** `applyPreset`, `src/pantheon/presets.mjs:493` (assignment at `:496`) |
| `agents:` (roles, capabilities, skills, model mapping) | Partly — the validator reads it; the plugin does not |
| `delegation:` | Partly — the validator reads it, in check G5b (`scripts/validate-routing.mjs:284`); the plugin does not |
| `permission.task:` | **None** |
| `fallback_chains:` | **None** |
| `intent_gate:` | **None** |
| `auto_continue:` | **None** |
| `background_job_board:` | **None** |
| `background_delegation:` | Comment references only, plus one parity test |
| `handoffs:` | Read by the validator, for referential integrity only |
| `todo_enforcer:`, `hashline:`, `full_auto:` | **None** — each self-describes as a doc mirror (`src/routing.yml:543`, `src/routing.yml:549`, `src/routing.yml:556`) |

Three of these deserve their own note.

**`permission.task:` is decorative and its value contradicts the frontmatter.**
`src/routing.yml:531` declares a single global rule, `"*": allow`. Every agent's
frontmatter instead declares `"*": deny` except the orchestrator's
(`scripts/validate-routing.mjs:314`). The module that would read the routing block
exists — `loadRoutingPermissionTask`, `src/pantheon/presets.mjs:226` — and has **no
caller anywhere in `src/` or `scripts/`**, and no test. Editing it changes nothing.

**`background_job_board:` is decorative and its values are duplicated in code.**
`src/routing.yml:511` declares `max_concurrent_per_agent: 3`, a signal directory and
a persistence path. The actual values are hard-coded in the shared-board factory
(`src/pantheon/shared-board.ts:25`, `src/pantheon/shared-board.ts:26`, `src/pantheon/shared-board.ts:34`) — identical today, two sources.
Changing the YAML changes nothing; changing the code changes everything.

**The two functions that read `presets.<n>.agents.<a>.model` are not interchangeable.**
The live reader is `applyPreset` (`src/pantheon/presets.mjs:472`), which walks
`resolved.agents` at `src/pantheon/presets.mjs:493` and writes `config.agent[a].model`
at `:496`. It is reached from the plugin through `applyActivePresetToConfig`
(`src/pantheon/presets.mjs:532`), called at `src/plugin.ts:385`. Its sibling
`loadRoutingAgentModels` (`src/pantheon/presets.mjs:262`) performs the same read and
**has no production caller anywhere** — only the test suite and documentation name it.
The verdict above is about the first; a reader who greps for the function name used in
`docs/INSTALLATION.md` lands on the dead one.

### 2.4 Layer 3 — the config the installer seeds

This is the layer that reaches the host, and it is produced by a deliberately narrow
extraction. The installer reads each agent file's frontmatter and copies **seven keys**
into the installed config (`scripts/install/opencode.mjs:921`): colour, description,
mode, hidden, temperature, the model-invocation flag, and `permission`
(`scripts/install/opencode.mjs:948`). Those seven are the whole of what provably
reaches an installed config.

Everything else in an agent's frontmatter does not reach it. The installer extracts no
`tools` map, no `mcp_tools`, no `skills`, no `reasoning_effort` and no `visible` flag,
and a repo-wide search for a consumer of `mcp_tools` across `src/` and `scripts/`
returns nothing.

On top of the per-agent blocks, the installer seeds a small set of **top-level**
defaults. These are declared in code rather than in a packaged template, with an
explicit contract that nothing personal may be seeded there
(`scripts/install/opencode.mjs:103`). What actually gets seeded, and the rule that
governs each:

| Seeded value | Rule | Citation |
|---|---|---|
| `default_agent` | only if absent — a user's choice is kept | `scripts/install/opencode.mjs:104` |
| `permission` as an object | only if absent | `scripts/install/opencode.mjs:1158` |
| `permission.skill: {"*": allow}` | only if absent, and only when the skills component is installed | `scripts/install/opencode.mjs:1177` |
| `permission.bash` dev allowlist | only if absent | `scripts/install/opencode.mjs:1203` |
| `permission.mcp.<server>` defaults | per server, only if absent | `scripts/install/opencode.mjs:1327` |

Two properties of this layer matter for everything downstream:

- **The seed is gap-filling, never overwriting.** Every rule above is conditional on
  the user not having set the key. So this layer cannot be used to *tighten* a user's
  config, and a user value always survives an install.
- **Per-agent permissions behave the opposite way.** The per-agent merge is not
  gap-filling: for an agent that already exists, the framework-managed fields are
  overwritten from the canonical source (`scripts/install/opencode.mjs:974`). So the
  *agent-level* permissions are authoritative and the *top-level* ones defer to the
  user. Those two rules are different on purpose and it is worth knowing which side
  of the line a given setting falls on.

For a **new** agent the seed is a fresh object, with one repair step: if the
canonical permission block has no `bash` key, one is copied in
(`scripts/install/opencode.mjs:998`). That branch is unreachable for any agent that
already declares a `bash` entry, which is all of them.

### 2.5 Layer 4 — the V1→V2 translation map

This layer runs only when the installer resolves the V2 generation
(`scripts/install/opencode.mjs:1350`). It converts the V1-shaped config the merge
produced into the V2 shape before writing.

The permission-action map is four entries (`scripts/install/config-migration.mjs:33`):

```
bash → shell          skill → skill
edit → edit           websearch → websearch
```

Only the first is a rename. The other three are identity entries. **The map is
incomplete**, and the module's own comment says unknown keys pass through
(`scripts/install/config-migration.mjs:53`):

```js
const action = V1_PERMISSION_TO_ACTION[key] || key
```

Current behaviour, verified by running the converter over the permission blocks this
project actually writes:

| V1 key in the config | V2 action emitted |
|---|---|
| `bash` | `shell` |
| `read`, `grep`, `glob`, `webfetch`, `question` | passes through unchanged |
| `task` | passes through unchanged |
| `write`, `edit`, `hashline_edit` | passes through unchanged |
| `mcp` | passes through unchanged |

Two consequences, both verified by execution rather than reading:

1. **Resource granularity survives.** A nested V1 value becomes one rule per
   resource, so the orchestrator's `"*": allow` and the scoped denies do not
   collapse. But the *action* name is whatever the V1 key was.
2. **A nested glob deny keeps both halves.** The scoped write rule produces
   `{action: "write", resource: "*", effect: "deny"}` **and**
   `{action: "write", resource: ".pantheon/memory-bank/**", effect: "allow"}`. Which
   of the two a host honours, and in what order, is a host-side question this
   repository cannot answer — see [§5](#5-unverified-and-the-evidence-that-would-settle-it).

**Framing, preserved deliberately.** This assessment was made as a **lower bound on
blast radius, not an estimate**. What is established is the shape of the defect: the
map covers one rename out of the action vocabulary the config uses, and every other
key passes through unrenamed. What is *not* established is how many installed
configs are affected or what a given host does with an unrecognised action — both
require inspecting installed configs and host behaviour respectively. Treat the
count of affected keys as a floor, never as a total.

**A second, documented gap on the same path.** The installer writes the V1 spelling
`permission` (`scripts/install/opencode.mjs:128`) while V2 reads `permissions`. Both
files record this as known debt rather than fixing it
(`scripts/install/opencode.mjs:118`, `scripts/install/config-migration.mjs:330`),
because choosing a winner changes what an install writes. The migration's own
managed-field list uses the V2 name
(`scripts/install/config-migration.mjs:340`), and a drift guard asserts the two
managed-field lists match as sets (`scripts/install/config-migration.mjs:362`). So
the *field lists* are kept in sync; the *spelling the installer writes* is not.

Verified consequence: when the migration runs, the agent ends up with a single
`permissions` key and the installer's canonical value **overwrites** a user's
hand-written `permissions` on that agent — because `permissions` is
framework-managed. The user's tightening does not survive an install. This is
consistent with the managed-field contract, but it is the opposite of what "the
installer's merge is additive" suggests.

### 2.6 Which layer is load-bearing

Stated plainly, with the evidence.

**Layer 3, the installed config, is load-bearing.** It is the only layer the host
reads at session time, and it is built from the seven frontmatter keys in
[§2.4](#24-layer-3-the-config-the-installer-seeds). Everything the installer does
not extract is decorative *with respect to that config* — which, per §2.4, includes
the `tools` map, `mcp_tools`, `skills`, `reasoning_effort` and `visible`.

**A qualification on "decorative", because it is easy to overread.** Decorative here
means *no code in this repository reads it*. It does not mean the host ignores it.
The agent files are installed and referenced by path, so a key the installer never
copies is still available to whatever the host chooses to parse from an agent
definition. Whether it is honoured is [UNVERIFIED](#5-unverified-and-the-evidence-that-would-settle-it).
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

### 2.7 A fifth copy: the agent table in `AGENTS.md`

Not one of the four, but it behaves like a layer and is more likely than any of them
to be mistaken for the source. The agent table in `AGENTS.md` is a **hard-coded
string literal** in the build script (`scripts/build-agents-md.mjs:39`), not a
rendering of the agent files. Editing a `description` in `src/agents/*.md` does not
change `AGENTS.md`, and the build check will not notice, because the table is not an
input to the build.

A second-order consequence: `AGENTS.md` states a coverage minimum that no gate in
this repository enforces.

**A third generator exists, and it would drop the orchestrator.** It differs from the
committed one on a detail that looks cosmetic and is not: `src/agents/zeus.md` is the
**only** agent file whose frontmatter has no `name:` key. `scripts/install/agents-md.mjs`
derives its table from agent frontmatter rather than hard-coding it, and
`readCanonicalAgents()` pushes a file only when the parse succeeds — which is decided
by the `!fm.name` guard (`scripts/install/agents-md.mjs:51`) and applied at the
conditional push (`scripts/install/agents-md.mjs:94`). `zeus` is therefore dropped
without warning, and the count interpolated into the prose
(`scripts/install/agents-md.mjs:151`, "with ${agentCount} specialized agents") would be
**13, with the orchestrator absent from the table** — the one agent that can delegate is
the one erased.

**The limit, stated plainly: it is CLI-only today.** No install path calls this
generator; its only entry point is its own CLI
(`scripts/install/agents-md.mjs:10`). The committed `AGENTS.md` is produced by the
hard-coded builder in `scripts/build-agents-md.mjs`, which is why the committed table
lists all 14 agents. So no user install is affected today — the defect is latent and
becomes live the moment that generator is wired into an install.

---

## 3. Delegation

### 3.1 Two mechanisms, and what each is for

There are two, they are not alternatives to each other, and only one of them
enforces anything.

**The native `task()` child-session engine.** Dispatch, child-session lifecycle and
result retrieval all belong to the host. Pantheon ships no delegation tool; the
repository documents this removal explicitly in the README
([Delegation](README.md)) and in [INSTALLATION](INSTALLATION.md). Background mode
(the default the orchestrator is instructed to use,
`src/agents/zeus.md:132`) requires a host environment variable to be set before
launch. **This is the mechanism that carries delegation.** Everything in
[§3.2](#32-who-may-delegate-to-whom) is enforced here.

**The background job board.** A pure-TypeScript state machine
(`src/pantheon/background-job-board.ts:26`) with states
`running → completed | error | cancelled → reconciled` and a restricted transition
table (`src/pantheon/background-job-board.ts:47`). **This mechanism does not
delegate anything.** It is a bookkeeping mirror, plus a concurrency counter. Its one
runtime entry point is a best-effort post-hoc mirror of a native dispatch
(`src/plugins/pantheon-hooks.ts:798`), and what the mirror is for is stated in the
source: so the finalize path writes a terminal report and the TUI tracks the child
end-to-end.

Three consequences a planner needs:

1. **The board cannot start work.** There is no dispatch path through it. Planning a
   workflow "on the board" means planning on a mechanism that only observes.
2. **The board's only admission control is concurrency** — a running-count cap per
   agent (`src/pantheon/background-job-board.ts:507`), not a permissions check.
3. **Its mirror failure is silent by design.** The mirror is fire-and-forget and its
   rejection handler is an empty catch (`src/plugins/pantheon-hooks.ts:804`). When
   the cap is reached the mirror throws and the catch discards it: the delegation
   still runs, and the job simply never appears on the board. Verified: the cap
   check is at `src/pantheon/background-job-board.ts:259`, reached only from the
   mirror.

Most of the board's API is not called by any plugin. `waitForTerminal`,
`markReconciled` and `formatForPrompt` have callers in the test suite and in the
orchestrator's *instructions*, and nowhere in `src/`. That is not a defect: an
instruction telling an agent to call a board method is a legitimate use. It does mean
that a workflow whose correctness depends on those methods has no code-level
guarantee — it depends on the model making the call.

### 3.2 Who may delegate to whom

Three layers again, and this time they do not all agree.

| Layer | Says | Enforced by |
|---|---|---|
| Frontmatter `permission.task` | Orchestrator: `"*": allow`. `hermes`/`athena`: `"*": deny, apollo: allow`. All others: `"*": deny`. | The host, from the installed config. It reaches the config (verified, [§2.4](#24-layer-3-the-config-the-installer-seeds)); whether the host applies last-match-wins glob semantics to a `task` key is **UNVERIFIED** — see [§5](#5-unverified-and-the-evidence-that-would-settle-it) |
| Routing matrix (`agents.<a>.subagent_can_delegate_to`) | Same intent, per agent. Enforced as a consistency invariant by the repo validator (`scripts/validate-routing.mjs:236`) and `can_delegate` by `scripts/validate-routing.mjs:214`. | The validator, not the runtime |
| Runtime matrix (`isDelegationAllowed`) | Orchestrator → anyone; `athena`/`hermes` → `apollo` only; **everything else denied** (`src/pantheon/delegation-enforce.ts:138`) | **The plugin's tool hook** |

The runtime matrix is a hard-coded two-line function, not a table read from
`routing.yml`. Its glob gate is dead in the plugin: the guard is constructed without
the option that supplies the globs (`src/plugin.ts:101`), so the glob check
short-circuits on its fail-open branch (`src/pantheon/permission-globs.ts:60`).

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
(`src/instructions/zeus-timeout-retry.instructions.md:43`): a per-agent ordered list
of substitutes, plus a per-role table of timeouts and retry counts, plus an
escalation protocol.

**Nothing in the repository executes it.** The routing-matrix validator does not read
`fallback_chains`; a repo-wide search for a consumer returns nothing. The chain is
model-executed text. Two consequences:

- **The timeouts in the routing file are decorative.** `background_delegation.timeout_ms`
  (`src/routing.yml:516`) has no consumer; the table that is actually presented to the
  orchestrator is in the instructions file. Where the two disagree, the instructions
  win because they are what the model reads.
- **No chain step invokes anything.** Every entry is a decision the orchestrator
  makes, including the terminal ones. For the reviewer, the GitHub operator and the
  memory-bank owner the chain terminates at the orchestrator itself
  (`src/routing.yml:475`, `src/routing.yml:487`, `src/routing.yml:489`), so those
  three have no route out of the chain except a message to the user.

One part of the chain has a code analogue, and it is worth not confusing the two:
the empty-result guard (`src/pantheon/task-result-guard.ts:14`) converts an empty
delegation result into an explicit error so the caller sees a failure rather than
silence. That is a *failure detector*, not a fallback — it triggers no substitute
agent.

### 3.4 Session reuse

The reuse protocol is in the instructions
(`src/instructions/zeus-timeout-retry.instructions.md:68`): before dispatching,
check for a prior session with that agent and continue it, passing the files already
examined. The retention count is `background_delegation.session_max`
(`src/routing.yml:520`) — **decorative**; no consumer. So the numeric bound is
whatever the instructions say, and the YAML value is not the limit.

Two reuse mechanisms exist and are unrelated to each other: host-level session
continuation for subagent conversations, and the persistence MCP's checkpoint store
for orchestrator state. A planner should not assume reusing one reuses the other.

### 3.5 Per host generation: what you can rely on

**This section is conditional by construction.** "V1" and "V2" here mean the two
plugin contracts Pantheon ships, selected at install time by a generation gate
(`scripts/install/opencode-version.mjs:213`). They are not statements about any
particular host build. The installer registers a different plugin set per contract
and strips the other's entries (`scripts/install/opencode.mjs:1075`, `scripts/install/opencode.mjs:1106`), so
this is a genuine fork, not a preference.

The V2 adapter maintains an explicit list of what it does not implement, seeded in a
plain-`.mjs` module so the plugin, the installer and `doctor` all read the same
strings (`src/pantheon/v2-unsupported.mjs:55`). Two of those entries decide what a
planner may rely on.

#### Delegation: available on both contracts, but with a different enforcement floor

Native delegation is available on both contracts — it is the host's engine.

| Relied-on property | V1 contract | V2 contract |
|---|---|---|
| Native delegation available | Yes | Yes |
| Read-only agents blocked from mutating tools | Yes | Yes |
| Depth-2 for read-only agents | Yes | Yes |
| **Caller/target matrix enforced** | **Yes** | **No** |

The V2 adapter builds its guard without `getSessionAgent`, `isRootSession` or
`isChildSession` (`src/plugin-v2.ts:870`), for **two** independent reasons that are
easy to conflate. Keeping them apart matters, because the one that sounds structural
is not the one that denies:

1. **Missing `getSessionAgent` — wiring.** This is what would deny **every** `task()`
   call in **every** session. V2 learns the active agent from the `execute.before`
   event itself and keeps no session→agent map, so there is no lookup to hand the
   guard: it would call `isDelegationAllowed(undefined, target)`, which returns `false`
   for an undefined caller (`src/pantheon/delegation-enforce.ts:145`) and throw *caller
   agent is unavailable*.
2. **Unwired hierarchy — design.** `SessionHierarchyRegistry` gates exactly two
   things, and nothing else: the depth-2 child deny and the root-session gate. Left
   unseeded, `isChild` is `false` for every session, so depth-2 would never fire on a
   genuine child, and a registry that cannot tell a child from a root is not
   trustworthy input to either check.

**The inference that is easy to get backwards.** The registry does report an unseeded
session as a *root*, and `true` **passes** the root gate
(`src/pantheon/delegation-enforce.ts:110`) — it does not deny. The deny in case 1 comes
from the absent caller identity, not from the hierarchy.

**Unwired, not impossible.** The V2 `session.created` event carries
`properties.info: Session`, and `Session` declares `parentID?: string` — the same field
V1 seeds from on that exact event, a superset of the two fields V1 reads there — so
seeding V2's live sessions is one line in `onSessionCreated`
(`src/plugin-v2.ts:513`). The real asymmetry is V1's *second* source: the fail-open
`client.session.list()` startup seed covering sessions that predate plugin load, which
has no V2 equivalent at all because the V2 `PluginContext` exposes no `client`
(`src/plugin-v2.ts:531`). Whether a live host actually populates `info.parentID` on
that event is **UNVERIFIED** — no measurement reads an event payload.

Omitting all three predicates skips the branch entirely; the guard only enters it when
`isRootSession` is defined. The consequence is stated plainly in the source: the
caller/target matrix itself is **not** enforced on V2, and this is a known gap, not a
covered case (`src/plugin-v2.ts:867`). The upgrade guide documents the same limitation
from the user's side — see [Known limitation](UPGRADING.md).

**What this means for planning:** on the V2 contract, the restriction "only the
orchestrator and the two read-only scouts may delegate" is a **convention you are
relying on other agents to honour, not a control**. The only delegation restriction
still enforced is on the two read-only agents, and it holds only because the
delegation tool is itself in their blocked-tool list.

#### The board: available on V1, absent on V2

This is the part with no existing documentation, and the part whose absence is now
**announced** rather than silent — at install time and in `doctor`.

**On the V2 contract there is no board.** Not "a reduced board" — the state machine,
the store and the client it needs are all reachable only from the V1 plugin, which
the V2 contract does not register. The adapter lists the goal tooling as absent for
exactly this reason: it needs a store, a loop client and a board, none of which the
V2 plugin context exposes (`src/pantheon/v2-unsupported.mjs:71`).

The bridge that would carry them across exists and is never wired. The bridge factory
and the context accessor are both implemented
(`src/pantheon/v2-bridge.ts:89`, `src/pantheon/v2-bridge.ts:110`), and **no production code path calls the
factory** — its only callers are in the test suite. So the V2 accessor returns null
in every real configuration, and that null is handled by *not registering the
dependent tools* rather than by registering them as non-functional. **Absent, not
broken** still describes the board itself — but "absent" no longer means "unnoticed":
the reduction carries a marker (`goal-tools`, `src/pantheon/v2-unsupported.mjs:76`),
and two surfaces report it.

| Board capability | V1 contract | V2 contract |
|---|---|---|
| Dispatch mirrored onto the board | Yes | No |
| Terminal audit log | Yes | No |
| Periodic pruning of old jobs | Yes | No |
| Recovery of running jobs after restart | Yes | No |
| `markReconciled` / `formatForPrompt` / `waitForTerminal` | Callable per instructions | No |

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
(`src/pantheon/v2-unsupported.mjs:55`), so the two surfaces cannot report a reduction
the plugin does not, or miss one it does. Neither surface helps a workflow *mid-flight*:
the notice arrives before you depend on the board, not when a dispatch goes unrecorded.

Two V1-specific behaviours worth stating conditionally as well, since both are
recorded as observations of specific host builds rather than as guarantees:

- **Restart recovery.** On restart, jobs left in `running` are marked errored
  (`src/plugin.ts:55`). Old jobs are not resumed and child work is not restarted.
  The persisted reports remain historical records. See
  [INSTALLATION](INSTALLATION.md).
- **Background completion observability.** The finalize path is driven by an idle
  event plus a periodic scan. Whether a background child's completion is observable
  at all is recorded in the source as host-build-dependent
  (`src/plugins/pantheon-hooks.ts:1359`). Plan completion detection on the idle path
  and treat an absent completion as possible.

**The reader's rule:** before planning on the job board, on goal tools, or on any
caller/target restriction, establish which contract the target install resolved. All
three are safe on V1; none of the three is available on V2.

---

## 4. Disagreements between layers

Surfaced, not resolved. Each row names the layers and what each one says.

| # | Layers | The disagreement |
|---|---|---|
| 1 | `routing.yml` global `permission.task` vs per-agent frontmatter | The routing file declares one global rule, `"*": allow` (`src/routing.yml:533`). Every agent's frontmatter declares `"*": deny` except the orchestrator's. The routing layer is decorative ([§2.3](#23-layer-2-routingyml-what-is-read-and-what-is-not)), but it reads as the global default. |
| 2 | `routing.yml` `background_job_board` vs the shared-board factory | Same values, two sources. The YAML is not read. Changing the YAML silently no-ops. |
| 3 | `routing.yml` `background_delegation` timeouts vs the instructions-file timeout table | Two independent timeout sources. Neither is code-enforced; the instructions table is the one the model sees. |
| 4 | `permission:` block vs `tools:` map | Two mechanisms for the same restriction, on the same agents, with no validator comparing them and different failure modes. |
| 5 | Installer writes `permission` (V1 spelling) vs V2 reads `permissions` | Recorded as known debt in both files and deliberately not fixed. Verified consequence: on the V2 path the installer's value overwrites a user's hand-written `permissions` on a managed agent. |
| 6 | Translation map vs the action vocabulary the config uses | The map covers one rename out of many; all other keys pass through unrenamed ([§2.5](#25-layer-4-the-v1v2-translation-map)). Assessed as a lower bound on blast radius. |
| 7 | `docs/INSTALLATION.md`'s V2 config example vs the migration output | The documented example shows a rule shape keyed on the tool with an allowed-agent list (`docs/INSTALLATION.md:179`); the converter emits a shape keyed on an action with a resource and an effect (`scripts/install/config-migration.mjs:33`). One of the two is stale. |
| 8 | `docs/INSTALLATION.md`'s V2 MCP example vs the MCP converter | The example shows the wrapper form; the converter's own comment says the host rejects that wrapper and normalises it away (`scripts/install/config-migration.mjs:243`). The example contradicts the code. |
| 9 | Routing matrix vs board path | The matrix is enforced on the native path only. The board path enforces a concurrency cap and no permissions ([§3.2](#32-who-may-delegate-to-whom)). |
| 10 | Orchestrator's documented wave size vs the board's concurrency cap | The instructions describe waves of up to five (`src/agents/zeus.md:154`); the board caps running jobs **per agent** at three (`src/pantheon/shared-board.ts:25`; `getRunningCount(agent)`, `src/pantheon/background-job-board.ts:512`). Above the cap, the mirror is dropped silently and the extra job is untracked. **The disagreement is real, but the documented wave pattern cannot trip it:** that example dispatches to six *distinct* agents, and council synthesis caps itself at 3 specialists (`src/instructions/zeus-council-synthesis.instructions.md:107`), so no documented wave puts four jobs on one agent. Two things do reach the cap — four concurrent dispatches to the **same** agent, or accumulated jobs stuck in `running`, since every eviction path filters to terminal/reconciled only (`pruneExpired`, `src/pantheon/background-job-board.ts:630`; `pruneCompleted`, `:677`; `enforceEntryCap`, `:695`). A stuck job therefore holds its slot until the process restarts. |
| 11 | Orchestrator's depth rule vs the plugin's depth rule | Two independent depth mechanisms: a key-value counter in the instructions (`src/agents/zeus.md:189`) and a parent-child session hierarchy in the plugin (`src/pantheon/delegation-enforce.ts:353`). The plugin's is the enforced one. |
| 12 | `AGENTS.md` agent table vs the agent files | Hard-coded literal, not generated from the files ([§2.7](#27-a-fifth-copy-the-agent-table-in-agentsmd)). |
| 13 | `AGENTS.md` coverage minimum vs the coverage script | `AGENTS.md` states a minimum; the repository's own coverage script states that no threshold is enforced. |
| 14 | Agent-file index links vs the files on disk | The agent reference index links each agent to a `.agent.md` filename, resolved relative to itself (`docs/agents/README.md:9`); the canonical files carry the plain `.md` extension and live in `src/agents/`. All 14 links are dead — no `.agent.md` file exists anywhere in the repository, and `docs/agents/` contains only its own README. **No CI job catches it:** the docs workflow triggers only on a `v*` tag push or `workflow_dispatch` (`.github/workflows/docs.yml:4`) and runs no link check, so nothing in CI or in the docs build ever resolves these targets. |

**Rows 7 and 8 name stale examples in a document this one does not fix.** Both were
re-verified for this revision and are still stale as of `80bac52`: the `permissions`
example (`docs/INSTALLATION.md:177-182`) is keyed on `tool` with an `allow` list, while
the converter emits `{action, resource, effect}`; and the `mcp.servers` wrapper
(`docs/INSTALLATION.md:183-188`) is the form the converter's own comment says the host
rejects (`scripts/install/config-migration.mjs:238`). **Correcting them belongs to a
follow-up that edits `docs/INSTALLATION.md`, not to this document.** Two consequences
for the reader: do not treat this table as authorisation to edit that file as part of
reading it, and until the follow-up lands do not treat those two examples as
authoritative — they are the stale side of a known disagreement, not a specification.

---

## 5. Unverified, and the evidence that would settle it

Each item is something this repository cannot settle, with the evidence that would.

| # | Claim | Why unverified here | Evidence that would settle it |
|---|---|---|---|
| 1 | Whether the host honours a `tools:` map entry by hiding the tool or by failing the call, and how `tools` and `permission` interact when both are present | The host's agent-config schema is not in this repository. The repo's own ambient declaration records that the agent-config surface is not typed here (`src/opencode.d.ts:4`) | The host's published agent configuration schema, or a host-emitted config after loading one agent that declares both |
| 2 | Whether the host honours `mcp_tools`, `visible`, `skills` and `reasoning_effort` from agent frontmatter | No consumer in `src/` or `scripts/`; host behaviour unknown | Same as above |
| 3 | Whether a 2.x host recognises the action names the converter emits (`read`, `grep`, `glob`, `task`, `webfetch`, `question`, `write`, `mcp`, …) as distinct actions | The V2 action vocabulary is not defined in this repository | The host's `permissions` schema for that generation |
| 4 | Whether a nested glob deny and its wildcard sibling resolve last-match-wins, first-match-wins, or most-specific-wins | Ordering semantics live in the host | The host's permission resolution rules, plus a test config exercising both orders |
| 5 | Whether the host applies the glob semantics the project assumes to a `permission.task` block — i.e. whether `"*": deny` plus one named allow actually permits only that one agent | The block reaches the installed config (verified), but the interpretation is the host's. The project's own glob implementation is real (`src/pantheon/permission-globs.ts:40`) and is **not** wired to it ([§3.2](#32-who-may-delegate-to-whom)), so it cannot be used as evidence of host behaviour | The host's `task` permission rules, or an end-to-end test: one agent whose frontmatter permits exactly one target, observed attempting a second |
| 6 | Whether `task_status` with a blocking wait is available on each host generation | It is a host tool; this repository only documents it in the orchestrator's instructions | The host's tool registry per generation |
| 7 | Whether a background child's completion is observable on a given host build | Recorded in the source as an observation of one build, not a contract | A probe against the target build: dispatch a background child, observe which events fire |
| 8 | The number of installed configs actually affected by the incomplete translation map | The defect's shape is verified; its population is not | Enumerating installed configs and counting permission keys absent from the map |

All eight are host-side or population-side questions. The one item this list previously
carried that the repository *can* settle on its own — whether the routing validator runs
in CI on every change — has been resolved and moved to [§1.2](#12-what-the-reviewer-enforces-and-what-it-does-not)
as a dated fact: it is enforced per pull request, and ungated only for direct pushes to
`main`.

---

## See also

Where another document is authoritative, this one defers to it:

- Agent roles, capabilities and invocation — [AGENTS.md](../AGENTS.md)
- Reviewer contract, layers, verdicts — the reviewer agent's own file
- Delegation engine contract and its removal — [README](README.md)
- Install, generation pinning, background delegation setup — [INSTALLATION](INSTALLATION.md)
- Per-generation behaviour differences and the V2 enforcement gap — [UPGRADING](UPGRADING.md)
- Design rationale for delegation, sync and memory tiers — [ARCHITECTURE](ARCHITECTURE.md)
- Orchestrator protocol: timeouts, fallback chains, the subtask decision tree,
  session reuse — the orchestrator's instructions, consolidated into `AGENTS.md`
- Per-agent model routing — [reference/model-routing.md](reference/model-routing.md)