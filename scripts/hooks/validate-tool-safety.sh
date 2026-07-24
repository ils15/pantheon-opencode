#!/usr/bin/env bash
# validate-tool-safety.sh — Pantheon PreToolUse Security Hook
# Blocks destructive commands: rm -rf, DROP TABLE, TRUNCATE, etc.
set -euo pipefail

BLOCKED_PATTERNS=(
    "rm\s+-rf\s+/$"          # rm -rf / (root only)
    "rm\s+-rf\s+/\*"         # rm -rf /*
    "rm\s+-rf\s+~$"          # rm -rf ~ (home only)
    "rm\s+-rf\s+~/"          # rm -rf ~/...
    "rm\s+-rf\s+\.\.?/"      # rm -rf ./ or rm -rf ../
    "DROP\s+TABLE"
    "DROP\s+DATABASE"
    "TRUNCATE\s+TABLE"
    "DELETE\s+FROM\s+.*;?\s*$"
    "rm\s+.*\s+--no-preserve-root"
    ":(){ :|:& };:"
    ">\s*/dev/\(sd[a-z]\|hd[a-z]\|disk[0-9]*\)"
    "dd\s+if=.*of=/dev/"
    "mkfs\."
    "fdisk\s+/dev/"
)

INPUT="${1:-${TOOL_INPUT:-}}"
if [[ -z "$INPUT" ]] && [[ ! -t 0 ]]; then
    INPUT=$(cat)
fi

if [[ -z "$INPUT" ]]; then
    exit 0
fi

for pattern in "${BLOCKED_PATTERNS[@]}"; do
    if echo "$INPUT" | grep -iqE "$pattern"; then
        echo "[SECURITY BLOCKED] Pattern matched: $pattern" >&2
        echo "[SECURITY BLOCKED] Destructive command detected and blocked by Pantheon hook." >&2
        exit 1
    fi
done

exit 0
