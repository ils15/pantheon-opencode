/**
 * Native Probe — lazy capability detection for native task() delegation.
 *
 * The probe is invoked on the FIRST native delegation of a session (not at
 * startup). It creates a child session with a minimal "ping" prompt, waits
 * for idle, and classifies the output.
 *
 * Results are cached per probe instance (singleton guard):
 *   - UNAVAILABLE is TERMINAL — no retry.
 *   - AVAILABLE is also cached — no re-probe.
 *
 * Uses the OpenCode V1 session API (session.create + promptAsync) injected via
 * the parent context.
 *
 * @module native-probe
 */

import { createPantheonLogger } from './logger.ts'

const log = createPantheonLogger({ module: 'native-probe' })

// ─── Types ─────────────────────────────────────────────────────────────

/** Possible outcomes of a native capability probe. */
export type NativeProbeResult = {
  status: 'AVAILABLE' | 'UNAVAILABLE' | 'UNSUPPORTED'
}

/** Minimal V1 client shape needed by the probe (session.create + promptAsync). */
export interface ProbeClient {
  session: {
    create: (input: { body: { parentID: string } }) => Promise<{ id: string }>
    promptAsync: (input: {
      path: { id: string }
      body: { agent: string; parts: Array<{ type: 'text'; text: string }> }
    }) => Promise<unknown>
  }
}

/** Context injected into the probe function. */
export interface NativeProbeContext {
  client: ProbeClient
  parentSessionID: string
}

/** Options for a single probe invocation. */
export interface NativeProbeOptions {
  /** Timeout in milliseconds. Default: 30000. */
  timeoutMs?: number
}

/** The probe function signature. */
export type NativeProbeFn = (
  ctx: NativeProbeContext,
  options?: NativeProbeOptions,
) => Promise<NativeProbeResult>

// ─── Helpers ───────────────────────────────────────────────────────────

/** Default timeout for the probe. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Sentinel value indicating a timeout occurred. */
const TIMEOUT_SENTINEL = Symbol('timeout')

/**
 * Wrap a promise with a timeout.
 * Returns the value on success, throws the original error on rejection,
 * or returns TIMEOUT_SENTINEL if the timeout fires first.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof TIMEOUT_SENTINEL> {
  return new Promise<T | typeof TIMEOUT_SENTINEL>((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), ms)
    void promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * Extract text content from a promptAsync response.
 * Returns empty string if no recognizable content found.
 */
function extractOutput(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return result
  if (typeof result === 'object') {
    const obj = result as Record<string, unknown>
    // Check common shapes: { output }, { content }, { text }
    if (typeof obj.output === 'string') return obj.output
    if (typeof obj.content === 'string') return obj.content
    if (typeof obj.text === 'string') return obj.text
  }
  // Non-empty object → treat as content (accepted message, etc.)
  if (typeof result === 'object' && result !== null) {
    return 'acknowledged'
  }
  return ''
}

function isUnsupportedError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('not available') ||
    lower.includes('not supported') ||
    lower.includes('unsupported') ||
    lower.includes('method not found')
  )
}

// ─── Implementation ────────────────────────────────────────────────────

/**
 * Create a native probe function with per-instance caching.
 *
 * The probe is LAZY: it does not run at startup. Call it on the first
 * native delegation of the session. The result is cached — subsequent
 * calls return the cached value without re-probing.
 *
 * @returns A probe function that caches results per instance.
 */
export function createNativeProbe(): NativeProbeFn {
  let cachedResult: NativeProbeResult | null = null
  let inFlight: Promise<NativeProbeResult> | null = null

  return async (
    ctx: NativeProbeContext,
    options?: NativeProbeOptions,
  ): Promise<NativeProbeResult> => {
    // Return cached result if available (singleton guard)
    if (cachedResult !== null) {
      return cachedResult
    }
    // Concurrent first dispatches share one probe instead of creating multiple
    // child sessions. The promise is cleared only after a terminal result.
    if (inFlight !== null) return inFlight

    inFlight = probe(ctx, options)
    try {
      return await inFlight
    } finally {
      inFlight = null
    }
  }

  async function probe(
    ctx: NativeProbeContext,
    options?: NativeProbeOptions,
  ): Promise<NativeProbeResult> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS

    // ── Phase 1: create child session ──────────────────────────────
    let childID: string
    try {
      const createResult = await withTimeout(
        ctx.client.session.create({ body: { parentID: ctx.parentSessionID } }),
        timeoutMs,
      )
      if (createResult === TIMEOUT_SENTINEL) {
        // Timeout during session.create → UNAVAILABLE
        log.warn('[Native Probe] session.create timed out after', timeoutMs, 'ms')
        const result: NativeProbeResult = { status: 'UNAVAILABLE' }
        cachedResult = result
        return result
      }
      childID = createResult.id
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('[Native Probe] session.create failed:', msg)
      // Check for unsupported API patterns
      if (isUnsupportedError(msg)) {
        const result: NativeProbeResult = { status: 'UNSUPPORTED' }
        cachedResult = result
        return result
      }
      // Other creation failures → UNAVAILABLE
      const result: NativeProbeResult = { status: 'UNAVAILABLE' }
      cachedResult = result
      return result
    }

    // ── Phase 2: send probe prompt ─────────────────────────────────
    let promptResult: unknown
    try {
      const raw = await withTimeout(
        ctx.client.session.promptAsync({
          path: { id: childID },
          body: { agent: 'probe', parts: [{ type: 'text', text: 'Reply with PONG.' }] },
        }),
        timeoutMs,
      )
      if (raw === TIMEOUT_SENTINEL) {
        // Timeout during promptAsync → UNAVAILABLE
        log.warn('[Native Probe] promptAsync timed out after', timeoutMs, 'ms')
        const result: NativeProbeResult = { status: 'UNAVAILABLE' }
        cachedResult = result
        return result
      }
      promptResult = raw
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('[Native Probe] promptAsync failed:', msg)
      if (isUnsupportedError(msg)) {
        const result: NativeProbeResult = { status: 'UNSUPPORTED' }
        cachedResult = result
        return result
      }
      // promptAsync error → UNAVAILABLE
      const result: NativeProbeResult = { status: 'UNAVAILABLE' }
      cachedResult = result
      return result
    }

    // ── Phase 3: classify output ───────────────────────────────────
    const output = extractOutput(promptResult)
    const hasContent = output.trim() !== ''

    const result: NativeProbeResult = {
      status: hasContent ? 'AVAILABLE' : 'UNAVAILABLE',
    }
    cachedResult = result
    return result
  }
}
