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
  EXTRACTED_PATH=$(node -e '
try {
  const d = JSON.parse(process.argv[1] || "{}");
  const t = String(d.tool_name || "").toLowerCase();
  const inp = d.tool_input && typeof d.tool_input === "object" ? d.tool_input : {};
  let fp = "";
  if (["edit", "write", "hashline_edit"].includes(t)) {
    fp = inp.file_path || inp.filePath || inp.file || inp.path || "";
  } else if (t === "bash") {
    const cmd = String(inp.command || "");
    for (const tok of cmd.split(/\s+/)) {
      if (tok && !tok.startsWith("-") && /^[^\n]+\.[A-Za-z0-9]+$/.test(tok)) {
        fp = tok;
        break;
      }
    }
  }
  if (fp) process.stdout.write(String(fp));
} catch {}
' "$STDIN_JSON" 2>/dev/null || echo "")
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
    js|jsx|ts|tsx|json|jsonc)
        if command -v biome >/dev/null 2>&1; then
            biome format --write "$FILE_PATH" || true
        elif [[ -x "$REPO_ROOT/node_modules/.bin/biome" ]]; then
            "$REPO_ROOT/node_modules/.bin/biome" format --write "$FILE_PATH" || true
        elif command -v prettier >/dev/null 2>&1; then
            prettier --write "$FILE_PATH" || true
        fi
        ;;
    md|yaml|yml|css|html)
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
