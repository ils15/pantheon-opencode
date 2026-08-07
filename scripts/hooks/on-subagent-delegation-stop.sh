#!/usr/bin/env bash
# on-subagent-delegation-stop.sh — Pantheon SubagentStop Audit Hook
# Logs completion, failure, or BACKGROUND DISPATCH of subagent tasks.
#
# Honest telemetry (Council P1-1, 2026-08-06; P0-1/P0-2, 2026-08-06 2nd
# session): the previous version read AGENT_NAME from env (always '' — opencode
# tool.execute hooks carry no agent_id) and defaulted STATUS to 'success',
# fabricating success even for refusals/failures. This version reads the
# Claude Code protocol payload {tool_name, tool_input, agent_id, session_id,
# delegation_id, task_id, duration_ms} from stdin and derives:
#
#     agent = tool_input.subagent_type (task tool) -> payload agent_id (the
#             plugin's BEFORE-time agent from its callID-keyed record — the
#             after-hook args may carry the MERGED background result
#             {task_id, state} and are NEVER used to derive the agent) ->
#             tool_name -> env AGENT_NAME -> 'unknown'.
#     status = 1. env STATUS override (hook-runner never sets it — empty here)
#              2. payload.status — plugin-derived from the REAL tool result.
#                 P0-1: 'dispatched' is now a first-class status — the task
#                 tool in BACKGROUND mode returns IMMEDIATELY with
#                 {task_id, state:'running'}, so tool.execute.after observes
#                 DISPATCH, not completion. Background dispatch is recorded
#                 as 'dispatched', NEVER 'success'.
#              3. explicit status-ish field inside tool_output, including a
#                 state of running/queued/pending/scheduled -> 'dispatched'
#              4. background-dispatch signature (task_id present in the
#                 result, or state running/queued) -> 'dispatched'
#              5. explicit status-ish field in tool_input (as before)
#              6. strong failure markers in the tool_output text -> 'failure'
#              7. non-empty tool_output.output -> 'success' (real completion
#                 evidence — the result reached the plugin)
#              8. strong failure markers in the tool_input text -> 'failure'
#              9. else 'unknown' — NEVER fabricated 'success'
#     delegation_id = payload.delegation_id — the SAME id the start hook
#             logged (P0-2), so delegations.log joins Start<->Stop on it.
#     task_id       = payload.task_id — the plugin extracts it into its OWN
#             field; never concatenated into agent/status.
#     duration_ms   = payload.duration_ms — plugin-computed from the
#             before-record start timestamp.
# All log fields pass through a primitive sanitizer — a merged result blob can
# never contaminate agent/status/session_id/task_id.
#
# LIMITATION (P0-1, documented): on opencode 1.18.13 real completion of
# BACKGROUND tasks is NOT observable via tool.execute.after (no second
# after-event fires). The stop record for a background launch is 'dispatched'
# by design — 'success' would be fabricated telemetry.
set -euo pipefail

# Project-local by default; set XDG_STATE_HOME for system-wide logging
if [ -n "${LOG_DIR:-}" ]; then
    LOG_DIR="$LOG_DIR"
elif [ -n "${XDG_STATE_HOME:-}" ]; then
    LOG_DIR="$XDG_STATE_HOME/pantheon/hooks"
else
    LOG_DIR="logs/agent-sessions"
fi
mkdir -p "$LOG_DIR"

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Preserve the pre-derivation env values (derived fields overwrite them below).
ENV_AGENT_NAME="${AGENT_NAME:-}"
ENV_STATUS="${STATUS:-}"
ENV_REASON="${REASON:-}"
ARG_REASON="${1:-}"

# The Claude Code protocol payload arrives on stdin (hook-runner always pipes
# it, even empty). Buffer it in a temp file — prompts can exceed argv limits.
TMP_IN=$(mktemp "${TMPDIR:-/tmp}/subagent-stop.XXXXXX")
TMP_PY=$(mktemp "${TMPDIR:-/tmp}/subagent-stop.XXXXXX.py")
TMP_OUT=$(mktemp "${TMPDIR:-/tmp}/subagent-stop.XXXXXX.out")
trap 'rm -f "$TMP_IN" "$TMP_PY" "$TMP_OUT"' EXIT
cat > "$TMP_IN"

# Derivation logic: agent + status + reason + correlation fields from the
# payload. (Kept in a temp file — heredocs inside $(...) are not portable.)
cat > "$TMP_PY" <<'PY'
import sys
import json
import re

