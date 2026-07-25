---
description: "Manage git worktrees for isolated parallel work"
agent: zeus
---
# /pantheon-worktree — Git Worktrees

**What:** Create, list, and remove git worktrees for safe isolated parallel work.
**Usage:** `/pantheon-worktree <action> [name]`
**Returns:** Worktree status or confirmation

## Actions
- `create <branch>` — Create worktree for branch
- `list` — List all worktrees
- `remove <name>` — Remove worktree when done

Delegates to @prometheus or @iris with `skill: worktrees`.
