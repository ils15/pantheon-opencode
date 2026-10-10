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
#                            checkout this script lives in). Must be an existing
#                            Pantheon checkout; used consistently by prepare,
#                            generated run-test.sh and --reset guards.
#   PANTHEON_V2_PORT         Dedicated loopback port (default: 49376). The
#                            harness fails if it is invalid or already bound;
#                            it never stops or reuses an existing service.
#   PANTHEON_V2_HOST         IPv4 loopback IP for the V2 service (default:
#                            127.0.0.1); non-loopback addresses are rejected.
#   PANTHEON_V2_MCP_LIST_TIMEOUT
#                            Per-call `opencode mcp list` timeout in seconds
#                            (default: 15).
#   PANTHEON_SANDBOX_MODEL   Model used by init/prompts
#                            (default: opencode-go/mimo-v2.5)
#   PANTHEON_PROMPT_TIMEOUT  Per-prompt timeout in seconds (default: 300)
# Exit codes: 0 = every required check returned explicit PASS,
#             1 = any failure or untested check (see reports in the sandbox root),
#             2 = usage error, 3 = sandbox not prepared.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Derived from this script's own location so the sandbox is always built from
# the checkout that CONTAINS this harness. It must never be inferred from a
# sibling directory: a sibling may be a different checkout (or a different
# branch) with unrelated uncommitted work. Package tarballs are written only to
# an isolated temporary directory inside the selected sandbox.
SCRIPT_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
REPO_DIR="$SCRIPT_REPO_DIR"

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
# These locations are intentionally fixed inside the sandbox. External config
# and database overrides could make prepare/run write outside the safe root.
V2_CONFIG="$SANDBOX_ROOT/project-v2/opencode.json"
V2_DB="$SANDBOX_ROOT/opencode-v2.db"
unset PANTHEON_V2_CONFIG PANTHEON_V2_DB
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

resolve_harness_repo() {
  local requested_repo="${PANTHEON_REPO:-$SCRIPT_REPO_DIR}"
  [ -n "$requested_repo" ] \
    || die "PANTHEON_REPO must not be empty"
  case "$requested_repo" in
    /*) ;;
    *) die "PANTHEON_REPO must be an absolute path (got: $requested_repo)" ;;
  esac
  [ -d "$requested_repo" ] \
    || die "PANTHEON_REPO path does not exist or is not a directory: $requested_repo"
  REPO_DIR="$(cd -P -- "$requested_repo" 2>/dev/null && pwd -P)" \
    || die "cannot resolve PANTHEON_REPO path: $requested_repo"
  [ -f "$REPO_DIR/package.json" ] \
    || die "PANTHEON_REPO is not a Pantheon package checkout (package.json missing): $REPO_DIR"
  node -e 'if (require(process.argv[1]).name !== "pantheon-opencode") process.exit(1)' \
    "$REPO_DIR/package.json" \
    || die "PANTHEON_REPO package name must be pantheon-opencode: $REPO_DIR"
}

project_dir() { printf '%s/project-%s' "$SANDBOX_ROOT" "$TARGET_VERSION"; }

validate_v2_port() {
  local port_number
  [[ "$V2_PORT" =~ ^[0-9]{1,5}$ ]] \
    || die "PANTHEON_V2_PORT must be an integer from 1 through 65535 (got '$V2_PORT')"
  port_number=$((10#$V2_PORT))
  [ "$port_number" -ge 1 ] && [ "$port_number" -le 65535 ] \
    || die "PANTHEON_V2_PORT must be an integer from 1 through 65535 (got '$V2_PORT')"
  V2_PORT="$port_number"
}

assert_v2_port_available() {
  validate_v2_port
  if ! python3 - "$V2_LOOPBACK_HOST" "$V2_PORT" <<'PY'
import ipaddress
import socket
import sys

host, raw_port = sys.argv[1], sys.argv[2]
try:
    address = ipaddress.ip_address(host)
    if not address.is_loopback or address.version != 4:
        raise ValueError("host must be an IPv4 loopback IP address")
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind((host, int(raw_port)))
except (OSError, ValueError) as exc:
    print(f"cannot bind dedicated V2 port {host}:{raw_port}: {exc}", file=sys.stderr)
    raise SystemExit(1)
PY
  then
    die "dedicated V2 port $V2_PORT is already in use or unavailable; refusing to reuse or stop an unrelated service"
  fi
}

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
  guard_sandbox_root use
  canonicalize_sandbox_root
  validate_v2_port
  mkdir -p -- "$SANDBOX_ROOT"
  sandbox_path_guard "$SANDBOX_ROOT" dir-check
  sandbox_path_guard "$SANDBOX_HOME" dir-create
  sandbox_path_guard "$NPM_PREFIX" dir-create
  sandbox_path_guard "$SANDBOX_HOME/.npm-cache" dir-create
  sandbox_path_guard "$SANDBOX_HOME/.config" dir-create
  sandbox_path_guard "$SANDBOX_HOME/.config/opencode" dir-create
  sandbox_path_guard "$SANDBOX_HOME/.config/xdg" dir-create
  sandbox_path_guard "$SANDBOX_HOME/.local/share" dir-create
  sandbox_path_guard "$SANDBOX_HOME/.local/share/opencode" dir-create
  sandbox_path_guard "$SANDBOX_HOME/.local/share/xdg" dir-create
  sandbox_path_guard "$SANDBOX_HOME/.local/state" dir-create
  sandbox_path_guard "$SANDBOX_HOME/.local/state/opencode" dir-create
  sandbox_path_guard "$SANDBOX_HOME/.cache" dir-create
  sandbox_path_guard "$SANDBOX_HOME/.cache/opencode" dir-create
  sandbox_path_guard "$SANDBOX_HOME/.opencode" dir-create
  sandbox_path_guard "$V2_CONFIG" file-allow-missing-parent
  sandbox_path_guard "$V2_DB" file-allow-missing-parent
  export HOME="$SANDBOX_HOME"
  export PATH="$NPM_PREFIX/bin:$HOME/.config/opencode/.venv/bin:$PATH"
  export npm_config_prefix="$NPM_PREFIX"
  export npm_config_cache="$SANDBOX_HOME/.npm-cache"
  export XDG_CONFIG_HOME="$SANDBOX_HOME/.config"
  export XDG_CONFIG_DIRS="$SANDBOX_HOME/.config/xdg"
  export XDG_DATA_HOME="$SANDBOX_HOME/.local/share"
  export XDG_DATA_DIRS="$SANDBOX_HOME/.local/share/xdg"
  export XDG_STATE_HOME="$SANDBOX_HOME/.local/state"
  export XDG_CACHE_HOME="$SANDBOX_HOME/.cache"
  # Do not inherit an OpenChamber/developer-machine config selector. The V2
  # project config is created by prepare_project and is the only config this
  # gate is allowed to inspect.
  export OPENCODE_CONFIG_DIR="$(dirname "$V2_CONFIG")"
  export OPENCODE_DB="$V2_DB"
  export PANTHEON_V2_PORT="$V2_PORT"
  export PORT="$V2_PORT"
  unset OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT OPENCODE_CONFIG_PROJECT_DISABLE \
    OPENCODE_DATA_DIR OPENCODE_STATE_DIR OPENCODE_CACHE_DIR OPENCODE_STORAGE_PATH
  sandbox_path_guard "$V2_SERVICE_STATE" file-allow-missing-parent
  sandbox_path_guard "$(dirname "$V2_SERVICE_STATE")" dir-create
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
    "code_mode.py",
    "memory_mcp.py",
    "mcp_persistence.py",
    "mcp_resources.py",
    "pantheon_vision.py",
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
  validate_v2_port

  # Never attach to an unrelated service on the dedicated port. A successful
  # health probe before our process starts is an environmental collision, not
  # a reason to silently reuse that service.
  if curl --fail --silent --show-error --max-time 1 \
    "http://$V2_LOOPBACK_HOST:${V2_PORT}/global/health" >/dev/null 2>&1; then
    die "dedicated V2 port ${V2_PORT} is already in use; refusing to reuse an unrelated service"
  fi
  assert_v2_port_available

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

# Node's compile cache is disposable, but tmp/ can also contain runtime state
# and human handoffs. Expire only hash-named cache files owned by this user after
# 30 days; never recurse through links or prune any other tmp/ entry.
cleanup_sandbox_tmp() {
  local cache_dir="$SANDBOX_ROOT/tmp/node-compile-cache" cache_file cache_name owner
  [ -d "$SANDBOX_ROOT/tmp" ] && [ ! -L "$SANDBOX_ROOT/tmp" ] || return 0
  [ -d "$cache_dir" ] && [ ! -L "$cache_dir" ] || return 0
  owner="$(id -un)" || return 0
  while IFS= read -r -d '' cache_file; do
    cache_name="${cache_file##*/}"
    if [[ "$cache_name" =~ ^[[:xdigit:]]{8}$ ]]; then
      rm -f -- "$cache_file"
    fi
  done < <(find "$cache_dir" -xdev -type f -user "$owner" -mtime +30 -print0)
}

