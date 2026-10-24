import { rmSync } from 'node:fs'

const SEMVER =
  /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const VERSION_TOKEN = /(?<![0-9A-Za-z.+-])v?\d[0-9A-Za-z.+-]*(?=$|[^0-9A-Za-z.+-])/g

function normalizeExpectedVersion(expected) {
  const value = String(expected).trim()
  if (!SEMVER.test(value)) {
    throw new Error(
      `expected OpenCode version is not a valid semantic version: ${JSON.stringify(value)}`,
    )
  }
  return value.replace(/^v/, '')
}

/** Parse the single semantic-version token printed by `opencode --version`. */
export function parseOpenCodeVersion(output) {
  const text = String(output).trim()
  const candidates = [...text.matchAll(VERSION_TOKEN)]
    .map(([token]) => token)
    .filter((token) => /^v?\d+\./.test(token))

  if (candidates.length !== 1 || !SEMVER.test(candidates[0] ?? '')) {
    throw new Error(`could not parse one valid OpenCode version from ${JSON.stringify(text)}`)
  }
  return candidates[0].replace(/^v/, '')
}

/** Require a successful host command and exact normalized version identity. */
export function assertOpenCodeVersion({ output, expected, status }) {
  const expectedVersion = normalizeExpectedVersion(expected)
  const actualVersion = parseOpenCodeVersion(output)
  if (status !== 0 || actualVersion !== expectedVersion) {
    throw new Error(
      `tool canary expected OpenCode ${expectedVersion}, got ${JSON.stringify(String(output).trim())} (parsed=${actualVersion}, status=${status})`,
    )
  }
  return actualVersion
}

/** Replace every exact occurrence of a generated secret, including across lines. */
export function redactDiagnosticSecret(value, secret) {
  const text = String(value)
  if (typeof secret !== 'string' || secret.length === 0) return text
  return text.split(secret).join('[REDACTED]')
}

/** Stop only the owned child process, and fail unless its exit is observed. */
export function createChildProcessStopper(
  child,
  { waitForExit, timeoutMs = 1000, sanitize = String } = {},
) {
  if (typeof waitForExit !== 'function') {
    throw new TypeError('waitForExit must be a function')
  }

  const exited = () => child.exitCode !== null || child.signalCode !== null
  const wait = async () => {
    try {
      await waitForExit(timeoutMs)
    } catch {
      // Exit state below is authoritative; a waiter failure must not look like
      // successful cleanup.
    }
  }
  const signal = (name) => {
    try {
      child.kill(name)
    } catch {
      // Verify the child state after waiting and fail closed if it is alive.
    }
  }

  return async function stopChildProcess() {
    if (exited()) return

    signal('SIGTERM')
    await wait()
    if (exited()) return

    signal('SIGKILL')
    await wait()
    if (!exited()) {
      throw new Error(sanitize(`host pid ${child.pid} remained alive after SIGKILL`))
    }
  }
}

/** Track every canary-owned temp project from creation through test teardown. */
export function createSandboxCleanupRegistry(remove = rmSync) {
  const roots = new Set()
  return {
    register(root) {
      roots.add(root)
      return root
    },
    cleanup() {
      const errors = []
      for (const root of roots) {
        try {
          remove(root, { recursive: true, force: true })
        } catch (error) {
          errors.push(error)
        }
      }
      roots.clear()
      if (errors.length > 0) {
        throw new AggregateError(errors, 'failed to remove one or more canary temp projects')
      }
    },
  }
}

export const canarySandboxCleanup = createSandboxCleanupRegistry()
