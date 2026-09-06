#!/usr/bin/env bash
# Wrapper for session-end-save.py
# Usage: ./session-end-save.sh [agent_name] [--dry-run]
#
# Persists Vector DB entries to a timestamped backup file in
# .pantheon/memory-bank/.tmp/ with client-side importance filtering.
#
# Arguments:
#   agent_name  — name of the agent triggering the save (default: unknown)
#   --dry-run   — preview without writing

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT="${1:-unknown}"
shift || true

python3 "$SCRIPT_DIR/session-end-save.py" --agent "$AGENT" "$@"
