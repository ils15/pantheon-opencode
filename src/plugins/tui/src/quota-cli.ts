import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, parse, resolve, sep } from 'node:path'

const CLI_TIMEOUT_MS = 5_000
const MAX_STDOUT_BYTES = 16 * 1024
const MAX_STDERR_BYTES = 4 * 1024
const CLI_ARGS = ['usage', 'token-plan', '--output', 'json'] as const
const TRUSTED_EXECUTABLE_ENV = 'PANTHEON_TRUSTED_BL_EXECUTABLE'
const SAFE_ENV_NAMES = ['HOME', 'LANG', 'LC_ALL', 'LC_MESSAGES', 'TZ'] as const

export type AlibabaTokenPlanUsageResult =
  | { readonly percentage: number }
  | { readonly reason: 'cli_identity_unavailable' | 'provider_error' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse only the documented Bailian CLI JSON fields for Personal Token Plan. */
export function parseAlibabaTokenPlanPercentage(output: string): number | undefined {
  try {
    const value: unknown = JSON.parse(output)
    if (!isRecord(value)) return undefined
    if (
      Object.keys(value).some((key) => !['per1MonthPercentage', 'per1MonthResetTime'].includes(key))
    ) {
      return undefined
    }
    if (
      'per1MonthResetTime' in value &&
      (typeof value.per1MonthResetTime !== 'number' ||
        !Number.isSafeInteger(value.per1MonthResetTime) ||
        value.per1MonthResetTime < 0)
    ) {
      return undefined
    }
    const percentage = value.per1MonthPercentage
    return typeof percentage === 'number' &&
      Number.isFinite(percentage) &&
      percentage >= 0 &&
      percentage <= 1
      ? percentage
      : undefined
  } catch {
    return undefined
  }
}

function safeCliEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined {
  if (typeof environment.HOME !== 'string' || environment.HOME.length === 0) return undefined
  const result: NodeJS.ProcessEnv = {}
  for (const name of SAFE_ENV_NAMES) {
    const value = environment[name]
    if (typeof value === 'string' && value.length <= 4096) result[name] = value
  }
  return result
}

async function trustedExecutable(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const path = environment[TRUSTED_EXECUTABLE_ENV]
  if (
    typeof path !== 'string' ||
    path.length > 4096 ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    basename(path) !== 'bl' ||
    // Node's Windows mode bits do not prove ACL write restrictions.
    process.platform === 'win32'
  ) {
    return undefined
  }

  try {
    const resolvedPath = await realpath(path)
    if (resolvedPath !== path) return undefined

    const root = parse(resolvedPath).root
    const components = resolvedPath.slice(root.length).split(sep)
    let currentPath = root
    let executable: Awaited<ReturnType<typeof lstat>> | undefined
    for (const [index, component] of components.entries()) {
      if (!component) continue
      currentPath = join(currentPath, component)
      const metadata = await lstat(currentPath)
      if (metadata.isSymbolicLink()) return undefined
      if (index === components.length - 1) {
        executable = metadata
        continue
      }
      if (!metadata.isDirectory()) return undefined
      const permissions = metadata.mode & 0o7777
      const isSticky = (permissions & 0o1000) !== 0
      // A sticky shared directory prevents other users replacing another owner's entry.
      if ((permissions & 0o222) !== 0 && !isSticky) return undefined
    }

    if (
      !executable?.isFile() ||
      (Number(executable.mode) & 0o111) === 0 ||
      (Number(executable.mode) & 0o222) !== 0
    ) {
      return undefined
    }
    await access(resolvedPath, constants.X_OK)
    if ((await realpath(path)) !== resolvedPath) return undefined

    const verifiedExecutable = await lstat(resolvedPath)
    if (
      verifiedExecutable.isSymbolicLink() ||
      !verifiedExecutable.isFile() ||
      (Number(verifiedExecutable.mode) & 0o111) === 0 ||
      (Number(verifiedExecutable.mode) & 0o222) !== 0
    ) {
      return undefined
    }
    return resolvedPath
  } catch {
    return undefined
  }
}

function isMissingExecutable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return error.code === 'ENOENT' || error.code === 'EACCES'
}

/**
 * Run the fixed Bailian command only through an explicitly trusted absolute
 * executable path. Credentials remain in the CLI's own login store; Pantheon
 * passes no provider secrets or arbitrary arguments.
 */
export async function queryAlibabaTokenPlanUsage(
  signal: AbortSignal,
  spawnProcess: typeof spawn = spawn,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AlibabaTokenPlanUsageResult> {
  if (signal.aborted) return { reason: 'provider_error' }
  const env = safeCliEnvironment(environment)
  if (!env?.HOME) return { reason: 'cli_identity_unavailable' }
  const executable = await trustedExecutable(environment)
  if (!executable) return { reason: 'cli_identity_unavailable' }
  if (signal.aborted) return { reason: 'provider_error' }

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawnProcess(executable, [...CLI_ARGS], {
        shell: false,
        windowsHide: true,
        cwd: env.HOME,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({
        reason: isMissingExecutable(error) ? 'cli_identity_unavailable' : 'provider_error',
      })
      return
    }
    if (!child.stdout || !child.stderr) {
      child.kill()
      resolve({ reason: 'provider_error' })
      return
    }

    let settled = false
    let stdoutBytes = 0
    let stderrBytes = 0
    const chunks: Buffer[] = []
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    const timeout = setTimeout(() => fail('provider_error', true), CLI_TIMEOUT_MS)
    timeout.unref()

    const terminate = () => {
      try {
        child.kill('SIGTERM')
      } catch {
        // The child may have exited between the event and the signal.
      }
      forceKillTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // The child may have exited between the signals.
        }
      }, 250)
      forceKillTimer.unref()
    }

    const finish = (result: AlibabaTokenPlanUsageResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    }

    const fail = (reason: 'cli_identity_unavailable' | 'provider_error', kill = false) => {
      if (kill) terminate()
      finish({ reason })
    }

    const onAbort = () => fail('provider_error', true)
    child.stdout.on('data', (chunk: Buffer | Uint8Array) => {
      if (settled) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      stdoutBytes += bytes.byteLength
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        fail('provider_error', true)
        return
      }
      chunks.push(bytes)
    })
    child.stderr.on('data', (chunk: Buffer | Uint8Array) => {
      if (settled) return
      stderrBytes += chunk.byteLength
      if (stderrBytes > MAX_STDERR_BYTES) fail('provider_error', true)
    })
    child.on('error', (error) =>
      fail(isMissingExecutable(error) ? 'cli_identity_unavailable' : 'provider_error'),
    )
    child.on('close', (code) => {
      if (forceKillTimer) clearTimeout(forceKillTimer)
      if (settled) return
      if (code !== 0) {
        fail('provider_error')
        return
      }
      const percentage = parseAlibabaTokenPlanPercentage(Buffer.concat(chunks).toString('utf8'))
      finish(percentage === undefined ? { reason: 'provider_error' } : { percentage })
    })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}
