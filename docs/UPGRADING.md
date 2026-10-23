# Upgrading Pantheon

[Português (Brasil)](UPGRADING.pt-BR.md)

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

- **The V2 tool surface is three unconditional tools** — `hashline_edit`,
  `pantheon_cost`, `pantheon_model` — plus up to two host-dependent ones:
  `vision_describe` when the host exposes its model catalog, and
  `pantheon_bounded_read` when the host exposes its permission and session APIs
  (root Zeus sessions only). It is not six tools.
- **The three V2 goal tools are not registered.** The goal loop needs a
  `GoalStore`, a `GoalLoopClient`, and a `BackgroundJobBoard`, none of which the
  V2 `PluginContext` exposes. The gap is reported as `goal-tools`.
- **Every V2 tool declares `output`.** OpenCode 2.0.x rejects a tool whose
  declaration and result disagree.
- **V2 read-only sessions are enforced.** A delegated `apollo`/`gaia` session is
  denied `edit`, `write`, `bash`, `task`, `hashline_edit`, and
  `pantheon_model` by the V2 `execute.before` hook.
- **Durable manual goals move to the Persistence MCP.** `goal_create`,
  `goal_get`, `goal_update`, and `goal_done` are Zeus-only and session-scoped.
  V1 goal tools remain available but deprecated.
- **Step ceilings are stripped on V2 installs.** `steps` is optional in
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
   copy a V1 plugin entry into a V2 `plugins` list, or vice versa.
3. If the TUI is wanted, include the installer `plugins` component. V1 uses
   `tui.json`; V2 uses its native local-plugin `index.ts` + `tui.ts`
   entrypoints. Installing the V2 server plugin alone does not install the TUI.
4. Inspect the result: V1 Pantheon entries belong in `plugin`; the V2 Pantheon
   entry is the `<installed>/src/plugin-v2` directory in `plugins`.
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
  [OpenCode V2](opencode-v2.md).
- **Recovery:** on restart, old or running V1 board jobs are marked errored;
  they are not auto-resumed and child work is not restarted automatically. V2
  adds no automatic resume/restart behavior.
- **Reports:** `.pantheon/delegations/` Markdown reports are historical V1
  board output, not a V2 task protocol.

Do not describe this upgrade as a V1-to-V2 feature-parity migration. It is a
choice between a legacy runtime plugin and a narrower, host-native adapter.

## Outlook: 1.6.x to 2.x

From **1.7 onward** Pantheon drops the V1 contract and targets OpenCode 2 only.
OpenCode 1.X hosts are not supported on 2.x. OpenCode 2 support is already
present in 1.6.x, so the 2.x change is a removal of the V1 path rather than a
new host requirement.

Prepare for 2.x by:

- moving durable manual goals to the Persistence MCP `goal_*` tools;
- replacing any reliance on V1 goal tools or the BackgroundJobBoard;
- confirming the installation is registered through `plugins` with the
  `<installed>/src/plugin-v2` directory;
- running `doctor` and the V2 sandbox checks described in
  [Release Process](RELEASING.md).

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
