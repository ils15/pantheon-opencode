/**
 * j-telemetry-file.ts — field-baseline mirror for the J-series shadow
 * records (J1 risk gate, J3 escalation, J4 review).
 *
 * The in-memory sink (`createTelemetrySink`) is deliberately I/O-free and
 * "the plugin never reads back" — which made the shadow records impossible
 * to measure in the field, and the J1/J3 activation gate requires a measured
 * baseline. This module adds the measurement channel: an opt-in JSONL mirror
 * (`.pantheon/logs/j-telemetry.jsonl`) written ONLY when the J-series flags
 * are on, carrying ONLY the already-sanitized record fields (point, mode,
 * effect, reason tokens — the same bounded vocabulary the in-memory records
 * carry; no user content exists on this path by construction).
 *
 * Fire-and-forget like every plugin log: a write failure is swallowed and
 * never reaches the hook. The file is size-capped (rotate to `.1`, drop the
 * oldest) so a long session cannot grow it unbounded.
 */

import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const MAX_FILE_BYTES = 1_048_576

/** Default mirror target: the established Pantheon logs directory. */
export function defaultMirrorPath(cwd: string = process.cwd()): string {
  return join(cwd, '.pantheon', 'logs', 'j-telemetry.jsonl')
}

/** The record fields allowed on the wire. Everything else is dropped. */
const ALLOWED_FIELDS = ['point', 'mode', 'effect', 'decision', 'reason'] as const

/** Extract the bounded projection a mirror line may carry. */
export function mirrorProjection(record: unknown): Record<string, unknown> | null {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null
  const source = record as Record<string, unknown>
  const projected: Record<string, unknown> = { ts: new Date().toISOString() }
  for (const field of ALLOWED_FIELDS) {
    const value = source[field]
    if (value === undefined) continue
    if (typeof value !== 'string') return null
    if (value.length > 200) return null
    projected[field] = value
  }
  return projected
}

export interface JTelemetryMirror {
  /**
   * Append one sanitized record line; best-effort, never throws. Fire-and-
   * forget at call sites (the promise may be ignored); it is returned so a
   * test can await the write.
   */
  record(record: unknown): Promise<void>
}

/**
 * Create the opt-in JSONL mirror. Returns null when `enabled` is false so
 * callers keep the zero-overhead path branch-free.
 * @param {{ enabled: boolean, path?: string }} options
 */
export function createJTelemetryMirror(options: {
  enabled: boolean
  path?: string
}): JTelemetryMirror | null {
  if (!options.enabled) return null
  const path = options.path ?? defaultMirrorPath()
  let rotating = false
  return {
    record(record: unknown): Promise<void> {
      try {
        const projected = mirrorProjection(record)
        if (projected === null) return Promise.resolve()
        const line = `${JSON.stringify(projected)}\n`
        return (async () => {
          try {
            if (!rotating) {
              const current = await stat(path).catch(() => null)
              if (current !== null && current.size > MAX_FILE_BYTES) {
                rotating = true
                await rename(path, `${path}.1`).catch(() => {})
                rotating = false
              }
            }
            await mkdir(dirname(path), { recursive: true })
            await appendFile(path, line, 'utf8')
          } catch {
            // Best-effort mirror — never break the plugin over telemetry.
          }
        })()
      } catch {
        // Swallow: projection failures are data-shaped, never fatal.
        return Promise.resolve()
      }
    },
  }
}
