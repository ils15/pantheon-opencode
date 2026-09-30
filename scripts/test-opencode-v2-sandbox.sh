#!/usr/bin/env bash
# test-opencode-v2-sandbox.sh — Pantheon global-install sandbox validator for
# OpenCode V2.
#
# Validates the installed pantheon-opencode package AS A REAL USER inside an
# isolated sandbox (own HOME, npm prefix and venv), never the dev environment.
#
# WHAT "V2" MEANS HERE
# --------------------
# It does not mean a different binary. On hosts where both `opencode` and
# `opencode2` exist, `opencode2` is typically a two-line shim that execs the very
# same `opencode` binary, so a "V1 vs V2 side-by-side" comparison proved nothing
# about the binary. "V2" here means this script observes a specific hook canary
# against an OpenCode v2.0.18 host. It does not establish a stable
# `@opencode/plugin@2.0.18` SDK contract or compatibility across the full 2.x
# line. This project is V2-exclusive, so there is a single host leg to validate.
#
# Modes (combinable):
#   --prepare        Build tarball, install pantheon-opencode + the OpenCode V2
#                    binary in the sandbox prefix, headless init, and generate
#                    the project config and sandbox run-test.sh.
#   --run v2         Base validation: opencode mcp list + doctor (config is
#                    regenerated first).
#   --prompts        Prompt battery via `opencode run --format json`.
#   --cost           Offline pantheon_cost probe.
#   --rehydrate      Offline context_rehydrate + context_session_summary probe.
#   --hooks          V2 hook canary: proves hook callbacks FIRE through the
#                    sandbox's V2 binary (not merely that a plugin loaded).
#                    This does not test transform callback effects or Pantheon
#                    execute.before security enforcement (deferred to S6).
#   --reset          Wipe the sandbox root.
#   --help           Usage.
#
# Env overrides:
#   PANTHEON_SANDBOX_ROOT    Sandbox root (default: ~/pantheon-sandbox)
#   OPENCODE_V2_SPEC         npm spec providing the V2 binary
#                            (default: @opencode-ai/cli@beta). NOTE: this is an
#                            install spec only — it is not a dependency of this
#                            package, and no code imports it.
#   PANTHEON_REPO            Repository the sandbox is built from (default: the
#                            checkout this script lives in). Only read by the
#                            GENERATED run-test.sh, which cannot derive it from
#                            its own location and reads the .repo-dir file this
#                            script generates beside it. --reset refuses a
#                            sandbox root that overlaps either protected repo.
#   PANTHEON_SANDBOX_MODEL   Model used by init/prompts
#                            (default: opencode-go/mimo-v2.5)
#   PANTHEON_PROMPT_TIMEOUT  Per-prompt timeout in seconds (default: 300)
# Exit codes: 0 = every required check returned explicit PASS,
#             1 = any failure or untested check (see reports in the sandbox root),
#             2 = usage error, 3 = sandbox not prepared.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Derived from this script's own location so the sandbox is always built from
# the checkout that CONTAINS this harness. It must never be inferred from a
# sibling directory: a sibling may be a different checkout (or a different
# branch) with unrelated uncommitted work, and --prepare runs `npm pack` inside
# it, writing a tarball into that tree.
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SANDBOX_ROOT="${PANTHEON_SANDBOX_ROOT:-$HOME/pantheon-sandbox}"
SANDBOX_HOME="$SANDBOX_ROOT/home"
NPM_PREFIX="$SANDBOX_HOME/.npm-global"

OPENCODE_V2_SPEC="${OPENCODE_V2_SPEC:-@opencode-ai/cli@beta}"
PANTHEON_SANDBOX_MODEL="${PANTHEON_SANDBOX_MODEL:-opencode-go/mimo-v2.5}"
PANTHEON_PROMPT_TIMEOUT="${PANTHEON_PROMPT_TIMEOUT:-300}"

V2_BIN="${OPENCODE_V2_BIN:-opencode2}"

# OpenCode V2's CLI talks to its background service for `mcp list`. Keep the
# probe hermetic: an inherited config, database, or PORT can otherwise make
# the command query a different service and report a false result.
V2_CONFIG="${PANTHEON_V2_CONFIG:-$SANDBOX_ROOT/project-v2/opencode.json}"
V2_DB="${PANTHEON_V2_DB:-$SANDBOX_ROOT/opencode-v2.db}"
V2_PORT="${PANTHEON_V2_PORT:-49376}"
V2_LOOPBACK_HOST="${PANTHEON_V2_HOST:-127.0.0.1}"
V2_HANDSHAKE_TIMEOUT="${PANTHEON_V2_HANDSHAKE_TIMEOUT:-60}"
V2_MCP_LIST_TIMEOUT="${PANTHEON_V2_MCP_LIST_TIMEOUT:-15}"
V2_SERVER_PID=""
V2_SERVER_LOG="$SANDBOX_ROOT/v2-server.log"
V2_SERVICE_STATE="$SANDBOX_HOME/.local/state/opencode/service.json"

# The single target version. Kept as a name so reports and prompts keep their
# per-version labels without reintroducing a second leg.
TARGET_VERSION="v2"

REPORT_FILE="$SANDBOX_ROOT/prompts-report.md"
COST_REPORT_FILE="$SANDBOX_ROOT/pantheon-cost-report.md"
REHYDRATE_REPORT_FILE="$SANDBOX_ROOT/context-rehydrate-report.md"
EXTRACT_PY="$SANDBOX_ROOT/.prompt-extract-json.py"

MODE_PREPARE=0
MODE_RESET=0
MODE_PROMPTS=0
MODE_COST=0
MODE_REHYDRATE=0
MODE_HOOKS=0
RUN_VERSION=""

usage() {
  sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 2
}

log() { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

project_dir() { printf '%s/project-%s' "$SANDBOX_ROOT" "$TARGET_VERSION"; }

# Resolve a binary STRICTLY inside the sandbox npm prefix — never fall back to
# the dev PATH, otherwise a non-prepared sandbox would silently test the host
# installation.
sandbox_bin_for() { # name → prints path; rc 1 if not inside sandbox prefix
  local p
  p="$(command -v "$1" 2>/dev/null || true)"
  case "$p" in
    "$NPM_PREFIX"/*) printf '%s' "$p" ;;
    *) return 1 ;;
  esac
}

sandbox_bin() { # echoes the V2 binary path; rc 1 if missing
  sandbox_bin_for "$V2_BIN"
}

# ── Sandbox environment isolation ─────────────────────────────────────────────

sandbox_env() {
  export HOME="$SANDBOX_HOME"
  export PATH="$NPM_PREFIX/bin:$HOME/.config/opencode/.venv/bin:$PATH"
  export npm_config_prefix="$NPM_PREFIX"
  export XDG_STATE_HOME="$SANDBOX_HOME/.local/state"
  # Do not inherit an OpenChamber/developer-machine config selector. The V2
  # project config is created by prepare_project and is the only config this
  # gate is allowed to inspect.
  export OPENCODE_CONFIG_DIR="$(dirname "$V2_CONFIG")"
  export OPENCODE_DB="$V2_DB"
  export PANTHEON_V2_PORT="$V2_PORT"
  export PORT="$V2_PORT"
  unset OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT OPENCODE_CONFIG_PROJECT_DISABLE
  mkdir -p "$SANDBOX_ROOT" "$(dirname "$V2_DB")" "$(dirname "$V2_SERVICE_STATE")"
}

stop_v2_service() {
  if [ -n "$V2_SERVER_PID" ] && kill -0 "$V2_SERVER_PID" 2>/dev/null; then
    kill "$V2_SERVER_PID" 2>/dev/null || true
    wait "$V2_SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$V2_SERVICE_STATE"
  V2_SERVER_PID=""
}

print_v2_diagnostics() {
  printf '%s\n' '--- V2 service registration ---' >&2
  if [ -f "$V2_SERVICE_STATE" ]; then
    cat "$V2_SERVICE_STATE" >&2 || true
    printf '\n' >&2
  else
    printf 'missing service registration: %s\n' "$V2_SERVICE_STATE" >&2
  fi
  printf '%s\n' '--- V2 service log ---' >&2
  if [ -f "$V2_SERVER_LOG" ]; then
    tail -200 "$V2_SERVER_LOG" >&2 || true
  else
    printf 'missing service log: %s\n' "$V2_SERVER_LOG" >&2
  fi
  local runtime_log="$HOME/.local/share/opencode/log/opencode.log"
  printf '%s\n' '--- OpenCode runtime log ---' >&2
  if [ -f "$runtime_log" ]; then
    tail -200 "$runtime_log" >&2 || true
  else
    printf 'missing runtime log: %s\n' "$runtime_log" >&2
  fi
}

wait_for_v2_service_registration() {
  local registration_url="http://$V2_LOOPBACK_HOST:$V2_PORT"
  local registration_pid="$V2_SERVER_PID"
  local attempt

  for attempt in $(seq 1 "$V2_HANDSHAKE_TIMEOUT"); do
    if ! kill -0 "$V2_SERVER_PID" 2>/dev/null; then
      printf 'V2 service exited before registration was written.\n' >&2
      print_v2_diagnostics
      return 1
    fi
    if [ -f "$V2_SERVICE_STATE" ] \
      && SERVICE_STATE="$V2_SERVICE_STATE" \
        REGISTRATION_URL="$registration_url" \
        REGISTRATION_PID="$registration_pid" \
        python3 - <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ["SERVICE_STATE"])
try:
    state = json.loads(path.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError):
    raise SystemExit(1)

expected_url = os.environ["REGISTRATION_URL"]
expected_pid = int(os.environ["REGISTRATION_PID"])
if not isinstance(state, dict):
    raise SystemExit(1)
if state.get("url") != expected_url or state.get("pid") != expected_pid:
    raise SystemExit(1)
if not all(isinstance(state.get(key), str) and state[key] for key in ("id", "version", "password")):
    raise SystemExit(1)
PY
    then
      return 0
    fi
    sleep 1
  done
  printf 'Timed out after %ss waiting for V2 service registration matching url=%s pid=%s.\n' \
    "$V2_HANDSHAKE_TIMEOUT" "$registration_url" "$registration_pid" >&2
  print_v2_diagnostics
  return 1
}

wait_for_v2_mcp_registrations() {
  local runtime_dir="$1" python_bin="$2" attempt
  for attempt in $(seq 1 "$V2_HANDSHAKE_TIMEOUT"); do
    if ! kill -0 "$V2_SERVER_PID" 2>/dev/null; then
      echo 'ERROR: V2 service exited before all five MCP registrations completed' >&2
      print_v2_diagnostics
      return 1
    fi
    if SERVICE_LOG="$V2_SERVER_LOG" RUNTIME_DIR="$runtime_dir" MCP_PYTHON="$python_bin" \
      python3 - <<'PY'
import os
import re
from pathlib import Path

try:
    log = Path(os.environ["SERVICE_LOG"]).read_text(encoding="utf-8")
except OSError:
    raise SystemExit(1)
expected = {
    "code_mode_server.py",
    "memory_mcp_server.py",
    "mcp_persistence_server.py",
    "mcp_resources_server.py",
    "pantheon_vision_server.py",
}
pattern = re.compile(
    r"spawning process \{\s*"
    r"command:\s*\"(?P<command>[^\"]+)\".*?"
    r"args:\s*\[\s*\"(?P<script>[^\"]+)\"\s*\].*?"
    r"cwd:\s*\"(?P<cwd>[^\"]+)\"",
    re.DOTALL,
)
records = list(pattern.finditer(log))
runtime_dir = os.environ["RUNTIME_DIR"]
python_bin = os.environ["MCP_PYTHON"]
registered = set()
for record in records:
    command = record.group("command")
    script = Path(record.group("script")).name
    cwd = record.group("cwd")
    if command != python_bin or cwd != runtime_dir or script not in expected:
        raise SystemExit(1)
    registered.add(script)
if len(records) != len(expected) or registered != expected:
    raise SystemExit(1)
PY
    then
      return 0
    fi
    sleep 1
  done
  printf 'ERROR: timed out after %ss waiting for exactly five MCP registrations in the active sandbox\n' \
    "$V2_HANDSHAKE_TIMEOUT" >&2
  print_v2_diagnostics
  return 1
}

wait_for_v2_handshakes() {
  local runtime_log="$HOME/.local/share/opencode/log/opencode.log"
  local names=(
    pantheon-code-mode
    pantheon-memory
    pantheon-persistence
    pantheon-resources
    pantheon-vision
  )
  local attempt name ready connected_names connected_count
  for attempt in $(seq 1 "$V2_HANDSHAKE_TIMEOUT"); do
    if ! kill -0 "$V2_SERVER_PID" 2>/dev/null; then
      printf 'V2 service exited before all MCP handshakes completed.\n' >&2
      print_v2_diagnostics
      return 1
    fi
    ready=1
    for name in "${names[@]}"; do
      if [ ! -f "$runtime_log" ] || ! grep -Fq "message=\"mcp connected\" server=$name" "$runtime_log"; then
        ready=0
        break
      fi
    done
    if [ "$ready" -eq 1 ]; then
      # A stale or inherited MCP must not turn five expected handshakes into a
      # false PASS. The service log is dedicated to this run and must contain
      # exactly the five managed server names.
      connected_names="$({ grep -oE 'message="mcp connected" server=[^ ]+' "$runtime_log" || true; } \
        | sed 's/.*server=//' | sort -u)"
      connected_count="$(printf '%s\n' "$connected_names" | sed '/^$/d' | wc -l)"
      if [ "$connected_count" -eq 5 ] \
        && ! printf '%s\n' "$connected_names" | grep -Evx \
          'pantheon-code-mode|pantheon-memory|pantheon-persistence|pantheon-resources|pantheon-vision' \
          >/dev/null; then
        return 0
      fi
      ready=0
    fi
    sleep 1
  done
  printf 'Timed out after %ss waiting for exactly five MCP handshakes.\n' \
    "$V2_HANDSHAKE_TIMEOUT" >&2
  print_v2_diagnostics
  return 1
}

start_v2_service() { # binary project
  local bin="$1" project="$2" ready=0 attempt
  if [ -n "$V2_SERVER_PID" ] && kill -0 "$V2_SERVER_PID" 2>/dev/null; then
    return 0
  fi

  # Never attach to an unrelated service on the dedicated port. A successful
  # health probe before our process starts is an environmental collision, not
  # a reason to silently reuse that service.
  if curl --fail --silent --show-error --max-time 1 \
    "http://$V2_LOOPBACK_HOST:${V2_PORT}/global/health" >/dev/null 2>&1; then
    die "dedicated V2 port ${V2_PORT} is already in use; refusing to reuse an unrelated service"
  fi

  rm -f "$V2_SERVER_LOG" "$V2_SERVICE_STATE" "$HOME/.local/share/opencode/log/opencode.log"
  (cd "$project" && "$bin" serve --hostname "$V2_LOOPBACK_HOST" --port "$V2_PORT" --service) \
    >"$V2_SERVER_LOG" 2>&1 &
  V2_SERVER_PID=$!

  for attempt in $(seq 1 "$V2_HANDSHAKE_TIMEOUT"); do
    if ! kill -0 "$V2_SERVER_PID" 2>/dev/null; then
      printf 'V2 service exited before becoming healthy.\n' >&2
      print_v2_diagnostics
      return 1
    fi
    if curl --fail --silent --show-error --max-time 2 \
      "http://$V2_LOOPBACK_HOST:${V2_PORT}/global/health" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then
    printf 'Timed out after %ss waiting for V2 service health on port %s.\n' \
      "$V2_HANDSHAKE_TIMEOUT" "$V2_PORT" >&2
    print_v2_diagnostics
    return 1
  fi
  if ! wait_for_v2_service_registration; then
    return 1
  fi
}

trap stop_v2_service EXIT

# ── Gate (b): sandbox run-test.sh with pantheon://agents content validation ──

write_run_test_sh() {
  # Quoted heredoc: the body is emitted verbatim, so nothing inside is expanded
  # at generation time. REPO_DIR is the one value the body needs, and it is
  # handed over as its own generated file instead of a placeholder baked into
  # the shell source: interpolating it meant escaping for TWO languages (sed
  # replacement text AND the double-quoted shell context it lands in), and only
  # the first set was escaped — a path containing `$`, a backtick, a backslash
  # or a quote was silently rewritten or executed by the generated script.
  printf '%s\n' "$REPO_DIR" > "$SANDBOX_ROOT/.repo-dir"
  cat > "$SANDBOX_ROOT/run-test.sh" <<'RUNTEST'
#!/usr/bin/env bash
# Generated by pantheon-opencode scripts/test-opencode-v2-sandbox.sh --prepare
# Validates the global install: the V2 binary, exactly 5 connected MCPs, doctor
# 0 errors, AND the CONTENT of pantheon://agents (zeus/hermes present).
set -euo pipefail

SANDBOX_DIR="$(cd "$(dirname "$0")" && pwd)"
SANDBOX_HOME="$SANDBOX_DIR/home"
NPM_PREFIX="$SANDBOX_HOME/.npm-global"
PANTHEON_GLOBAL="$SANDBOX_HOME/.config/opencode"
SANDBOX_VENV="$PANTHEON_GLOBAL/.venv"
# The checkout this harness ran from, written by the generator into the
# .repo-dir file next to this script. It used to be a placeholder baked into
# this line and substituted with sed afterwards, but the sandbox lives outside
# any repo so the value cannot be derived from this file's own location either.
# Reading a file the generator wrote keeps the path out of the shell source, so
# no escaping can be wrong. PANTHEON_REPO may still override it; the generator's
# --reset guard refuses to run when that points inside a repo, so an override
# can never turn this into a repo-wiping target.
REPO_DIR="${PANTHEON_REPO:-$(cat "$SANDBOX_DIR/.repo-dir")}"

echo "=== Pantheon Sandbox Test (OpenCode V2) ==="
echo "Sandbox: $SANDBOX_DIR"
echo "Repo:    $REPO_DIR"

export HOME="$SANDBOX_HOME"
export PATH="$NPM_PREFIX/bin:$SANDBOX_VENV/bin:$PATH"
export npm_config_prefix="$NPM_PREFIX"
export XDG_STATE_HOME="$SANDBOX_HOME/.local/state"
# The V2 CLI resolves `mcp list` through its service. Keep generated sandbox
# runs isolated from any config/database/port inherited from the host.
V2_CONFIG="$SANDBOX_DIR/project-v2/opencode.json"
V2_DB="${PANTHEON_V2_DB:-$SANDBOX_DIR/opencode-v2.db}"
V2_PORT="${PANTHEON_V2_PORT:-49376}"
V2_LOOPBACK_HOST="${PANTHEON_V2_HOST:-127.0.0.1}"
V2_HANDSHAKE_TIMEOUT="${PANTHEON_V2_HANDSHAKE_TIMEOUT:-60}"
V2_SERVER_LOG="$SANDBOX_DIR/v2-server.log"
V2_SERVICE_STATE="$SANDBOX_HOME/.local/state/opencode/service.json"
V2_SERVER_PID=""
export OPENCODE_CONFIG_DIR="$(dirname "$V2_CONFIG")"
export OPENCODE_DB="$V2_DB"
export PANTHEON_V2_PORT="$V2_PORT"
export PORT="$V2_PORT"
unset OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT OPENCODE_CONFIG_PROJECT_DISABLE
mkdir -p "$(dirname "$V2_SERVICE_STATE")"

stop_v2_service() {
  if [ -n "$V2_SERVER_PID" ] && kill -0 "$V2_SERVER_PID" 2>/dev/null; then
    kill "$V2_SERVER_PID" 2>/dev/null || true
    wait "$V2_SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$V2_SERVICE_STATE"
  V2_SERVER_PID=""
}

print_v2_diagnostics() {
  printf '%s\n' '--- V2 service registration ---' >&2
  if [ -f "$V2_SERVICE_STATE" ]; then
    cat "$V2_SERVICE_STATE" >&2 || true
    printf '\n' >&2
  else
    printf 'missing service registration: %s\n' "$V2_SERVICE_STATE" >&2
  fi
  printf '%s\n' '--- V2 service log ---' >&2
  [ -f "$V2_SERVER_LOG" ] && tail -200 "$V2_SERVER_LOG" >&2 || true
  local runtime_log="$HOME/.local/share/opencode/log/opencode.log"
  printf '%s\n' '--- OpenCode runtime log ---' >&2
  [ -f "$runtime_log" ] && tail -200 "$runtime_log" >&2 || true
}

wait_for_v2_service_registration() {
  local registration_url="http://$V2_LOOPBACK_HOST:$V2_PORT"
  local registration_pid="$V2_SERVER_PID"
  local attempt
  for attempt in $(seq 1 "$V2_HANDSHAKE_TIMEOUT"); do
    if ! kill -0 "$V2_SERVER_PID" 2>/dev/null; then
      echo 'ERROR: V2 service exited before registration was written' >&2
      print_v2_diagnostics
      return 1
    fi
    if [ -f "$V2_SERVICE_STATE" ] \
      && SERVICE_STATE="$V2_SERVICE_STATE" \
        REGISTRATION_URL="$registration_url" \
        REGISTRATION_PID="$registration_pid" \
        python3 - <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ["SERVICE_STATE"])
try:
    state = json.loads(path.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError):
    raise SystemExit(1)
expected_url = os.environ["REGISTRATION_URL"]
expected_pid = int(os.environ["REGISTRATION_PID"])
if not isinstance(state, dict):
    raise SystemExit(1)
if state.get("url") != expected_url or state.get("pid") != expected_pid:
    raise SystemExit(1)
if not all(isinstance(state.get(key), str) and state[key] for key in ("id", "version", "password")):
    raise SystemExit(1)
PY
    then
      return 0
    fi
    sleep 1
  done
  printf 'ERROR: timed out after %ss waiting for V2 service registration matching url=%s pid=%s\n' \
    "$V2_HANDSHAKE_TIMEOUT" "$registration_url" "$registration_pid" >&2
  print_v2_diagnostics
  return 1
}

wait_for_v2_mcp_registrations() {
  local runtime_dir="$1" python_bin="$2" attempt
  for attempt in $(seq 1 "$V2_HANDSHAKE_TIMEOUT"); do
    if ! kill -0 "$V2_SERVER_PID" 2>/dev/null; then
      echo 'ERROR: V2 service exited before all five MCP registrations completed' >&2
      print_v2_diagnostics
      return 1
    fi
    if SERVICE_LOG="$V2_SERVER_LOG" RUNTIME_DIR="$runtime_dir" MCP_PYTHON="$python_bin" \
      python3 - <<'PY'
import os
import re
from pathlib import Path

try:
    log = Path(os.environ["SERVICE_LOG"]).read_text(encoding="utf-8")
except OSError:
    raise SystemExit(1)
expected = {
    "code_mode_server.py",
    "memory_mcp_server.py",
    "mcp_persistence_server.py",
    "mcp_resources_server.py",
    "pantheon_vision_server.py",
}
pattern = re.compile(
    r"spawning process \{\s*"
    r"command:\s*\"(?P<command>[^\"]+)\".*?"
    r"args:\s*\[\s*\"(?P<script>[^\"]+)\"\s*\].*?"
    r"cwd:\s*\"(?P<cwd>[^\"]+)\"",
    re.DOTALL,
)
records = list(pattern.finditer(log))
runtime_dir = os.environ["RUNTIME_DIR"]
python_bin = os.environ["MCP_PYTHON"]
registered = set()
for record in records:
    command = record.group("command")
    script = Path(record.group("script")).name
    cwd = record.group("cwd")
    if command != python_bin or cwd != runtime_dir or script not in expected:
        raise SystemExit(1)
    registered.add(script)
if len(records) != len(expected) or registered != expected:
    raise SystemExit(1)
PY
    then
      return 0
    fi
    sleep 1
  done
  printf 'ERROR: timed out after %ss waiting for exactly five MCP registrations in the active sandbox\n' \
    "$V2_HANDSHAKE_TIMEOUT" >&2
  print_v2_diagnostics
  return 1
}

start_v2_service() {
  local bin="$1" project="$2" attempt ready=0
  if [ -n "$V2_SERVER_PID" ] && kill -0 "$V2_SERVER_PID" 2>/dev/null; then
    return 0
  fi
  if curl --fail --silent --show-error --max-time 1 \
    "http://$V2_LOOPBACK_HOST:${V2_PORT}/global/health" >/dev/null 2>&1; then
    echo "ERROR: dedicated V2 port $V2_PORT is already in use" >&2
    return 1
  fi
  rm -f "$V2_SERVER_LOG" "$V2_SERVICE_STATE" "$HOME/.local/share/opencode/log/opencode.log"
  (cd "$project" && "$bin" serve --hostname "$V2_LOOPBACK_HOST" --port "$V2_PORT" --service) \
    >"$V2_SERVER_LOG" 2>&1 &
  V2_SERVER_PID=$!
  for attempt in $(seq 1 "$V2_HANDSHAKE_TIMEOUT"); do
    if ! kill -0 "$V2_SERVER_PID" 2>/dev/null; then
      echo 'ERROR: V2 service exited before becoming healthy' >&2
      print_v2_diagnostics
      return 1
    fi
    if curl --fail --silent --show-error --max-time 2 \
      "http://$V2_LOOPBACK_HOST:${V2_PORT}/global/health" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then
    echo "ERROR: timed out waiting for V2 service on port $V2_PORT" >&2
    print_v2_diagnostics
    return 1
  fi
  if ! wait_for_v2_service_registration; then
    return 1
  fi
}

wait_for_v2_handshakes() {
  local runtime_log="$HOME/.local/share/opencode/log/opencode.log"
  local names=(pantheon-code-mode pantheon-memory pantheon-persistence pantheon-resources pantheon-vision)
  local attempt name ready connected_names connected_count
  for attempt in $(seq 1 "$V2_HANDSHAKE_TIMEOUT"); do
    if ! kill -0 "$V2_SERVER_PID" 2>/dev/null; then
      echo 'ERROR: V2 service exited before all MCP handshakes completed' >&2
      print_v2_diagnostics
      return 1
    fi
    ready=1
    for name in "${names[@]}"; do
      if [ ! -f "$runtime_log" ] || ! grep -Fq "message=\"mcp connected\" server=$name" "$runtime_log"; then
        ready=0
        break
      fi
    done
    if [ "$ready" -eq 1 ]; then
      connected_names="$({ grep -oE 'message=\"mcp connected\" server=[^ ]+' "$runtime_log" || true; } \
        | sed 's/.*server=//' | sort -u)"
      connected_count="$(printf '%s\n' "$connected_names" | sed '/^$/d' | wc -l)"
      if [ "$connected_count" -eq 5 ] \
        && ! printf '%s\n' "$connected_names" | grep -Evx \
          'pantheon-code-mode|pantheon-memory|pantheon-persistence|pantheon-resources|pantheon-vision' \
          >/dev/null; then
        return 0
      fi
      ready=0
    fi
    sleep 1
  done
  echo "ERROR: timed out waiting for exactly five MCP handshakes" >&2
  print_v2_diagnostics
  return 1
}

rewrite_v2_mcp_config() {
  local config_path="$V2_CONFIG"
  local runtime_dir="$SANDBOX_DIR/project-v2/.opencode"
  local python_bin="$SANDBOX_DIR/project-v2/.venv/bin/python3"
  [ -f "$config_path" ] || { echo "ERROR: V2 config was not generated: $config_path" >&2; return 1; }
  [ -x "$python_bin" ] || { echo "ERROR: V2 MCP Python is missing: $python_bin" >&2; return 1; }
  CONFIG_PATH="$config_path" RUNTIME_DIR="$runtime_dir" MCP_PYTHON="$python_bin" \
    python3 - <<'PY'
import json
import os
from pathlib import Path

config_path = Path(os.environ["CONFIG_PATH"])
runtime_dir = os.environ["RUNTIME_DIR"]
python_bin = os.environ["MCP_PYTHON"]
managed = {
    "pantheon-code-mode": "code_mode_server.py",
    "pantheon-memory": "memory_mcp_server.py",
    "pantheon-persistence": "mcp_persistence_server.py",
    "pantheon-resources": "mcp_resources_server.py",
    "pantheon-vision": "pantheon_vision_server.py",
}
try:
    config = json.loads(config_path.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError) as exc:
    raise SystemExit(f"cannot read V2 config {config_path}: {exc}")
if not isinstance(config, dict):
    raise SystemExit(f"V2 config must be an object: {config_path}")
mcp = config.setdefault("mcp", {})
if not isinstance(mcp, dict):
    raise SystemExit("V2 config mcp section must be an object")
for name, script in managed.items():
    entry = mcp.get(name) if isinstance(mcp.get(name), dict) else {}
    entry.pop("disabled", None)
    entry.update(type="local", cwd=runtime_dir, command=[python_bin, f"scripts/{script}"], enabled=True)
    mcp[name] = entry
tmp_path = config_path.with_name(config_path.name + ".sandbox-tmp")
tmp_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
os.replace(tmp_path, config_path)
validated = json.loads(config_path.read_text(encoding="utf-8"))
for name, script in managed.items():
    entry = validated.get("mcp", {}).get(name)
    expected = {"type": "local", "cwd": runtime_dir, "command": [python_bin, f"scripts/{script}"], "enabled": True}
    if not isinstance(entry, dict) or any(entry.get(key) != value for key, value in expected.items()):
        raise SystemExit(f"stale or invalid paths remain for {name} in {config_path}")
    if not Path(entry["cwd"]).is_dir() or not Path(entry["command"][0]).is_file() or not (Path(entry["cwd"]) / entry["command"][1]).is_file():
        raise SystemExit(f"active sandbox path is missing for {name}: {entry}")
PY
}

trap stop_v2_service EXIT

STATUS_FAIL=0
STATUS_PASS=0

record_status() { # label status detail
  local label="$1" status="$2" detail="$3"
  case "$status" in
    PASS) STATUS_PASS=$((STATUS_PASS + 1)) ;;
    FAIL) STATUS_FAIL=$((STATUS_FAIL + 1)) ;;
    *) STATUS_FAIL=$((STATUS_FAIL + 1)); status="FAIL" ;;
  esac
  printf '%s: %s — %s\n' "$status" "$label" "$detail"
}

check_binary() { # label binary
  local label="$1" bin="$2" out rc=0
  if ! command -v "$bin" >/dev/null 2>&1; then
    record_status "$label" "FAIL" "binary '$bin' is not installed in the sandbox prefix"
    return 0
  fi
  set +e
  out="$("$bin" --version 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    record_status "$label" "PASS" "${out:-version command exited 0}"
  else
    record_status "$label" "FAIL" "version check exited $rc"
  fi
}

check_mcp() { # label binary project
  local label="$1" bin="$2" project="$3" out connected_count rc=0 list_file list_pid
  local final_file final_pid final_rc final_count
  if ! command -v "$bin" >/dev/null 2>&1; then
    record_status "$label MCP" "FAIL" "binary '$bin' is not installed in the sandbox prefix"
    return 0
  fi
  if [ ! -d "$project" ]; then
    record_status "$label MCP" "FAIL" "project directory is missing: $project"
    return 0
  fi
  if ! start_v2_service "$bin" "$project"; then
    record_status "$label MCP" "FAIL" "V2 service did not become healthy"
    return 0
  fi

  # `mcp list` is the operation that causes OpenCode V2 to launch the MCP
  # subprocesses. Start it immediately after health, before waiting for the
  # handshakes; waiting first deadlocks forever because those subprocesses are
  # otherwise never loaded.
  list_file="$(mktemp "$SANDBOX_DIR/v2-mcp-list.XXXXXX")"
  (cd "$project" && timeout --foreground "$V2_MCP_LIST_TIMEOUT" "$bin" mcp list) \
    >"$list_file" 2>&1 &
  list_pid=$!
  if ! wait_for_v2_mcp_registrations "$project/.opencode" "$project/.venv/bin/python3"; then
    kill "$list_pid" 2>/dev/null || true
    wait "$list_pid" 2>/dev/null || true
    rm -f "$list_file"
    record_status "$label MCP" "FAIL" "MCP registrations did not match the active sandbox"
    return 0
  fi
  if wait_for_v2_handshakes; then
    :
  else
    kill "$list_pid" 2>/dev/null || true
    wait "$list_pid" 2>/dev/null || true
    rm -f "$list_file"
    record_status "$label MCP" "FAIL" "MCP handshakes did not become ready after mcp list started"
    return 0
  fi
  if wait "$list_pid"; then
    rc=0
  else
    rc=$?
  fi
  out="$(cat "$list_file")"
  rm -f "$list_file"
  connected_count="$(printf '%s' "$out" | grep -Eic '(^|[^[:alnum:]_])connected([^[:alnum:]_]|$)' || true)"
  if [ "$rc" -eq 0 ] && [ "$connected_count" -ne 5 ]; then
    # The first V2 beta `mcp list` call is the loader trigger and may return
    # before the service has populated its MCP catalog. Re-query only after
    # the registration and handshake gates above have proved the active five.
    final_file="$(mktemp "$SANDBOX_DIR/v2-mcp-list.XXXXXX")"
    (cd "$project" && timeout --foreground "$V2_MCP_LIST_TIMEOUT" "$bin" mcp list) \
      >"$final_file" 2>&1 &
    final_pid=$!
    if wait "$final_pid"; then
      final_rc=0
    else
      final_rc=$?
    fi
    out="$(cat "$final_file")"
    rm -f "$final_file"
    if [ "$final_rc" -ne 0 ]; then
      rc="$final_rc"
    fi
  fi
  out="$(printf '%s' "$out" | sed -E $'s/\x1B\\[[0-?]*[ -/]*[@-~]//g')"
  printf '%s\n' "$out"
  if [ "$rc" -ne 0 ]; then
    record_status "$label MCP" "FAIL" "mcp list exited $rc (see output above)"
    return 0
  fi
  connected_count="$(printf '%s' "$out" | grep -Eic '(^|[^[:alnum:]_])connected([^[:alnum:]_]|$)')" || connected_count=0
  if [ "$connected_count" -eq 5 ] \
    && ! printf '%s' "$out" | grep -Eiq 'failed|✘' \
    && printf '%s' "$out" | grep -Fq 'pantheon-code-mode' \
    && printf '%s' "$out" | grep -Fq 'pantheon-memory' \
    && printf '%s' "$out" | grep -Fq 'pantheon-persistence' \
    && printf '%s' "$out" | grep -Fq 'pantheon-resources' \
    && printf '%s' "$out" | grep -Fq 'pantheon-vision'; then
    record_status "$label MCP" "PASS" "exactly 5 connected MCPs"
  else
    record_status "$label MCP" "FAIL" "expected exactly 5 connected MCPs; found $connected_count or failures reported"
  fi
}

echo "--- Binaries ---"
check_binary "V2 binary" opencode2

echo "--- Building tarball ---"
cd "$REPO_DIR"
npm pack --ignore-scripts 2>/dev/null || { echo "ERROR: npm pack failed"; exit 1; }
TGZ=$(ls -t pantheon-opencode-*.tgz | head -1)
npm rm -g pantheon-opencode 2>/dev/null || true
npm install -g "$TGZ"
if ! git -C "$REPO_DIR" ls-files --error-unmatch -- "$TGZ" >/dev/null 2>&1; then rm -f -- "$TGZ"; fi

echo "--- Init (headless) ---"
pantheon-opencode init --headless -y
rewrite_v2_mcp_config

echo "--- MCP Validation ---"
check_mcp "V2" opencode2 "$SANDBOX_DIR/project-v2"

echo "--- Doctor ---"
if command -v pantheon-opencode >/dev/null 2>&1; then
  set +e
  DOCTOR_OUTPUT="$(pantheon-opencode doctor --target "$SANDBOX_DIR" 2>&1)"
  DOCTOR_RC=$?
  set -e
  if [ "$DOCTOR_RC" -eq 0 ]; then
    record_status "doctor" "PASS" "exit 0"
  else
    record_status "doctor" "FAIL" "doctor exited $DOCTOR_RC"
  fi
else
  record_status "doctor" "FAIL" "pantheon-opencode is not installed in the sandbox prefix"
fi

echo "--- Gate (b): pantheon://agents CONTENT check ---"
RESOURCES_SRV="$PANTHEON_GLOBAL/scripts/mcp_resources_server.py"
if [ ! -f "$RESOURCES_SRV" ]; then
  record_status "pantheon://agents resource" "FAIL" "resources server not found at $RESOURCES_SRV"
else
  set +e
  AGENTS_CONTENT="$("$SANDBOX_VENV/bin/python" - "$RESOURCES_SRV" <<'PYEOF'
import asyncio, importlib.util, sys
from pathlib import Path
resource_path = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(resource_path.parent))
spec = importlib.util.spec_from_file_location("mrs", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(asyncio.run(mod.list_agents()))
PYEOF
)"
  AGENTS_RC=$?
  set -e
  printf '%s\n' "$AGENTS_CONTENT" | head -8
  if [ "$AGENTS_RC" -ne 0 ]; then
    record_status "pantheon://agents resource" "FAIL" "resource probe exited $AGENTS_RC"
  elif printf '%s\n' "$AGENTS_CONTENT" | grep -qi 'zeus' \
    && printf '%s\n' "$AGENTS_CONTENT" | grep -qi 'hermes'; then
    record_status "pantheon://agents resource" "PASS" "pantheon://agents content includes zeus and hermes"
  else
    record_status "pantheon://agents resource" "FAIL" "content missing zeus/hermes (connectivity alone is not enough)"
  fi
fi
echo ""
echo "=== VALIDATION COMPLETE ==="
if [ "$STATUS_FAIL" -gt 0 ] || [ "$STATUS_PASS" -eq 0 ]; then
  FINAL_VERDICT="FAIL"
else
  FINAL_VERDICT="PASS"
fi
printf 'Final verdict: %s\n' "$FINAL_VERDICT"
if [ "$FINAL_VERDICT" != "PASS" ]; then
  exit 1
fi
echo "Next: open the isolated TUI with: $SANDBOX_DIR/start-pantheon.sh"
RUNTEST
  chmod +x "$SANDBOX_ROOT/run-test.sh"
}

# ── Reset / Prepare ───────────────────────────────────────────────────────────

# Resolve existing symlinked directory components and normalize missing path
# components without requiring the sandbox root to exist yet. If an existing
# non-directory appears before the final component, resolution fails closed.
canonicalize_path() {
  local path="$1" resolved="/" component candidate
  [ -n "$path" ] || return 1
  case "$path" in
    /*) ;;
    *) path="$PWD/$path" ;;
  esac

  while [ -n "$path" ]; do
    case "$path" in
      */*) component="${path%%/*}"; path="${path#*/}" ;;
      *) component="$path"; path="" ;;
    esac
    case "$component" in
      "" | .) continue ;;
      ..)
        if [ "$resolved" != "/" ]; then
          resolved="${resolved%/*}"
          [ -n "$resolved" ] || resolved="/"
        fi
        ;;
      *)
        if [ "$resolved" = "/" ]; then
          candidate="/$component"
        else
          candidate="$resolved/$component"
        fi
        if [ -d "$candidate" ]; then
          resolved="$(cd -P -- "$candidate" 2>/dev/null && pwd -P)" || return 1
        elif [ -e "$candidate" ] || [ -L "$candidate" ]; then
          [ -z "$path" ] || return 1
          resolved="$candidate"
        else
          resolved="$candidate"
        fi
        ;;
    esac
  done

  printf '%s\n' "$resolved"
}

