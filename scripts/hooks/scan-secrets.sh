#!/usr/bin/env bash
# scan-secrets.sh — Pantheon PreToolUse Secret Scanning Hook
# Detects hardcoded secrets in tool input. Logs ALWAYS (masked); the exit
# code drives the plugin's hybrid blocking (see pantheon-hooks.ts):
#
#   exit 0 — no match.
#   exit 1 — LOW_CONFIDENCE match only (header/KEY NAMES such as the Bifrost header
#            alone, api_key=/password=/secret= without a recognizable token
#            value). Advisory: the plugin logs + toasts, does NOT block.
#   exit 2 — HIGH_CONFIDENCE match (real token formats: sk-bf-<token>,
#            AKIA..., ghp_..., glpat-..., sk_live_/sk_test_..., xox[baprs]-...,
#            Bearer <token>, JWT). The plugin BLOCKS the tool call (throws
#            after logging — the only deliberate throw in the plugin).
#
# Matches are always MASKED (first 4 + last 4 chars for len>8, else "****")
# before being echoed — the hook trail must never contain a raw secret value.
set -euo pipefail

HIGH_CONFIDENCE_PATTERNS=(
    "AKIA[0-9A-Z]{16}"
    "gh[pousr]_[A-Za-z0-9_]{36,}"
    "glpat-[A-Za-z0-9_\\-]{20}"
    "sk-[a-zA-Z0-9]{20,}"
    "sk_live_[a-zA-Z0-9]{20,}"
    "sk_test_[a-zA-Z0-9]{20,}"
    "xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24}"
    "bearer\\s+[a-zA-Z0-9_\\-\\.]{20,}"
    "eyJ[A-Za-z0-9_-]*\\.eyJ[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]*"
)

LOW_CONFIDENCE_PATTERNS=(
    # KEY/header NAMES without a recognizable token value — high false-positive
    # rate (e.g. the Bifrost header alone, api_key=longvalue, password="x", secret="y"):
    # advisory only, never blocks.
    "[a-zA-Z0-9_-]*api[_-]?key[a-zA-Z0-9_-]*\\s*[:=]\\s*[\"']?[a-zA-Z0-9_\\-]{16,}[\"']?"
    "[a-zA-Z0-9_-]*password[a-zA-Z0-9_-]*\\s*[:=]\\s*[\"'][^\"']{8,}[\"']"
    "[a-zA-Z0-9_-]*secret[a-zA-Z0-9_-]*\\s*[:=]\\s*[\"'][^\"']{8,}[\"']"
)

# Keep provider-specific markers assembled so this scanner is not self-matched
# by the repository secret test.
BIFROST_HEADER="x""-bf-""vk"
BIFROST_TOKEN_PREFIX="sk""-bf-"
HIGH_CONFIDENCE_PATTERNS+=("${BIFROST_TOKEN_PREFIX}[A-Za-z0-9_-]{8,}")
LOW_CONFIDENCE_PATTERNS+=("$BIFROST_HEADER")

# Mask a matched secret for safe logging: first 4 + last 4 chars (len > 8),
# else fully hidden — short matches must not be reconstructable by
# concatenating the visible slices.
mask_secret() {
    local match="$1"
    if [[ ${#match} -le 8 ]]; then
        echo "****"
    else
        echo "${match:0:4}****${match: -4}"
    fi
}

INPUT="${1:-${TOOL_INPUT:-}}"
if [[ -z "$INPUT" ]] && [[ ! -t 0 ]]; then
    INPUT=$(cat)
fi

if [[ -z "$INPUT" ]]; then
    exit 0
fi

FOUND_HIGH=0
FOUND_LOW=0

for pattern in "${HIGH_CONFIDENCE_PATTERNS[@]}"; do
    if echo "$INPUT" | grep -iqE "$pattern"; then
        MATCH=$(echo "$INPUT" | grep -ioE "$pattern" | head -1)
        echo "[SECRET SCAN] High-confidence secret detected: $(mask_secret "$MATCH") (pattern: $pattern)" >&2
        FOUND_HIGH=1
    fi
done

for pattern in "${LOW_CONFIDENCE_PATTERNS[@]}"; do
    if echo "$INPUT" | grep -iqE "$pattern"; then
        MATCH=$(echo "$INPUT" | grep -ioE "$pattern" | head -1)
        echo "[SECRET SCAN] Potential secret detected (low confidence): $(mask_secret "$MATCH") (pattern: $pattern)" >&2
        FOUND_LOW=1
    fi
done

if [[ $FOUND_HIGH -eq 1 ]]; then
    echo "[SECRET SCAN] High-confidence hardcoded secret detected. Tool call will be BLOCKED." >&2
    exit 2
fi

if [[ $FOUND_LOW -eq 1 ]]; then
    echo "[SECRET SCAN] Possible secret detected. Remove it and use environment variables or a vault." >&2
    exit 1
fi

exit 0
