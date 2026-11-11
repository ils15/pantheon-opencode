---
description: "Scan, clean, cache, and archive Pantheon project files. Scans for bloat, archives completed deepwork, and cleans workspace artifacts. Usage: /pantheon-optimize"
agent: "zeus"
---
# /pantheon-optimize — Pantheon Project Optimizer

**What:** Multi-mode workspace optimization: archives or cleans completed deepwork sessions from `.pantheon/deepwork/`, prunes stale backups and logs, and reports optimization opportunities.

## CLI Usage (Deterministic, Zero-Token)

You can run the optimizer directly from the terminal without AI token spend:

```bash
pantheon-opencode optimize                  # Dry-run inspection (default)
pantheon-opencode optimize --apply          # Archive completed deepworks and clean old logs
pantheon-opencode optimize --clean --apply  # Permanently remove resolved deepworks
pantheon-opencode optimize --age 5          # Set inactivity threshold (days)
```

## Slash Command Usage

```
/pantheon-optimize                          → Full inspection (preview only)
/pantheon-optimize --archive                → Archive completed deepwork sessions
/pantheon-optimize --clean                  → Delete completed deepwork sessions
```

## Modes

### Deepwork Optimization
Completed or inactive deepwork sessions in `.pantheon/deepwork/<slug>/` are identified by:
1. `REVIEW.md` containing "APPROVED" or "PASS".
2. `STATUS.md` marked "complete".
3. Inactivity exceeding the age threshold (default: 7 days).

### Output

```
Pantheon Optimizer — Workspace Inspection
Target: /path/to/project
Mode: dry-run (preview only)
────────────────────────────────────────────────────────────
Deepwork sessions: 5 total
  Resolvable candidates (4):
    - beta10-jev-uplift (inactive for >7 days)
    - decision-layer-v2 (inactive for >7 days)
    - opencode-v2-dual-migration (inactive for >7 days)
    - v2-cycle (inactive for >7 days)
  Active sessions kept (1):
    - 2.0-jev-uplift (in-progress)
Stale backups: 0 candidates (>14 days, keeping 3 latest)
Stale logs: 0 candidates (>7 days)
────────────────────────────────────────────────────────────
[DRY-RUN] No changes made.
To archive resolved deepworks: pantheon-opencode optimize --apply
To permanently delete resolved deepworks: pantheon-opencode optimize --clean --apply
```
