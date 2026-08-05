/**
 * hook-runner.ts — version-proof runner for the Pantheon security-hook layer.
 *
 * The previous plugin used the Bun Shell `$` injected by the opencode plugin
 * API (`$.quiet().nothrow().timeout(...)`). `.timeout()` does not exist on the
 * BunShell interface, so every hook crashed with a TypeError and the layer was
 * removed (24-25/07). This runner uses ONLY `node:child_process` — stable
 * across every Node >= 18 runtime and every opencode plugin loader version.
 *
 * Claude Code stdin protocol: the hook scripts receive
 * `{tool_name, tool_input, agent_id, session_id}` as JSON on stdin. Scripts
 * that read env vars instead (log-session-start.sh, on-subagent-delegation-*)
 * get their fields mapped into the child env (SESSION_ID / AGENT_NAME /
 * TASK_DESC) so both protocols work end to end.
 *
 * IMPORTANT (verified empirically): the `input:` option on the async
 * `execFile()` API is silently ignored by Node — it only exists on
 * spawnSync/execFileSync. This runner therefore writes stdin explicitly to a
 * spawned child, which delivers the payload reliably.
 *
 * Hooks NEVER throw: every failure (missing script, timeout, non-zero exit)
 * is returned as a structured HookResult so the opencode session can never be
 * taken down by the security layer.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

export const HOOK_TIMEOUT_MS = 15_000
export const HOOK_MAX_BUFFER = 10 * 1024 * 1024

/** Claude Code hook protocol payload. */
export type HookPayload = {
  tool_name?: string
  tool_input?: unknown
  agent_id?: string
  session_id?: string
}

export type HookResult = {
  code: number
  stdout: string
  stderr: string
  signal: NodeJS.Signals | null
  timedOut: boolean
}

export type RunHookOptions = {
  env?: Record<string, string | undefined>
  cwd?: string
  timeout?: number
}

/**
 * Resolve the hooks directory relative to this module — robust to any npm
 * global-install prefix because it anchors on import.meta.url, not __dirname
 * or process.cwd().
 */
export function resolveHooksDir(): string {
  return fileURLToPath(new URL('../../scripts/hooks/', import.meta.url))
}

/**
 * Map the Claude Code protocol payload into the child environment. Scripts
 * that read env vars (log-session-start.sh, delegation audit scripts) rely on
 * these; scripts that read stdin receive the full JSON via `input` in runHook.
 * PATH is always preserved so `python3`/`bash` resolution inside the scripts
 * is never affected by a stripped-down environment.
 */
export function hookEnv(
  payload: HookPayload,
  extra?: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: process.env.PATH ?? '',
    SESSION_ID: payload.session_id ?? '',
    AGENT_NAME: payload.agent_id ?? '',
    TASK_DESC: payload.tool_name ?? '',
    ...(extra ?? {}),
  }
}

/**
 * Run one hook script with the Claude Code protocol payload on stdin.
 *
 * @param script  file name inside scripts/hooks/ (e.g. "validate-tool-safety.sh")
 * @param payload protocol payload translated from the opencode hook event
 * @param opts    optional env overrides / cwd / timeout
 * @returns      HookResult — NEVER throws; resolve with a non-zero code instead
 */
export function runHook(
  script: string,
  payload: HookPayload,
  opts: RunHookOptions = {},
): Promise<HookResult> {
  const scriptPath = path.join(opts.cwd ?? resolveHooksDir(), script)
  const timeout = opts.timeout ?? HOOK_TIMEOUT_MS

  return new Promise<HookResult>((resolve) => {
    const stdoutBuf: { value: string } = { value: '' }
    const stderrBuf: { value: string } = { value: '' }
    let settled = false

    const settle = (result: HookResult) => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }

    const spawnOpts = {
      timeout,
      killSignal: 'SIGKILL' as const,
      env: hookEnv(payload, opts.env),
      stdio: 'pipe' as const,
      windowsHide: true,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    }

    // stdio:'pipe' picks the ChildProcessWithoutNullStreams overload — do not
    // widen these option literals or child.stdin/stdout become nullable.
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(scriptPath, [], spawnOpts)
    } catch (err) {
      // Synchronous spawn failure (invalid args etc.) — never propagate.
      settle({
        code: 1,
        stdout: '',
        stderr: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        signal: null,
        timedOut: false,
      })
      return
    }

    // The child may exit before we write stdin — swallow EPIPE instead of
    // crashing the plugin process with an unhandled stream error.
    child.stdin.on('error', () => {})

    const collect = (stream: Readable, buf: { value: string }) => {
      stream.setEncoding('utf-8')
      stream.on('data', (chunk: string) => {
        if (buf.value.length < HOOK_MAX_BUFFER) {
          buf.value += chunk.slice(0, HOOK_MAX_BUFFER - buf.value.length)
        }
      })
    }
    collect(child.stdout, stdoutBuf)
    collect(child.stderr, stderrBuf)

    child.on('error', (err: NodeJS.ErrnoException) => {
      // ENOENT / EACCES — script missing or not executable. Report, never throw.
      settle({
        code: 1,
        stdout: stdoutBuf.value,
        stderr: stderrBuf.value || `hook script failed to spawn: ${err.message}`,
        signal: null,
        timedOut: false,
      })
    })

    child.on('close', (code, signal) => {
      settle({
        code: code ?? 1,
        stdout: stdoutBuf.value,
        stderr: stderrBuf.value,
        signal,
        timedOut: code === null && signal === 'SIGKILL',
      })
    })

    // Deliver the Claude Code protocol JSON on stdin.
    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  })
}
