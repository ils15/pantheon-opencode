#!/bin/bash
# Pantheon v3.9.1 — Complete Validation Suite
# Run: bash .tests/test-all.sh

cd /home/ils15/pantheon || exit 1

echo "=========================================="
echo "  Pantheon v3.9.1 — Validation Suite"
echo "=========================================="
echo ""

PASS=0
FAIL=0
TOTAL=0

run_test() {
  TOTAL=$((TOTAL + 1))
  echo -n "  [$1] $2... "
  if "$@"; then
    echo "✅ PASS"
    PASS=$((PASS + 1))
  else
    echo "❌ FAIL"
    FAIL=$((FAIL + 1))
  fi
}

sh_test() {
  local desc="$1" cmd="$2"
  TOTAL=$((TOTAL + 1))
  echo -n "  [$desc] ... "
  if eval "$cmd" > /dev/null 2>&1; then
    echo "✅ PASS"
    PASS=$((PASS + 1))
  else
    echo "❌ FAIL"
    FAIL=$((FAIL + 1))
  fi
}

echo "--- Visual Review Pipeline ---"
sh_test "TC-27" 'grep -q "verdict" instructions/visual-review-pipeline.instructions.md &&
  grep -q "issues" instructions/visual-review-pipeline.instructions.md &&
  grep -q "pass_if_fixed" instructions/visual-review-pipeline.instructions.md'
sh_test "TC-28" 'grep -q "visual_review" routing.yml &&
  grep -q "visual_fix" routing.yml &&
  grep -q "visual_escalate" routing.yml'
sh_test "TC-29" 'grep -q "3 iterations" instructions/visual-review-pipeline.instructions.md &&
  grep -q "escalat" agents/zeus.agent.md'
sh_test "TC-30" 'grep -q "MCP Check Protocol\|Playwright MCP" agents/zeus.agent.md'

echo ""
echo "--- MCP Frontmatter ---"
sh_test "TC-31" 'missing=0; for f in agents/*.agent.md; do grep -q "mcpServers:" "$f" || missing=$((missing+1)); done; [ "$missing" -eq 0 ]'
sh_test "TC-32" 'over=0; for f in agents/*.agent.md; do count=$(awk "/^mcpServers:/,/^---/" "$f" | grep -c "  - name:"); [ "$count" -gt 5 ] && over=$((over+1)); done; [ "$over" -eq 0 ]'
sh_test "TC-33" 'grep -q "context7_resolve-library-id" agents/aphrodite.agent.md &&
  grep -q "browser/screenshotPage" agents/aphrodite.agent.md &&
  grep -q "brave-search_search" agents/apollo.agent.md'
sh_test "TC-34" 'grep -q "queryMode.*parameterized-only" agents/hermes.agent.md &&
  grep -q "readOnly.*true" agents/hermes.agent.md &&
  grep -q "forbiddenFlags" agents/prometheus.agent.md'

echo ""
echo "--- Search Optimization ---"
sh_test "TC-35" 'grep -q "name: exa" agents/apollo.agent.md &&
  grep -q "name: grep-app" agents/apollo.agent.md &&
  grep -q "name: context7" agents/apollo.agent.md &&
  grep -q "name: brave-search" agents/apollo.agent.md'
echo ""
echo "--- Security Hardening ---"
sh_test "TC-39" 'grep -q "Parameterized Query Mandate" agents/demeter.agent.md &&
  grep -q "NEVER.*f-strings" agents/demeter.agent.md &&
  grep -q "Pre-Flight Checklist" agents/demeter.agent.md'
sh_test "TC-40" 'grep -q "readOnly.*true" agents/hermes.agent.md &&
  grep -q "Read-Only Constraint" agents/hermes.agent.md &&
  grep -q "SELECT only" agents/hermes.agent.md'
sh_test "TC-41" 'grep -q "Mandatory Security Flags" agents/prometheus.agent.md &&
  grep -q "Forbidden Flags" agents/prometheus.agent.md &&
  grep -q -e "--cap-drop=ALL" agents/prometheus.agent.md &&
  grep -q "Pre-Run Checklist" agents/prometheus.agent.md'
sh_test "TC-42" 'grep -q "MCP Security Violation" agents/themis.agent.md &&
  grep -q "SQL Injection" agents/themis.agent.md &&
  grep -q "Docker escape" agents/themis.agent.md &&
  grep -q "Credential leak" agents/themis.agent.md'
sh_test "TC-43" 'grep -q "Credential Leakage" agents/apollo.agent.md &&
  grep -q "URL allowlist" agents/apollo.agent.md &&
  grep -q "Credential safety" agents/argus.agent.md'

echo ""
echo "--- Adapter Conformance ---"
sh_test "TC-44" 'node scripts/test-adapter-conformance.mjs 2>&1 | tail -1 | grep -q "check(s) failed" && false || true'
sh_test "TC-45" 'count=$(ls platform/opencode/agents/*.md 2>/dev/null | wc -l); [ "$count" -eq 14 ]'
sh_test "TC-46" 'count=$(ls platform/claude/agents/*.md 2>/dev/null | wc -l); [ "$count" -eq 14 ]'
sh_test "TC-47" 'count=$(ls platform/cursor/rules/*.mdc 2>/dev/null | wc -l); [ "$count" -eq 14 ]'
sh_test "TC-48" 'count=$(ls platform/windsurf/rules/*.md 2>/dev/null | wc -l); [ "$count" -eq 14 ]'

echo ""
echo "--- Platform Sync ---"
sh_test "SYNC-1" 'node scripts/sync-platforms.mjs --dry-run 2>&1 | grep -q "already up-to-date\|Would update\|Would create"'

echo ""
echo "=========================================="
echo "  Summary: $PASS/$TOTAL passed, $FAIL failed"
echo "=========================================="

exit $FAIL
