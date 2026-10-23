# Platforms

Pantheon runs **only** on [OpenCode](https://opencode.ai). Multi-platform
adapters were removed in v1.0; Claude Code, Cursor, Windsurf, Cline,
Continue.dev, and VS Code Copilot are not supported. This page is an overview
and links out. It does not restate the support matrix — that is
[Compatibility](COMPATIBILITY.md).

## Form factors

OpenCode ships as a terminal TUI, a desktop app, and an IDE extension. Pantheon's
agents, skills, and instructions are discovered from the project directory the
same way in each. The desktop app adds integrated diffs, file-tree browsing, and
native notifications; it is not a separate installation model.

## Install

Use the installer, not manual copying:

```bash
npx pantheon-opencode init            # global
npx pantheon-opencode init --project  # project-local
```

The installer registers Pantheon's runtime integrations automatically. It
writes the singular `plugin` key for OpenCode V1 and the plural `plugins` key
for OpenCode V2; do not add either key by hand. Flags, backup, uninstall, and
reconcile are in [Installation](INSTALLATION.md).

## Configuration

OpenCode reads `opencode.json` (or `opencode.jsonc`) from the project root. The
installer writes `opencode.json`; a V2 host may also merge a sibling
`.jsonc` — see
[Compatibility](COMPATIBILITY.md#config-registration-and-the-hosts-config-merge).

`default_agent: zeus` and `permission.skill` are seeded by the installer, not
shipped as a template file. The published package carries no `opencode.json`
template. Contributors who keep a project-level config for their own sessions
should leave it untracked.

Agent definitions live in `src/agents/*.md`; the installer copies them into the
selected config tree. Editing an installed copy does not persist — the next
`init` overwrites it. Edit the canonical source instead.

## File locations

Project install:

```text
your-project/
├── opencode.json
├── AGENTS.md
├── .opencode/agents/
├── .opencode/skills/
├── .opencode/instructions/
├── .opencode/prompts/
└── .pantheon/
```

Global install:

```text
~/.config/opencode/
├── opencode.json
├── AGENTS.md
├── agents/
├── skills/
├── instructions/
├── scripts/          # installed MCP entrypoints
└── tui.json          # V1 TUI registration
```

The V2 TUI uses a local plugin directory instead of `tui.json`. See
[OpenCode V2](opencode-v2.md).

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
