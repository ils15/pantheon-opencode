#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
/**
 * Offline/ambiental probe for context_rehydrate and context_session_summary.
 *
 * The Python child imports the installed persistence server and exercises the
 * real FastMCP tools against a temporary SQLite database. No OpenCode command,
 * network call, LLM, or user database is involved. Missing package/runtime is
 * NOT_TESTED/AMBIENTAL rather than a false PASS.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const requestedVersion = valueFor('--version')
const jsonOutput = process.argv.includes('--json')
const runtime = fileURLToPath(new URL('./mcp_persistence_server.py', import.meta.url))

function valueFor(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function emit(status, detail, checks = []) {
  const result = { status, version: requestedVersion, detail, checks }
  if (jsonOutput) process.stdout.write(JSON.stringify(result))
  else process.stdout.write(`${status}: ${detail}\n`)
  if (status === 'FAIL') process.exitCode = 1
}

function unavailable(detail) {
  emit('NOT_TESTED', detail)
}

function pythonCandidates() {
  const venvPython = process.env.HOME
    ? join(process.env.HOME, '.config', 'opencode', '.venv', 'bin', 'python')
    : undefined
  return [process.env.PANTHEON_PYTHON, venvPython, 'python3'].filter(Boolean)
}

const PYTHON_HARNESS = `
import asyncio
import importlib.util
import json
import os
import sys
from pathlib import Path

runtime_path = Path(sys.argv[1]).resolve()
db_root = Path(sys.argv[2]).resolve()
sys.path.insert(0, str(runtime_path.parent))
sys.argv = [str(runtime_path), "--global-db", str(db_root / "global.db"),
            "--project-db", str(db_root / "project.db")]

spec = importlib.util.spec_from_file_location("probe_mcp_persistence", runtime_path)
if spec is None or spec.loader is None:
    raise RuntimeError("could not load persistence runtime")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


async def call(name, arguments):
    result = await module.mcp.call_tool(name, arguments)
    if isinstance(result, tuple):
        structured = result[1]
        if structured is not None:
            if isinstance(structured, dict) and "result" in structured:
                return structured["result"]
            return structured
        result = result[0]
    if isinstance(result, dict):
        return result
    if not result:
        return None
    text = getattr(result[0], "text", str(result[0]))
    try:
        return json.loads(text)
    except (TypeError, ValueError, json.JSONDecodeError):
        return text


async def main():
    checks = []
    slug = "context-rehydrate-probe"
    session_id = "synthetic-session"
    checkpoint = {
        "version": 1,
        "goal": {"id": "probe-goal", "objective": "verify context recovery",
                 "status": "in_progress"},
        "phase": {"current": 2, "total": 3, "name": "offline validation"},
        "delegations": {"in_flight": [{"alias": "apo-probe", "agent": "apollo",
                                         "task_id": "probe-task"}]},
    }
    tail = ["phase 1 complete", "phase 2 payload validated"]

    # context_save creates the real session-qualified latest pointer. Keeping
    # tail under its own key also tests the runtime's latest/tail fallback.
    await call("context_save", {"slug": slug, "key": "tail",
                                 "content": json.dumps(tail),
                                 "session_id": session_id})
    await call("context_save", {"slug": slug, "key": "phase:2",
                                 "content": json.dumps(checkpoint),
                                 "session_id": session_id})
    latest = await call("context_get", {"slug": slug, "key": "latest",
                                         "session_id": session_id})
    stored_tail = await call("context_get", {"slug": slug, "key": "tail",
                                              "session_id": session_id})
    if latest is None or stored_tail is None:
        raise AssertionError("synthetic latest/tail checkpoint payload is null")
    checks.append("synthetic latest/tail/goal/phase/delegation checkpoint: PASS")

    os.environ.pop("PANTHEON_COMPACTION", None)
    os.environ.pop("PANTHEON_SESSION_END_SUMMARY", None)
    blocks = await call("context_rehydrate", {"slug": slug})
    summary = await call("context_session_summary", {"slug": slug})
    if not isinstance(blocks, list) or not blocks:
        raise AssertionError("context_rehydrate returned a null/empty payload")
    if not isinstance(summary, str) or not summary:
        raise AssertionError("context_session_summary returned a null/empty payload")
    for fragment in ("verify context recovery", "phase 2/3", "apo-probe",
                     "phase 2 payload validated"):
        if not any(fragment in block for block in blocks) and fragment not in summary:
            raise AssertionError(f"payload is missing {fragment!r}")
    checks.append("context_rehydrate non-null payload: PASS")
    checks.append("context_session_summary non-null payload: PASS")

    missing_blocks = await call("context_rehydrate", {"slug": "probe-absent"})
    missing_summary = await call("context_session_summary", {"slug": "probe-absent"})
    if missing_blocks is not None or missing_summary is not None:
        raise AssertionError("absent checkpoint must return null payloads")
    checks.append("absence returns null: PASS")

    expired_slug = "context-expired-probe"
    await call("context_save", {"slug": expired_slug, "key": "phase:1",
                                 "content": json.dumps(checkpoint), "ttl": -1,
                                 "session_id": session_id})
    expired_blocks = await call("context_rehydrate", {"slug": expired_slug})
    expired_summary = await call("context_session_summary", {"slug": expired_slug})
    if expired_blocks is not None or expired_summary is not None:
        raise AssertionError("expired checkpoint must return null payloads")
    checks.append("expiration returns null: PASS")

    invalid_slug = "context-invalid-probe"
    await call("context_save", {"slug": invalid_slug, "key": "phase:1",
                                 "content": "not-json", "session_id": session_id})
    invalid_blocks = await call("context_rehydrate", {"slug": invalid_slug})
    invalid_summary = await call("context_session_summary", {"slug": invalid_slug})
    if invalid_blocks is not None or invalid_summary is not None:
        raise AssertionError("invalid checkpoint must return null payloads")
    checks.append("invalid payload returns null: PASS")

    os.environ["PANTHEON_COMPACTION"] = "off"
    switched_blocks = await call("context_rehydrate", {"slug": slug})
    if switched_blocks is not None:
        raise AssertionError("PANTHEON_COMPACTION=off must return null")
    os.environ.pop("PANTHEON_COMPACTION", None)
    os.environ["PANTHEON_SESSION_END_SUMMARY"] = "off"
    switched_summary = await call("context_session_summary", {"slug": slug})
    if switched_summary is not None:
        raise AssertionError("PANTHEON_SESSION_END_SUMMARY=off must return null")
    checks.append("kill-switches return null: PASS")
    print(json.dumps({"checks": checks}))


asyncio.run(main())
`

async function main() {
  if (requestedVersion !== 'v1' && requestedVersion !== 'v2') {
    emit('FAIL', 'usage: --version v1|v2 [--json]')
    return
  }
  if (!existsSync(runtime)) {
    unavailable('installed package does not include mcp_persistence_server.py')
    return
  }

  const root = mkdtempSync(join(tmpdir(), 'pantheon-context-probe-'))
  const dbRoot = join(root, 'db')
  const python = pythonCandidates().find((candidate) =>
    candidate.includes('/') ? existsSync(candidate) : true,
  )
  if (!python) {
    rmSync(root, { recursive: true, force: true })
    unavailable('Python persistence runtime is not available')
    return
  }

  try {
    const child = spawnSync(python, ['-c', PYTHON_HARNESS, runtime, dbRoot], {
      encoding: 'utf8',
      timeout: 30000,
      env: process.env,
    })
    if (child.error) {
      const detail = child.error instanceof Error ? child.error.message : String(child.error)
      if (/EACCES|permission denied|not found/i.test(detail)) {
        emit('AMBIENTAL', `persistence runtime unavailable: ${detail}`)
      } else {
        unavailable(`persistence runtime unavailable: ${detail}`)
      }
      return
    }
    if (child.signal === 'SIGTERM') {
      emit('AMBIENTAL', 'persistence probe timed out after 30s')
      return
    }
    if (child.status !== 0) {
      const detail = `${child.stderr || child.stdout || 'persistence probe failed'}`.trim()
      if (
        /No module named|ModuleNotFoundError|can't open file|No such file|importerror/i.test(detail)
      ) {
        unavailable(`persistence runtime unavailable: ${detail.slice(0, 320)}`)
      } else {
        emit('FAIL', `offline persistence checks failed: ${detail.slice(0, 320)}`)
      }
      return
    }

    const lines = child.stdout.trim().split('\n').filter(Boolean)
    const payload = JSON.parse(lines.at(-1) || '')
    if (!Array.isArray(payload.checks) || payload.checks.length < 6) {
      emit('FAIL', 'offline persistence probe returned incomplete checks')
      return
    }
    emit(
      'PASS',
      'offline synthetic persistence checks passed; no LLM or user DB was used',
      payload.checks,
    )
  } catch (error) {
    emit('FAIL', error instanceof Error ? error.message : String(error))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

await main()
