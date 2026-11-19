---
description: "Interactive specialist forge wizard: auto-detect project stack and scaffold tailored specialists"
agent: zeus
---

Run the interactive Pantheon Agent Forge wizard for the current workspace:

1. Call `pantheon_agent_forge(action="detect_stack")` and `pantheon_agent_forge(action="list")` to inspect detected project manifests (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`), suggested specialists, and existing `.opencode/agents/*.md` files.
2. Use the native `question` tool to ask the user which recommended specialist (or custom domain) they want to scaffold, keeping defaults marked `(Recomendado)`.
3. Upon user confirmation, call `pantheon_agent_forge(action="create", ...)` and summarize the created `.opencode/agents/<name>.md` path and test command.

$ARGUMENTS
