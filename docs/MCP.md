# Pantheon MCP Servers

Pantheon provides 5 built-in MCP (Model Context Protocol) servers that enhance
AI agent capabilities with persistent memory, resource discovery, vision, and
confined script execution. All five are local Python stdio servers that
auto-start with OpenCode.

The packaged runtime pins the MCP Python SDK to `mcp==2.2.0` and the standalone
FastMCP server framework to `fastmcp==4.0.10`. Server code imports `FastMCP`
from `fastmcp`; MCP SDK v2 removed the old `mcp.server.fastmcp` re-export.
Installation creates the isolated Python environment from the appropriate
manifest in `src/mcp/`.

---

## Server Comparison

| Server | Tools | Resources | Purpose |
|--------|-------|-----------|---------|
| **pantheon-resources** | — | 3 static + 5 templates | Agent discovery, skills, routing, deepwork plans, memory-bank |
| **pantheon-code-mode** | 1 | 1 static + 1 template | Confined script execution from `.pantheon/code-mode/` |
| **pantheon-memory** | 9 | 2 static | Persistent memory with FTS5 keyword search, recall, knowledge graph (6 `memory_*` + 3 `code_*`) |
| **pantheon-persistence** | 14 | — | Namespaced key-value storage with FTS5 search and TTL (8 `kv_*`/`purge_*` + 6 `context_*`) |
| **pantheon-vision** | 3 | — | Image description, OCR, and structured analysis through OpenCode |

---

## Quick Start

Add to your platform config (e.g., `opencode.json` or `.mcp.json`):

```json
{
  "mcpServers": {
    "pantheon-resources": {
      "command": "python3",
      "args": ["scripts/mcp_resources.py"]
    },
    "pantheon-code-mode": {
      "command": "python3",
      "args": ["scripts/code_mode.py"]
    },
    "pantheon-memory": {
      "command": "python3",
      "args": ["scripts/memory_mcp.py"]
    },
    "pantheon-persistence": {
      "command": "python3",
      "args": ["scripts/mcp_persistence.py"]
    },
    "pantheon-vision": {
      "command": "python3",
      "args": ["src/mcp/pantheon_vision.py"]
    }
  }
}
```

Restart your MCP client. The servers auto-start and connect.

### Permission Tiers

In `opencode.json`, set auto-approve levels:

```json
"permission": {
  "mcp": {
    "pantheon-resources": "allow",
    "pantheon-code-mode": "ask",
    "pantheon-memory": "allow",
    "pantheon-persistence": "allow",
    "pantheon-vision": "ask"
  }
}
```

- **pantheon-resources** → `allow` (read-only, same trust boundary as repo)
- **pantheon-code-mode** → `ask` (script execution needs explicit confirmation)
- **pantheon-memory** → `allow` (read/write within agent sandbox)
- **pantheon-persistence** → `allow` (namespaced local key-value storage)
- **pantheon-vision** → `ask` (sends image data or URLs to the configured vision gateway)

The installer also reads each canonical agent's `mcp_tools` frontmatter and
writes native per-agent tool rules for both OpenCode generations. It denies
undeclared tools from Pantheon's five MCP servers, then allows only the listed
tools; unrelated user MCP servers are left alone. OpenCode V2 can hide those
tools from an agent while keeping the MCP server connected. See the
[per-agent MCP reference](AGENT-MCP.md) for the current allowlists.

---

## pantheon-resources

**Script:** `scripts/mcp_resources.py`

Read-only resource server exposing Pantheon framework metadata. No tools, only
resources and resource templates accessible via `pantheon://` URIs.

### Static Resources

| URI | Description |
|-----|-------------|
| `pantheon://routing` | Full content of `routing.yml` — canonical delegation rules, handoff contracts, agent registry |
| `pantheon://agents` | List of all 14 Pantheon agents with roles from YAML frontmatter |
| `pantheon://skills` | List of all Pantheon skills with descriptions |

### Resource Templates (Parameterized URIs)