write_run_test_sh() {
  canonicalize_sandbox_root
  mkdir -p -- "$SANDBOX_ROOT"
  sandbox_path_guard "$SANDBOX_ROOT" dir-check
  sandbox_path_guard "$SANDBOX_ROOT/.repo-dir" replace-file
  sandbox_path_guard "$SANDBOX_ROOT/run-test.sh" replace-file
  # Keep the path in a regular data file instead of shell source. Write it
  # atomically so an interrupted prepare cannot leave a truncated .repo-dir.
  local repo_file_tmp run_test_tmp
  repo_file_tmp="$(mktemp "$SANDBOX_ROOT/.repo-dir.XXXXXX")" \
    || die "cannot create temporary .repo-dir"
  if ! printf '%s\n' "$REPO_DIR" > "$repo_file_tmp"; then
    rm -f -- "$repo_file_tmp"
    die "cannot write temporary .repo-dir"
  fi
  atomic_replace_file "$repo_file_tmp" "$SANDBOX_ROOT/.repo-dir" 0600 \
    || die "cannot atomically replace .repo-dir"
  run_test_tmp="$(mktemp "$SANDBOX_ROOT/.run-test.sh.XXXXXX")" \
    || die "cannot create temporary run-test.sh"
  if ! cat > "$run_test_tmp" <<'RUNTEST'
#!/usr/bin/env bash
# Generated by pantheon-opencode scripts/test-opencode-v2-sandbox.sh --prepare
# Validates the global install: the V2 binary, exactly 5 connected MCPs, doctor
# 0 errors, AND the CONTENT of pantheon://agents (zeus/hermes present).
set -euo pipefail

SANDBOX_DIR="$(cd "$(dirname "$0")" && pwd -P)"
SANDBOX_HOME="$SANDBOX_DIR/home"
NPM_PREFIX="$SANDBOX_HOME/.npm-global"
PANTHEON_GLOBAL="$SANDBOX_HOME/.config/opencode"
SANDBOX_VENV="$PANTHEON_GLOBAL/.venv"
export HOME="$SANDBOX_HOME"
export PATH="$NPM_PREFIX/bin:$SANDBOX_VENV/bin:$PATH"
export npm_config_prefix="$NPM_PREFIX"
export npm_config_cache="$SANDBOX_HOME/.npm-cache"
export XDG_CONFIG_HOME="$SANDBOX_HOME/.config"
export XDG_CONFIG_DIRS="$SANDBOX_HOME/.config/xdg"
export XDG_DATA_HOME="$SANDBOX_HOME/.local/share"
export XDG_DATA_DIRS="$SANDBOX_HOME/.local/share/xdg"
export XDG_STATE_HOME="$SANDBOX_HOME/.local/state"
export XDG_CACHE_HOME="$SANDBOX_HOME/.cache"
# The V2 CLI resolves `mcp list` through its service. Keep generated sandbox
# runs isolated from any config/database/port inherited from the host.
V2_CONFIG="$SANDBOX_DIR/project-v2/opencode.json"
V2_DB="$SANDBOX_DIR/opencode-v2.db"
V2_PORT="${PANTHEON_V2_PORT:-49376}"
V2_LOOPBACK_HOST="${PANTHEON_V2_HOST:-127.0.0.1}"
V2_HANDSHAKE_TIMEOUT="${PANTHEON_V2_HANDSHAKE_TIMEOUT:-60}"
V2_MCP_LIST_TIMEOUT="${PANTHEON_V2_MCP_LIST_TIMEOUT:-15}"
V2_SERVER_LOG="$SANDBOX_DIR/v2-server.log"
V2_SERVICE_STATE="$SANDBOX_HOME/.local/state/opencode/service.json"
V2_SERVER_PID=""

resolve_sandbox_repo() {
  local requested_repo resolved_repo repo_file
  if [ -n "${PANTHEON_REPO:-}" ]; then
    requested_repo="$PANTHEON_REPO"
  else
    repo_file="$SANDBOX_DIR/.repo-dir"
    [ -f "$repo_file" ] && [ ! -L "$repo_file" ] \
      || { printf 'ERROR: sandbox .repo-dir is missing or not a regular file: %s\n' "$repo_file" >&2; return 1; }
    IFS= read -r requested_repo < "$repo_file" \
      || { printf 'ERROR: sandbox .repo-dir is empty or unreadable: %s\n' "$repo_file" >&2; return 1; }
  fi
  [ -n "$requested_repo" ] \
    || { printf 'ERROR: repository path is empty (PANTHEON_REPO/.repo-dir)\n' >&2; return 1; }
  case "$requested_repo" in
    /*) ;;
    *) printf 'ERROR: repository path must be absolute: %s\n' "$requested_repo" >&2; return 1 ;;
  esac
  [ -d "$requested_repo" ] \
    || { printf 'ERROR: repository path does not exist or is not a directory: %s\n' "$requested_repo" >&2; return 1; }
  resolved_repo="$(cd -P -- "$requested_repo" 2>/dev/null && pwd -P)" \
    || { printf 'ERROR: cannot resolve repository path: %s\n' "$requested_repo" >&2; return 1; }
  [ -f "$resolved_repo/package.json" ] \
    || { printf 'ERROR: repository package.json is missing: %s\n' "$resolved_repo" >&2; return 1; }
  node -e 'if (require(process.argv[1]).name !== "pantheon-opencode") process.exit(1)' \
    "$resolved_repo/package.json" \
    || { printf 'ERROR: repository package name must be pantheon-opencode: %s\n' "$resolved_repo" >&2; return 1; }
  printf '%s\n' "$resolved_repo"
}

path_is_same_or_descendant() {
  local candidate="$1" parent="$2"
  [ "$candidate" = "$parent" ] && return 0
  [ "$parent" = "/" ] && [[ "$candidate" = /* ]] && return 0
  case "$candidate" in "$parent"/*) return 0 ;; esac
  return 1
}

validate_v2_port() {
  local port_number
  [[ "$V2_PORT" =~ ^[0-9]{1,5}$ ]] \
    || { printf "ERROR: PANTHEON_V2_PORT must be an integer from 1 through 65535 (got '%s')\n" "$V2_PORT" >&2; return 1; }
  port_number=$((10#$V2_PORT))
  [ "$port_number" -ge 1 ] && [ "$port_number" -le 65535 ] \
    || { printf "ERROR: PANTHEON_V2_PORT must be an integer from 1 through 65535 (got '%s')\n" "$V2_PORT" >&2; return 1; }
  V2_PORT="$port_number"
}

assert_v2_port_available() {
  validate_v2_port || return 1
  python3 - "$V2_LOOPBACK_HOST" "$V2_PORT" <<'PY'
import ipaddress
import socket
import sys

host, raw_port = sys.argv[1], sys.argv[2]
try:
    address = ipaddress.ip_address(host)
    if not address.is_loopback or address.version != 4:
        raise ValueError("host must be an IPv4 loopback IP address")
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind((host, int(raw_port)))
except (OSError, ValueError) as exc:
    print(f"ERROR: dedicated V2 port {host}:{raw_port} is already in use or unavailable; refusing to reuse or stop an unrelated service: {exc}", file=sys.stderr)
    raise SystemExit(1)
PY
}

REPO_DIR="$(resolve_sandbox_repo)" || exit 1
if path_is_same_or_descendant "$SANDBOX_DIR" "$REPO_DIR" \
  || path_is_same_or_descendant "$REPO_DIR" "$SANDBOX_DIR"; then
  printf 'ERROR: sandbox path overlaps the selected repository; refusing to package: sandbox=%s repo=%s\n' \
    "$SANDBOX_DIR" "$REPO_DIR" >&2
  exit 1
fi
validate_v2_port || exit 1
echo "=== Pantheon Sandbox Test (OpenCode V2) ==="
echo "Sandbox: $SANDBOX_DIR"
echo "Repo:    $REPO_DIR"

export OPENCODE_CONFIG_DIR="$(dirname "$V2_CONFIG")"
export OPENCODE_DB="$V2_DB"
export PANTHEON_V2_PORT="$V2_PORT"
export PORT="$V2_PORT"
unset PANTHEON_V2_CONFIG PANTHEON_V2_DB
unset OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT OPENCODE_CONFIG_PROJECT_DISABLE \
  OPENCODE_DATA_DIR OPENCODE_STATE_DIR OPENCODE_CACHE_DIR OPENCODE_STORAGE_PATH

validate_sandbox_paths() {
  SANDBOX_DIR="$SANDBOX_DIR" python3 - <<'PY'
import os
import stat
import sys
from pathlib import Path

root = Path(os.environ["SANDBOX_DIR"])
if root.resolve(strict=True) != root:
    raise SystemExit(f"ERROR: sandbox root is not canonical: {root}")

def validate(path, directory):
    try:
        relative = path.relative_to(root)
    except ValueError:
        raise SystemExit(f"ERROR: sandbox path escaped root: {path}")
    if any(part in ("", ".", "..") for part in relative.parts):
        raise SystemExit(f"ERROR: unsafe sandbox path component: {path}")
    current = root
    for index, part in enumerate(relative.parts):
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            return
        if stat.S_ISLNK(info.st_mode):
            raise SystemExit(f"ERROR: sandbox path contains symlink: {current}")
        is_final = index == len(relative.parts) - 1
        if (not is_final or directory) and not stat.S_ISDIR(info.st_mode):
            raise SystemExit(f"ERROR: sandbox path component is not a directory: {current}")
        if is_final and not directory and not stat.S_ISREG(info.st_mode):
            raise SystemExit(f"ERROR: sandbox output is not a regular file: {current}")
        if current.resolve(strict=True) != current:
            raise SystemExit(f"ERROR: sandbox path resolves outside its lexical location: {current}")

for directory in (
    root / "home",
    root / "home/.npm-cache",
    root / "home/.config",
    root / "home/.config/opencode",
    root / "home/.config/xdg",
    root / "home/.local/share",
    root / "home/.local/share/opencode",
    root / "home/.local/share/xdg",
    root / "home/.local/state",
    root / "home/.local/state/opencode",
    root / "home/.cache",
    root / "home/.cache/opencode",
    root / "home/.opencode",
    root / "project-v2",
):
    validate(directory, True)
for output in (root / "project-v2/opencode.json", root / "opencode-v2.db"):
    validate(output, False)
PY
}
validate_sandbox_paths
sandbox_path_parent="$(dirname "$V2_SERVICE_STATE")"
mkdir -p "$sandbox_path_parent"

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
import stat
import tempfile
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
    "code_mode.py",
    "memory_mcp.py",
    "mcp_persistence.py",
    "mcp_resources.py",
    "pantheon_vision.py",
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
  validate_v2_port || return 1
  if curl --fail --silent --show-error --max-time 1 \
    "http://$V2_LOOPBACK_HOST:${V2_PORT}/global/health" >/dev/null 2>&1; then
    echo "ERROR: dedicated V2 port $V2_PORT is already in use" >&2
    return 1
  fi
  assert_v2_port_available || return 1
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
import stat
import tempfile
from pathlib import Path

config_path = Path(os.environ["CONFIG_PATH"])
runtime_dir = os.environ["RUNTIME_DIR"]
python_bin = os.environ["MCP_PYTHON"]
managed = {
    "pantheon-code-mode": "code_mode.py",
    "pantheon-memory": "memory_mcp.py",
    "pantheon-persistence": "mcp_persistence.py",
    "pantheon-resources": "mcp_resources.py",
    "pantheon-vision": "pantheon_vision.py",
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
temp_fd, temp_name = tempfile.mkstemp(
    prefix=f".{config_path.name}.", suffix=".tmp", dir=config_path.parent
)
tmp_path = Path(temp_name)
try:
    with os.fdopen(temp_fd, "w", encoding="utf-8") as stream:
        stream.write(json.dumps(config, indent=2) + "\n")
    os.chmod(tmp_path, stat.S_IMODE(config_path.stat().st_mode))
    os.replace(tmp_path, config_path)
finally:
    try:
        tmp_path.unlink()
    except FileNotFoundError:
        pass
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

install_pantheon_package() {
  local pack_dir pack_json filename tgz
  pack_dir="$(mktemp -d "$SANDBOX_DIR/.pantheon-npm-pack.XXXXXX")" \
    || { echo "ERROR: cannot create isolated npm pack directory" >&2; exit 1; }
  pack_json="$pack_dir/pack.json"
  if ! (cd "$REPO_DIR" && npm pack --ignore-scripts --json --pack-destination "$pack_dir") > "$pack_json"; then
    find "$pack_dir" -maxdepth 1 -type f -name 'pantheon-opencode-*.tgz' -delete
    rm -f -- "$pack_json"
    rmdir -- "$pack_dir" 2>/dev/null || true
    echo "ERROR: npm pack failed" >&2
    exit 1
  fi
  if ! filename="$(node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8")); if (!Array.isArray(p) || p.length !== 1 || typeof p[0].filename !== "string") process.exit(1); process.stdout.write(p[0].filename)' < "$pack_json")" \
    || [[ "$filename" != pantheon-opencode-*.tgz || "$filename" == */* || ! -f "$pack_dir/$filename" ]]; then
    find "$pack_dir" -maxdepth 1 -type f -name 'pantheon-opencode-*.tgz' -delete
    rm -f -- "$pack_json"
    rmdir -- "$pack_dir" 2>/dev/null || true
    echo "ERROR: npm pack returned an invalid tarball filename" >&2
    exit 1
  fi
  tgz="$pack_dir/$filename"
  npm rm -g pantheon-opencode 2>/dev/null || true
  if ! npm install -g "$tgz"; then
    rm -f -- "$tgz" "$pack_json"
    rmdir -- "$pack_dir" 2>/dev/null || true
    echo "ERROR: install of isolated tarball failed: $tgz" >&2
    exit 1
  fi
  rm -f -- "$tgz" "$pack_json"
  rmdir -- "$pack_dir"
}

