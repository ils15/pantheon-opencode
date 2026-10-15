/**
 * bench/lib/aggregate.mjs — pure statistics + aggregation contracts for the
 * beta-10 latency baseline harness (Phase 0).
 *
 * Everything in this module is PURE: no I/O, no clock, no randomness. The
 * runner (bench/bin/bench.mjs) feeds it collected records; the tests in
 * tests/bench-aggregate.test.mjs lock the contracts:
 *
 *   - root + children token aggregation counts each session exactly once
 *   - failed / timed-out / interrupted runs are never "completed" and never
 *     enter median/p80 pools
 *   - an unavailable metric is {status:'unavailable', reason} — never zero
 *
 * @module bench/lib/aggregate
 */

/** Arithmetic mean of the two middle values for even samples (median). */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(
      'median of an empty sample is undefined; treat empty as unavailable upstream',
    )
  }
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

/** Nearest-rank percentile; p must be in (0, 1]. */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(
      'percentile of an empty sample is undefined; treat empty as unavailable upstream',
    )
  }
  if (!(p > 0) || p > 1) {
    throw new TypeError(`percentile p must be in (0, 1], got ${p}`)
  }
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil(p * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

/**
 * Decide whether a bench run counts as completed.
 *
 * A run is completed ONLY when: the child exited 0, it did not time out, the
 * root session was found in the db, and the root session did not end with a
 * failed/interrupted idle outcome. Anything else is a recorded failure.
 */
export function runIsCompleted({ exitCode, timedOut, rootSession }) {
  if (timedOut === true) return false
  if (exitCode !== 0) return false
  if (!rootSession || typeof rootSession !== 'object') return false
  const outcome = rootSession.idle_outcome
  if (outcome === 'failed' || outcome === 'interrupted') return false
  return true
}

/**
 * Walk the session tree once (visited-set) and sum per-message token rows.
 *
 * `sessions` are the raw db rows (root + every descendant); `messages` are the
 * per-assistant-message token records joined to their session_id. The tree is
 * traversed from `rootId` through parent_id edges with a visited set, so a
 * hostile parent cycle can never double count. Messages belonging to sessions
 * outside the tree are ignored — that is the no-double-counting guarantee:
 * every token row enters the sum at most once, through exactly one session.
 *
 * Token fields missing from a message count as absent (undefined → skipped),
 * because "absent" and "zero" are different facts. Callers that need the
 * distinction read the returned `tokensSource` counts.
 */
export function aggregateSessionTree(sessions, messages, rootId) {
  const byId = new Map()
  const childrenOf = new Map()
  for (const s of sessions) {
    if (!byId.has(s.id)) byId.set(s.id, s)
    const parent = s.parent_id
    if (typeof parent === 'string' && parent !== '' && parent !== s.id) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, [])
      childrenOf.get(parent).push(s.id)
    }
  }

  // Visited-once BFS from the root.
  const ordered = []
  const seen = new Set()
  const queue = [rootId]
  while (queue.length > 0) {
    const id = queue.shift()
    if (typeof id !== 'string' || seen.has(id) || !byId.has(id)) continue
    seen.add(id)
    ordered.push(id)
    for (const child of childrenOf.get(id) ?? []) queue.push(child)
  }

  const inTree = new Set(ordered)
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  let tokenMessages = 0
  for (const msg of messages) {
    if (!inTree.has(msg.session_id)) continue
    const t = msg.tokens
    if (!t || typeof t !== 'object') continue
    tokenMessages += 1
    if (typeof t.input === 'number') tokens.input += t.input
    if (typeof t.output === 'number') tokens.output += t.output
    if (typeof t.reasoning === 'number') tokens.reasoning += t.reasoning
    const cache = t.cache
    if (cache && typeof cache === 'object') {
      if (typeof cache.read === 'number') tokens.cacheRead += cache.read
      if (typeof cache.write === 'number') tokens.cacheWrite += cache.write
    }
  }

  return {
    sessionIds: ordered,
    childrenCount: Math.max(0, ordered.length - 1),
    tokens,
    tokenMessages,
    tokensSource: tokenMessages > 0 ? 'ok' : 'empty',
  }
}

