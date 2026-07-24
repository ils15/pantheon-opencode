#!/usr/bin/env bash
# validate-post-conditions.sh — Stop hook
# Checks that Themis review was called after implementation
set -euo pipefail

# Read JSON input from stdin
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null || echo "")

REVIEW_DIR=".pantheon/memory-bank/.tmp"
if [ -d "$REVIEW_DIR" ]; then
    REVIEW_COUNT=$(ls "$REVIEW_DIR"/REVIEW-* 2>/dev/null | wc -l)
    if [ "$REVIEW_COUNT" -eq 0 ]; then
        echo "[POST-CONDITION] ⚠️ No REVIEW artifact found in $REVIEW_DIR/" >&2
        echo "[POST-CONDITION] 💡 Remember: implementation agents MUST call @themis for review" >&2
    else
        echo "[POST-CONDITION] ✅ $REVIEW_COUNT REVIEW artifact(s) found" >&2
    fi
fi

exit 0