| URI Template | Description |
|-------------|-------------|
| `pantheon://agents/{agent_name}` | Content of a single agent file by name (case-insensitive) |
| `pantheon://deepwork/{slug}` | `PLAN.md` content for a deepwork task slug |
| `pantheon://deepwork/{slug}/status` | `STATUS.md` content for a deepwork task (or default IN_PROGRESS) |
| `pantheon://memory-bank/{path}` | Content of a file within `.pantheon/memory-bank/` by relative path (path traversal blocked) |
| `pantheon://skills/{name}` | Content of a skill's `SKILL.md` file by name |

### Usage

```python
# Read via MCP resource URI
read_mcp_resource(server="pantheon-resources", uri="pantheon://agents")
read_mcp_resource(server="pantheon-resources", uri="pantheon://routing")
read_mcp_resource(server="pantheon-resources", uri="pantheon://skills/hermes")
```

### Good For

- Discovering which agents exist and their roles
- Reading routing/delegation rules during orchestration
- Loading skill instructions on demand
- Checking deepwork plan status
- Reading memory-bank files by path

---

## pantheon-code-mode

**Script:** `scripts/code_mode.py`

Confined script execution server. Runs `.sh` and `.py` scripts from
`.pantheon/code-mode/` with a 30-second timeout.

### Tool

| Tool | Description |
|------|-------------|
| `execute_code_script(script_name)` | Execute a script from `.pantheon/code-mode/` and return output |

### Resources

| URI | Description |
|-----|-------------|
| `pantheon://code-mode/scripts` | List all available code-mode scripts |
| `pantheon://code-mode/scripts/{name}` | View script content by name |

### Security Rules

- Only `.sh` and `.py` files are allowed
- Scripts must live in `.pantheon/code-mode/`
- 30-second execution timeout
- Permission tier set to `ask` (requires user confirmation)
- Path traversal outside `.pantheon/code-mode/` is blocked

### How to Create a Script

Create a `.sh` or `.py` file in `.pantheon/code-mode/`:

```bash
#!/bin/bash
# .pantheon/code-mode/deploy.sh
echo "Deploying..."
npm run build
```

Then run it from an agent:

```
execute_code_script("deploy.sh")
```

### Usage by Agent

| Agent | Use Case |
|-------|----------|
| **zeus** | Automated orchestration sequences (build → test → deploy) |
| **prometheus** | Docker builds, CI/CD pipelines, deployment scripts |
| **hermes** | Test runner, lint automation |
| **talos** | Hotfix automation, batch fixes |

---

## pantheon-memory

**Script:** `scripts/memory_mcp.py`

Persistent, lightweight memory server using **SQLite FTS5 (BM25)** for lexical
keyword search. No embedding model and no vector index: recall is purely
lexical, so a query must share a token with the stored text to match it.
Provides 9 tools (6 `memory_*` plus 3 `code_*`) and 2 resources.

### Tools (9)

| Tool | Description |
|------|-------------|
| `memory_store` | Store a memory entry (FTS5 index updated by trigger) |
| `memory_search` | FTS5 BM25 keyword search; stopwords dropped, terms of 4+ chars prefix-matched; optional `decay_days` freshness half-life (default off) |
| `memory_recall` | Exact recall of an entry by key within a namespace |
| `memory_forget` | Delete an entry by ID or key (FTS index cleaned via trigger) |
| `memory_list` | List entries chronologically with namespace and key-prefix filters |
| `memory_stats` | Database statistics: totals, namespaces, disk usage |
| `code_index` | Index codebase files into a knowledge graph (hash-based skip) |
| `code_query` | Search code entities via FTS5 |
| `code_neighbors` | Graph neighbors of a code entity (BFS depth 1-3) |

### Resources

| URI | Description |
|-----|-------------|
| `pantheon://memory/sessions` | List all sessions with entry counts and timestamps |
| `pantheon://memory/status` | Memory server statistics: total entries, session count, disk usage |

### Tech Stack

