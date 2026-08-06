#!/usr/bin/env bash
# log-session-start.sh — Pantheon SessionStart Logging Hook
# Logs session start with structured JSON.
set -euo pipefail

# Project-local by default; set XDG_STATE_HOME for system-wide logging
if [ -n "${LOG_DIR:-}" ]; then
    LOG_DIR="$LOG_DIR"
elif [ -n "${XDG_STATE_HOME:-}" ]; then
    LOG_DIR="$XDG_STATE_HOME/pantheon/hooks"
else
    LOG_DIR="logs/agent-sessions"
fi
mkdir -p "$LOG_DIR"

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SESSION_ID="${SESSION_ID:-$(date +%s)}"

# P2 (2026-08-06): platform was hardcoded 'unknown' — derive it from env
# (OSTYPE) or detect via uname, with a clean 'linux' default. Never 'unknown'
# on a supported OS.
detect_platform() {
    case "${OSTYPE:-}" in
        linux*) echo "linux" && return ;;
        darwin*) echo "darwin" && return ;;
        msys* | mingw* | cygwin*) echo "windows" && return ;;
    esac
    case "$(uname -s 2>/dev/null)" in
        Linux) echo "linux" ;;
        Darwin) echo "darwin" ;;
        MINGW* | MSYS* | CYGWIN*) echo "windows" ;;
        *) echo "linux" ;;
    esac
}
PLATFORM="${PLATFORM:-$(detect_platform)}"

cat >> "$LOG_DIR/sessions.log" << JSON
{"event":"SessionStart","timestamp":"$TIMESTAMP","session_id":"$SESSION_ID","platform":"$PLATFORM"}
JSON

echo "[LOG] Session start logged → $LOG_DIR/sessions.log" >&2
exit 0
