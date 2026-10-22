#!/usr/bin/env bash
set -euo pipefail

# V1 permission proof — the 1.19.x row of the P0-5 matrix.
#
# The V2 proof (`run-v2-permission-proof.sh`) drives `permission.evaluate` and
# `ctx.permission.assert`; neither exists on a V1 host. This wrapper gates the V1
# line (1.19.*) and runs `tests/canary/v1-permission-canary.test.mjs`, which
# registers a V1 `permission.ask` plugin against the real host.
#
# The gate is deliberately separate from the V2 one: an operator who points this
# at a V2 binary gets an explicit refusal (exit 2) instead of a green run that
# measured a different mechanism.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
opencode_bin="${PANTHEON_V1_CANARY_BIN:-opencode}"
version="$("$opencode_bin" --version)"

accepted_versions="${PANTHEON_V1_CANARY_ACCEPTED_VERSIONS-1.19.*}"
matched=0
IFS=',' read -ra version_patterns <<<"$accepted_versions"
for pattern in "${version_patterns[@]}"; do
  # Trim ASCII whitespace without external tools.
  pattern="${pattern#"${pattern%%[![:space:]]*}"}"
  pattern="${pattern%"${pattern##*[![:space:]]}"}"
  [[ -n "$pattern" ]] || continue
  # Unquoted RHS: the operator supplies globs (`1.19.*`).
  # shellcheck disable=SC2053
  if [[ "$version" == *$pattern* ]]; then
    matched=1
    break
  fi
done
if [[ "$matched" -ne 1 ]]; then
  printf 'Expected V1 OpenCode version matching [%s], got: %s\n' "$accepted_versions" "$version" >&2
  exit 2
fi
command -v bwrap >/dev/null || { echo 'bwrap is required' >&2; exit 2; }

fixture_root="$(mktemp -d /tmp/pantheon-v1-permission-proof.XXXXXX)"
trap 'rm -rf "$fixture_root"' EXIT
mkdir -p "$fixture_root/etc/ssl/certs"
for file in passwd group hosts nsswitch.conf ld.so.cache; do
  [[ ! -e "/etc/$file" ]] || cp -a "/etc/$file" "$fixture_root/etc/$file"
done
[[ ! -e /etc/ssl/openssl.cnf ]] || cp -a /etc/ssl/openssl.cnf "$fixture_root/etc/ssl/openssl.cnf"
[[ ! -e /etc/ssl/certs/ca-certificates.crt ]] || cp -a /etc/ssl/certs/ca-certificates.crt "$fixture_root/etc/ssl/certs/ca-certificates.crt"

echo "V1 permission.ask probe ($version)"
bwrap \
  --unshare-user --unshare-pid --unshare-net \
  --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp \
  --ro-bind "$fixture_root/etc" /etc \
  --chdir "$repo_root" \
  --setenv HOME /tmp/test-home \
  --setenv XDG_CONFIG_HOME /tmp/test-config \
  --setenv XDG_DATA_HOME /tmp/test-data \
  --setenv XDG_STATE_HOME /tmp/test-state \
  --setenv XDG_CACHE_HOME /tmp/test-cache \
  --setenv PANTHEON_V1_CANARY_BIN "$opencode_bin" \
  --setenv PANTHEON_V1_CANARY_ACCEPTED_VERSIONS "$accepted_versions" \
  --setenv npm_config_cache /tmp/npm-cache \
  -- node scripts/run-node-tests.mjs --label 'test:v1-permission-canary' 'tests/canary/v1-permission-canary.test.mjs'
