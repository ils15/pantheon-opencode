# MCP Servers

Pantheon ships five local Python stdio MCP servers. They auto-start with
OpenCode and cover project memory, persistence, resources, confined script
execution, and vision. This page owns MCP setup, entrypoints, allowlists, and
pins. Tool signatures live in [MCP Tools](mcp-tools.md); memory policy lives in
[Memory](MEMORY.md).

## Runtime pins

The packaged runtime pins the MCP Python SDK to `mcp==2.2.0` and the standalone
FastMCP server framework to `fastmcp==4.0.10`. Server code imports `FastMCP`
from `fastmcp`; MCP SDK v2 removed the old `mcp.server.fastmcp` re-export.
Installation creates the isolated Python environment from the matching manifest
in `src/mcp/`.

## Entrypoints

The installer declares the five servers in `scripts/install-mcp.mjs:74-78` and
registers them at `:196-301`. Each entrypoint is a real script, not a shared
`server.py`:

| Server | Entrypoint | Tools | Resources |
|---|---|---|---|
| `pantheon-resources` | `scripts/mcp_resources.py` | — | 4 static + 6 templates |
| `pantheon-code-mode` | `scripts/code_mode.py` | 2 | 1 static + 1 template |
| `pantheon-memory` | `scripts/memory_mcp.py` | 9 | — |
| `pantheon-persistence` | `scripts/mcp_persistence.py` | 6 | — |
| `pantheon-vision` | `src/mcp/pantheon_vision.py` | 3 | — |

The entrypoints were renamed away from the shared `*_server.py` token. The
installer heals stale paths with the mapping in
`scripts/install/config-migration.mjs:700-706`:

| Old | New |
|---|---|
| `mcp_resources_server.py` | `mcp_resources.py` |
| `code_mode_server.py` | `code_mode.py` |
| `memory_mcp_server.py` | `memory_mcp.py` |
| `mcp_persistence_server.py` | `mcp_persistence.py` |
| `pantheon_vision_server.py` | `pantheon_vision.py` |

Installation writes absolute paths for the venv interpreter and the server
script. `pantheon-memory` uses `src/mcp/memory_mcp.py` as its canonical runtime
source; `scripts/memory_mcp.py` is a source-tree compatibility entrypoint that
delegates to it. `pantheon-vision` is deployed from the canonical source to
`scripts/pantheon_vision.py`; do not maintain a second source copy.

## OpenCode configuration

The installer writes this shape. Add the same shape by hand only for a custom
server.

```json
{
  "mcp": {
    "pantheon-resources": {
      "type": "local",
      "command": ["<venv-python>", "<installed>/scripts/mcp_resources.py"],
      "enabled": true
    },
    "pantheon-code-mode": {
      "type": "local",
      "command": ["<venv-python>", "<installed>/scripts/code_mode.py"],
      "cwd": ".",
      "enabled": true
    }
  }
}
```

Restart the client after changing MCP configuration. Servers are separate OS
processes launched by the host.

## Per-agent allowlists

The installer reads `mcp_tools` from each canonical `src/agents/*.md` file and
generates native per-agent permissions. For each Pantheon server it denies the
wildcard first, then allows the declared tools. Undeclared Pantheon servers
default to deny; unrelated user MCP servers are untouched.

| Agent | Resources | Code-mode | Memory | Persistence | Vision |
|---|---|---|---|---|---|
| **zeus** | all | — | search | context_save, context_get, goal_create, goal_get, goal_update, goal_done | — |
| **athena** | all | — | search, code_query, code_neighbors | — | — |
| **apollo** | all | — | search, code_query, code_neighbors | — | — |
| **hermes** | all | execute script | search | — | — |
| **aphrodite** | all | execute script | search | — | describe/OCR/analyze |
| **demeter** | all | execute script | search | — | — |
| **themis** | all | execute script | search | — | — |
| **prometheus** | all | execute script | search | — | — |
| **hephaestus** | all | execute script | search | — | — |
| **nyx** | all | execute script | search | — | — |
| **gaia** | all | — | recall | — | describe/OCR/analyze |
| **iris** | all | — | recall | — | — |
| **mnemosyne** | all | execute script | explicit memory tools | — | — |
| **talos** | all | execute script | recall | — | — |