echo "--- Building tarball ---"
install_pantheon_package

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
RESOURCES_SRV="$PANTHEON_GLOBAL/scripts/mcp_resources.py"
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
  then
    rm -f -- "$run_test_tmp"
    die "cannot write temporary run-test.sh"
  fi
  atomic_replace_file "$run_test_tmp" "$SANDBOX_ROOT/run-test.sh" 0755 \
    || die "cannot atomically replace run-test.sh"
}

write_sandbox_entrypoints() {
  canonicalize_sandbox_root
  mkdir -p -- "$SANDBOX_ROOT"
  sandbox_path_guard "$SANDBOX_ROOT" dir-check
  sandbox_path_guard "$SANDBOX_ROOT/start-pantheon.sh" replace-file
  sandbox_path_guard "$SANDBOX_ROOT/README.md" replace-file
  local launcher_tmp readme_tmp
  launcher_tmp="$(mktemp "$SANDBOX_ROOT/.start-pantheon.sh.XXXXXX")" \
    || die "cannot create temporary start-pantheon.sh"
  if ! cat > "$launcher_tmp" <<'START'
#!/usr/bin/env bash
set -euo pipefail

SANDBOX_DIR="$(cd "$(dirname "$0")" && pwd -P)"
SANDBOX_HOME="$SANDBOX_DIR/home"
NPM_PREFIX="$SANDBOX_HOME/.npm-global"
V2_BIN="$NPM_PREFIX/bin/opencode2"
PROJECT_DIR="$SANDBOX_DIR/project-v2"
V2_HOST="${PANTHEON_V2_HOST:-127.0.0.1}"
V2_PORT="${PANTHEON_V2_PORT:-49376}"
if [[ ! "$V2_PORT" =~ ^[0-9]{1,5}$ ]]; then
  echo "ERROR: PANTHEON_V2_PORT must be an integer from 1 through 65535 (got '$V2_PORT')" >&2
  exit 1
fi
V2_PORT=$((10#$V2_PORT))
if [ "$V2_PORT" -lt 1 ] || [ "$V2_PORT" -gt 65535 ]; then
  echo "ERROR: PANTHEON_V2_PORT must be an integer from 1 through 65535 (got '$V2_PORT')" >&2
  exit 1
fi
if ! python3 - "$V2_HOST" "$V2_PORT" <<'PY'
import ipaddress
import socket
import sys

host, raw_port = sys.argv[1], sys.argv[2]
try:
    address = ipaddress.ip_address(host)
    if not address.is_loopback or address.version != 4:
        raise ValueError("host must be an IPv4 loopback IP address")
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind((host, int(raw_port)))
except (OSError, ValueError) as exc:
    print(f"ERROR: dedicated V2 port {host}:{raw_port} is already in use or unavailable; no service was stopped: {exc}", file=sys.stderr)
    raise SystemExit(1)
PY
then
  exit 1
fi
[ -x "$V2_BIN" ] || { echo "ERROR: V2 binary is missing: $V2_BIN" >&2; exit 3; }
[ -d "$PROJECT_DIR" ] || { echo "ERROR: V2 project is missing: $PROJECT_DIR (run --prepare first)" >&2; exit 3; }

export HOME="$SANDBOX_HOME"
export PATH="$NPM_PREFIX/bin:$SANDBOX_HOME/.config/opencode/.venv/bin:$PATH"
export npm_config_prefix="$NPM_PREFIX"
export npm_config_cache="$SANDBOX_HOME/.npm-cache"
export XDG_CONFIG_HOME="$SANDBOX_HOME/.config"
export XDG_CONFIG_DIRS="$SANDBOX_HOME/.config/xdg"
export XDG_DATA_HOME="$SANDBOX_HOME/.local/share"
export XDG_DATA_DIRS="$SANDBOX_HOME/.local/share/xdg"
export XDG_STATE_HOME="$SANDBOX_HOME/.local/state"
export XDG_CACHE_HOME="$SANDBOX_HOME/.cache"
V2_CONFIG="$SANDBOX_DIR/project-v2/opencode.json"
export OPENCODE_CONFIG_DIR="$PROJECT_DIR"
export OPENCODE_DB="$SANDBOX_DIR/opencode-v2.db"
export PANTHEON_V2_PORT="$V2_PORT"
export PORT="$V2_PORT"
unset PANTHEON_V2_CONFIG PANTHEON_V2_DB
unset OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT OPENCODE_CONFIG_PROJECT_DISABLE \
  OPENCODE_DATA_DIR OPENCODE_STATE_DIR OPENCODE_CACHE_DIR OPENCODE_STORAGE_PATH
python3 - "$SANDBOX_DIR" <<'PY'
import stat
import sys
from pathlib import Path

root = Path(sys.argv[1])
if root.resolve(strict=True) != root:
    raise SystemExit(f"ERROR: sandbox root is not canonical: {root}")

def validate(path, directory):
    try:
        relative = path.relative_to(root)
    except ValueError:
        raise SystemExit(f"ERROR: sandbox path escaped root: {path}")
    if any(part in ("", ".", "..") for part in relative.parts):
        raise SystemExit(f"ERROR: unsafe sandbox path component: {path}")
    current = root
    for index, part in enumerate(relative.parts):
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            return
        if stat.S_ISLNK(info.st_mode):
            raise SystemExit(f"ERROR: sandbox path contains symlink: {current}")
        final = index == len(relative.parts) - 1
        if (not final or directory) and not stat.S_ISDIR(info.st_mode):
            raise SystemExit(f"ERROR: sandbox path component is not a directory: {current}")
        if final and not directory and not stat.S_ISREG(info.st_mode):
            raise SystemExit(f"ERROR: sandbox output is not a regular file: {current}")
        if current.resolve(strict=True) != current:
            raise SystemExit(f"ERROR: sandbox path resolves outside its lexical location: {current}")

for directory in (
    root / "home",
    root / "home/.npm-cache",
    root / "home/.config",
    root / "home/.config/opencode",
    root / "home/.config/xdg",
    root / "home/.local/share",
    root / "home/.local/share/opencode",
    root / "home/.local/share/xdg",
    root / "home/.local/state",
    root / "home/.local/state/opencode",
    root / "home/.cache",
    root / "home/.cache/opencode",
    root / "home/.opencode",
    root / "project-v2",
):
    validate(directory, True)
for output in (root / "project-v2/opencode.json", root / "opencode-v2.db"):
    validate(output, False)
PY
cd "$PROJECT_DIR"
exec "$V2_BIN"
START
  then
    rm -f -- "$launcher_tmp"
    die "cannot write temporary start-pantheon.sh"
  fi
  atomic_replace_file "$launcher_tmp" "$SANDBOX_ROOT/start-pantheon.sh" 0755 \
    || die "cannot atomically replace start-pantheon.sh"

  readme_tmp="$(mktemp "$SANDBOX_ROOT/.README.md.XXXXXX")" \
    || die "cannot create temporary sandbox README"
  if ! cat > "$readme_tmp" <<'SANDBOXREADME'
# Pantheon isolated OpenCode V2 sandbox

This folder is generated by `scripts/test-opencode-v2-sandbox.sh --prepare` and
uses its own HOME, npm prefix, project config, database, and Python environment.
It does not use the developer's OpenCode configuration.

## Use

- Validate the installation: `bash ~/pantheon-sandbox/run-test.sh`
- Open the isolated TUI: `bash ~/pantheon-sandbox/start-pantheon.sh`
- Recreate/update the sandbox: `scripts/test-opencode-v2-sandbox.sh --prepare`
- Reset only after reviewing the sandbox path: `scripts/test-opencode-v2-sandbox.sh --reset`

## Environment overrides

- `PANTHEON_SANDBOX_ROOT`: sandbox location (default `~/pantheon-sandbox`).
- `PANTHEON_REPO`: existing Pantheon checkout used consistently for packaging;
  a missing, dangling, or non-Pantheon path fails before `npm pack`.
- `PANTHEON_V2_PORT`: dedicated loopback port (default `49376`). The scripts
  reject invalid or occupied ports and never stop or reuse an existing service.
- `PANTHEON_V2_HOST`: IPv4 loopback IP (default `127.0.0.1`); other addresses
  are rejected to avoid exposing the sandbox service on external interfaces.
- `PANTHEON_V2_MCP_LIST_TIMEOUT`: each `opencode mcp list` timeout in seconds
  (default `15`).
- `OPENCODE_V2_SPEC`: OpenCode V2 npm install spec (default `@opencode-ai/cli@beta`).

## Temporary files

No blanket `tmp/` cleanup is performed. On `--prepare`, only hash-named files
owned by the current user under `tmp/node-compile-cache/` older than 30 days may
expire. Runtime state, unknown files, and handoff/evidence files are retained.
Do not remove `tmp/` recursively.
SANDBOXREADME
  then
    rm -f -- "$readme_tmp"
    die "cannot write temporary sandbox README"
  fi
  atomic_replace_file "$readme_tmp" "$SANDBOX_ROOT/README.md" 0644 \
    || die "cannot atomically replace sandbox README"
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

canonicalize_existing_directory() {
  local path="$1"
  [ -n "$path" ] && [ -d "$path" ] || return 1
  (cd -P -- "$path" 2>/dev/null && pwd -P)
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

canonicalize_sandbox_root() {
  local canonical_root
  canonical_root="$(canonicalize_path "$SANDBOX_ROOT")" \
    || die "cannot canonicalize sandbox root: $SANDBOX_ROOT"
  SANDBOX_ROOT="$canonical_root"
  SANDBOX_HOME="$SANDBOX_ROOT/home"
  NPM_PREFIX="$SANDBOX_HOME/.npm-global"
  V2_CONFIG="$SANDBOX_ROOT/project-v2/opencode.json"
  V2_DB="$SANDBOX_ROOT/opencode-v2.db"
  V2_SERVER_LOG="$SANDBOX_ROOT/v2-server.log"
  V2_SERVICE_STATE="$SANDBOX_HOME/.local/state/opencode/service.json"
  REPORT_FILE="$SANDBOX_ROOT/prompts-report.md"
  COST_REPORT_FILE="$SANDBOX_ROOT/pantheon-cost-report.md"
  REHYDRATE_REPORT_FILE="$SANDBOX_ROOT/context-rehydrate-report.md"
  EXTRACT_PY="$SANDBOX_ROOT/.prompt-extract-json.py"
}

# Validate/create paths one component at a time. Existing symlinks are rejected
# rather than followed, and every existing component must resolve to its lexical
# location below the canonical sandbox root.
sandbox_path_guard() {
  local target="$1" mode="$2"
  SANDBOX_ROOT="$SANDBOX_ROOT" python3 - "$target" "$mode" <<'PY'
import os
import stat
import sys
from pathlib import Path

root = Path(os.environ["SANDBOX_ROOT"])
target = Path(sys.argv[1])
mode = sys.argv[2]

def fail(message):
    print(f"ERROR: unsafe sandbox path {target}: {message}", file=sys.stderr)
    raise SystemExit(1)

if not root.is_absolute() or not target.is_absolute():
    fail("paths must be absolute")
try:
    relative = target.relative_to(root)
except ValueError:
    fail("path is outside the canonical sandbox root")
parts = relative.parts
if any(part in ("", ".", "..") for part in parts):
    fail("dot or empty path components are not allowed")

try:
    root_stat = root.lstat()
except OSError as exc:
    fail(f"sandbox root is missing: {exc}")
if stat.S_ISLNK(root_stat.st_mode) or not stat.S_ISDIR(root_stat.st_mode):
    fail("sandbox root must be a real directory")
if root.resolve(strict=True) != root:
    fail("sandbox root is not canonical")

if mode.startswith("dir-"):
    current = root
    for part in parts:
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            if mode != "dir-create":
                fail("directory does not exist")
            try:
                current.mkdir()
            except OSError as exc:
                fail(f"cannot create directory: {exc}")
            info = current.lstat()
        except OSError as exc:
            fail(f"cannot inspect path: {exc}")
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            fail("directory component is a symlink or not a directory")
        if current.resolve(strict=True) != current:
            fail("directory component resolves outside its lexical path")
    raise SystemExit(0)

if mode not in ("file-check", "file-allow-missing-parent", "replace-file"):
    fail(f"unknown validation mode {mode}")

current = root
for part in parts[:-1]:
    current = current / part
    try:
        info = current.lstat()
    except FileNotFoundError:
        if mode == "file-allow-missing-parent":
            raise SystemExit(0)
        fail("parent directory does not exist")
    except OSError as exc:
        fail(f"cannot inspect parent: {exc}")
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        fail("parent component is a symlink or not a directory")
    if current.resolve(strict=True) != current:
        fail("parent component resolves outside its lexical path")

if not parts:
    fail("expected a file path below the sandbox root")
leaf = current / parts[-1]
try:
    info = leaf.lstat()
except FileNotFoundError:
    raise SystemExit(0)
except OSError as exc:
    fail(f"cannot inspect file: {exc}")
if mode != "replace-file" and stat.S_ISLNK(info.st_mode):
    fail("file is a symlink")
if mode != "replace-file" and not stat.S_ISREG(info.st_mode):
    fail("file is not a regular file")
PY
}

atomic_replace_file() {
  local temporary="$1" destination="$2" mode="$3"
  if ! chmod "$mode" "$temporary"; then
    rm -f -- "$temporary"
    return 1
  fi
  if ! mv -fT -- "$temporary" "$destination"; then
    rm -f -- "$temporary"
    return 1
  fi
}

guard_sandbox_root() {
  # Both destructive reset and prepare are forbidden from overlapping HOME or
  # any package checkout. This prevents packing generated sandbox files into a
  # repo and prevents reset from deleting a repo or one of its ancestors.
  local action="${1:-use}" protected canonical_root canonical_home canonical_protected
  local config_home data_home state_home cache_home
  local path_list path_entry
  canonical_root="$(canonicalize_path "$SANDBOX_ROOT")" \
    || die "refusing to $action sandbox root that cannot be canonicalized: $SANDBOX_ROOT"
  canonical_home="$(canonicalize_path "$HOME")" \
    || die "refusing to $action sandbox because HOME cannot be canonicalized: $HOME"
  [ "$canonical_root" != "/" ] \
    || die "refusing to $action unsafe sandbox root: $SANDBOX_ROOT (filesystem root)"
  [ "$canonical_root" != "$canonical_home" ] \
    || die "refusing to $action unsafe sandbox root: $SANDBOX_ROOT (HOME)"
  if path_is_same_or_descendant "$canonical_home" "$canonical_root"; then
    die "refusing to $action unsafe sandbox root: $SANDBOX_ROOT (it is an ancestor of HOME $HOME)"
  fi

  config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
  data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
  state_home="${XDG_STATE_HOME:-$HOME/.local/state}"
  cache_home="${XDG_CACHE_HOME:-$HOME/.cache}"
  for path_list in "${XDG_CONFIG_DIRS:-}" "${XDG_DATA_DIRS:-}"; do
    while [ -n "$path_list" ]; do
      case "$path_list" in
        *:*) path_entry="${path_list%%:*}"; path_list="${path_list#*:}" ;;
        *) path_entry="$path_list"; path_list="" ;;
      esac
      [ -n "$path_entry" ] || continue
      for protected in "$path_entry" "$path_entry/opencode"; do
        canonical_protected="$(canonicalize_path "$protected")" \
          || die "refusing to $action because global OpenCode path cannot be resolved: $protected"
        if path_is_same_or_descendant "$canonical_root" "$canonical_protected" \
          || path_is_same_or_descendant "$canonical_protected" "$canonical_root"; then
          die "refusing to $action unsafe sandbox root: $SANDBOX_ROOT (overlaps global OpenCode path $protected)"
        fi
      done
    done
  done
  for protected in \
    "$HOME/.config/opencode" "$HOME/.opencode" \
    "$config_home/opencode" "$data_home/opencode" \
    "$state_home/opencode" "$cache_home/opencode" \
    "${OPENCODE_CONFIG_DIR:-}" "${OPENCODE_DATA_DIR:-}" \
    "${OPENCODE_STATE_DIR:-}" "${OPENCODE_CACHE_DIR:-}" "${OPENCODE_STORAGE_PATH:-}" \
    "${OPENCODE_CONFIG:-}" "${OPENCODE_DB:-}"; do
    [ -n "$protected" ] || continue
    canonical_protected="$(canonicalize_path "$protected")" \
      || die "refusing to $action because global OpenCode path cannot be resolved: $protected"
    if path_is_same_or_descendant "$canonical_root" "$canonical_protected" \
      || path_is_same_or_descendant "$canonical_protected" "$canonical_root"; then
      die "refusing to $action unsafe sandbox root: $SANDBOX_ROOT (overlaps global OpenCode path $protected)"
    fi
  done

  for protected in "$REPO_DIR" "${PANTHEON_REPO:-}"; do
    [ -n "$protected" ] || continue
    canonical_protected="$(canonicalize_existing_directory "$protected")" \
      || die "refusing to $action sandbox because protected repo path is missing or cannot be resolved: $protected"
    if path_is_same_or_descendant "$canonical_root" "$canonical_protected"; then
      die "refusing to $action unsafe sandbox root: $SANDBOX_ROOT (it is equal to or inside the repo $protected)"
    fi
    if path_is_same_or_descendant "$canonical_protected" "$canonical_root"; then
      die "refusing to $action unsafe sandbox root: $SANDBOX_ROOT (it is an ancestor of the repo $protected)"
    fi
  done
}

cmd_reset() {
  guard_sandbox_root reset
  log "Resetting sandbox: $SANDBOX_ROOT"
  rm -rf -- "$SANDBOX_ROOT"
  log "Sandbox removed."
}

install_binaries() {
  log "--- Installing pantheon-opencode (from repo tarball) ---"
  local pack_dir pack_json filename tgz
  pack_dir="$(mktemp -d "$SANDBOX_ROOT/.pantheon-npm-pack.XXXXXX")" \
    || die "cannot create isolated npm pack directory"
  pack_json="$pack_dir/pack.json"
  if ! (cd "$REPO_DIR" && npm pack --ignore-scripts --json --pack-destination "$pack_dir") > "$pack_json"; then
    find "$pack_dir" -maxdepth 1 -type f -name 'pantheon-opencode-*.tgz' -delete
    rm -f -- "$pack_json"
    rmdir -- "$pack_dir" 2>/dev/null || true
    die "npm pack failed"
  fi
  if ! filename="$(node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8")); if (!Array.isArray(p) || p.length !== 1 || typeof p[0].filename !== "string") process.exit(1); process.stdout.write(p[0].filename)' < "$pack_json")" \
    || [[ "$filename" != pantheon-opencode-*.tgz || "$filename" == */* || ! -f "$pack_dir/$filename" ]]; then
    find "$pack_dir" -maxdepth 1 -type f -name 'pantheon-opencode-*.tgz' -delete
    rm -f -- "$pack_json"
    rmdir -- "$pack_dir" 2>/dev/null || true
    die "npm pack returned an invalid tarball filename"
  fi
  tgz="$pack_dir/$filename"
  npm rm -g pantheon-opencode 2>/dev/null || true
  if ! npm install -g "$tgz"; then
    rm -f -- "$tgz" "$pack_json"
    rmdir -- "$pack_dir" 2>/dev/null || true
    die "install of isolated tarball failed: $tgz"
  fi
  rm -f -- "$tgz" "$pack_json"
  rmdir -- "$pack_dir" || die "could not clean isolated npm pack directory: $pack_dir"
  log "--- Installing OpenCode V2 ($OPENCODE_V2_SPEC) ---"
  npm install -g "$OPENCODE_V2_SPEC" || die "install of $OPENCODE_V2_SPEC failed"
}

