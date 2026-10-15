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

  if (arm === 'candidate') {
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
