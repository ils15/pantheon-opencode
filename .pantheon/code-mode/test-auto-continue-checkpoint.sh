#!/bin/bash
# Test: auto-continue-checkpoint.sh
# Validates the checkpoint script creates checkpoints and heartbeat files correctly.
# Usage: bash .pantheon/code-mode/test-auto-continue-checkpoint.sh

set -euo pipefail

TEST_DIR="$(mktemp -d)/test-auto-continue"
trap 'rm -rf "$TEST_DIR"' EXIT
SCRIPT=".pantheon/code-mode/auto-continue-checkpoint.sh"

# Ensure script exists
if [ ! -f "$SCRIPT" ]; then
    echo "❌ FAIL: $SCRIPT not found"
    exit 1
fi

echo "=== RED: Testing checkpoint script ==="

# 1. Create a deepwork directory with a STATUS.md
DEEPDIR="$TEST_DIR/test-slug"
mkdir -p "$DEEPDIR"
cat > "$DEEPDIR/STATUS.md" << 'EOF'
# STATUS — test-slug
**Date:** 2026-07-16T20:00:00Z
**Phase:** 2
**Turns:** 15
**Status:** In Progress
EOF

# 2. Run the checkpoint script targeting our test directory
# We need to run from repo root and use SLUG that maps to our test dir
# The script uses .pantheon/deepwork/<slug>, so we need to symlink or override
# Strategy: create a temporary .pantheon/deepwork/test-slug dir
# Resolve the repo/runtime root from this script's location so the test never
# depends on a hardcoded checkout path (the tarball must be machine-path-free).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
mkdir -p "$REPO_ROOT/.pantheon/deepwork/test-slug"

# Copy STATUS.md into the real deepwork path
cp "$DEEPDIR/STATUS.md" "$REPO_ROOT/.pantheon/deepwork/test-slug/STATUS.md"

# Run the actual script
bash "$REPO_ROOT/$SCRIPT" "test-slug"

# 3. VERIFY: checkpoint file created in the real deepwork path
if [ ! -f "$REPO_ROOT/.pantheon/deepwork/test-slug/checkpoint-1.json" ]; then
    echo "❌ FAIL: checkpoint-1.json not created"
    # Cleanup
    rm -rf "$REPO_ROOT/.pantheon/deepwork/test-slug"
    rm -rf "$TEST_DIR"
    exit 1
fi
echo "  ✅ checkpoint-1.json created"

# 4. VERIFY: heartbeat file created
if [ ! -f "$REPO_ROOT/.pantheon/deepwork/test-slug/heartbeat.json" ]; then
    echo "❌ FAIL: heartbeat.json not created"
    rm -rf "$REPO_ROOT/.pantheon/deepwork/test-slug"
    rm -rf "$TEST_DIR"
    exit 1
fi
echo "  ✅ heartbeat.json created"

# 5. VERIFY: checkpoint content is valid JSON
if ! jq empty "$REPO_ROOT/.pantheon/deepwork/test-slug/checkpoint-1.json" 2>/dev/null; then
    echo "❌ FAIL: checkpoint-1.json is not valid JSON"
    rm -rf "$REPO_ROOT/.pantheon/deepwork/test-slug"
    rm -rf "$TEST_DIR"
    exit 1
fi
echo "  ✅ checkpoint-1.json is valid JSON"

# 6. VERIFY: heartbeat content is valid JSON
if ! jq empty "$REPO_ROOT/.pantheon/deepwork/test-slug/heartbeat.json" 2>/dev/null; then
    echo "❌ FAIL: heartbeat.json is not valid JSON"
    rm -rf "$REPO_ROOT/.pantheon/deepwork/test-slug"
    rm -rf "$TEST_DIR"
    exit 1
fi
echo "  ✅ heartbeat.json is valid JSON"

# 7. VERIFY: checkpoint fields
SLUG_CHECK=$(jq -r '.slug' "$REPO_ROOT/.pantheon/deepwork/test-slug/checkpoint-1.json")
PHASE_CHECK=$(jq -r '.phase' "$REPO_ROOT/.pantheon/deepwork/test-slug/checkpoint-1.json")
TURNS_CHECK=$(jq -r '.turn_count' "$REPO_ROOT/.pantheon/deepwork/test-slug/checkpoint-1.json")

if [ "$SLUG_CHECK" != "test-slug" ]; then
    echo "❌ FAIL: slug mismatch: got '$SLUG_CHECK'"
    rm -rf "$REPO_ROOT/.pantheon/deepwork/test-slug"
    rm -rf "$TEST_DIR"
    exit 1