prepare_project() {
  local dir pan
  canonicalize_sandbox_root
  dir="$(project_dir)"
  sandbox_path_guard "$dir" dir-create
  sandbox_path_guard "$V2_CONFIG" file-allow-missing-parent \
    || die "unsafe project config path: $V2_CONFIG"
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
  canonicalize_sandbox_root
  local runtime_dir="$(project_dir)/.opencode"
  local python_bin="$(project_dir)/.venv/bin/python3"
  sandbox_path_guard "$V2_CONFIG" file-check \
    || die "V2 config path is missing or unsafe: $V2_CONFIG"
  [ -f "$V2_CONFIG" ] || die "V2 config was not generated: $V2_CONFIG"
  [ -x "$python_bin" ] || die "V2 MCP Python is missing: $python_bin"

  CONFIG_PATH="$V2_CONFIG" RUNTIME_DIR="$runtime_dir" MCP_PYTHON="$python_bin" \
    python3 - <<'PY'
import json
import os
import stat
import sys
import tempfile
from pathlib import Path

config_path = Path(os.environ["CONFIG_PATH"])
runtime_dir = os.environ["RUNTIME_DIR"]
python_bin = os.environ["MCP_PYTHON"]
managed = {
    "pantheon-code-mode": "code_mode.py",
    "pantheon-memory": "memory_mcp.py",
    "pantheon-persistence": "mcp_persistence.py",
    "pantheon-resources": "mcp_resources.py",
    "pantheon-vision": "pantheon_vision.py",
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

tmp_path = None
try:
    temp_fd, temp_name = tempfile.mkstemp(
        prefix=f".{config_path.name}.", suffix=".tmp", dir=config_path.parent
    )
    tmp_path = Path(temp_name)
    with os.fdopen(temp_fd, "w", encoding="utf-8") as stream:
        stream.write(json.dumps(config, indent=2) + "\n")
    os.chmod(tmp_path, stat.S_IMODE(config_path.stat().st_mode))
    os.replace(tmp_path, config_path)
except OSError as exc:
    if tmp_path is not None:
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
  validate_v2_port
  guard_sandbox_root use
  canonicalize_sandbox_root
  sandbox_env
  cleanup_sandbox_tmp
  write_run_test_sh
  write_sandbox_entrypoints
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
  canonicalize_sandbox_root
  mkdir -p -- "$SANDBOX_ROOT"
  sandbox_path_guard "$SANDBOX_ROOT" dir-check
  sandbox_path_guard "$EXTRACT_PY" replace-file
  local extract_tmp
  extract_tmp="$(mktemp "$SANDBOX_ROOT/.prompt-extract-json.py.XXXXXX")" \
    || die "cannot create temporary prompt extractor"
  if ! cat > "$extract_tmp" <<'PYEOF'
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
  then
    rm -f -- "$extract_tmp"
    die "cannot write temporary prompt extractor"
  fi
  atomic_replace_file "$extract_tmp" "$EXTRACT_PY" 0644 \
    || die "cannot atomically replace prompt extractor"
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
  local v="$1" probe_file probe_shell_arg
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
  probe_file="$SANDBOX_ROOT/pantheon-sandbox-probe-$v.txt"
  printf -v probe_shell_arg '%q' "$probe_file"
  add_prompt "tmp-write-read" "TMP-OK" "" \
    "$probe_file::TMP-OK" \
    "Using the bash tool, run a python3 -c command that writes the text TMP-OK to the file at $probe_shell_arg (overwrite it), then run another python3 -c command to read that file back. Do not use any other tool or command to write or read the file — only python3 -c. If what you read back is exactly TMP-OK, reply with exactly: TMP-OK"
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
  if [ -n "$verify" ]; then
    rm -f "${verify%%::*}"
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
  resolve_harness_repo
  cmd_reset
  exit 0
fi

if [ "$MODE_PREPARE" -eq 0 ] && [ -z "$RUN_VERSION" ] \
  && [ "$MODE_PROMPTS" -eq 0 ] && [ "$MODE_COST" -eq 0 ] \
  && [ "$MODE_REHYDRATE" -eq 0 ] && [ "$MODE_HOOKS" -eq 0 ]; then
  usage
fi

resolve_harness_repo

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
