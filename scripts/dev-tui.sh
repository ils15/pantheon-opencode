#!/usr/bin/env bash
# dev-tui.sh — load the Pantheon TUI from the repo (src/plugins/tui) WITHOUT publishing.
#
# Flow: build the bundle → register the repo's absolute path in
# .opencode/tui.json (read by the OpenCode TUI loader) → restart hint.
# It deliberately does NOT touch opencode.json: that file is packaged and
# merged into user configs by the installer, so a repo-relative path would
# leak into third-party installs and break the CI package gates.
#
# Usage: scripts/dev-tui.sh [--test]
#   --test   also run the full repo test suite (npm run test:all) after build.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TUI_DIR="$ROOT/src/plugins/tui"
TUI_JSON="$ROOT/.opencode/tui.json"

command -v npm >/dev/null 2>&1 || { echo "error: npm not found in PATH" >&2; exit 1; }
[ -d "$TUI_DIR" ] || { echo "error: TUI source not found: $TUI_DIR" >&2; exit 1; }

echo "==> TUI dev source: $TUI_DIR"

# 1. Install pinned deps + build dist/tui.js (dist/tui.tsx is copied by build).
echo "==> Installing TUI dev dependencies (npm ci)"
npm ci --prefix "$TUI_DIR" --ignore-scripts --no-audit --no-fund

echo "==> Building TUI plugin"
npm run build --prefix "$TUI_DIR"

# 2. Optional: full suite to match the CI gate before opening a PR.
if [[ "${1:-}" == "--test" ]]; then
  echo "==> Running full test suite (npm run test:all)"
  npm run test:all
fi

# 3. Register the repo path in the project tui.json (absolute, gitignored).
#    Reuses the installer's registerPlugin so the array is merged, not clobbered.
echo "==> Registering repo TUI path in $TUI_JSON"
ROOT="$ROOT" TUI_JSON="$TUI_JSON" TUI_DIR="$TUI_DIR" node --input-type=module <<'NODE'
const { registerPlugin } = await import(`${process.env.ROOT}/scripts/install/plugin.mjs`)
const result = registerPlugin(process.env.TUI_JSON, process.env.TUI_DIR)
console.log(`${result}: ${process.env.TUI_DIR}`)
NODE

# 4. Restart hint + dev-mode caveat.
echo "==> Done. Restart OpenCode to load the rebuilt TUI plugin."
echo "    Dev mode caveat: do NOT run 'init' in this repo while iterating — it"
echo "    removes repo path refs as stale. If you do, re-run scripts/dev-tui.sh."
