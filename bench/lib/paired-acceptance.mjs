import { summarizeRuns } from './aggregate.mjs'

/** Separate successful execution from the identity/routing contract per arm. */
export function assessPairedRun({
  arm,
  completed,
  requestedAgent,
  observedAgent,
  rootAvailable,
  rootParentId,
  childrenCount,
  toolCalls,
  agentRouting,
  routingParity = false,
  instructions,
  globalInstructionFixture,
  projectInstructionFixture,
}) {
  const entries = Array.isArray(instructions?.entries) ? instructions.entries : []
  const matchingEntries = (fixture) =>
    fixture && typeof fixture.sha256 === 'string' && Number.isInteger(fixture.bytes)
      ? entries.flatMap((entry, index) =>
          entry?.sha256 === fixture.sha256 && entry.bytes === fixture.bytes ? [index] : [],
        )
      : []
  const d4Available =
    instructions?.status === 'ok' && globalInstructionFixture && projectInstructionFixture
  const d4Matches = d4Available
    ? entries.length === 2 &&
      matchingEntries(globalInstructionFixture).some((globalIndex) =>
        matchingEntries(projectInstructionFixture).some(
          (projectIndex) => globalIndex !== projectIndex,
        ),
      )
    : null
  const checks = {
    runtimeCompleted: completed === true,
    rootAgentMatches: rootAvailable ? observedAgent === requestedAgent : null,
    rootHasNoParent: rootAvailable ? rootParentId === null : null,
    doubleInjectionProvenance: d4Matches,
  }

  if (routingParity) {
    checks.agentRoutingAvailable = agentRouting?.status === 'ok' ? true : null
    checks.toolCallLedgerAvailable =
      typeof toolCalls === 'object' && toolCalls !== null && toolCalls.status !== 'unavailable'
        ? true
        : null
  } else if (arm === 'candidate') {
    checks.hasNoChildren = childrenCount === null ? null : childrenCount === 0
    checks.didNotAttemptSubagent =
      toolCalls?.status === 'unavailable'
        ? null
        : typeof toolCalls === 'object' && toolCalls !== null
          ? (toolCalls.subagent ?? 0) === 0
          : null
  }

  const values = Object.values(checks)
  const status = values.includes(false)
    ? 'ineligible'
    : values.includes(null)
      ? 'unavailable'
      : 'eligible'
  return { status, checks }
}

function normalizedRoute(record) {
  const sessions = record?.agentRouting?.sessions
  if (record?.agentRouting?.status !== 'ok' || !Array.isArray(sessions)) {
    return { status: 'unavailable', reason: 'session agent identities are unavailable' }
  }
  const byId = new Map()
  for (const session of sessions) {
    if (
      typeof session?.id !== 'string' ||
      session.id === '' ||
      typeof session.agent !== 'string' ||
      session.agent === '' ||
      byId.has(session.id)
    ) {
      return { status: 'unavailable', reason: 'session routing rows are incomplete or duplicated' }
    }
    byId.set(session.id, session)
  }

  const roots = sessions.filter((session) => session.parentId === null)
  if (roots.length !== 1) {
    return { status: 'unavailable', reason: 'session routing tree must have exactly one root' }
  }
  const root = roots[0]
  const depths = new Map([[root.id, 0]])
  const visiting = new Set()
  const depthOf = (id) => {
    if (depths.has(id)) return depths.get(id)
    if (visiting.has(id)) return null
    const session = byId.get(id)
    if (!session || typeof session.parentId !== 'string' || session.parentId === '') return null
    visiting.add(id)
    const parentDepth = depthOf(session.parentId)
    visiting.delete(id)
    if (parentDepth === null) return null
    const depth = parentDepth + 1
    depths.set(id, depth)
    return depth
  }

  const descendants = []
  for (const session of sessions) {
    if (session.id === root.id) continue
    const depth = depthOf(session.id)
    if (depth === null) {
      return { status: 'unavailable', reason: 'session routing tree has an orphan or cycle' }
    }
    descendants.push({ parentDepth: depth - 1, agent: session.agent })
  }
  descendants.sort(
    (left, right) => left.parentDepth - right.parentDepth || left.agent.localeCompare(right.agent),
  )
  return { status: 'ok', rootAgent: root.agent, descendants }
}

function subagentCount(record) {
  const calls = record?.toolCalls
  if (!calls || typeof calls !== 'object' || calls.status === 'unavailable') return null
  const count = calls.subagent ?? 0
  return Number.isInteger(count) && count >= 0 ? count : null
}

/** Compare each interleaved pair's normalized route and delegation count. */
export function assessPairedRoutingParity(runs) {
  const pairs = new Map()
  for (const run of runs) {
    if (!Number.isInteger(run?.pair)) continue
    const pair = pairs.get(run.pair) ?? {}
    if (run.arm === 'control' || run.arm === 'candidate') {
      if (pair[run.arm] !== undefined) pair.duplicate = true
      pair[run.arm] = run
    }
    pairs.set(run.pair, pair)
  }

  return Object.fromEntries(
    [...pairs.entries()].map(([pairId, pair]) => {
      let result
      if (!pair.control || !pair.candidate || pair.duplicate) {
        result = {
          status: 'unavailable',
          checks: { pairComplete: false, routeMatches: null, subagentCallsMatch: null },
          reason: 'pair is missing an arm or contains a duplicate arm',
        }
      } else {
        const controlRoute = normalizedRoute(pair.control)
        const candidateRoute = normalizedRoute(pair.candidate)
        const controlCalls = subagentCount(pair.control)
        const candidateCalls = subagentCount(pair.candidate)
        const routeAvailable = controlRoute.status === 'ok' && candidateRoute.status === 'ok'
        const callsAvailable = controlCalls !== null && candidateCalls !== null
        const routeMatches = routeAvailable
          ? controlRoute.rootAgent === candidateRoute.rootAgent &&
            JSON.stringify(controlRoute.descendants) === JSON.stringify(candidateRoute.descendants)
          : null
        const subagentCallsMatch = callsAvailable ? controlCalls === candidateCalls : null
        const checks = {
          pairComplete: true,
          routeMatches,
          subagentCallsMatch,
        }
        const values = Object.values(checks)
        result = {
          status: values.includes(false)
            ? 'ineligible'
            : values.includes(null)
              ? 'unavailable'
              : 'eligible',
          checks,
          controlRoute,
          candidateRoute,
          controlSubagentCalls: controlCalls,
          candidateSubagentCalls: candidateCalls,
        }
      }
      return [String(pairId), result]
    }),
  )
}

/** Metric summaries include only completed runs meeting their arm contract. */
export function summarizePairedRunsByArm(runs) {
  return Object.fromEntries(
    ['control', 'candidate'].map((arm) => {
      const armRuns = runs.filter((run) => run.arm === arm)
      const eligible = armRuns.filter((run) => run.armAcceptance?.status === 'eligible')
      return [
        arm,
        {
          runs: armRuns.length,
          eligible: eligible.length,
          ineligible: armRuns.filter((run) => run.armAcceptance?.status === 'ineligible').length,
          unavailable: armRuns.filter((run) => run.armAcceptance?.status === 'unavailable').length,
          metrics: summarizeRuns(eligible),
        },
      ]
    }),
  )
}
