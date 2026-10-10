# Upgrading Pantheon — 1.5.0

[Português (Brasil)](UPGRADING.pt-BR.md)

> ### ⚠️ Before you upgrade: check the line boundary
>
> **1.6.x is the last Pantheon line that supports an OpenCode 1.X host. From
> 1.7 onward every release is a breaking change targeting OpenCode 2.** Upgrading
> from any 1.6.x release to 1.7+ therefore crosses both a Pantheon support
> boundary and an OpenCode major boundary at once. The policy, its support
> matrix and what is verified against which host are in the
> [README compatibility section](../README.md#compatibility-and-support-policy)
> and, in more detail, in
> [INSTALLATION.md](INSTALLATION.md#opencode-v1v2--contrato-de-plugin).
> Everything below applies to upgrades *within* the 1.6 line.

Pantheon 1.5.0 formalizes two exclusive OpenCode plugin contracts. Before
upgrading, choose the contract that matches the OpenCode host you will run:

| Selector | Config key | Pantheon entry | Scope |
|---|---|---|---|
| `v1` | singular `plugin` | `src/plugin.ts` and the V1 `src/plugins/pantheon-hooks.ts` | Pantheon V1 plugin: 6 tools (`hashline_edit`, the 3 goal tools, `pantheon_cost`, `pantheon_model`), board lifecycle, V1 hooks and implemented compaction path |
| `v2` | plural `plugins` | `<installed>/src/plugin-v2` directory (`index.ts` re-exports `src/plugin-v2.ts`) | Full V2 plugin: 3 tools (`hashline_edit`, `pantheon_cost`, `pantheon_model`), 5 event subscriptions, session hooks (`prompt`, `context`), a read-only-enforcing tool `execute.before` hook, plus configuration transforms |

**Changed in 1.6.0 — the V2 tool surface is 3 tools, not 6.** The three goal
tools (`pantheon_goal_create`, `pantheon_goal_get`, `pantheon_goal_update`) are
**not registered on the V2 contract**. The goal loop requires a `GoalStore`, a
`GoalLoopClient` and a `BackgroundJobBoard`, none of which the V2
`PluginContext` exposes, and the V1 bridge resolves to `null` outside V1. They
were previously registered as placeholders that returned an explanatory string —
but on OpenCode 2.0.x such a tool fails on **every** call with
`Tool result declared output without an output schema`, so the placeholder never
ran usefully. They are now absent instead. `getUnsupportedFeatures()` reports
the gap as the `goal-tools` marker. Use the V1 contract if you need the goal
loop.

Three further V2 fixes ship alongside it:

- Every V2 tool now declares `output`. The host requires the declaration and
  the resolved result to agree, in both directions; an undeclared tool fails on
  100% of calls.
- The V2 tool `execute.before` hook **enforces read-only sessions** instead of
  being a no-op. The three V2 tools — including the `hashline_edit` write
  primitive and `pantheon_model`, which writes `active-preset.json` in project
  *and* global scope — were reachable from a delegated `apollo`/`gaia` session,
  because the V1 `tool.execute.before` hook that was meant to deny them lives in
  `src/plugin.ts`, which is not loaded when only `plugin-v2` is configured. The
  V2 plugin now instantiates the same `createEnforcementGuard` and denies
  `edit`, `write`, `bash`, `task`, `hashline_edit` and `pantheon_model` in a
  read-only session. The host puts the active agent on the `execute.before`
  event itself, so V2 needs no `chat.params`-equivalent hook to populate the
  registry.
- `pantheon_model` on V2 has no interactive wizard (a tool call has no
  terminal). Pass `action="status"` to read overrides, or `agent` + `model`
  with `action="set"`.

### V2 delegation and hook behavior

V2 enforces the caller/target matrix for Pantheon-managed targets across every
entry in `permission.evaluate`'s `resources` array. Native-only resources pass
through unchanged to OpenCode; mixed native/Pantheon and multi-target requests
are denied unless every Pantheon target is explicitly allowed for the
authoritative caller. Explicit host denies remain final, and malformed or
unknown resource data fails closed. The V2.0.25 sandbox probe observed
`resources`, `agent`, `sessionID`, and `effect` on the permission event, with a
mutable output argument. If that output argument is absent, a policy denial
throws an error rather than silently relying on a status mutation that cannot
occur.

V2 `execute.after` runs the completed-result parity chain in this order:
`task-result-guard` → `context-sandbox` → `read-enhancer`. The `session.prompt`
and compaction hooks remain registration-only; vision interception and
compaction context construction remain V1-only. `context-sandbox` is a
post-result transformation, not an authorization boundary or a general
fail-closed control.

#### V2 `context_sandbox` configuration and security scope

The V2 host does not preserve the V1 top-level `context_sandbox` setting. In an
isolated live-host probe against `opencode2 v0.0.0-beta-19271` (2026-10-09),
`GET /api/config` omitted a supplied top-level `context_sandbox`, while a plugin
entry's `options.context_sandbox` arrived unchanged in `ctx.options`. A direct
top-level V2 setting is therefore **unsupported/inert**; do not treat it as
active protection. The V2 installer translates a legacy top-level block into
the Pantheon plugin's `plugins[].options.context_sandbox`, preserving the
top-level copy for a later V1 downgrade. Existing installer tests cover the
translation, per-leaf precedence, validation, and idempotence. When editing a
V2 config manually, use the nested plugin option.

“Fail closed” is deliberately scoped to the V2 delegation policy and secret
scanner failure paths exercised with injected failures. It is not a claim about
every V2 hook, every config key, or `context-sandbox` result transformation.

The installer removes Pantheon entries from both config shapes and writes only
the selected generation. It does not mix `src/plugin.ts` or
`src/plugins/pantheon-hooks.ts` with `<installed>/src/plugin-v2`; unrelated
third-party entries are retained and are not converted.

#### Repeatable V2 verification and interactive-TUI waiver

The isolated install/MCP/doctor gate is repeatable without loading third-party
plugins:

```bash
bash scripts/test-opencode-v2-sandbox.sh --prepare
bash ~/pantheon-sandbox/run-test.sh
```

The local read-hook replay and the host-backed hook slice are separate checks;
the former uses explicit fixture events rather than relying on a model to call
`read`, and the latter exercises hook dispatch through the isolated OpenCode
host. The V2 contract tests exercise delegation decisions with controlled
permission events. `tests/tui-packaged-smoke.test.mjs` verifies that the
packaged TUI plugin registers its sidebar, handles a task event, and disposes.
This is an explicit waiver for an automated *interactive TUI session*: no
interactive keystroke/session claim is made by the headless MCP, hook, contract,
or packaged-plugin smoke checks.

```bash
# Pin one contract for this OpenCode configuration
npx pantheon-opencode init --opencode-version v1
npx pantheon-opencode init --opencode-version v2

# The default. Reads the generation from the host: explicit
# OPENCODE_VERSION wins; otherwise an OPENCODE_BIN ending in opencode2
# selects V2; otherwise the host's own --version decides (major >= 2 => V2).
npx pantheon-opencode init --opencode-version auto
```

`--version v1|v2` remains accepted after `init` as the legacy spelling.
`auto` is the default and never installs both Pantheon plugin generations.

### Debugging: the host is on the wrong generation

An install that lands on the wrong generation means the gate could not read the
host, not that it guessed wrong. `auto` falls back to V1 — with one visible
warning — in exactly three situations:

- **The probe could not run.** `opencode` was not on `PATH`, or
  `OPENCODE_BIN` pointed somewhere unrunnable. The warning quotes the spawn
  error. Fix the path, or pass `--opencode-version v2` explicitly.
- **The banner had no readable version.** Some hosts print a bare build date
  (`built 2026.10.04`) instead of a version; a date is never read as a major.
  The warning quotes what the probe returned.
- **The banner contradicted itself.** Version-like tokens that disagree with no
  tool name to break the tie, for example `1.18.33 (runtime 2.0.0)`. The
  warning lists the majors it found. Pass the generation explicitly.

To see what the gate actually reads, run the host binary yourself:

```bash
opencode --version
```

The gate prefers the version token that immediately follows the tool name, so
`node v22.1.0 (opencode 1.18.33)` resolves as a 1.x host and
`opencode v1.18.33 built 2026.10.04` resolves as 1.x too. If the resolution is
still not what you expect, `--opencode-version v1|v2` overrides it outright and
`OPENCODE_VERSION` overrides everything except the explicit flag.

### Updating between beta releases (1.5.0-beta.5+)

1. Stop OpenCode.
2. Run `npx pantheon-opencode@beta update` (beta channel, the default during
   1.5.0 prereleases) or `npx pantheon-opencode@beta update --stable`. Always
   pin `@beta` on npx — plain `npx pantheon-opencode` resolves the `latest`
   dist-tag (the stable release), which predates the `update` command. The
   command compares the installed version with the npm dist-tag, installs the
   newer package globally, and re-runs `init --yes --headless` so config
   merges, the Python venv and MCP entries match the new package. With a
   global install, `pantheon-opencode update` (no npx) does the same.
3. If the update was interrupted, just run `init` again — every copy step is
   byte-compare idempotent and the config write leaves an
   `opencode.json.bak` of the previous content.
4. Start OpenCode and optionally confirm with `npx pantheon-opencode doctor`
   (it compares the installed-version marker against the package and warns on
   drift).

Copy-only artifacts (agents, skills, AGENTS.md, commands, MCP scripts and the
code-mode payload) are refreshed automatically by the package postinstall on
every `npm install`; `init`/`update` is only required for config merges, the
venv and MCP entries.

### Migration checklist

1. Stop OpenCode before changing the plugin generation.
2. Run `init` once with the desired selector (`v1`, `v2`, or `auto`). Do not
   copy a V1 plugin entry into a V2 `plugins` list, or vice versa.
3. If the TUI is wanted, include the installer `plugins` component. The TUI is
   a separate `tui.json` registration; installing V2 does not imply that the
   TUI or V1 runtime is loaded.
4. Inspect the result: V1 Pantheon entries belong in `plugin`; the V2 Pantheon
   entry is the `<installed>/src/plugin-v2` directory in `plugins`.
5. Restart OpenCode after changing configuration. This restart reloads the
   selected plugin; it is not an automatic resume of delegated work.

### Runtime differences after the upgrade

- **Delegation:** neither generation registers a Pantheon delegation tool —
  both use OpenCode's native `task()`. The former `pantheon_delegate`,
  `pantheon_delegation_read` and `pantheon_delegation_list` tools were removed
  from the V1 plugin.
- **V1:** additionally ships `hashline_edit`, the goal/cost/model tools, the
  BackgroundJobBoard lifecycle, and the hooks explicitly registered for V1.
- **V2:** `plugin-v2` does not register the BackgroundJobBoard, V1 event/tool
  hooks, or a Pantheon compaction hook. Native OpenCode `task()` is a host
  capability, not a V2 Pantheon API.
- **TUI:** native tasks may be followed only when OpenCode exposes explicit
  origin, parent/child and status metadata. A missing Markdown report is not
  enough to classify a child as native.
- **Reports:** `.pantheon/delegations/` Markdown reports are historical V1
  delegate/board output. They are not a V2 task protocol and are not converted
  automatically.
- **Recovery:** V1 compaction carry-forward is available only through its
  implemented `experimental.session.compacting` path. On restart, old/running
  V1 board jobs are marked errored; they are not auto-resumed and child work is
  not restarted automatically. V2 adds no automatic resume/restart behavior.

Do not describe this upgrade as a V1-to-V2 feature-parity migration. It is a
choice between a legacy runtime plugin and a narrower configuration adapter.

## Historical upgrade notes (superseded)

The following notes describe older releases and are retained for historical
reference. They are not the active 1.5.0 installation contract.

### Upgrading to v1.0 (OpenCode-only)

v1.0 removes all multi-platform support. Pantheon now runs exclusively on OpenCode.

### Breaking Changes
1. **No longer supports**: Claude Code, Cursor, Windsurf, Cline, Continue.dev, VS Code Copilot
2. **Installation changed**: Use `npx pantheon-opencode init` instead of per-platform scripts
3. **Background delegation**: Requires `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`
4. **OpenCode-only**: Multi-platform support removed. Use `npx pantheon-opencode init` for setup.

### Migration Steps
1. Uninstall old platform-specific configs
2. Run `npx pantheon-opencode init` to install agents globally
3. Run `npm run setup` for MCP servers + skills + TUI
4. Add `export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` to your shell profile

### Rollback
For a rollback, use the previous Pantheon release tag that matches your deployment.


### Historical: upgrading to v3.19.0

> **Historical:** These notes are preserved for users upgrading from legacy versions.
> New installations should follow [INSTALLATION.md](INSTALLATION.md).

### Memory Persistence Protocol
Pantheon v3.19.0 introduces the Memory Persistence Protocol — a standardized system for how agents persist and recall memory.

Key changes:
- All 14 agent files now have a `## 🧠 Memory Protocol` section with mandatory rules
- Agents must call `memory_recall()` before work (top_k=3, skip if score <0.3)
- Agents must call `memory_store()` after work (2 lines max, importance 0.4-0.9)
- Zeus auto-stores on agent return — no extra work needed
- Session-end auto-save runs at session close
- Memory Bank is updated only at sprint close (importance ≥ 0.6 graduates)

**No manual migration needed.** The protocol is enforced at the agent instruction level.

### Previous historical upgrades

For upgrading from versions before v3.19.0, see the CHANGELOG for version-specific changes.
