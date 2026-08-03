# Pantheon MCP Servers

Pantheon provides 5 built-in MCP (Model Context Protocol) servers that enhance
AI agent capabilities with persistent memory, resource discovery, vision, and
confined script execution. All five are local Python stdio servers that
auto-start with OpenCode.

---

## Server Comparison

| Server | Tools | Resources | Purpose |
|--------|-------|-----------|---------|
| **pantheon-resources** | — | 3 static + 5 templates | Agent discovery, skills, routing, deepwork plans, memory-bank |
| **pantheon-code-mode** | 1 | 1 static + 1 template | Confined script execution from `.pantheon/code-mode/` |
| **pantheon-memory** | 14 | 2 static | Persistent memory with semantic search, recall, knowledge graph |
| **pantheon-persistence** | 6 | — | Namespaced key-value storage with FTS5 search and TTL |
| **pantheon-vision** | 3 | — | Image description, OCR, and structured analysis through OpenCode |

---

## Quick Start

Add to your platform config (e.g., `opencode.json` or `.mcp.json`):

```json
{
  "mcpServers": {
    "pantheon-resources": {
      "command": "python3",
      "args": ["scripts/mcp_resources_server.py"]
    },
    "pantheon-code-mode": {
      "command": "python3",
      "args": ["scripts/code_mode_server.py"]
    },
    "pantheon-memory": {
      "command": "python3",
      "args": ["scripts/memory_mcp_server.py"]
    },
    "pantheon-persistence": {
      "command": "python3",
      "args": ["scripts/mcp_persistence_server.py"]
    },
    "pantheon-vision": {
      "command": "python3",
      "args": ["src/mcp/pantheon_vision_server.py"]
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

---

## pantheon-resources

**Script:** `scripts/mcp_resources_server.py`

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

**Script:** `scripts/code_mode_server.py`

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

**Script:** `scripts/memory_mcp_server.py`

Persistent, lightweight memory server using sqlite-vec + fastembed
(BAAI/bge-small-en-v1.5) for local embeddings (~30MB, ONNX, no PyTorch). Provides 14 tools and 2 resources.

### Tools (14)

| Tool | Description |
|------|-------------|
| `memory_store` | Store a memory entry with metadata (category, agent, session, importance, links) |
| `memory_search` | Search with dense vector similarity + freshness decay + importance boost |
| `memory_recall` | Auto-recall: context → relevant memories as formatted prompt injection |
| `memory_compress` | Compress oldest entries into summarized form (DCP-style range compression) |
| `memory_expand` | Restore a compressed entry back to detailed form |
| `memory_consolidate` | Merge duplicate/similar entries (cosine similarity threshold) |
| `memory_delete` | Permanently delete a specific memory entry by ID |
| `memory_update` | Update content and/or metadata of an existing entry |
| `memory_link` | Create a bidirectional relationship between two entries |
| `memory_traverse` | Walk the knowledge graph from an entry, following links up to max_depth |
| `memory_verify` | Verify a claim: check entry exists and validate freshness |
| `memory_sessions` | List all unique session IDs with entry count and latest timestamp |
| `memory_export` | Export memories as formatted markdown, optionally scoped to a session |
| `memory_cleanup` | Delete test/old sessions (prefix minimum 3 characters) |

### Resources

| URI | Description |
|-----|-------------|
| `pantheon://memory/sessions` | List all sessions with entry counts and timestamps |
| `pantheon://memory/status` | Memory server statistics: total entries, session count, disk usage |

### Tech Stack

| Component | Implementation |
|-----------|---------------|
| Vector DB | sqlite-vec (SQLite vector extension) → `~/.pantheon/memory/memory.db` |
| Embeddings | `fastembed` (ONNX, BAAI/bge-small-en-v1.5, ~30MB, auto-download) |
| Freshness decay | 30-day half-life (exponential, Shokunin-inspired) |
| Compression | DCP-style range compression (deterministic, not LLM-based) |
| Fusion scoring | Dense similarity + freshness boost + importance boost |

### Full Documentation

See `docs/MEMORY.md` for complete usage guide with examples for all 14 tools.

---

## pantheon-persistence

**Script:** `scripts/mcp_persistence_server.py`

Namespaced local key-value storage with FTS5 search, TTL expiration, and scope
isolation. See `docs/persistence-mcp.md` for the complete tool reference.

---

## pantheon-vision

**Canonical source:** `src/mcp/pantheon_vision_server.py`

Lightweight image MCP server. The installer deploys a runtime copy under
`scripts/pantheon_vision_server.py` from the canonical source; do not maintain
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
| Link related memories into a graph | pantheon-memory |
| Auto-recall context at session start | pantheon-memory |
| Export session memories as markdown | pantheon-memory |
| Describe, OCR, or analyze an image | pantheon-vision |

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Server not found | Not in MCP config | Add to `opencode.json` → `mcp` or `.mcp.json` |
| Connection refused | Python env issue | Verify `python3` has required deps (`fastembed`, `fastmcp`) |
| `memory_recall` returns empty | No entries stored yet | First call `memory_store` with some content |
| Code-mode script not found | Wrong path | Script must be in `.pantheon/code-mode/` |
| Vision server not connecting | Runtime script or Python dependency issue | Run `npm run setup`, then `npm run doctor` |
| Path traversal error | Invalid URI segment | Use flat filenames for `pantheon://memory-bank/{path}` (no nested `../`) |
