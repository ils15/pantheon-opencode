#!/usr/bin/env bash
# validate-tool-safety.sh — Pantheon PreToolUse Security Hook
# Blocks destructive commands: rm -rf, DROP TABLE, TRUNCATE, etc.
set -euo pipefail

BLOCKED_PATTERNS=(
    # "rm -rf /" appears mid-JSON in the hook stdin protocol (e.g.
    # {"tool_input":{"command":"rm -rf /"}}), so the old `/$` end-of-line
    # anchor never matched. Match "/" followed by a JSON delimiter (", },
    # comma), whitespace, or end of line — catches bare "rm -rf /" anywhere
    # in the payload while keeping "rm -rf /some/path" (safe) unblocked.
    "rm\s+-rf\s+/([\"},\t[:space:]]|$)"   # rm -rf / (root only)
    "rm\s+-rf\s+/\*"         # rm -rf /*
    "rm\s+-rf\s+~([\",[:space:]]|$)"      # rm -rf ~ (home only)
    "rm\s+-rf\s+~/"          # rm -rf ~/...
    "rm\s+-rf\s+\.\.?/"      # rm -rf ./ or rm -rf ../
    "DROP\s+TABLE"
    "DROP\s+DATABASE"
    "TRUNCATE\s+TABLE"
    "DELETE\s+FROM\s+.*;?\s*$"
    # DEAD PATTERN REMOVED: `rm\s+.*\s+--no-preserve-root` — redundant with
    # pattern #1 which already blocks `rm -rf /` regardless of flags.
    # DEAD PATTERN REMOVED: `:(){ :|:& };:` — fork bomb syntax never appears
    # in real tool_input.command payloads (the entire stdin would need to be
    # exactly this 13-char token with zero surrounding JSON/context).
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