/** Merge per-name tool call counts across runs (completed runs only, upstream). */
function mergeToolCalls(perRuns) {
  const totals = {}
  for (const calls of perRuns) {
    if (!calls || typeof calls !== 'object' || calls.status === 'unavailable') continue
    for (const [name, count] of Object.entries(calls)) {
      if (typeof count === 'number') totals[name] = (totals[name] ?? 0) + count
    }
  }
  return totals
}

/**
 * Summarize collected runs into the report shape.
 *
 * Only `status === 'completed'` runs feed median/p80/token/tool pools;
 * failures are counted and carried with their reasons. A pool with zero
 * completed runs is reported as {status:'unavailable', reason} — never as 0.
 */
export function summarizeRuns(runs) {
  const completed = runs.filter((r) => r.status === 'completed')
  const failed = runs.filter((r) => r.status !== 'completed')

  const pool = (values) => {
    if (values.length === 0) {
      return { status: 'unavailable', reason: 'no completed runs in this sample' }
    }
    return { median: median(values), p80: percentile(values, 0.8), n: values.length }
  }

  const perScenario = {}
  for (const r of completed) {
    const bucket = perScenario[r.scenario] ?? {
      runs: 0,
      completed: 0,
      failures: 0,
      wallMsValues: [],
    }
    bucket.completed += 1
    bucket.wallMsValues.push(r.wallMs)
    perScenario[r.scenario] = bucket
  }
  for (const r of failed) {
    const bucket = perScenario[r.scenario] ?? {
      runs: 0,
      completed: 0,
      failures: 0,
      wallMsValues: [],
    }
    bucket.failures += 1
    perScenario[r.scenario] = bucket
  }
  for (const bucket of Object.values(perScenario)) {
    bucket.runs = bucket.completed + bucket.failures
    bucket.wallMs =
      bucket.wallMsValues.length === 0
        ? { status: 'unavailable', reason: 'no completed runs for this scenario' }
        : { median: median(bucket.wallMsValues), p80: percentile(bucket.wallMsValues, 0.8) }
    delete bucket.wallMsValues
  }

  const tokenFields = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite']
  const completedTokens = completed.map((r) => r.tokens)
  const completeTokenRecords = completedTokens.filter(
    (tokens) =>
      tokens &&
      typeof tokens === 'object' &&
      tokens.status === 'ok' &&
      tokenFields.every((field) => typeof tokens[field] === 'number'),
  )
  const tokens =
    completed.length > 0 && completeTokenRecords.length === completed.length
      ? {
          status: 'ok',
          input: completeTokenRecords.reduce((a, t) => a + t.input, 0),
          output: completeTokenRecords.reduce((a, t) => a + t.output, 0),
          cacheRead: completeTokenRecords.reduce((a, t) => a + t.cacheRead, 0),
          cacheWrite: completeTokenRecords.reduce((a, t) => a + t.cacheWrite, 0),
          perRunMedianInput: median(completeTokenRecords.map((t) => t.input)),
          perRunMedianOutput: median(completeTokenRecords.map((t) => t.output)),
          completeRuns: completeTokenRecords.length,
          completedRuns: completed.length,
        }
      : {
          status: 'unavailable',
          reason:
            completed.length === 0
              ? 'no completed runs in this sample'
              : 'token fields unavailable or incomplete for one or more completed runs',
          completeRuns: completeTokenRecords.length,
          completedRuns: completed.length,
        }

  return {
    runs: runs.length,
    completed: completed.length,
    failures: failed.length,
    failureReasons: failed.map((r) => r.failureReason ?? 'unknown'),
    wallMs: pool(completed.map((r) => r.wallMs)),
    tokens,
    toolCalls: mergeToolCalls(completed.map((r) => r.toolCalls)),
    childrenCount:
      completed.length > 0
        ? percentile(
            completed.map((r) => r.childrenCount ?? 0),
            0.5,
          )
        : null,
    perScenario,
  }
}

/** Summarize paired arms independently so control and candidate never mix. */
export function summarizeRunsByArm(runs) {
  const arms = [...new Set(runs.map((run) => run.arm).filter((arm) => typeof arm === 'string'))]
  return Object.fromEntries(
    arms.map((arm) => [arm, summarizeRuns(runs.filter((run) => run.arm === arm))]),
  )
}