def prim(v):
    """P0-1 sanitizer: primitives -> str; junk (dicts/lists from a merged
    result blob) -> '' so log fields are never contaminated."""
    if isinstance(v, str):
        return v
    if isinstance(v, (int, float, bool)):
        return str(v)
    return ''

try:
    with open(sys.argv[1], encoding='utf-8') as f:
        payload = json.load(f)
except Exception:
    payload = {}

env_status = sys.argv[2] if len(sys.argv) > 2 else ''
env_agent = sys.argv[3] if len(sys.argv) > 3 else ''
tool_name = payload.get('tool_name') or ''
ti = payload.get('tool_input')
if not isinstance(ti, dict):
    ti = {}
session_id = prim(payload.get('session_id'))
delegation_id = prim(payload.get('delegation_id'))
task_id = prim(payload.get('task_id'))
duration_ms = prim(payload.get('duration_ms'))

# P1-1 follow-up: the plugin now forwards the REAL tool result —
# payload.tool_output = the tool.execute.after callback output
# ({title, output, metadata}) and payload.status = the plugin-derived status
# from it. Prefer these over the args-only heuristics below.
plugin_status = payload.get('status') or ''
result = payload.get('tool_output')
if not isinstance(result, dict):
    result = None
result_text = json.dumps(result, ensure_ascii=False).lower() if result else ''

# Agent (P0-2): subagent_type -> env AGENT_NAME (plugin agent_id resolved from
# the tool.execute.before record — after-time args may hold the MERGED
# background result {task_id, state} with no subagent_type) -> tool_name -> ''
agent = ti.get('subagent_type') or ti.get('subagentType') or env_agent or tool_name or ''

# Status: env override -> plugin status -> result field -> background dispatch
#         -> tool_input field -> result markers/output -> tool_input markers
#         -> unknown. NEVER fabricated success.
status = env_status
reason = ''
source = ''
STATUS_KEYS = (
    'status', 'state', 'result', 'success', 'ok',
    'error', 'failed', 'error_message', 'exception',
)
SUCCESS_WORDS = ('success', 'successful', 'completed', 'complete',
                 'done', 'finished', 'ok', 'true', '1')
FAILURE_WORDS = ('failure', 'failed', 'error', 'refused', 'denied',
                 'exception', 'false', '0', 'cancelled', 'canceled', 'aborted')
BACKGROUND_STATES = ('running', 'queued', 'pending', 'scheduled', 'dispatched')


def classify(key, val):
    """Return ('success' | 'failure' | '', reason) for a status-ish value."""
    if val in (None, '', False):
        return '', ''
    if isinstance(val, bool):
        return ('success' if val else 'failure'), ''
    if isinstance(val, (str, int, float)):
        low = str(val).strip().lower()
        if low in SUCCESS_WORDS:
            return 'success', ''
        if low in FAILURE_WORDS:
            return 'failure', ''
        return '', "status-like field '%s' present but unrecognized: %s" % (key, str(val)[:80])
    return '', ''


def status_field_in(scope, prefix):
    """First explicit status-ish field inside a dict scope, or ('', '')."""
    for key in STATUS_KEYS:
        if key in scope and scope[key] not in (None, '', False):
            s, r = classify(key, scope[key])
            if s:
                return s, prefix + key
    return '', ''


def result_task_id():
    """P0-1/P0-5: task_id from metadata, JSON-as-string output, or the TEXT
    form `<task id="ses_..." state="running">` (the REAL opencode 1.18.x
    background-dispatch format) — always its own field."""
    if not result:
        return ''
    meta = result.get('metadata')
    if isinstance(meta, dict):
        for k in ('task_id', 'taskId'):
            v = meta.get(k)
            if v:
                return prim(v)
    text = '%s %s' % (result.get('title') or '', result.get('output') or '')
    m = re.search(r'"task_id"\s*:\s*"?([^",\s}]+)"?', text)
    if m:
        return m.group(1)
    m = re.search(r'\btask\s+id="(ses_[^"]+)"', text, re.I)
    if m:
        return m.group(1)
    return ''


def result_state():
    """P0-1/P0-5: state from metadata, JSON-as-string output, or the TEXT
    form `state="running"` (lowercased)."""
    if not result:
        return ''
    meta = result.get('metadata')
    if isinstance(meta, dict) and meta.get('state'):
        return str(meta['state']).strip().lower()
    text = '%s %s' % (result.get('title') or '', result.get('output') or '')
    m = re.search(r'"state"\s*:\s*"?([^",\s}]+)"?', text)
    if m:
        return m.group(1).strip().lower()
    m = re.search(r'\bstate="(running|queued|pending|scheduled|dispatched)"', text, re.I)
    if m:
        return m.group(1).strip().lower()
    return ''


