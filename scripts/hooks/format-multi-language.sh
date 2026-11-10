#!/usr/bin/env bash
# format-multi-language.sh — Pantheon PostToolUse Formatting Hook
# Runs appropriate formatter on the modified file.
# Supports both Claude Code stdin protocol and legacy env-var input.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"

# ── Claude Code stdin protocol ──────────────────────────────────────────
# Parse JSON from stdin when piped (PostToolUse hook format).
# Extracts file_path from Edit/Write or file paths from Bash commands.
if [ -p /dev/stdin ]; then
  STDIN_JSON=$(cat)
  EXTRACTED_PATH=$(python3 -c "
import sys, json, re, shlex
try:
    d = json.load(sys.stdin)
    t = str(d.get('tool_name', '')).lower()
    inp = d.get('tool_input', {})
    if not isinstance(inp, dict):
        inp = {}
    fp = ''
    if t in ('edit', 'write', 'hashline_edit'):
        fp = inp.get('file_path', '') or inp.get('filePath', '') or inp.get('path', '')
    elif t == 'bash':
        cmd = inp.get('command', '')
        if cmd:
            try:
                tokens = shlex.split(cmd)
            except ValueError:
                tokens = cmd.split()
            path_re = re.compile(r'^([^\\n]+\\.[A-Za-z0-9]+)$')
            for tok in tokens:
                if not tok.startswith('-') and path_re.match(tok):
                    fp = tok
                    break
    if fp:
        print(fp)
except Exception:
    pass
" <<< "$STDIN_JSON" 2>/dev/null || echo "")
  if [ -n "$EXTRACTED_PATH" ]; then
    FILE_PATH="$EXTRACTED_PATH"
  fi
fi

FILE_PATH="${FILE_PATH:-${1:-}}"
if [[ -n "$FILE_PATH" ]] && [[ "$FILE_PATH" != /* ]]; then
    if [[ -f "$REPO_ROOT/$FILE_PATH" ]]; then
        FILE_PATH="$REPO_ROOT/$FILE_PATH"
    fi
fi

if [[ -z "$FILE_PATH" ]] || [[ ! -f "$FILE_PATH" ]]; then
    exit 0
fi

EXT="${FILE_PATH##*.}"
EXIT_CODE=0

case "$EXT" in
    py)
        if command -v ruff >/dev/null 2>&1; then
            ruff format "$FILE_PATH" || true
        elif command -v black >/dev/null 2>&1; then
            black -q "$FILE_PATH" || true
        fi
        ;;
    js|jsx|ts|tsx|json|jsonc|md|yaml|yml|css|html)
        if command -v prettier >/dev/null 2>&1; then
            prettier --write "$FILE_PATH" || true
        fi
        ;;
    sh|bash)
        if command -v shfmt >/dev/null 2>&1; then
            shfmt -w "$FILE_PATH" || true
        fi
        ;;
esac

exit 0
