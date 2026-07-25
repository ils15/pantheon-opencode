---
name: worktrees
description: Git worktrees as safe, isolated coding lanes for risky or parallel work without affecting the main workspace
---

# Worktrees

Use git worktrees to create isolated working directories for parallel or experimental changes.

## When to Use

- Working on 2+ features simultaneously
- Risky refactoring that shouldn't affect the main workspace
- Reviewing a PR while keeping current work intact
- Running long-lived experiments

## Setup

```bash
# Create a worktree
git worktree add ../project-feature-x feature-x

# List worktrees
git worktree list

# Remove a worktree
git worktree remove ../project-feature-x
```

## Workflow

1. Create worktree: `git worktree add ../<name> <branch>`
2. Work in the worktree directory
3. Commit and push from within the worktree
4. Clean up: `git worktree remove ../<name>`
5. Delete branch if no longer needed

## Rules
- Never create worktrees inside the main project directory
- Name worktrees descriptively: `../project-auth-refactor`
- Remove worktrees when done (they consume disk space)
- Worktrees share the same git history — pushing from a worktree is the same as pushing from main
- Escalate to @iris for branch management if unsure
