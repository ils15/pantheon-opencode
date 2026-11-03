# Upgrading Pantheon

> **2.0 note:** 2.0 removed the V1 plugin line. The sections below describe the
> 1.x → 2.x migration and are kept as history; new installs are 2.x-only and
> the installer registers `src/plugin` (pre-rename configs still register
> `src/plugin-v2`, which `init` migrates).

[Português (Brasil)](UPGRADING.pt-BR.md)

## Upgrading to 2.0

Pantheon 2.0 requires **OpenCode 2.x** and Node.js **>=26.4.0**; the legacy
OpenCode 1.19.x plugin line was removed. What that means for an existing
install:

- **Removed with the V1 line:** the V1 plugin itself, the install-time model
  wizard and static presets (`init --preset`, `set-tier`,
  `PANTHEON_MODEL_PRESET` — use `pantheon_model` project overrides instead),
  the V1 goal tools and BackgroundJobBoard lifecycle, and
  `/pantheon-model`'s interactive wizard and global scope. See
  [Installation](INSTALLATION.md) and
  [Model Routing](reference/model-routing.md).
- **Legacy installs are migrated, not recreated:** run
  `npx pantheon-opencode init` once. A pre-2.0 registration — including the
  deprecated `src/plugin-v2` package path — is recognized, stripped, and
  rewritten to the current `src/plugin` entry. A host that reports OpenCode 1.x
  is refused (upgrade OpenCode first), and an explicit `--opencode-version v1`
  refuses with the 2.0 message. Version resolution is documented in
  [Compatibility](COMPATIBILITY.md#how-the-generation-is-selected).
- **Deprecated aliases go away in 2.1:** the `pantheon-opencode/plugin-v2`
  export alias and the `PANTHEON_V2_P7_LOOP` / `PANTHEON_V2_P8_GUARDRAIL`
  environment-variable aliases still work in 2.0 with a deprecation warning;
  rename to `pantheon-opencode/plugin` and `PANTHEON_P7_LOOP` /
  `PANTHEON_P8_GUARDRAIL` before 2.1. Canonical names are in
  [Env Vars](reference/env-vars.md).
- After upgrading, run `pantheon-opencode doctor` and restart OpenCode.

Version-by-version detail lives in the
[changelog](https://github.com/ils15/pantheon-opencode/blob/main/CHANGELOG.md);
this page does not duplicate it.

This guide covers two moves: **1.5.2 → 1.6.0**, which is an in-line upgrade, and
**1.6.x → 2.x**, which crosses the Pantheon support boundary. Supported host
versions and evidence are in [Compatibility](COMPATIBILITY.md); this page
describes the actions.

## Upgrading from 1.5.2 to 1.6.0

Install globally first — `update` refuses local, workspace, and `npx` copies:

```bash
npm install -g pantheon-opencode@beta
pantheon-opencode update            # npm beta channel + config refresh
pantheon-opencode update --stable   # stable channel instead
```

`update` compares the installed version with the npm dist-tag, runs
`npm install -g pantheon-opencode@<channel>`, then re-runs `init --yes
--headless` so config merges, the Python venv, and MCP entries match the new
package. Copy-only artifacts (agents, skills, `AGENTS.md`, commands, MCP
scripts, code-mode payload) are refreshed by `postinstall` on every `npm
install`.

After the update:

```bash
pantheon-opencode doctor
```

`doctor` warns when the package is newer than the last sync and detects plugin
version drift when the registered path points into an older
`node_modules/pantheon-opencode` copy.

If the update is interrupted, run `init` again. Every copy step is
byte-compare idempotent, and the exact backup set under
`.pantheon/backups/<timestamp>/` is reversible with
`pantheon-opencode restore`. Details are in [Installation](INSTALLATION.md).

### What changes in 1.6.0

- **The tool surface is three unconditional tools** — `hashline_edit`,
  `pantheon_cost`, `pantheon_model` — plus up to two host-dependent ones:
  `vision_describe` when the host exposes its model catalog, and
  `pantheon_bounded_read` when the host exposes its permission and session APIs
  (root Zeus sessions only). It is not six tools.
- **The three plugin goal tools are not registered.** The goal loop needs a
  `GoalStore`, a `GoalLoopClient`, and a `BackgroundJobBoard`, none of which the
  `PluginContext` exposes. The gap is reported as `goal-tools`.
- **Every tool declares `output`.** OpenCode 2.0.x rejects a tool whose
  declaration and result disagree.
- **Read-only sessions are enforced.** A delegated `apollo`/`gaia` session is
  denied `edit`, `write`, `bash`, `task`, `hashline_edit`, and
  `pantheon_model` by the `execute.before` hook.
- **Durable manual goals move to the Persistence MCP.** `goal_create`,
  `goal_get`, `goal_update`, and `goal_done` are Zeus-only and session-scoped.
  V1 goal tools remain available but deprecated.
- **Step ceilings are stripped on installs.** `steps` is optional in
  OpenCode 2; an absent value means no native ceiling. Run the installer once to
  clear a stale value from a managed agent.
- **Memory gains a 64 KiB cap and TTL**, and `pantheon_cost` reports USD by
  agent, model, and session from the models.dev catalog.

### Choosing the generation

```bash
npx pantheon-opencode init --opencode-version v1
npx pantheon-opencode init --opencode-version v2
npx pantheon-opencode init --opencode-version auto
```

`auto` is the default. `--version v1|v2` remains accepted after `init` as the
legacy spelling. The resolution order and fallback behavior are documented once
in [Compatibility](COMPATIBILITY.md#how-the-generation-is-selected). `auto`
never installs both Pantheon plugin generations.

### Migration checklist

1. Stop OpenCode before changing the plugin generation.
2. Run `init` once with the desired selector (`v1`, `v2`, or `auto`). Do not
   copy a V1 plugin entry into a `plugins` list, or vice versa.
3. If the TUI is wanted, include the installer `plugins` component. V1 uses
   `tui.json`; V2 uses its native local-plugin `index.ts` + `tui.ts`
   entrypoints. Installing the V2 server plugin alone does not install the TUI.
4. Inspect the result: V1 Pantheon entries belong in `plugin`; the V2 Pantheon
   entry is the `<installed>/src/plugin` directory in `plugins`.
5. Restart OpenCode after changing configuration.
6. Run `doctor` and confirm no plugin-version drift remains.

### If the host lands on the wrong generation

An install on the wrong generation means the gate could not read the host; it
does not mean it guessed. Pass `--opencode-version v2` explicitly, or set
`OPENCODE_VERSION=v2`. To see what the gate reads, run `opencode --version`.

## Runtime differences after upgrading

- **Delegation:** neither generation registers a Pantheon-specific delegation
  tool. Use the host's native child-session engine — `subagent` in the reported
  root runtime, `task()` in host/API documentation. The former
  `pantheon_delegate`, `pantheon_delegation_read`, and `pantheon_delegation_list`
  tools were removed.
- **V1:** ships `hashline_edit`, the goal/cost/model tools, the
  BackgroundJobBoard lifecycle, and the V1 event/tool/compaction hooks.
- **V2:** does not register the BackgroundJobBoard, V1 event/tool hooks, or a
  Pantheon V1 compaction hook. It adds the V2 hooks documented in
  [OpenCode 2.x](opencode.md).
- **Recovery:** on restart, old or running V1 board jobs are marked errored;
  they are not auto-resumed and child work is not restarted automatically. V2
  adds no automatic resume/restart behavior.
- **Reports:** `.pantheon/delegations/` Markdown reports are historical V1
  board output, not a V2 task protocol.

Do not describe this upgrade as a V1-to-V2 feature-parity migration. It is a
choice between a legacy runtime plugin and a narrower, host-native adapter.

## Historical outlook: the 1.6.x plan for 2.x

The removal the 1.6.x line announced for "1.7 onward" shipped as **2.0**: the
V1 contract is gone and OpenCode 2 is the only supported host. The preparation
steps below are kept for readers coming from 1.6.x; what actually happened to
each surface is listed in [Upgrading to 2.0](#upgrading-to-20).

## Historical upgrade notes

These notes are superseded and retained for users coming from older lines.

- **v1.0** removed all multi-platform support; Pantheon runs only on OpenCode.
  Installation moved to `npx pantheon-opencode init`.
- **v3.19.0** introduced the Memory Persistence Protocol. Its mandatory
  per-agent recall/store rules are historical: current policy searches only when
  project history could change the outcome, reuses coordinator results across
  delegation, and stores at most one reusable top-level outcome when a permitted
  write tool exists. See [Memory](MEMORY.md).
- `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` is not a universal
  prerequisite. It is an experimental gate for some runtimes and is set by
  Pantheon's `npm run start` launcher; use it only when the runtime documents
  and requires it.

For version-by-version detail, see the
[changelog](https://github.com/ils15/pantheon-opencode/blob/main/CHANGELOG.md).