| Component | Implementation |
|-----------|---------------|
| Database | SQLite (stdlib) + FTS5 → `~/.pantheon/memory/memory.db` |
| Search | FTS5 BM25 ranking, no external dependency |
| Freshness decay | Opt-in via `decay_days` on `memory_search` (30-day half-life, default off) |
| Ranking | BM25 relevance, optionally multiplied by the freshness factor |

### Full Documentation

See [MCP tools](mcp-tools.md) for the full tool catalog and [Memory](MEMORY.md)
for the usage policy and store boundaries.

---

## pantheon-persistence

**Script:** `scripts/mcp_persistence.py`

Namespaced local key-value storage with FTS5 search, TTL expiration, and scope
isolation. See `docs/persistence-mcp.md` for the complete tool reference.

---

## pantheon-vision

**Canonical source:** `src/mcp/pantheon_vision.py`

Lightweight image MCP server. The installer deploys a runtime copy under
`scripts/pantheon_vision.py` from the canonical source; do not maintain
a second source copy under `scripts/`.

### Tools

| Tool | Description |
|------|-------------|
| `vision_describe(path, prompt?)` | Describe image content, text, layout, and objects |
| `vision_ocr(path)` | Extract visible text |
| `vision_analyze(path)` | Return metadata, description, and OCR as JSON |

The server resolves `PANTHEON_OPENCODE_API_KEY` or `OPENCODE_API_KEY`, then the
standard OpenCode auth store. The plugin uses native vision as a fast-path and
injects this MCP when native vision is unavailable. Bifrost is opt-in only via
`PANTHEON_VISION_TOOL` or an explicit `imageAnalysisTool` configuration.

---

## When to Use Which Server

| Need | Server |
|------|--------|
| Read routing.yml, agent list, skill files | pantheon-resources |
| Check deepwork plan or status | pantheon-resources (`pantheon://deepwork/{slug}`) |
| Read memory-bank files | pantheon-resources (`pantheon://memory-bank/{path}`) |
| Run a shell/Python script safely | pantheon-code-mode |
| Store an important fact across sessions | pantheon-memory |
| Find relevant past decisions | pantheon-memory |
| Recall a memory by key | pantheon-memory |
| Describe, OCR, or analyze an image | pantheon-vision |

---

## Killing MCP Servers Safely

MCP servers are separate OS processes launched by the client. **Never terminate
them with a bare filename substring** — a broad idiom such as
`pkill -f server.py` matches every process whose command line contains that
token, not just the one you meant. This was observed once as collateral damage:
an external `SIGTERM` on a `server.py` pattern took down the whole MCP fleet
(20 processes across 4 workspaces) within a 91 ms window.

**Kill by PID or by port, never by a bare filename substring.** To stop a
specific server, find its PID (`pgrep -f '/absolute/path/to/memory_mcp.py'`,
matching the full path) and `kill <pid>` it, or stop the client that owns it.
A full-path pattern is anchored to the server you mean; a bare `server.py` is
not.

The five entrypoints were also renamed away from the shared `*_server.py`
token (`mcp_resources.py`, `code_mode.py`, `memory_mcp.py`,
`mcp_persistence.py`, `pantheon_vision.py`) so a broad `server.py` pattern no
longer matches any of them. That is defense in depth — the PID/port rule still
governs how you stop a process.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Server not found | Not in MCP config | Add to `opencode.json` → `mcp` or `.mcp.json` |
| Connection refused | Python env issue | Verify `python3` has required deps (`fastmcp`); memory search needs no extra package beyond the stdlib |
| `memory_recall` returns empty | No entries stored yet | First call `memory_store` with some content |
| Code-mode script not found | Wrong path | Script must be in `.pantheon/code-mode/` |
| Vision server not connecting | Runtime script or Python dependency issue | Run `npm run setup`, then `npm run doctor` |
| Path traversal error | Invalid URI segment | Use flat filenames for `pantheon://memory-bank/{path}` (no nested `../`) |
