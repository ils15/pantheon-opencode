# Pantheon Code Mode Scripts

Orchestration scripts executed via the `pantheon-code-mode` MCP server
(`execute_code_script`). All scripts live in this directory.

## Script Index

| Script | Language | Purpose |
|--------|----------|---------|
| `checkpoint_session.py` | Python | Full checkpoint management: init, save, status, resume, list, health, archive, cleanup |
| `checkpoint-session.sh` | Bash | Shell wrapper for `checkpoint_session.py` |
| `compress-inline.py` | Python | Inline context compression — score, compress, stats, batch modes |
| `session-end-save.py` | Python | Session-end Vector DB backup scaffold |
| `session-end-save.sh` | Bash | Shell wrapper for `session-end-save.py` |
| `example-sync.sh` | Bash | Minimal demo script for testing `execute_code_script` |

## checkpoint_session.py Commands

| Command | Description |
|---------|-------------|
| `init <slug>` | Create session.json and heartbeat.json |
| `save <slug>` | Save checkpoint + update heartbeat |
| `status <slug>` | Show human-readable session status |
| `resume <slug>` | Print latest checkpoint as JSON |
| `list <slug>` | List all checkpoints for a slug |
| `health <slug>` | Validate session consistency (required fields, checkpoint integrity, stale detection) |
| `archive <slug>` | Move session to `.pantheon/deepwork/archive/<slug>/` |
| `cleanup [--dry-run]` | Remove orphan directories, temp files, flag stale sessions |

## Invocation

From an agent prompt, call via the MCP tool:

```
execute_code_script("checkpoint-session.sh", args=["init", "my-task"])
```

Or directly for cleanup (which doesn't need `checkpoint-session.sh`):

```
execute_code_script("checkpoint_session.py", args=["cleanup", "--dry-run"])
```

All scripts are idempotent unless noted otherwise.

## Script Metadata (YAML Frontmatter)

Scripts may declare optional metadata in a comment-style YAML frontmatter
block at the top of the file (after the shebang). Comment lines keep the
script a valid executable in both bash and python:

```python
#!/usr/bin/env python3
# ---
# description: Runs the checkpoint save
# timeout: 5
# allowed_args:
#   - compress
#   - --text
# ---
import sys
...
```

Supported keys:

| Key | Type | Purpose |
|-----|------|---------|
| `description` | string | Human-readable purpose, surfaced in tool output metadata |
| `timeout` | int (seconds) | Per-script execution timeout override (default 30s). The subprocess is killed when it elapses. |
| `allowed_args` | list of strings | Allowlist of CLI args accepted by `execute_code_script`. Passing an unlisted arg is rejected before execution. Omit for unrestricted args. |

Metadata is exposed in two places:

- `execute_code_script(..., json_output=true)` returns a structured dict with
  `stdout`, `stderr`, `exit_code`, `duration_ms`, `timed_out`, `timeout_s`
  and `metadata` (the parsed frontmatter).
- `pantheon://code-mode/scripts/{name}` resource prepends a `# metadata`
  section when frontmatter is present.

Malformed or missing frontmatter fails open: the script executes with the
30s default timeout and no arg restriction.

## Conventions

- **Wrapper pattern**: `.sh` files are thin wrappers that pass `$@` to a
  `.py` implementation. This keeps CLI ergonomics (shell-native `--flags`)
  while keeping logic in Python where it's more reliable.
- **Exit codes**: 0 = success / no issues, 1 = action taken (recovery
  dispatched, etc.), 2+ = error.
- **Paths**: Scripts resolve their own directory at runtime; never hardcode.
- **Output**: Artifacts go under `.pantheon/memory-bank/.tmp/` (gitignored).
  See `skill: artifact-management`.
