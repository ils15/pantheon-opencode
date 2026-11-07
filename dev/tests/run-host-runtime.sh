#!/bin/bash
set -euo pipefail

PATH='/usr/sbin:/usr/bin:/sbin:/bin'
export PATH
readonly PATH

trusted_helper() {
  local name="$1"
  local resolved
  if resolved="$(builtin type -P "$name" 2>/dev/null)"; then
    :
  else
    resolved=''
  fi
  if [[ -z "$resolved" || ! -f "$resolved" || ! -x "$resolved" ]]; then
    echo "BLOCKED host-runtime: trusted helper is unavailable: $name" >&2
    return 2
  fi
  printf '%s\n' "$resolved"
}

realpath_bin="$(trusted_helper realpath)"
dirname_bin="$(trusted_helper dirname)"
repo_root="$(cd "$("$dirname_bin" "${BASH_SOURCE[0]}")/../.." && pwd -P)"
mode=host
sentinel_path=''
socket_path=''
if [[ "${1:-}" == '--isolation-probe' ]]; then
  if [[ $# -ne 3 ]]; then
    echo 'Usage: run-host-runtime.sh --isolation-probe SENTINEL UNIX_SOCKET' >&2
    exit 2
  fi
  mode=probe
  sentinel_path="$2"
  socket_path="$3"
elif [[ $# -ne 0 ]]; then
  echo 'Usage: run-host-runtime.sh [--isolation-probe SENTINEL UNIX_SOCKET]' >&2
  exit 2
fi

host_bin="${PICKLEBALL_OPENCODE_BIN:-}"
if [[ -z "$host_bin" ]]; then
  host_bin="$(builtin type -P opencode 2>/dev/null)" || host_bin=''
fi
if [[ -n "$host_bin" && -x "$host_bin" ]]; then
  host_bin="$("$realpath_bin" "$host_bin")"
else
  host_bin=''
fi
if [[ "$mode" == host && -z "$host_bin" ]]; then
  echo 'SKIP host-runtime: set PICKLEBALL_OPENCODE_BIN or install OpenCode on PATH.'
  exit 0
fi
ldconfig_bin="$(trusted_helper ldconfig)"
readelf_bin="$(trusted_helper readelf)"
awk_bin="$(trusted_helper awk)"
bwrap_bin="$(trusted_helper bwrap)"
env_bin="$(trusted_helper env)"
node_bin="${PICKLEBALL_NODE_BIN:-}"
if [[ -z "$node_bin" ]]; then
  node_bin="$(builtin type -P node 2>/dev/null)" || node_bin=''
fi
if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
  echo 'BLOCKED host-runtime: Node.js is required (install it in the trusted system PATH or set PICKLEBALL_NODE_BIN).' >&2
  exit 2
fi
node_bin="$("$realpath_bin" "$node_bin")"

# Build a new root from individual runtime files only. In particular, never
# bind the host root, HOME, /run, /var/run, or any host socket into this sandbox.
declare -a mount_ops=()
declare -A mounted_dirs=()
declare -A mounted_files=()

ensure_directory() {
  local path="$1"
  if [[ "$path" == '/' || -n "${mounted_dirs[$path]:-}" ]]; then
    return
  fi
  ensure_directory "$("$dirname_bin" "$path")"
  mount_ops+=(--dir "$path")
  mounted_dirs[$path]=1
}

bind_readonly_file() {
  local source="$1"
  local destination="$2"
  if [[ ! -f "$source" ]]; then
    echo "BLOCKED host-runtime: required runtime file is unavailable: $source" >&2
    return 2
  fi
  source="$("$realpath_bin" "$source")"
  ensure_directory "$("$dirname_bin" "$destination")"
  if [[ -z "${mounted_files[$destination]:-}" ]]; then
    mount_ops+=(--ro-bind "$source" "$destination")
    mounted_files[$destination]="$source"
  elif [[ "${mounted_files[$destination]}" != "$source" ]]; then
    echo "BLOCKED host-runtime: conflicting runtime files target $destination" >&2
    return 2
  fi
}

is_system_library_path() {
  case "$1" in
    /lib/*|/lib64/*|/usr/lib/*) return 0 ;;
    *) return 1 ;;
  esac
}

if ! dependency_cache="$("$ldconfig_bin" -p 2>/dev/null)"; then
  echo 'BLOCKED host-runtime: could not read the system ELF library cache.' >&2
  exit 2
fi
declare -A system_dependency_paths=()
cache_pattern='^[[:space:]]*([^[:space:]]+)[[:space:]]+\([^)]*\)[[:space:]]+=>[[:space:]]+(.+)$'
while IFS= read -r cache_entry; do
  if [[ "$cache_entry" =~ $cache_pattern ]]; then
    soname="${BASH_REMATCH[1]}"
    candidate="${BASH_REMATCH[2]}"
    if [[ "$soname" =~ ^[A-Za-z0-9_.+-]+$ ]] && is_system_library_path "$candidate"; then
      resolved="$("$realpath_bin" "$candidate")" || continue
      if [[ -f "$resolved" ]] && is_system_library_path "$resolved" && [[ -z "${system_dependency_paths[$soname]:-}" ]]; then
        system_dependency_paths[$soname]="$candidate"
      fi
    fi
  fi
done <<< "$dependency_cache"

resolve_system_dependency() {
  local soname="$1"
  local candidate="${system_dependency_paths[$1]:-}"

  if [[ ! "$soname" =~ ^[A-Za-z0-9_.+-]+$ ]]; then
    echo "BLOCKED host-runtime: unsupported ELF dependency name: $soname" >&2
    return 2
  fi
  if [[ -n "$candidate" && -f "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  echo "BLOCKED host-runtime: could not resolve system ELF dependency: $soname" >&2
  return 2
}

declare -A inspected_runtime_files=()
inspect_runtime_dependencies() {
  local binary="$1"
  local canonical
  local header
  local program_headers
  local dynamic_section
  local interpreter
  local resolved_interpreter
  local dependency
  local dependency_path
  local -a dependencies=()

  canonical="$("$realpath_bin" "$binary")"
  if [[ -n "${inspected_runtime_files[$canonical]:-}" ]]; then
    return 0
  fi
  inspected_runtime_files[$canonical]=1

  if ! header="$("$readelf_bin" -h "$canonical" 2>/dev/null)" || [[ "$header" != *'Class:'* ]]; then
    echo "BLOCKED host-runtime: readelf could not verify ELF runtime file: $binary" >&2
    return 2
  fi
  if ! program_headers="$("$readelf_bin" -lW "$canonical" 2>/dev/null)"; then
    echo "BLOCKED host-runtime: could not inspect ELF program headers for $binary." >&2
    return 2
  fi
  if ! dynamic_section="$("$readelf_bin" -dW "$canonical" 2>/dev/null)"; then
    echo "BLOCKED host-runtime: could not inspect ELF dependencies for $binary." >&2
    return 2
  fi

  interpreter="$(printf '%s\n' "$program_headers" | "$awk_bin" '/Requesting program interpreter:/ { sub(/^.*Requesting program interpreter: /, ""); sub(/\].*$/, ""); print; exit }')"
  if [[ -n "$interpreter" ]]; then
    if ! is_system_library_path "$interpreter"; then
      echo "BLOCKED host-runtime: ELF interpreter is outside the system library allowlist: $interpreter" >&2
      return 2
    fi
    resolved_interpreter="$("$realpath_bin" "$interpreter")" || return 2
    if ! is_system_library_path "$resolved_interpreter"; then
      echo "BLOCKED host-runtime: resolved ELF interpreter is outside the system library allowlist: $interpreter" >&2
      return 2
    fi
    bind_readonly_file "$interpreter" "$interpreter"
    inspect_runtime_dependencies "$interpreter"
  fi

  mapfile -t dependencies < <(printf '%s\n' "$dynamic_section" | "$awk_bin" -F'[][]' '/\(NEEDED\)/ { print $2 }')
  for dependency in "${dependencies[@]}"; do
    dependency_path="$(resolve_system_dependency "$dependency")" || return 2
    bind_readonly_file "$dependency_path" "$dependency_path"
    inspect_runtime_dependencies "$dependency_path"
  done
}

ensure_directory /opt
ensure_directory /harness
ensure_directory /harness/plugin
inspect_runtime_dependencies "$node_bin"
bind_readonly_file "$node_bin" /opt/node
bind_readonly_file "$repo_root/dev/tests/host-runtime.mjs" /harness/host-runtime.mjs
bind_readonly_file "$repo_root/dev/tests/offline-decision.mjs" /harness/offline-decision.mjs
bind_readonly_file "$repo_root/dev/tests/mcp-fixture.mjs" /harness/mcp-fixture.mjs
bind_readonly_file "$repo_root/dev/tests/plugin/index.ts" /harness/plugin/index.ts
bind_readonly_file "$repo_root/dev/tests/mount-isolation-probe.mjs" /harness/mount-isolation-probe.mjs
if [[ -n "$host_bin" ]]; then
  inspect_runtime_dependencies "$host_bin"
  bind_readonly_file "$host_bin" /opt/opencode
fi

base_mounts=(
  --unshare-user --unshare-pid --unshare-net
  --tmpfs /
  --proc /proc
  --dev /dev
  --tmpfs /tmp
)
bwrap_args=(
  "${base_mounts[@]}"
  "${mount_ops[@]}"
  --chdir /harness
  --setenv PATH /opt
  --setenv HOME /tmp/pickleball-harness-home
  --setenv XDG_CONFIG_HOME /tmp/pickleball-harness-config
  --setenv XDG_DATA_HOME /tmp/pickleball-harness-data
  --setenv XDG_STATE_HOME /tmp/pickleball-harness-state
  --setenv XDG_CACHE_HOME /tmp/pickleball-harness-cache
  --setenv TMPDIR /tmp
)

if [[ "$mode" == probe ]]; then
  bwrap_args+=(
    --setenv PICKLEBALL_OUTSIDE_SENTINEL "$sentinel_path"
    --setenv PICKLEBALL_OUTSIDE_SOCKET "$socket_path"
  )
  exec "$env_bin" -i PATH=/usr/bin:/bin "$bwrap_bin" "${bwrap_args[@]}" -- \
    /opt/node /harness/mount-isolation-probe.mjs
fi

bwrap_args+=(
  --setenv PICKLEBALL_OPENCODE_BIN /opt/opencode
  --setenv PICKLEBALL_EGRESS_ISOLATED 1
)
exec "$env_bin" -i PATH=/usr/bin:/bin "$bwrap_bin" "${bwrap_args[@]}" -- \
  /opt/node /harness/host-runtime.mjs
