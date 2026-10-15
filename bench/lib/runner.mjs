/**
 * bench/lib/runner.mjs — non-interactive `opencode run` execution for the
 * beta-10 latency baseline harness (Phase 0).
 *
 * Contract highlights (locked by tests/bench-runner.test.mjs):
 *   - the child is spawned NON-interactively: `opencode run --format json
 *     --standalone --auto --log-level debug --agent <selected> --title … --model
 *     <model> <prompt>` — no shell, the prompt rides as the final positional
 *     argument. Two flags are REQUIRED, not cosmetic:
 *       · `--log-level debug` — observed on opencode 2.0.27, the V2 tool-hook
 *         registration only completes under debug logging (without it the
 *         session runs with tools but the plugin's execute.before/after hooks
 *         never fire — reproducible 4/4 vs 0/2)
 *       · `--agent zeus` — headless runs without an agent create sessions with
 *         agent=NULL and the V2 delegation policy then denies EVERY subagent
 *         spawn ("caller or target is not allowed"), which is NOT the user's
 *         real profile (the TUI starts sessions on the default agent)
 *   - resolveBenchEnv never mutates the host env; it strips stale session and
 *     config-override vars and points XDG_CONFIG_HOME at the bench shadow
 *     config dir (built by the CLI: host content, repo plugin pinned)
 *   - a timed-out child is killed and the run is recorded with timedOut=true;
 *     completion semantics are decided later by aggregate.runIsCompleted
 *
 * @module bench/lib/runner
 */

import { spawn as nodeSpawn } from 'node:child_process'

const TAIL_CHARS = 2000

/**
 * Build the child env for one bench run.
 *
 * - OPENCODE_SESSION_ID: a stale value would attach the run to a foreign
 *   session — always stripped.
 * - OPENCODE_CONFIG / OPENCODE_CONFIG_CONTENT / OPENCODE_CONFIG_DIR: host
 *   config overrides would race the bench shadow config — always stripped.
 * - XDG_CONFIG_HOME: pointed at the bench shadow config dir, so the private
 *   (`--standalone`) server loads the REPO plugin from the shadow opencode.json
 *   instead of the globally installed copy (config merge is additive, so
 *   pinning plugins inside a shadow dir — not a config override — is what
 *   guarantees the instrumented plugin is the one that registers its hooks).
 * - PWD/OLDPWD: the host shell's PWD would disagree with the spawn cwd, and
 *   project/workspace resolution that consults PWD would resolve the run to
 *   the WRONG directory (observed: sessions attributed to the repo). PWD is
 *   pinned to the run directory and OLDPWD dropped.
 * - OPENCODE_DB is deliberately NOT set: provider credentials live in the
 *   global opencode.db `credential` table, and the collector scopes sessions
 *   by their unique sessionID — the global db is both the auth source and the
 *   metric source, read STRICTLY read-only.
 * Everything else is inherited verbatim (provider auth, PATH, proxy…).
 */
export function resolveBenchEnv(hostEnv, { configDir, cwd }) {
  const env = { ...hostEnv }
  delete env.OPENCODE_SESSION_ID
  delete env.OPENCODE_CONFIG
  delete env.OPENCODE_CONFIG_CONTENT
  delete env.OPENCODE_CONFIG_DIR
  delete env.OLDPWD
  env.XDG_CONFIG_HOME = configDir
  env.PWD = cwd
  return env
}

/** NDJSON stdout → event objects (non-JSON lines skipped, never thrown). */
export function parseEvents(stdout) {
  const events = []
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      // progress/noise lines are expected — ignore
    }
  }
  return events
}

/** First sessionID found across the NDJSON events, or null. */
export function extractSessionId(events) {
  for (const event of events) {
    if (event && typeof event === 'object' && typeof event.sessionID === 'string') {
      return event.sessionID
    }
  }
  return null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Default spawn adapter: resolves an {stdout, stderr, exitCode, timedOut,
 * killed} handle when the child closes. SIGKILLs the child after timeoutMs.
 */
function spawnAndWait({ cmd, args, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = nodeSpawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: null, timedOut, killed: false })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code, timedOut, killed: child.killed || timedOut })
    })
  })
}

/**
 * Run ONE non-interactive bench run and measure its wall time.
 *
 * `spawn` is injectable for tests: either a function returning a promise of
 * the result handle (async path) or a synchronous handle
 * {stdout, stderr, exitCode, killed, onKill?} whose completion is polled up
 * to timeoutMs (stub path — onKill fires instead of a real signal).
 */
export async function runOnce({
  cwd,
  prompt,
  model,
  title,
  timeoutMs,
  env,
  spawn,
  agent = 'zeus',
}) {
  const args = [
    'run',
    '--format',
    'json',
    '--standalone',
    '--auto',
    '--log-level',
    'debug',
    '--agent',
    agent,
    '--title',
    title ?? 'pantheon-bench',
    '--model',
    model,
    prompt,
  ]
  const startedAt = Date.now()
  let result
  if (typeof spawn === 'function') {
    const handle = spawn('opencode', args, { cwd, env })
    if (handle && typeof handle.then === 'function') {
      result = await handle
    } else {
      // Synchronous stub handle: poll for an exit code until the timeout.
      const deadline = Date.now() + timeoutMs
      while (handle.exitCode === null && Date.now() < deadline) {
        await sleep(5)
      }
      if (handle.exitCode === null) {
        handle.timedOut = true
        handle.onKill?.()
      }
      result = handle
    }
  } else {
    result = await spawnAndWait({ cmd: 'opencode', args, cwd, env, timeoutMs })
  }
  const events = parseEvents(result.stdout)
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut === true,
    wallMs: Date.now() - startedAt,
    events,
    sessionId: extractSessionId(events),
    stdoutTail: String(result.stdout ?? '').slice(-TAIL_CHARS),
    stderrTail: String(result.stderr ?? '').slice(-TAIL_CHARS),
  }
}