# 2. Plugin-derived status (from the real tool result) — trusted signal.
#    P0-1: 'dispatched' (background launch) is a first-class status.
if not status and plugin_status:
    low = plugin_status.strip().lower()
    if low in ('success', 'failure', 'dispatched'):
        status = low
        source = 'plugin'
        reason = 'plugin-derived status from tool.execute.after result'
    else:
        reason = "plugin status unrecognized: %s" % plugin_status[:80]

# 3. Explicit status field inside the tool result (flat, then metadata).
#    P0-1: a state of running/queued/pending marks a background dispatch.
if not status and result:
    meta = result.get('metadata')
    if isinstance(meta, dict):
        for k in ('state', 'status'):
            v = meta.get(k)
            if v is not None and v is not False:
                if str(v).strip().lower() in BACKGROUND_STATES:
                    status = 'dispatched'
                    source = 'result.metadata.' + k
                    reason = 'background dispatch state in tool result'
                    break
    if not status:
        status, source = status_field_in(result, 'result.')
        if not status and isinstance(meta, dict):
            status, source = status_field_in(meta, 'result.metadata.')
        if status:
            reason = "explicit field '%s' in tool result indicates %s" % (source, status)

# 4. P0-1: background-dispatch signature — task_id present in the result
#    (metadata or JSON-as-string output) without a terminal status above.
if not status and result:
    tid = result_task_id()
    state = result_state()
    if tid or state in BACKGROUND_STATES:
        status = 'dispatched'
        source = 'result'
        reason = 'background dispatch: task_id=%s state=%s (completion not observable)' % (
            tid or '-', state or '-')

# 5. Explicit status field in tool_input (as before).
if not status:
    for key in STATUS_KEYS:
        if key in ti and ti[key] not in (None, '', False):
            val = ti[key]
            status, reason = classify(key, val)
            source = key
            if status:
                break
            reason = reason or ''
            break

# 6. Strong failure markers in the tool result text.
if not status and result:
    markers = ('"refused"', '"denied"', '"traceback"', '"exception"',
               'failed to', 'unable to', 'timed out', 'error:')
    if any(m in result_text for m in markers):
        status = 'failure'
        source = 'result'
        reason = 'failure markers found in tool result'

# 7. Non-empty result output = real completion evidence.
if not status and result:
    out = result.get('output')
    if isinstance(out, str) and out.strip():
        status = 'success'
        source = 'result'
        reason = 'tool result output present (real completion evidence)'

# 8. Strong failure markers in tool_input (as before).
if not status:
    text = json.dumps(ti, ensure_ascii=False).lower()
    markers = ('"refused"', '"denied"', '"traceback"', '"exception"',
               'failed to', 'unable to', 'timed out', 'error:')
    if any(m in text for m in markers):
        status = 'failure'
        source = 'tool_input'
        reason = 'failure markers found in tool_input'

# 9. Unknown — never fabricated success.
if not status:
    status = 'unknown'
    keys = ','.join(sorted(ti.keys())) if ti else '(empty)'
    reason = ('no result/status in payload; tool_input keys: %s'
              '; tool_output present: %s') % (keys, 'yes' if result else 'no')
if not reason and status in ('success', 'failure', 'dispatched'):
    reason = "explicit field '%s' indicates %s" % (source, status) if source else 'env STATUS override'

# P0-5: task_id fallback — the TEXT form `<task id="ses_...">` is the REAL
# background-dispatch format on opencode 1.18.x; derive it standalone so the
# script emits the id in its own field even without the plugin's extraction.
# A payload-supplied task_id (plugin-derived) always wins.
if not task_id and result:
    task_id = result_task_id()

# Result snippet for telemetry (kept short — prompts can be huge). This is the
# free-text blob in its OWN field — it never contaminates agent/status/etc.
result_snippet = ''
if result:
    try:
        raw = result.get('output') or result.get('title') or json.dumps(result, ensure_ascii=False)
        result_snippet = str(raw)[:200]
    except Exception:
        result_snippet = ''