# Compare complete path components; a sibling such as project-extra is not
# inside project. The root directory is a parent of every absolute path.
path_is_same_or_descendant() {
  local candidate="$1" parent="$2"
  [ "$candidate" = "$parent" ] && return 0
  if [ "$parent" = "/" ]; then
    case "$candidate" in /*) return 0 ;; esac
  fi
  case "$candidate" in "$parent"/*) return 0 ;; esac
  return 1
}

cmd_reset() {
  # Guard BOTH repos this harness can act on. REPO_DIR is where `--prepare`
  # runs `npm pack`; PANTHEON_REPO is the documented override the GENERATED
  # run-test.sh honours, and it may point somewhere else entirely. Refusing
  # only the default left an override able to name a checkout and have the
  # generated script pack a tarball into it.
  local protected canonical_root canonical_home canonical_protected
  canonical_root="$(canonicalize_path "$SANDBOX_ROOT")" \
    || die "refusing to reset sandbox root that cannot be canonicalized: $SANDBOX_ROOT"
  canonical_home="$(canonicalize_path "$HOME")" \
    || die "refusing to reset because HOME cannot be canonicalized: $HOME"
  [ "$canonical_root" != "/" ] \
    || die "refusing to reset unsafe sandbox root: $SANDBOX_ROOT (filesystem root)"
  [ "$canonical_root" != "$canonical_home" ] \
    || die "refusing to reset unsafe sandbox root: $SANDBOX_ROOT (HOME)"
  if path_is_same_or_descendant "$canonical_home" "$canonical_root"; then
    die "refusing to reset unsafe sandbox root: $SANDBOX_ROOT (it is an ancestor of HOME $HOME)"
  fi

  for protected in "$REPO_DIR" "${PANTHEON_REPO:-}"; do
    [ -n "$protected" ] || continue
    canonical_protected="$(canonicalize_path "$protected")" \
      || die "refusing to reset because protected repo path cannot be canonicalized: $protected"
    if path_is_same_or_descendant "$canonical_root" "$canonical_protected"; then
      die "refusing to reset unsafe sandbox root: $SANDBOX_ROOT (it is equal to or inside the repo $protected)"
    fi
    if path_is_same_or_descendant "$canonical_protected" "$canonical_root"; then
      die "refusing to reset unsafe sandbox root: $SANDBOX_ROOT (it is an ancestor of the repo $protected)"
    fi
  done
  log "Resetting sandbox: $SANDBOX_ROOT"
  rm -rf "$SANDBOX_ROOT"
  log "Sandbox removed."
}

install_binaries() {
  log "--- Installing pantheon-opencode (from repo tarball) ---"
  cd "$REPO_DIR"
  npm pack --ignore-scripts 2>/dev/null || die "npm pack failed"
  local tgz
  tgz=$(ls -t pantheon-opencode-*.tgz | head -1)
  npm rm -g pantheon-opencode 2>/dev/null || true
  npm install -g "$REPO_DIR/$tgz" || die "install of $tgz failed"
  if ! git -C "$REPO_DIR" ls-files --error-unmatch -- "$tgz" >/dev/null 2>&1; then rm -f -- "$tgz"; fi
  log "--- Installing OpenCode V2 ($OPENCODE_V2_SPEC) ---"
  npm install -g "$OPENCODE_V2_SPEC" || die "install of $OPENCODE_V2_SPEC failed"
}

prepare_project() {
  local dir pan
  dir="$(project_dir)"
  mkdir -p "$dir"
  pan="$(sandbox_bin_for "pantheon-opencode")" \
    || die "pantheon-opencode not installed in sandbox prefix — run $0 --prepare first"
  log "--- Regenerating config in $dir ---"
  (cd "$dir" && "$pan" init --project --version "$TARGET_VERSION" --model "$PANTHEON_SANDBOX_MODEL" -y) \
    || die "init --project --version $TARGET_VERSION failed in $dir"
  rewrite_v2_mcp_config
}

# The installer merges an existing project config. A reused sandbox can
# therefore contain five otherwise-valid MCP entries whose absolute paths
# point at a different sandbox or host. Rewrite the managed entries after the
# merge and validate the complete shape before any OpenCode process starts.
rewrite_v2_mcp_config() {
  local runtime_dir="$(project_dir)/.opencode"
  local python_bin="$(project_dir)/.venv/bin/python3"
  [ -f "$V2_CONFIG" ] || die "V2 config was not generated: $V2_CONFIG"
  [ -x "$python_bin" ] || die "V2 MCP Python is missing: $python_bin"

  CONFIG_PATH="$V2_CONFIG" RUNTIME_DIR="$runtime_dir" MCP_PYTHON="$python_bin" \
    python3 - <<'PY'
import json
import os
import sys
from pathlib import Path

config_path = Path(os.environ["CONFIG_PATH"])
runtime_dir = os.environ["RUNTIME_DIR"]
python_bin = os.environ["MCP_PYTHON"]
managed = {
    "pantheon-code-mode": "code_mode_server.py",
    "pantheon-memory": "memory_mcp_server.py",
    "pantheon-persistence": "mcp_persistence_server.py",
    "pantheon-resources": "mcp_resources_server.py",
    "pantheon-vision": "pantheon_vision_server.py",
}

try:
    config = json.loads(config_path.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError) as exc:
    raise SystemExit(f"cannot read V2 config {config_path}: {exc}")
if not isinstance(config, dict):
    raise SystemExit(f"V2 config must be an object: {config_path}")
mcp = config.setdefault("mcp", {})
if not isinstance(mcp, dict):
    raise SystemExit("V2 config mcp section must be an object")

for name, script in managed.items():
    entry = mcp.get(name)
    if not isinstance(entry, dict):
        entry = {}
    # Do not retain command/cwd values from the merged config. These are the
    # only paths the active project is allowed to use in this sandbox.
    entry.pop("disabled", None)
    entry.update(
        type="local",
        cwd=runtime_dir,
        command=[python_bin, f"scripts/{script}"],
        enabled=True,
    )
    mcp[name] = entry

tmp_path = config_path.with_name(config_path.name + ".sandbox-tmp")
try:
    tmp_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp_path, config_path)
except OSError as exc:
    try:
        tmp_path.unlink()
    except OSError:
        pass
    raise SystemExit(f"cannot rewrite V2 config {config_path}: {exc}")

try:
    validated = json.loads(config_path.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError) as exc:
    raise SystemExit(f"cannot validate rewritten V2 config {config_path}: {exc}")
for name, script in managed.items():
    entry = validated.get("mcp", {}).get(name)
    expected = {
        "type": "local",
        "cwd": runtime_dir,
        "command": [python_bin, f"scripts/{script}"],
        "enabled": True,
    }
    if not isinstance(entry, dict) or any(entry.get(key) != value for key, value in expected.items()):
        raise SystemExit(f"stale or invalid paths remain for {name} in {config_path}")
    if not Path(entry["cwd"]).is_dir() or not Path(entry["command"][0]).is_file():
        raise SystemExit(f"active sandbox path is missing for {name}: {entry}")
    if not (Path(entry["cwd"]) / entry["command"][1]).is_file():
        raise SystemExit(f"active sandbox MCP script is missing for {name}: {entry}")
PY
}

cmd_prepare() {
  mkdir -p "$SANDBOX_HOME" "$NPM_PREFIX"
  write_run_test_sh
  sandbox_env
  install_binaries
  local pan
  pan="$(sandbox_bin_for "pantheon-opencode")" \
    || die "pantheon-opencode not found in sandbox prefix after install"
  log "--- Headless init (global venv + runtime) ---"
  "$pan" init --headless -y --model "$PANTHEON_SANDBOX_MODEL" \
    || die "pantheon-opencode init --headless failed"
  prepare_project
  write_extract_py
  log "Prepare complete. Sandbox: $SANDBOX_ROOT"
  log "Next: $0 --run v2 --prompts"
}

# ── JSON text extraction (schema-agnostic) ────────────────────────────────────

write_extract_py() {
  cat > "$EXTRACT_PY" <<'PYEOF'
"""Collect every string value from opencode run --format json output."""
import json
import sys


def walk(obj, out):
    if isinstance(obj, str):
        out.append(obj)
    elif isinstance(obj, dict):
        for value in obj.values():
            walk(value, out)
    elif isinstance(obj, list):
        for value in obj:
            walk(value, out)


raw = sys.stdin.read()
chunks = []
try:
    walk(json.loads(raw), chunks)
except Exception:
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            walk(json.loads(line), chunks)
        except Exception:
            chunks.append(line)
print("\n".join(chunks))
PYEOF
}

# ── Prompt battery ────────────────────────────────────────────────────────────

PROMPT_IDS=()
PROMPT_TEXTS=()
PROMPT_MARKERS=()
PROMPT_VERIFY=()

add_prompt() { # id marker ignored verify text
  PROMPT_IDS+=("$1")
  PROMPT_MARKERS+=("$2")
  PROMPT_VERIFY+=("$4")
  PROMPT_TEXTS+=("$5")
}

build_battery() {
  local v="$1"
  PROMPT_IDS=()
  PROMPT_TEXTS=()
  PROMPT_MARKERS=()
  PROMPT_VERIFY=()
  add_prompt "agents-resource" "AGENTS-OK" "" "" \
    "List your MCP resources and read the resource pantheon://agents. If the returned agent list includes an agent named 'zeus' and one named 'hermes', reply with exactly: AGENTS-OK. Otherwise reply with exactly: AGENTS-MISSING."
  add_prompt "memory-store" "MEMORY-STORE-OK" "" "" \
    "Use the pantheon-memory memory_store tool to store this exact entry: namespace 'default', key 'pantheon-sandbox-probe-$v', value 'alive'. Then reply with exactly: MEMORY-STORE-OK"
  add_prompt "memory-recall" "MEMORY-RECALL-OK" "" "" \
    "Use the pantheon-memory memory_recall tool (or memory_search) to look up key 'pantheon-sandbox-probe-$v' in namespace 'default'. If the stored value is 'alive', reply with exactly: MEMORY-RECALL-OK"
  add_prompt "tmp-write-read" "TMP-OK" "" \
    "${TMPDIR:-/tmp}/pantheon-sandbox-probe-$v.txt::TMP-OK" \
    "Using the bash tool, run a python3 -c command that writes the text TMP-OK to the file ${TMPDIR:-/tmp}/pantheon-sandbox-probe-$v.txt (overwrite it), then run another python3 -c command to read that file back. Do not use any other tool or command to write or read the file — only python3 -c. If what you read back is exactly TMP-OK, reply with exactly: TMP-OK"
  add_prompt "delegation" "DELEGATION-OK" "" "" \
    "Delegate a tiny task to the @talos agent via the task tool: ask it to reply with the single word PONG. If the delegated response contains PONG, reply with exactly: DELEGATION-OK. If you cannot delegate to agents in this context, reply with exactly: DELEGATION-UNAVAILABLE"
}

declare -A RESULTS
declare -A DETAILS

record() { # v id result detail
  RESULTS["$1:$2"]="$3"
  DETAILS["$1:$2"]="$4"
}

extract_text() { "$HOME/.config/opencode/.venv/bin/python" "$EXTRACT_PY" < "$1"; }

ATTEMPT_RESULT=""
ATTEMPT_DETAIL=""

run_prompt_attempt() { # v idx current_bin — sets ATTEMPT_RESULT / ATTEMPT_DETAIL
  local v="$1" idx="$2" bin="$3" id marker verify text
  id="${PROMPT_IDS[$idx]}"
  marker="${PROMPT_MARKERS[$idx]}"
  verify="${PROMPT_VERIFY[$idx]}"
  text="${PROMPT_TEXTS[$idx]}"

  # Remove the probe file first so post-run verification reflects THIS run.
  if [ -n "$verify" ]; then
    rm -f "${verify%%::*}"
  fi

  local out_file err_file rc=0
  out_file="$(mktemp)"
  err_file="$(mktemp)"

  set +e
  (cd "$(project_dir)" \
    && timeout "$PANTHEON_PROMPT_TIMEOUT" "$bin" run --auto --format json "$text") \
    > "$out_file" 2> "$err_file"
  rc=$?
  set -e

  local extracted
  extracted="$(extract_text "$out_file" || true)"
  local raw
  raw="$( { tr '\n' ' ' < "$out_file"; tr '\n' ' ' < "$err_file"; } | cut -c1-400)"
  rm -f "$out_file" "$err_file"

  if [ "$rc" -eq 124 ]; then
    ATTEMPT_RESULT="FAIL"
    ATTEMPT_DETAIL="timeout after ${PANTHEON_PROMPT_TIMEOUT}s"
  elif [ "$rc" -ne 0 ]; then
    ATTEMPT_RESULT="FAIL"
    ATTEMPT_DETAIL="marker $marker absent; exit $rc; snippet: $(printf '%s' "$raw" | cut -c1-160)"
  elif printf '%s' "$extracted" | grep -q "$marker"; then
    ATTEMPT_RESULT="PASS"
    ATTEMPT_DETAIL="marker $marker found"
  elif [ -n "$verify" ] \
    && [ "$(cat "${verify%%::*}" 2>/dev/null)" = "${verify##*::}" ]; then
    ATTEMPT_RESULT="PASS"
    ATTEMPT_DETAIL="probe file verified: ${verify%%::*} contains ${verify##*::}"
  else
    ATTEMPT_RESULT="FAIL"
    ATTEMPT_DETAIL="marker $marker absent; rc=$rc; snippet: $(printf '%s' "$raw" | cut -c1-160)"
  fi
}

run_prompt() { # v idx current_bin — exactly one attempt
  local v="$1" idx="$2" bin="$3" id
  id="${PROMPT_IDS[$idx]}"
  run_prompt_attempt "$v" "$idx" "$bin"
  record "$v" "$id" "$ATTEMPT_RESULT" "$ATTEMPT_DETAIL"
}

check_mcp_list() { # v
  local v="$1" bin out connected_count rc=0 last_out='' last_rc=0
  local list_file list_pid final_file final_pid final_rc
  if ! bin="$(sandbox_bin)"; then
    record "$v" "mcp-list" "FAIL" "binary not installed in sandbox prefix"
    return 0
  fi
  if ! start_v2_service "$bin" "$(project_dir)"; then
    record "$v" "mcp-list" "FAIL" "V2 service did not become healthy"
    return 0
  fi

  # Start the loader-triggering command before waiting for handshakes. The
  # previous order waited on log lines that `mcp list` itself had to create.
  list_file="$(mktemp "$SANDBOX_ROOT/v2-mcp-list.XXXXXX")"
  (cd "$(project_dir)" && timeout --foreground "$V2_MCP_LIST_TIMEOUT" "$bin" mcp list) \
    >"$list_file" 2>&1 &
  list_pid=$!
  if ! wait_for_v2_mcp_registrations "$(project_dir)/.opencode" "$(project_dir)/.venv/bin/python3"; then
    kill "$list_pid" 2>/dev/null || true
    wait "$list_pid" 2>/dev/null || true
    rm -f "$list_file"
    record "$v" "mcp-list" "FAIL" "MCP registrations did not match the active sandbox"
    return 0
  fi
  if wait_for_v2_handshakes; then
    :
  else
    kill "$list_pid" 2>/dev/null || true
    wait "$list_pid" 2>/dev/null || true
    rm -f "$list_file"
    record "$v" "mcp-list" "FAIL" "MCP handshakes did not become ready after mcp list started"
    return 0
  fi
  if wait "$list_pid"; then
    rc=0
  else
    rc=$?
  fi
  out="$(cat "$list_file")"
  rm -f "$list_file"
  connected_count="$(printf '%s' "$out" | grep -Eic '(^|[^[:alnum:]_])connected([^[:alnum:]_]|$)' || true)"
  if [ "$rc" -eq 0 ] && [ "$connected_count" -ne 5 ]; then
    # The first beta `mcp list` call triggers loading and can return before the
    # service catalog is populated. Re-query only after registrations and
    # handshakes have proved the active five servers.
    final_file="$(mktemp "$SANDBOX_ROOT/v2-mcp-list.XXXXXX")"
    (cd "$(project_dir)" && timeout --foreground "$V2_MCP_LIST_TIMEOUT" "$bin" mcp list) \
      >"$final_file" 2>&1 &
    final_pid=$!
    if wait "$final_pid"; then
      final_rc=0
    else
      final_rc=$?
    fi
    out="$(cat "$final_file")"
    rm -f "$final_file"
    if [ "$final_rc" -ne 0 ]; then
      rc="$final_rc"
    fi
  fi
  out="$(printf '%s' "$out" | sed -E $'s/\x1B\\[[0-?]*[ -/]*[@-~]//g')"
  last_out="$out"
  last_rc="$rc"
  connected_count="$(printf '%s' "$out" | grep -Eic '(^|[^[:alnum:]_])connected([^[:alnum:]_]|$)' || true)"
  if [ "$rc" -eq 0 ] \
    && [ "$connected_count" -eq 5 ] \
    && ! printf '%s' "$out" | grep -Eiq 'failed|✘' \
    && printf '%s' "$out" | grep -Fq 'pantheon-code-mode' \
    && printf '%s' "$out" | grep -Fq 'pantheon-memory' \
    && printf '%s' "$out" | grep -Fq 'pantheon-persistence' \
    && printf '%s' "$out" | grep -Fq 'pantheon-resources' \
    && printf '%s' "$out" | grep -Fq 'pantheon-vision'; then
    printf '%s\n' "$out"
    record "$v" "mcp-list" "PASS" "exactly 5 connected MCPs"
    return 0
  fi

  printf '%s\n' '--- mcp list output (last attempt) ---' >&2
  printf '%s\n' "$last_out" >&2
  printf 'mcp list exit=%s; connected=%s; expected exactly 5\n' \
    "$last_rc" "$connected_count" >&2
  print_v2_diagnostics
  record "$v" "mcp-list" "FAIL" \
    "expected exactly 5 connected MCPs; last exit $last_rc found $connected_count"
}

check_doctor() { # v
  local v="$1" pan rc=0 doctor_output=''
  if ! pan="$(sandbox_bin_for "pantheon-opencode")"; then
    record "$v" "doctor" "FAIL" "pantheon-opencode not installed in sandbox prefix"
    return 0
  fi
  if doctor_output="$(cd "$(project_dir)" && "$pan" doctor --target "$(project_dir)" 2>&1)"; then
    rc=0
  else
    rc=$?
  fi
  if [ "$rc" -eq 0 ]; then
    record "$v" "doctor" "PASS" "exit 0"
  else
    printf '%s\n' '--- doctor output ---' >&2
    printf '%s\n' "$doctor_output" >&2
    record "$v" "doctor" "FAIL" "doctor exited $rc (blocking errors)"
  fi
}

installed_package_root() {
  local pan resolved
  if ! pan="$(sandbox_bin_for "pantheon-opencode")"; then
    return 1
  fi
  resolved="$(readlink -f "$pan" 2>/dev/null || true)"
  [ -n "$resolved" ] || return 1
  dirname "$(dirname "$resolved")"
}

run_cost_probe() { # v
  local v="$1" package_root probe raw status detail
  if ! package_root="$(installed_package_root)"; then
    record "$v" "pantheon-cost" "FAIL" "sandbox package is not installed"
    return 0
  fi
  probe="$package_root/scripts/probe-pantheon-cost.mjs"
  if [ ! -f "$probe" ]; then
    record "$v" "pantheon-cost" "FAIL" "installed package has no offline cost probe"
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    record "$v" "pantheon-cost" "FAIL" "node runtime is not available"
    return 0
  fi
  set +e
  raw="$(node "$probe" --version "$v" --fixture --json 2>&1)"
  local rc=$?
  set -e
  case "$raw" in
    *'"status":"PASS"'*) status="PASS" ;;
    *'"status":"NOT_TESTED"'*) status="FAIL" ;;
    *'"status":"AMBIENTAL"'*) status="FAIL" ;;
    *) status="FAIL" ;;
  esac
  detail="$(printf '%s' "$raw" | tr '\n' ' ' | cut -c1-400)"
  if [ "$rc" -ne 0 ] && [ "$status" = "PASS" ]; then
    status="FAIL"
    detail="$detail (probe exit $rc)"
  elif [ "$rc" -ne 0 ] && [ "$status" != "FAIL" ]; then
    detail="$detail (probe exit $rc)"
  fi
  record "$v" "pantheon-cost" "$status" "$detail"
}

run_rehydrate_probe() { # v
  local v="$1" package_root probe raw status detail
  if ! package_root="$(installed_package_root)"; then
    record "$v" "context-rehydrate" "FAIL" "sandbox package is not installed"
    return 0
  fi
  probe="$package_root/scripts/probe-context-rehydrate.mjs"
  if [ ! -f "$probe" ]; then
    record "$v" "context-rehydrate" "FAIL" "installed package has no offline context probe"
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    record "$v" "context-rehydrate" "FAIL" "node runtime is not available"
    return 0
  fi
  set +e
  raw="$(timeout 30 node "$probe" --version "$v" --json 2>&1)"
  local rc=$?
  set -e
  case "$raw" in
    *'"status":"PASS"'*) status="PASS" ;;
    *'"status":"NOT_TESTED"'*) status="FAIL" ;;
    *'"status":"AMBIENTAL"'*) status="FAIL" ;;
    *) status="FAIL" ;;
  esac
  detail="$(printf '%s' "$raw" | tr '\n' ' ' | cut -c1-400)"
  if [ "$rc" -eq 124 ]; then
    status="FAIL"
    detail="context probe timed out after 30s"
  elif [ "$rc" -ne 0 ] && [ "$status" = "PASS" ]; then
    # A non-zero probe exit must never be reported as PASS.
    status="FAIL"
    detail="$detail (probe exit $rc)"
  elif [ "$rc" -ne 0 ] && [ "$status" != "FAIL" ]; then
    detail="$detail (probe exit $rc)"
  fi
  record "$v" "context-rehydrate" "$status" "$detail"
}

run_version_prompts() { # v
  local v="$1" bin
  if ! bin="$(sandbox_bin)"; then
    log "Binary '$V2_BIN' not in sandbox prefix — failing all $v checks."
    build_battery "$v"
    local i
    for i in "${!PROMPT_IDS[@]}"; do
      record "$v" "${PROMPT_IDS[$i]}" "FAIL" "binary $V2_BIN not installed in sandbox"
    done
    record "$v" "mcp-list" "FAIL" "binary $V2_BIN not installed in sandbox"
    record "$v" "doctor" "FAIL" "binary $V2_BIN not installed in sandbox"
    return 0
  fi
  prepare_project "$v"
  build_battery "$v"
  # check_mcp_list owns service startup and must launch `mcp list` before it
  # waits for the five MCP handshakes. Starting a service and waiting here
  # would recreate the V2 loader deadlock before the battery even begins.
  check_mcp_list "$v"
  local i
  for i in "${!PROMPT_IDS[@]}"; do
    log "[$v] prompt ${PROMPT_IDS[$i]} ..."
    run_prompt "$v" "$i" "$bin"
    log "[$v] prompt ${PROMPT_IDS[$i]} → ${RESULTS["$v:${PROMPT_IDS[$i]}"]}"
  done
  check_doctor "$v"
}

probe_verdict() { # pass total → PASS when every required check was explicitly PASS
  local pass="$1" total="$2"
  if [ "$pass" -eq "$total" ] && [ "$pass" -gt 0 ]; then
    printf 'PASS'
  else
    printf 'FAIL'
  fi
}

write_report() { # versions...
  local versions=("$@") total_fail=0 total_pass=0
  {
    printf '# Pantheon Sandbox Prompts Report\n\n'
    printf -- '- **Date:** %s\n' "$(date -u '+%Y-%m-%d %H:%M UTC')"
    printf -- '- **Model:** %s\n' "$PANTHEON_SANDBOX_MODEL"
    printf -- '- **Sandbox:** %s\n' "$SANDBOX_ROOT"
    printf -- '- **V2 binary:** %s (%s)\n\n' \
      "$V2_BIN" "$OPENCODE_V2_SPEC"
    local v id res
    for v in "${versions[@]}"; do
      printf '## Version %s (`%s`)\n\n' "$v" "$V2_BIN"
      printf '| Prompt | Result | Detail |\n|---|---|---|\n'
      for id in "${PROMPT_IDS[@]}" mcp-list doctor; do
        res="${RESULTS["$v:$id"]:-SKIP}"
        case "$res" in
        PASS) total_pass=$((total_pass + 1)) ;;
        *) total_fail=$((total_fail + 1)) ;;
        esac
        printf '| %s | %s | %s |\n' "$id" "$res" "${DETAILS["$v:$id"]:-—}"
      done
      printf '\n'
    done
    printf '## Summary\n\n'
    printf -- '- PASS: %d\n- Not PASS (blocking): %d\n\n' \
      "$total_pass" "$total_fail"
    printf '**Verdict: %s**\n' "$(probe_verdict "$total_pass" "$((total_pass + total_fail))")"
  } > "$REPORT_FILE"
  log "Report written to $REPORT_FILE"
}

write_cost_report() { # versions...
  local versions=("$@") total_fail=0 total_pass=0
  {
    printf '# Pantheon Cost Probe Report\n\n'
    printf -- '- **Date:** %s\n' "$(date -u '+%Y-%m-%d %H:%M UTC')"
    printf -- '- **Sandbox:** %s\n\n' "$SANDBOX_ROOT"
    printf '| Version | Result | Detail |\n|---|---|---|\n'
    local v result
    for v in "${versions[@]}"; do
      result="${RESULTS["$v:pantheon-cost"]:-NOT_TESTED}"
      case "$result" in
        PASS) total_pass=$((total_pass + 1)) ;;
        *) total_fail=$((total_fail + 1)) ;;
      esac
      printf '| %s | %s | %s |\n' "$v" "$result" "${DETAILS["$v:pantheon-cost"]:-—}"
    done
    printf '\n## Summary\n\n'
    printf -- '- PASS: %d\n- Not PASS (blocking): %d\n\n' \
      "$total_pass" "$total_fail"
    printf '**Verdict: %s**\n' "$(probe_verdict "$total_pass" "$((total_pass + total_fail))")"
  } > "$COST_REPORT_FILE"
  log "Cost probe report written to $COST_REPORT_FILE"
}

write_rehydrate_report() { # versions...
  local versions=("$@") total_fail=0 total_pass=0
  {
    printf '# Pantheon Context Rehydration Probe Report\n\n'
    printf -- '- **Date:** %s\n' "$(date -u '+%Y-%m-%d %H:%M UTC')"
    printf -- '- **Sandbox:** %s\n\n' "$SANDBOX_ROOT"
    printf '| Version | Probe | Result | Detail |\n|---|---|---|---|\n'
    local v result
    for v in "${versions[@]}"; do
      result="${RESULTS["$v:context-rehydrate"]:-NOT_TESTED}"
      case "$result" in
        PASS) total_pass=$((total_pass + 1)) ;;
        *) total_fail=$((total_fail + 1)) ;;
      esac
      printf '| %s | context_rehydrate + context_session_summary | %s | %s |\n' \
        "$v" "$result" "${DETAILS["$v:context-rehydrate"]:-—}"
    done
    printf '\n## Summary\n\n'
    printf -- '- PASS: %d\n- Not PASS (blocking): %d\n\n' \
      "$total_pass" "$total_fail"
    printf '**Verdict: %s**\n' "$(probe_verdict "$total_pass" "$((total_pass + total_fail))")"
  } > "$REHYDRATE_REPORT_FILE"
  log "Context probe report written to $REHYDRATE_REPORT_FILE"
}

run_cost() { # versions...
  local versions=("$@") v fail=0
  mkdir -p "$SANDBOX_ROOT"
  for v in "${versions[@]}"; do
    log "[$v] pantheon_cost offline probe ..."
    run_cost_probe "$v"
    log "[$v] pantheon-cost → ${RESULTS["$v:pantheon-cost"]}"
  done
  write_cost_report "${versions[@]}"
  for v in "${versions[@]}"; do
    [ "${RESULTS["$v:pantheon-cost"]:-}" = "PASS" ] || fail=$((fail + 1))
  done
  if [ "$fail" -gt 0 ]; then
    log "Cost probe: $fail check(s) without explicit PASS."
    exit 1
  fi
  log "Cost probe: PASS."
}

run_rehydrate() { # versions...
  local versions=("$@") v fail=0
  mkdir -p "$SANDBOX_ROOT"
  for v in "${versions[@]}"; do
    log "[$v] context_rehydrate/session_summary offline probe ..."
    run_rehydrate_probe "$v"
    log "[$v] context probe → ${RESULTS["$v:context-rehydrate"]}"
  done
  write_rehydrate_report "${versions[@]}"
  for v in "${versions[@]}"; do
    [ "${RESULTS["$v:context-rehydrate"]:-}" = "PASS" ] || fail=$((fail + 1))
  done
  if [ "$fail" -gt 0 ]; then
    log "Context probe: $fail check(s) without explicit PASS."
    exit 1
  fi
  log "Context probe: PASS."
}

# ── Hook canary (proves callbacks FIRE, not just that a plugin loaded) ────────

run_hooks() {
  local bin agent
  if ! bin="$(sandbox_bin)"; then
    printf 'ERROR: sandbox not prepared for hooks (binary '\''%s'\'' missing) — run %s --prepare first\n' \
      "$V2_BIN" "$0" >&2
    exit 3
  fi
  agent="${PANTHEON_HOOK_CANARY_AGENT:-canary}"
  log "[hooks] V2 hook canary against $bin (model $PANTHEON_SANDBOX_MODEL, agent $agent) ..."
  # PANTHEON_HOOK_CANARY_MODE=real is the point of this path: it makes the host
  # load src/plugin-v2.ts itself, so a hook that registers under a dead name
  # fails here. Default `fixture` mode only proves the hook NAMES are real, so
  # without this the sandbox would never exercise the shipped plugin.
  if PANTHEON_HOOK_CANARY_BIN="$bin" \
    PANTHEON_HOOK_CANARY_MODEL="$PANTHEON_SANDBOX_MODEL" \
    PANTHEON_HOOK_CANARY_AGENT="$agent" \
    PANTHEON_HOOK_CANARY_MODE=real \
    node --test "$REPO_DIR/tests/pantheon/plugin-v2-hook-canary.test.mjs"; then
    log "Hook canary: PASS."
  else
    log "Hook canary: FAIL."
    exit 1
  fi
}

run_battery() { # versions...
  local versions=("$@")
  mkdir -p "$SANDBOX_ROOT"
  write_extract_py
  local v
  for v in "${versions[@]}"; do
    run_version_prompts "$v"
  done
  write_report "${versions[@]}"
  local v fail=0 id
  for v in "${versions[@]}"; do
    for id in "${PROMPT_IDS[@]}" mcp-list doctor; do
      [ "${RESULTS["$v:$id"]:-}" = "PASS" ] || fail=$((fail + 1))
    done
  done
  if [ "$fail" -gt 0 ]; then
    log "Prompts battery: $fail check(s) without explicit PASS."
    exit 1
  fi
  log "Prompts battery: PASS."
}

# ── Base validation (no prompts) ──────────────────────────────────────────────

run_base() { # v
  local v="$1" bin
  if ! bin="$(sandbox_bin)"; then
    printf 'ERROR: sandbox not prepared for %s (binary '\''%s'\'' missing from sandbox prefix) — run %s --prepare first\n' \
      "$v" "$V2_BIN" "$0" >&2
    exit 3
  fi
  prepare_project "$v"
  build_battery "$v"
  log "[$v] opencode mcp list"
  check_mcp_list "$v"
  log "[$v] mcp-list → ${RESULTS["$v:mcp-list"]}"
  log "[$v] doctor"
  check_doctor "$v"
  log "[$v] doctor → ${RESULTS["$v:doctor"]}"
  local fail=0
  [ "${RESULTS["$v:mcp-list"]}" = "PASS" ] || fail=$((fail + 1))
  [ "${RESULTS["$v:doctor"]}" = "PASS" ] || fail=$((fail + 1))
  if [ "$fail" -gt 0 ]; then
    log "Base validation $v: $fail check(s) without explicit PASS."
    exit 1
  fi
  log "Base validation $v: PASS."
}

# ── CLI ───────────────────────────────────────────────────────────────────────

while [ $# -gt 0 ]; do
  case "$1" in
    --prepare) MODE_PREPARE=1 ;;
    --reset) MODE_RESET=1 ;;
    --prompts) MODE_PROMPTS=1 ;;
    --cost) MODE_COST=1 ;;
    --rehydrate) MODE_REHYDRATE=1 ;;
    --hooks) MODE_HOOKS=1 ;;
    --run)
      shift
      case "${1:-}" in
        v2) RUN_VERSION="$1" ;;
        v1)
          printf 'ERROR: the V1 leg was removed — this project is OpenCode V2-exclusive.\n' >&2
          exit 2
          ;;
        *) usage ;;
      esac
      ;;
    --help | -h) usage ;;
    *) usage ;;
  esac
  shift
done

if [ "$MODE_RESET" -eq 1 ]; then
  cmd_reset
  exit 0
fi

if [ "$MODE_PREPARE" -eq 0 ] && [ -z "$RUN_VERSION" ] \
  && [ "$MODE_PROMPTS" -eq 0 ] && [ "$MODE_COST" -eq 0 ] \
  && [ "$MODE_REHYDRATE" -eq 0 ] && [ "$MODE_HOOKS" -eq 0 ]; then
  usage
fi

if [ "$MODE_PREPARE" -eq 1 ]; then
  cmd_prepare
fi

if [ -n "$RUN_VERSION" ]; then
  if [ "$MODE_PROMPTS" -eq 1 ]; then
    sandbox_env
    run_battery "$RUN_VERSION"
  else
    sandbox_env
    run_base "$RUN_VERSION"
  fi
  if [ "$MODE_COST" -eq 1 ]; then
    sandbox_env
    run_cost "$RUN_VERSION"
  fi
  if [ "$MODE_REHYDRATE" -eq 1 ]; then
    sandbox_env
    run_rehydrate "$RUN_VERSION"
  fi
  if [ "$MODE_HOOKS" -eq 1 ]; then
    sandbox_env
    run_hooks
  fi
elif [ "$MODE_PROMPTS" -eq 1 ]; then
  sandbox_env
  run_battery "$TARGET_VERSION"
  if [ "$MODE_COST" -eq 1 ]; then
    run_cost "$TARGET_VERSION"
  fi
  if [ "$MODE_REHYDRATE" -eq 1 ]; then
    run_rehydrate "$TARGET_VERSION"
  fi
  if [ "$MODE_HOOKS" -eq 1 ]; then
    run_hooks
  fi
elif [ "$MODE_COST" -eq 1 ]; then
  sandbox_env
  run_cost "$TARGET_VERSION"
  if [ "$MODE_REHYDRATE" -eq 1 ]; then
    run_rehydrate "$TARGET_VERSION"
  fi
  if [ "$MODE_HOOKS" -eq 1 ]; then
    run_hooks
  fi
elif [ "$MODE_REHYDRATE" -eq 1 ]; then
  sandbox_env
  rehydrate_status=0
  # run_rehydrate exits when its check fails; isolate it so the separately
  # requested hook canary still runs, then return a failing status afterward.
  (run_rehydrate "$TARGET_VERSION") || rehydrate_status=$?
  hooks_status=0
  if [ "$MODE_HOOKS" -eq 1 ]; then
    (run_hooks) || hooks_status=$?
  fi
  if [ "$rehydrate_status" -ne 0 ]; then
    exit "$rehydrate_status"
  fi
  if [ "$hooks_status" -ne 0 ]; then
    exit "$hooks_status"
  fi
elif [ "$MODE_HOOKS" -eq 1 ]; then
  sandbox_env
  run_hooks
fi