Rules:

- `all` allows every tool from that named Pantheon server.
- A list allows only those tool names; an empty list denies every tool there.
- A server omitted from an agent's metadata is denied for that agent.
- Rules are generated into V1 `permission` objects and V2 `permissions` arrays.
- V1 `permission.task` rules translate to V2's native `subagent` action.
- Third-party MCP permissions remain the user's configuration.

On OpenCode 2.x the host evaluates a `permissions` rule whose action is
`<server>_*` (or `<server>_<tool>`) with effect `deny`/`allow`. The V1-shaped
`permission.mcp.<server>` key is not an action the host evaluates; the installer
translates `allow`/`deny` into the former. `ask` is not expressible for MCP on
that host: it hides the tool instead of prompting, so the installer emits no
rule and warns. In V2, per-agent rules can hide tools from that agent without
disconnecting the server.

The Apollo/Athena `code_query` and `code_neighbors` grants are the approved
read-only code-map choice; `code_index` and per-project binding were not
selected. Checkpoints are limited to `context_save` and `context_get` on Zeus;
they are session-qualified temporary persistence, not durable memory writes.
Mnemosyne's canonical allowlist includes durable-memory write tools; always
check the active tool list. These are installed per-agent allowlists, not a
guarantee that the root runtime exposes the same tools.

## pantheon-resources

Read-only resource server exposing Pantheon framework metadata. No tools, only
resources and templates.

| URI | Description |
|---|---|
| `pantheon://routing` | Canonical delegation rules and handoff contracts |
| `pantheon://agents` | All 14 agents with roles from frontmatter |
| `pantheon://skills` | All skills with descriptions |
| `pantheon://eval` | Latest certification scores from the `plugin_eval` namespace |
| `pantheon://agents/{agent_name}` | One agent file by name (case-insensitive) |
| `pantheon://deepwork/{slug}` | `PLAN.md` for a deepwork task |
| `pantheon://deepwork/{slug}/status` | `STATUS.md` for a deepwork task |
| `pantheon://memory-bank/{path}` | One file under `.pantheon/memory-bank/` (path traversal blocked) |
| `pantheon://skills/{name}` | One skill's `SKILL.md` |
| `pantheon://eval/{plugin}` | One certification report |

`pantheon://memory-bank/{path}` reads project documentation on demand; those
files are not automatically loaded. The evaluation resources read the global
Memory SQLite database in the `plugin_eval` namespace, which is an
organizational filter, not an access-control boundary.

## pantheon-code-mode

Confined script execution from `.pantheon/code-mode/`, with a 30-second
timeout. It exposes two tools: `execute_code_script(script_name)` runs an
approved script, and `approve_code_script(script_name)` records or refreshes its
SHA-256 in the manifest. Resources list the available scripts and show one
script's content.

Scripts run only when explicitly approved and recorded in the manifest with
their SHA-256. See [Code Mode](reference/code-mode.md) for the approval
contract and status codes.

## pantheon-memory

Persistent SQLite memory with FTS5/BM25 lexical search. It registers six
`memory_*` tools plus three `code_*` codemap tools; the canonical source is
`src/mcp/memory_mcp.py`. The database defaults to
`~/.config/opencode/memory/memory.db`, with `PANTHEON_HOME` and
`XDG_CONFIG_HOME` overrides.

Tool signatures are in [MCP Tools](mcp-tools.md); the size cap, TTL, search
policy, and error contract are in [Memory](MEMORY.md).

## pantheon-persistence

Session checkpoints plus manual session goals. The surface is exactly six
tools: `context_save`, `context_get`, `goal_create`, `goal_get`, `goal_update`,
and `goal_done`. The KV table is internal checkpoint storage; former KV
management, context list/statistics, rehydration, and summary operations are not
registered.

