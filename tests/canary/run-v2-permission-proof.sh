#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
opencode_bin="${PANTHEON_TOOL_CANARY_BIN:-$HOME/pantheon-sandbox/home/.npm-global/bin/opencode}"
version="$($opencode_bin --version)"

# Fail-closed version gate.
#
# The reference host is 2.0.29, but the P0-5 evidence matrix must run the same
# probe on 1.19.x, 2.0.22, 2.0.29, 2.0.30 and 2.1.x. Accept a comma-separated
# list of glob patterns instead of one hard-coded version. With no variable (or
# an empty one) only the reference version passes, so an operator who forgets
# to set the gate gets the old behaviour, not an open gate.
accepted_versions="${PANTHEON_TOOL_CANARY_ACCEPTED_VERSIONS-v2.0.29}"
matched=0
IFS=',' read -ra version_patterns <<<"$accepted_versions"
for pattern in "${version_patterns[@]}"; do
  # Trim ASCII whitespace without external tools.
  pattern="${pattern#"${pattern%%[![:space:]]*}"}"
  pattern="${pattern%"${pattern##*[![:space:]]}"}"
  [[ -n "$pattern" ]] || continue
  # Unquoted RHS: the operator supplies globs (`v2.0.*`, `v1.19.*`, `2.1.*`).
  # shellcheck disable=SC2053
  if [[ "$version" == *$pattern* ]]; then
    matched=1
    break
  fi
done
if [[ "$matched" -ne 1 ]]; then
  printf 'Expected OpenCode version matching [%s], got: %s\n' "$accepted_versions" "$version" >&2
  exit 2
fi
command -v bwrap >/dev/null || { echo 'bwrap is required' >&2; exit 2; }

fixture_root="$(mktemp -d /tmp/pantheon-v2-permission-proof.XXXXXX)"
trap 'rm -rf "$fixture_root"' EXIT
for etc_dir in deny/etc allow/etc; do
  mkdir -p "$fixture_root/$etc_dir/ssl/certs"
  for file in passwd group hosts nsswitch.conf ld.so.cache; do
    [[ ! -e "/etc/$file" ]] || cp -a "/etc/$file" "$fixture_root/$etc_dir/$file"
  done
  [[ ! -e /etc/ssl/openssl.cnf ]] || cp -a /etc/ssl/openssl.cnf "$fixture_root/$etc_dir/ssl/openssl.cnf"
  [[ ! -e /etc/ssl/certs/ca-certificates.crt ]] || cp -a /etc/ssl/certs/ca-certificates.crt "$fixture_root/$etc_dir/ssl/certs/ca-certificates.crt"
done
mkdir -p "$fixture_root/deny/etc/opencode"
cat >"$fixture_root/deny/etc/opencode/opencode.json" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "policies": [
    { "action": "tool.use", "resource": "shell:*", "effect": "deny" }
  ]
}
JSON

run_canary() {
  local expected="$1"
  local admission="$2"
  local etc_mount="$3"
  local matrix="${4:-0}"
  local managed_deny="${5:-0}"
  local -a admission_env=()
  if [[ "$admission" == "1" ]]; then
    admission_env=(--setenv PANTHEON_TOOL_CANARY_SUBAGENT_ADMISSION 1)
  else
    admission_env=(--setenv PANTHEON_TOOL_CANARY_SUBAGENT_ADMISSION 0)
  fi
  # Every harness switch is SET explicitly, not merely added when wanted:
  # bwrap inherits the parent environment, so an operator who exports
  # PANTHEON_TOOL_CANARY_PERMISSION_MATRIX=1 would otherwise leak it into the
  # deny-fixture run even if this wrapper never passes --setenv.
  local -a matrix_env=(--setenv PANTHEON_TOOL_CANARY_PERMISSION_MATRIX "$matrix")
  local -a fault_env=(
    --setenv PANTHEON_TOOL_CANARY_PROBE_FAULT "${PANTHEON_TOOL_CANARY_PROBE_FAULT:-}"
    --setenv PANTHEON_TOOL_CANARY_MATRIX_PROBE_FAULT "${PANTHEON_TOOL_CANARY_MATRIX_PROBE_FAULT:-}"
    --setenv PANTHEON_TOOL_CANARY_PERMISSION_ASK ""
    --setenv PANTHEON_TOOL_CANARY_BOUNDED_READ ""
    --setenv PANTHEON_TOOL_CANARY_BOUNDED_READ_DENY ""
    --setenv PANTHEON_TOOL_CANARY_MCP_GATING ""
  )

  bwrap \
    --unshare-user --unshare-pid --unshare-net \
    --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp \
    --ro-bind "$etc_mount" /etc \
    --chdir "$repo_root" \
    --setenv HOME /tmp/test-home \
    --setenv XDG_CONFIG_HOME /tmp/test-config \
    --setenv XDG_DATA_HOME /tmp/test-data \
    --setenv XDG_STATE_HOME /tmp/test-state \
    --setenv XDG_CACHE_HOME /tmp/test-cache \
    --setenv PANTHEON_TOOL_CANARY_BIN "$opencode_bin" \
    --setenv PANTHEON_TOOL_CANARY_PERMISSION_PROBE 1 \
    --setenv PANTHEON_TOOL_CANARY_PERMISSION_EXPECTED "$expected" \
    --setenv PANTHEON_TOOL_CANARY_MANAGED_DENY_FIXTURE "$managed_deny" \
    --setenv npm_config_cache /tmp/npm-cache \
    "${admission_env[@]}" \
    "${matrix_env[@]}" \
    "${fault_env[@]}" \
    -- npm run test:tool-canary
}

echo "Permission assertion: managed deny overrides project allow ($version)"
run_canary reject '' "$fixture_root/deny/etc" 0 1

echo "Permission assertion and F4A identity probe: project allow; invalid and valid-matrix subagent attempts ($version)"
run_canary allow 1 "$fixture_root/allow/etc" 0 0

# P0-5 matrix probes (action-name coverage, nested-deny ordering, task glob).
# Its own run AND its own clean /etc fixture: the managed deny fixture above is
# applied only to the precedence run, so the action-name scenario sees exactly
# the project config it writes.
if [[ "${PANTHEON_TOOL_CANARY_PERMISSION_MATRIX:-}" == "1" ]]; then
  echo "P0-5 permission matrix probes: action names, deny ordering, task glob ($version)"
  run_canary allow 0 "$fixture_root/allow/etc" 1 0
fi