# P0-5: JSON round-trip replaces the 8-field TSV (a real newline in
# result_snippet used to shift fields 5-8 into garbage with cut -fN). ONE
# json.dumps line — result_snippet and reason are additionally newline/tab-
# collapsed + 200-char truncated so NO delimiter-breaking character can
# corrupt the handoff or the log line (defense in depth on top of the
# json.dumps escaping).

def clean(v):
    """Collapse \n\t\r to single spaces; truncate to 200 chars."""
    return re.sub(r'[\n\t\r]+', ' ', str(v))[:200]


print(json.dumps({
    'agent': prim(agent),
    'status': prim(status),
    'session_id': session_id,
    'result_snippet': clean(result_snippet),
    'delegation_id': delegation_id,
    'task_id': task_id,
    'duration_ms': duration_ms,
    'reason': clean(reason),
}, ensure_ascii=False))
PY

DERIVED=$(python3 "$TMP_PY" "$TMP_IN" "$ENV_STATUS" "$ENV_AGENT_NAME" 2>/dev/null || printf '{"agent":"unknown","status":"unknown"}')

# P0-5: JSON round-trip into the bash variables — NO cut/TSV anywhere. The
# derivation script emits ONE json.dumps line (snippet/reason already
# newline-collapsed); a python3 one-liner parses it back into NUL-delimited
# values; bash reads each field with `IFS= read -r -d ''` so every field
# arrives intact — empty fields survive (no tab-collapsing), spaces/unicode
# are not split, and no delimiter-breaking character can shift fields. On
# python failure the fallback JSON above keeps agent/status honest.
printf '%s' "$DERIVED" | python3 -c '
import json
import sys

try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
for name in ("agent", "status", "session_id", "result_snippet",
             "delegation_id", "task_id", "duration_ms", "reason"):
    sys.stdout.write(str(d.get(name, "")))
    sys.stdout.write("\0")
' > "$TMP_OUT" || true
{
    IFS= read -r -d '' AGENT_NAME
    IFS= read -r -d '' STATUS
    IFS= read -r -d '' SESSION_ID
    IFS= read -r -d '' RESULT_SNIPPET
    IFS= read -r -d '' DELEGATION_ID
    IFS= read -r -d '' TASK_ID
    IFS= read -r -d '' DURATION_MS
    IFS= read -r -d '' REASON
} < "$TMP_OUT" || true

# Agent fallback chain (subagent_type -> env -> tool_name -> 'unknown').
if [ -z "$AGENT_NAME" ]; then
    AGENT_NAME="$ENV_AGENT_NAME"
fi
if [ -z "$AGENT_NAME" ]; then
    AGENT_NAME="unknown"
fi

# Legacy positional/env reason fallback (only when the derivation found none).
if [ -z "$REASON" ]; then
    REASON="${ENV_REASON:-$ARG_REASON}"
fi

# Emit a schema-compatible line: {event, timestamp, agent, status, reason,
# session_id, result, delegation_id, task_id, duration_ms} — P0-2: the
# delegation_id joins this record to the matching SubagentStart; task_id and
# duration_ms ride in their OWN fields. Built with json.dumps so arbitrary
# reason/result text cannot break the JSON.
LOG_LINE=$(python3 -c '
import json
import sys
print(json.dumps({
    "event": "SubagentStop",
    "timestamp": sys.argv[1],
    "agent": sys.argv[2],
    "status": sys.argv[3],
    "reason": sys.argv[4],
    "session_id": sys.argv[5],
    "result": sys.argv[6],
    "delegation_id": sys.argv[7],
    "task_id": sys.argv[8],
    "duration_ms": sys.argv[9] or None,
}, ensure_ascii=False))
' "$TIMESTAMP" "$AGENT_NAME" "$STATUS" "$REASON" "$SESSION_ID" "$RESULT_SNIPPET" "$DELEGATION_ID" "$TASK_ID" "$DURATION_MS")

LOG_FILE="$LOG_DIR/delegations.log"
if [ "$STATUS" = "failure" ]; then
    LOG_FILE="$LOG_DIR/delegation-failures.log"
fi

echo "$LOG_LINE" >> "$LOG_FILE"

echo "[DELEGATION] $AGENT_NAME stopped ($STATUS) delegation=$DELEGATION_ID → $LOG_FILE" >&2

# --- Post-condition validation: remind about Themis review ---
if echo "hermes aphrodite demeter prometheus" | grep -wq "$AGENT_NAME" 2>/dev/null; then
    echo "[POST-CONDITION] 🔔 Reminder: '$AGENT_NAME' should call Themis for review after implementation" >&2
fi

exit 0