Goals are Zeus-only and partitioned by OpenCode session id; the session id is a
correlation key, not authentication. See
[Memory](MEMORY.md#manual-session-goals) for permissions, TTL defaults, size
bounds, and migration of an existing database.

## pantheon-vision

Three tools: `vision_describe(path, prompt?, session_id?)`,
`vision_ocr(path, session_id?)`, and `vision_analyze(path, session_id?)`.

`session_id` is the caller's OpenCode session id. The MCP runs in a separate
process the host hands no session id to, so the plugin forwards it; the server
sends it to a Zen endpoint as the required `x-opencode-session` header (never to
a non-Zen host, and never logged).

The server resolves `PANTHEON_OPENCODE_API_KEY` or `OPENCODE_API_KEY`, then the
standard OpenCode auth store. It always talks to the OpenCode Zen endpoints.
Images degrade through native model → this MCP server → deterministic local
extraction; the tool never fabricates content. Bifrost remains opt-in only.

## Adding a custom MCP server

Adding a server to config is only half the work: agents do not auto-discover MCP
tools. Declare them in the agent's canonical file.

**1. Add the server** to `opencode.json` (OpenCode shape):

```json
{
  "mcp": {
    "my-tools": {
      "type": "local",
      "command": ["node", "my-mcp-server.js"],
      "enabled": true
    }
  }
}
```

**2. Declare tools** in the agent's YAML frontmatter:

```yaml
---
name: hermes
mcp_tools:
  my-tools:
    - analyze_dependency
---
```

**3. Document them** in the agent body so the agent knows when to use them:

```markdown
## Custom MCP Tools

| Server | Tool | When to use |
|---|---|---|
| **my-tools** | `analyze_dependency(package, depth?)` | Check a dependency for known vulnerabilities |
```

**4. Set access control.** V1 uses `permission.mcp.<server>`; on V2 use the
native `<server>_*` rule described above. Start with `ask` for a new server and
downgrade to `allow` only after verifying read-only safety.

### Worked example: GitHub MCP over stdio

The installer's own servers use the local shape shown above: `type`, `command`
as an array, optional `environment`, and `enabled`. A hand-added third-party
server takes the same keys, with the provider's documented command:

```json
{
  "mcp": {
    "github": {
      "type": "local",
      "command": [
        "docker",
        "run",
        "-i",
        "--rm",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "ghcr.io/github/github-mcp-server"
      ],
      "environment": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "{env:GITHUB_PERSONAL_ACCESS_TOKEN}"
      },
      "enabled": true
    }
  }
}
```

The GitHub server's documented stdio invocation is:

```bash
docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server
```

`-i` keeps stdin open for JSON-RPC, and the token reaches the container through
the `environment` entry rather than being written into `opencode.json`. If the
image or command differs in your setup, use whatever the provider documents —
only the `type`/`command`/`environment`/`enabled` shape is Pantheon's. Note that
the installer's own catalog configures GitHub as a remote server
(`https://api.githubcopilot.com/mcp/`) with OAuth, so this stdio entry is for the
cases where a local process is preferred; do not declare both under one name.

Best practices: short lowercase server names (they become the tool prefix);
declare only the tools the agent needs; keep the `mcp_tools` key identical to
the server name; interpolate secrets as `{env:VAR}` instead of inlining them;
and prefer three core plus up to four custom servers, because accuracy degrades
beyond seven.

## Killing MCP servers safely

MCP servers are separate OS processes. **Never terminate them with a bare
filename substring.** A broad idiom such as `pkill -f server.py` matches every
process whose command line contains that token. This was observed once as
collateral damage: an external `SIGTERM` on a `server.py` pattern took down 20
processes across four workspaces within 91 ms.

Kill by PID or by port. Find the PID with a full path
(`pgrep -f '/absolute/path/to/memory_mcp.py'`) and `kill <pid>`, or stop the
client that owns it. The entrypoint rename away from `*_server.py` is defense in
depth; the PID/port rule still governs.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Server not found | Not in MCP config | Add it under `mcp` in `opencode.json`, then restart |
| Connection refused | Python environment issue | Run `npm run setup`; verify `fastmcp` is installed |
| `memory_recall` empty | No entries stored | Call `memory_store` first |
| Code-mode script not found | Wrong path | Script must be in `.pantheon/code-mode/` |
| Vision returns metadata only | No gateway credential | Set `PANTHEON_OPENCODE_API_KEY` / `OPENCODE_API_KEY` or run `opencode auth login` |
| Path traversal error | Invalid URI segment | Use flat filenames for `pantheon://memory-bank/{path}` |
| Agent says it lacks a tool | MCP not declared in frontmatter | Add an `mcp_tools:` entry and reinstall |
