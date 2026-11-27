# Platforms

Pantheon runs **only** on [OpenCode](https://opencode.ai). Multi-platform
adapters were removed in v1.0; Claude Code, Cursor, Windsurf, Cline,
Continue.dev, and VS Code Copilot are not supported. This page is an overview
and links out. It does not restate the support matrix — that is
[Compatibility](COMPATIBILITY.md).

## Form factors

OpenCode ships as a terminal TUI (`opencode`), a desktop app, and an IDE
extension. All three share the same `opencode.json` (`plugins: ["pantheon-opencode"]`):

- **CLI (TUI) & Desktop App (Shared backend `./server`):** all 8 canonical agents, 26
  skills, 9 slash commands, 31 native TypeScript tools, security/edit guardrails,
  worktree shared `.pantheon/` stores, and GFM/Mermaid artifacts work in both.
- **CLI-only (`./tui`):** the `@opentui/solid` sidebar (`Context`, `Todo`,
  `Dispatch`), `/dispatch`, `/pantheon-settings`, `/pantheon-updates`, and
  `/pantheon-whats-new` run in the terminal TUI only; Desktop uses its own native
  GUI chrome (and renders Markdown/GFM artifacts inline).
- **Windows:** WSL2 (Linux) is the fully supported environment today; native
  `win32` outside WSL2 currently rejects POSIX `getuid`/`0o077` config guards in
  `pantheon_model` / `pantheon_local_decision` and assumes `/bin/bash` in `shell`.

## Install

Use OpenCode's native plugin manager (recommended — zero copied files on disk,
works in any directory) or the optional CLI installer:

```bash
# Recommended (global or project, works anywhere without init)
opencode plugin add pantheon-opencode

# Optional CLI installer (materializes .opencode/ files, AGENTS.md, or legacy MCPs)
npx pantheon-opencode init --project --no-mcp
```

Flags, backup, uninstall, and reconcile are in [Installation](INSTALLATION.md).

## Configuration

OpenCode reads `opencode.json` (or `opencode.jsonc`) from the global config
directory (`~/.config/opencode/`) or project root.

`default_agent: zeus` and `permission.skill` are seeded automatically in-process
by the plugin (or materialized when running `init`). Contributors who keep a
project-level `opencode.json` for their own sessions should leave it untracked.

Agent definitions live in `src/agents/*.md` (loaded natively by the plugin); do
not maintain duplicate manual copies under `.opencode/agents/` unless you
intentionally override an agent locally.

## File locations

Runtime state created on demand in any project or linked worktree (main repo
`.pantheon/` is shared automatically across git worktrees):

```text
your-project/
└── .pantheon/
    ├── memory/memory.db      # FTS5 memory, checkpoints & goals
    ├── codemap/codemap.db    # structural symbol & relation index
    ├── ledger/step-ledger.json
    ├── deepwork/<slug>/PLAN.md
    └── reports/
```

`ledger/step-ledger.json` (`version: 1`) records one entry per step:
`state` is `pending | in_progress | done | blocked | rolled_back`, plus optional
`dependsOn`, `blockedBy`/`cascadeReason`, `verificationAttempts`, `ownedFiles`,
`forbiddenFiles`, and `ephemeral` metadata. `pending` means prerequisites are
still open. A step is *ready* when it is `pending`, declares at least one
dependency, and every dependency is `done`; `pantheon_step_ledger(action="status")`
returns that as `graph.ready` with the parallel launch `waves`. A lock file
(`.pantheon/ledger/.step-ledger.lock`) makes concurrent writers safe — see
[Step dependencies](opencode.md#step-dependencies-and-readiness).

With the recommended `opencode plugin add pantheon-opencode` install, agents,
skills, commands, and the TUI bundle are loaded directly from OpenCode's npm
plugin cache—no redundant copies in `~/.config/opencode/agents/` or
`plugins/pantheon-tui/` are needed. See [OpenCode 2.x](opencode.md).

## Quick reference

| Action | Command |
|---|---|
| Start OpenCode (TUI) | `opencode` |
| Run non-interactively | `opencode run "prompt"` |
| Initialize project rules | `/init` in-session |
| Invoke an agent | `@zeus: implement email verification` |
| List agents | `opencode agent list` |
| List models | `opencode models` |
| Add an MCP server | `opencode mcp add` |
| Add a provider key | `opencode auth login` |
| List sessions | `opencode session list` |
| Token stats | `opencode stats` |

`/init` is OpenCode's built-in project-context generator. It is complementary
to Pantheon: `/init` captures project-level conventions, while Pantheon agents
supply role behavior. If `AGENTS.md` already exists, `/init` improves it in
place.

## ACP (Agent Client Protocol)

OpenCode can run as an ACP-compatible agent for editors such as Zed,
JetBrains, or Neovim. Start the server with `opencode acp`; it communicates over
JSON-RPC on stdio. ACP does not change the selected plugin contract: V1
hook/delegate behavior still depends on V1 host events, and the V2 plugin
remains its own surface. Verify the registration in `opencode.json` before
relying on a feature.

For Zed, add this to `~/.config/zed/settings.json`:

```json
{
  "agent_servers": {
    "OpenCode": {
      "type": "custom",
      "command": "opencode",
      "args": ["acp"]
    }
  }
}
```

`type: "custom"` is the field Zed's settings schema uses for a hand-configured
agent server rather than a built-in one.

## Troubleshooting

| Symptom | Check |
|---|---|
| Agents not showing up | `opencode agent list`; valid YAML frontmatter; correct agents directory |
| Default agent not working | `default_agent` must match an agent with `mode: primary` |
| Model not available | `provider/model` format; `opencode models`; provider key |
| Instructions not loading | Paths are relative to the config file; global and project layers merge |
| MCP server not connecting | `opencode mcp list`; OAuth via `opencode mcp auth <server>` |
| Skills not discovered | `permission.skill` allows the skill; skills are installed |
| Slow responses | Cheaper model for discovery; fewer instruction files |

For MCP-specific failures, see [MCP](MCP.md#troubleshooting). For installer and
driver problems, see [Installation](INSTALLATION.md).

## Dynamic prompts

OpenCode prompt files support `{file:path}` interpolation. Pantheon's
`/pantheon` council prompt uses that to build a dynamic, per-run prompt. The
generation script and its limits are described in the prompt file itself
(`prompts/`); static prompt templates remain the default for the other
commands.
