/**
 * bench/lib/hooklog.mjs — parser for the `[bench]` hook instrumentation lines
 * in .pantheon/logs/hooks.log (beta-10 latency slice, Phase 0).
 *
 * The instrumentation (src/plugin.ts) appends, per tool call:
 *
 *   [ISO] [bench] tool.execute.before end tool=<name> callID=<id> started_at=<ISO> duration_ms=<n>
 *   [ISO] [bench] tool.execute.after  end tool=<name> callID=<id> duration_ms=<n> since_before_ms=<n>
 *
 * The leading `[ISO] ` prefix is the append helper's write-time stamp. All
 * parsing is pure text work; malformed lines are skipped, never thrown.
 *
 * @module bench/lib/hooklog
 */

const BENCH_LINE = /\[bench\] tool\.execute\.(before|after) end tool=(\S+) callID=(\S+)(.*)/
const KV = /(\w+)=(\S+)/g

function parseKvPairs(rest) {
  const out = {}
  for (const match of rest.matchAll(KV)) {
    out[match[1]] = match[2]
  }
  return out
}

function parseMs(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function parseIsoMs(value) {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Extract every well-formed `[bench]` entry from a hooks.log text.
 *
 * Returns entries: {phase, tool, callID, durationMs, startedAtMs, lineAtMs,
 * sinceBeforeMs}. `lineAtMs` is the write-time stamp of the line itself; for
 * the before line `startedAtMs` is the hook's own start clock. Malformed or
 * non-bench lines (including a non-numeric duration) are ignored.
 */
export function parseBenchHookLines(text) {
  if (typeof text !== 'string' || text === '') return []
  const entries = []
  for (const line of text.split('\n')) {
    const match = line.match(BENCH_LINE)
    if (!match) continue
    const [, phase, tool, callID, rest] = match
    const kv = parseKvPairs(rest)
    const lineAtMs = parseIsoMs(line.match(/^\[([^\]]+)\]/)?.[1])
    const durationMs = parseMs(kv.duration_ms)
    if (durationMs === null) continue
    entries.push({
      phase,
      tool,
      callID,
      durationMs,
      startedAtMs: phase === 'before' ? parseIsoMs(kv.started_at) : null,
      lineAtMs,
      sinceBeforeMs: kv.since_before_ms === undefined ? null : parseMs(kv.since_before_ms),
    })
  }
  return entries
}

/**
 * Summarize parsed entries.
 *
 * - `beforeMs` / `afterMs`: the wall time the plugin spends INSIDE each hook
 *   handler (the hook-chain overhead the slice wants to attribute).
 * - `chainMs`: per callID, after-end minus before-start (the full guarded
 *   window around the tool call). Computed only for callIDs observed in both
 *   phases; otherwise {status:'unavailable'}.
 *
 * Empty input → {status:'unavailable', reason} — never zeros.
 */
export function summarizeHookTimings(entries, fallbackStartIso = null) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return {
      status: 'unavailable',
      reason:
        'no [bench] hook lines found in hooks.log (instrumentation absent or the wrong plugin generation ran)',
    }
  }
  const before = entries.filter((e) => e.phase === 'before')
  const after = entries.filter((e) => e.phase === 'after')

  const pool = (values) => {
    if (values.length === 0) return { status: 'unavailable', reason: 'no samples' }
    const sorted = [...values].sort((a, b) => a - b)
    const rank80 = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.8 * sorted.length) - 1))
    const mid = Math.floor(sorted.length / 2)
    const med = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    return { median: med, p80: sorted[rank80], n: sorted.length }
  }

  // Chain: after-line write stamp − before-start clock, per matched callID.
  const beforeStartByCall = new Map()
  for (const e of before) {
    if (e.startedAtMs !== null) beforeStartByCall.set(e.callID, e.startedAtMs)
  }
  const chainValues = []
  for (const e of after) {
    const start = beforeStartByCall.get(e.callID)
    if (start === undefined) continue
    const end =
      e.lineAtMs ??
      (e.sinceBeforeMs !== null && start !== undefined ? start + e.sinceBeforeMs : null)
    if (end === null) continue
    chainValues.push(Math.max(0, end - start))
  }

  return {
    status: 'ok',
    beforeCount: before.length,
    afterCount: after.length,
    beforeMs: pool(before.map((e) => e.durationMs)),
    afterMs: pool(after.map((e) => e.durationMs)),
    chainMs: chainValues.length
      ? pool(chainValues)
      : { status: 'unavailable', reason: 'no callID observed in both before and after phases' },
    fallbackStartIso,
  }
}
