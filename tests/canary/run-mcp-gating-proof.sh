#!/usr/bin/env bash
set -euo pipefail

# MCP gating proof — one isolated host run.
#
# Measures whether a `permission` rule whose `action` is the name the host
# actually emits for an MCP call (`<server>_<tool>`) blocks that call, and at
# what granularity. It is deliberately separate from the permission matrix so
# the answer does not depend on the matrix's other scenarios or their timeout.
#
# Isolation: bwrap with a private HOME/XDG tree and the report directory bound
# read-write at /reports. No network namespace, so only local stdio MCP works.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
opencode_bin="${PANTHEON_TOOL_CANARY_BIN:-$HOME/pantheon-sandbox/home/.npm-global/bin/opencode}"
version="$("$opencode_bin" --version)"

accepted_versions="${PANTHEON_TOOL_CANARY_ACCEPTED_VERSIONS-v2.0.29}"
matched=0
IFS=',' read -ra version_patterns <<<"$accepted_versions"
for pattern in "${version_patterns[@]}"; do
  pattern="${pattern#"${pattern%%[![:space:]]*}"}"
  pattern="${pattern%"${pattern##*[![:space:]]}"}"
  [[ -n "$pattern" ]] || continue
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

report_dir="${PANTHEON_TOOL_CANARY_MCP_GATING_REPORT_DIR:-}"
temp_report_dir=""
if [[ -z "$report_dir" ]]; then
  report_dir="$(mktemp -d /tmp/pantheon-v2-mcp-gating-report.XXXXXX)"
  temp_report_dir="$report_dir"
else
  mkdir -p "$report_dir"
fi
report_file="$report_dir/mcp-gating-report.json"

fixture_root="$(mktemp -d /tmp/pantheon-v2-mcp-gating.XXXXXX)"
cleanup() {
  rm -rf "$fixture_root"
  [[ -z "$temp_report_dir" ]] || rm -rf "$temp_report_dir"
}
trap cleanup EXIT
mkdir -p "$fixture_root/etc/ssl/certs"
for file in passwd group hosts nsswitch.conf ld.so.cache; do
  [[ ! -e "/etc/$file" ]] || cp -a "/etc/$file" "$fixture_root/etc/$file"
done
[[ ! -e /etc/ssl/openssl.cnf ]] || cp -a /etc/ssl/openssl.cnf "$fixture_root/etc/ssl/openssl.cnf"
[[ ! -e /etc/ssl/certs/ca-certificates.crt ]] || cp -a /etc/ssl/certs/ca-certificates.crt "$fixture_root/etc/ssl/certs/ca-certificates.crt"

echo "MCP action-name gating probe ($version)"
bwrap \
  --unshare-user --unshare-pid --unshare-net \
  --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp \
  --ro-bind "$fixture_root/etc" /etc \
  --bind "$report_dir" /tmp/reports \
  --chdir "$repo_root" \
  --setenv HOME /tmp/test-home \
  --setenv XDG_CONFIG_HOME /tmp/test-config \
  --setenv XDG_DATA_HOME /tmp/test-data \
  --setenv XDG_STATE_HOME /tmp/test-state \
  --setenv XDG_CACHE_HOME /tmp/test-cache \
  --setenv PANTHEON_TOOL_CANARY_BIN "$opencode_bin" \
  --setenv PANTHEON_TOOL_CANARY_MCP_GATING 1 \
  --setenv PANTHEON_TOOL_CANARY_MCP_GATING_REPORT /tmp/reports/mcp-gating-report.json \
  --setenv npm_config_cache /tmp/npm-cache \
  -- npm run test:tool-canary

if [[ -f "$report_file" ]]; then
  echo "mcp gating report: $report_file"
else
  echo "mcp gating report was not written: $report_file" >&2
  exit 3
fi
