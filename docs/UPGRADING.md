# Upgrading Pantheon — 1.5.0

## Upgrading to v1.5.0

Pantheon 1.5.0 formalizes two exclusive OpenCode plugin contracts. Before
upgrading, choose the contract that matches the OpenCode host you will run:

| Selector | Config key | Pantheon entry | Scope |
|---|---|---|---|
| `v1` | singular `plugin` | `src/plugin.ts` and the V1 `src/plugins/pantheon-hooks.ts` | Legacy Pantheon delegate tools, board lifecycle, V1 hooks and implemented compaction path |
| `v2` | plural `plugins` | `pantheon-opencode/plugin-v2` | Configuration adapter for agent/catalog/command/reference/skill drafts; no V1 runtime APIs |

The installer removes Pantheon entries from both config shapes and writes only
the selected generation. It does not mix `src/plugin.ts` or
`src/plugins/pantheon-hooks.ts` with `pantheon-opencode/plugin-v2`; unrelated
third-party entries are retained and are not converted.

```bash
# Pick one contract for this OpenCode configuration
npx pantheon-opencode init --opencode-version v1
npx pantheon-opencode init --opencode-version v2

# Conservative selector: explicit OPENCODE_VERSION wins; otherwise
# OPENCODE_BIN ending in opencode2 selects V2, and all other cases select V1.
npx pantheon-opencode init --opencode-version auto
```

`--version v1|v2` remains accepted after `init` as the legacy spelling; use
`--opencode-version auto` for the conservative selector.
`auto` is not general platform autodetection and never installs both Pantheon
plugin generations.

### Migration checklist

1. Stop OpenCode before changing the plugin generation.
2. Run `init` once with the desired selector (`v1`, `v2`, or `auto`). Do not
   copy a V1 plugin entry into a V2 `plugins` list, or vice versa.
3. If the TUI is wanted, include the installer `plugins` component. The TUI is
   a separate `tui.json` registration; installing V2 does not imply that the
   TUI or V1 runtime is loaded.
4. Inspect the result: V1 Pantheon entries belong in `plugin`; the V2 Pantheon
   entry is `pantheon-opencode/plugin-v2` in `plugins`.
5. Restart OpenCode after changing configuration. This restart reloads the
   selected plugin; it is not an automatic resume of delegated work.

### Runtime differences after the upgrade

- **V1:** `pantheon_delegate`, `pantheon_delegation_read` and
  `pantheon_delegation_list` remain available, together with the V1 board and
  the hooks explicitly registered for V1.
- **V2:** `plugin-v2` does not register those tools, the BackgroundJobBoard,
  V1 event/tool hooks, or a Pantheon compaction hook. Native OpenCode `task()`
  is a host capability, not a V2 Pantheon delegate API.
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
Pantheon v4.x remains available on the v4.x branch if you need multi-platform support.


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
