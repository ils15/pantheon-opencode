# Upgrading Pantheon

[Português (Brasil)](UPGRADING.pt-BR.md)


## Upgrading to v1.0 (OpenCode-only)

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


## Upgrading to v3.19.0

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

### Previous Upgrades

For upgrading from versions before v3.19.0, see the CHANGELOG for version-specific changes.