fi
echo "  ✅ checkpoint slug = '$SLUG_CHECK'"

if [ "$PHASE_CHECK" != "2" ]; then
    echo "❌ FAIL: phase mismatch: got '$PHASE_CHECK'"
    rm -rf "$REPO_ROOT/.pantheon/deepwork/test-slug"
    rm -rf "$TEST_DIR"
    exit 1
fi
echo "  ✅ checkpoint phase = $PHASE_CHECK"

if [ "$TURNS_CHECK" != "15" ]; then
    echo "❌ FAIL: turn_count mismatch: got '$TURNS_CHECK'"
    rm -rf "$REPO_ROOT/.pantheon/deepwork/test-slug"
    rm -rf "$TEST_DIR"
    exit 1
fi
echo "  ✅ checkpoint turn_count = $TURNS_CHECK"

# 8. VERIFY: heartbeat fields
HB_SLUG=$(jq -r '.slug' "$REPO_ROOT/.pantheon/deepwork/test-slug/heartbeat.json")
HB_STATUS=$(jq -r '.status' "$REPO_ROOT/.pantheon/deepwork/test-slug/heartbeat.json")

if [ "$HB_SLUG" != "test-slug" ]; then
    echo "❌ FAIL: heartbeat slug mismatch: got '$HB_SLUG'"
    rm -rf "$REPO_ROOT/.pantheon/deepwork/test-slug"
    rm -rf "$TEST_DIR"
    exit 1
fi
echo "  ✅ heartbeat slug = '$HB_SLUG'"

if [ "$HB_STATUS" != "alive" ]; then
    echo "❌ FAIL: heartbeat status mismatch: got '$HB_STATUS'"
    rm -rf "$REPO_ROOT/.pantheon/deepwork/test-slug"
    rm -rf "$TEST_DIR"
    exit 1
fi
echo "  ✅ heartbeat status = '$HB_STATUS'"

# 9. VERIFY: running a second time creates checkpoint-2.json
bash "$REPO_ROOT/$SCRIPT" "test-slug"

if [ ! -f "$REPO_ROOT/.pantheon/deepwork/test-slug/checkpoint-2.json" ]; then
    echo "❌ FAIL: checkpoint-2.json not created on second run"
    rm -rf "$REPO_ROOT/.pantheon/deepwork/test-slug"
    rm -rf "$TEST_DIR"
    exit 1
fi
echo "  ✅ checkpoint-2.json created (auto-increment works)"

# 10. VERIFY: second checkpoint has updated heartbeat
HB_TIMESTAMP=$(jq -r '.last_action' "$REPO_ROOT/.pantheon/deepwork/test-slug/heartbeat.json")
if [ -z "$HB_TIMESTAMP" ]; then
    echo "❌ FAIL: heartbeat timestamp empty after second run"
    rm -rf "$REPO_ROOT/.pantheon/deepwork/test-slug"
    rm -rf "$TEST_DIR"
    exit 1
fi
echo "  ✅ heartbeat timestamp updated = '$HB_TIMESTAMP'"

# 11. VERIFY: without STATUS.md, script still works (defaults to 0)
bash "$REPO_ROOT/$SCRIPT" "empty-test"
if [ ! -f "$REPO_ROOT/.pantheon/deepwork/empty-test/checkpoint-1.json" ]; then
    echo "❌ FAIL: checkpoint not created for slug without STATUS.md"
    rm -rf "$REPO_ROOT/.pantheon/deepwork/empty-test"
    rm -rf "$REPO_ROOT/.pantheon/deepwork/test-slug"
    rm -rf "$TEST_DIR"
    exit 1
fi

PHASE_DEFAULT=$(jq -r '.phase' "$REPO_ROOT/.pantheon/deepwork/empty-test/checkpoint-1.json")
if [ "$PHASE_DEFAULT" != "0" ]; then
    echo "❌ FAIL: phase should default to 0 without STATUS.md, got '$PHASE_DEFAULT'"
    rm -rf "$REPO_ROOT/.pantheon/deepwork/empty-test"
    rm -rf "$REPO_ROOT/.pantheon/deepwork/test-slug"
    rm -rf "$TEST_DIR"
    exit 1
fi
echo "  ✅ checkpoint works without STATUS.md (phase=0 default)"

# Cleanup all test artifacts
rm -rf "$REPO_ROOT/.pantheon/deepwork/test-slug"
rm -rf "$REPO_ROOT/.pantheon/deepwork/empty-test"
rm -rf "$TEST_DIR"

echo ""
echo "=== ✅ ALL CHECKPOINT TESTS PASSED ==="
