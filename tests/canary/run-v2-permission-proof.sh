#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
opencode_bin="${PANTHEON_TOOL_CANARY_BIN:-$HOME/pantheon-sandbox/home/.npm-global/bin/opencode}"
version="$($opencode_bin --version)"
if [[ "$version" != *"v2.0.29"* ]]; then
  printf 'Expected OpenCode v2.0.29, got: %s\n' "$version" >&2
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
  local -a admission_env=()
  if [[ "$admission" == "1" ]]; then
    admission_env=(--setenv PANTHEON_TOOL_CANARY_SUBAGENT_ADMISSION 1)
  fi

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
    --setenv npm_config_cache /tmp/npm-cache \
    "${admission_env[@]}" \
    -- npm run test:tool-canary
}

echo "Permission assertion: managed deny overrides project allow ($version)"
run_canary reject '' "$fixture_root/deny/etc"

echo "Permission assertion and F4A identity probe: project allow; invalid and valid-matrix subagent attempts ($version)"
run_canary allow 1 "$fixture_root/allow/etc"
