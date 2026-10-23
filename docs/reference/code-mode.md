# Code Mode

Code Mode runs scripts through the `pantheon-code-mode` MCP server
(`execute_code_script`). A script runs only when it is explicitly approved.
Approval is recorded in `.pantheon/code-mode/manifest.json` with the SHA-256 of
each script:

```json
{
  "version": 1,
  "scripts": {
    "example-sync.sh": "<sha256>"
  }
}
```

## Approval rules

- **No manifest → nothing executes.** A missing manifest returns
  `INVALID_STATE`; scripts are never run implicitly.
- **Not listed → `CONFLICT`.** The script must be approved first.
- **Hash mismatch → `CORRUPT_DATA`.** The SHA-256 of the file on disk must match
  the manifest entry, so edits after approval are detected.

Approve or re-approve a script with the `approve_code_script` MCP tool:

```text
approve_code_script("checkpoint-session.sh")
```

The installer seeds the manifest with the SHA-256 of every bundled script, so
shipped scripts stay approved across installs. Re-run `approve_code_script`
after intentionally editing a script.

Only `.sh` and `.py` files are allowed. Execution has a 30-second timeout, and
path traversal outside the code-mode directory is blocked.

## Resolution

Code Mode resolves project-first: `.opencode/.pantheon/code-mode` is preferred,
then `.pantheon/code-mode`. `PANTHEON_PROJECT` overrides the working directory,
and the installed MCP uses `cwd: "."` so OpenCode supplies the workspace. A
global directory is used only when no usable project directory is available.
Once a project directory is selected, a missing or corrupt manifest fails closed
instead of falling back. `doctor` validates the manifest and every script's
SHA-256 without regenerating it.

## Status codes

Results use the shared nine-code contract: `OK`, `UNSUPPORTED`, `UNAVAILABLE`,
`INVALID_INPUT`, `INVALID_STATE`, `CONFLICT`, `CORRUPT_DATA`, `TIMEOUT`,
`ESCALATE`. With `json_output=true`, results carry a `status` field.

## Persistence is separate

Session persistence is provided by the Persistence MCP server. The bundled
code-mode payload contains execution helpers only and does not export or back up
a database. See [Memory](../MEMORY.md#persistence-checkpoints).

## Development assets

The local `.pantheon/code-mode/eval-*.py` helpers and any Promptfoo/evaluation
assets are development-only inputs. They are excluded from the npm tarball and
from the runtime manifest. `src/mcp/eval_store.py` is different: it is a shipped
runtime dependency of the MCP resources server, not an evaluation asset, so it
remains packaged.

Server setup and the tool reference are in [MCP](../MCP.md) and
[MCP Tools](../mcp-tools.md).
