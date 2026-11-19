/**
 * Mandatory Fault-Localization & Reproduction Gate (`reproduction-gate.ts`).
 *
 * When a `@hermes` or `@talos` implementer runs inside a `bugfix` Step-Ledger
 * task (`taskType === 'bugfix'`), blocks production source edits until a
 * failing reproduction test (`exitCode !== 0`) has been recorded via
 * `pantheon_step_ledger(action="record_reproduction", ...)`. Editing test or
 * spec files remains permitted so the RED test can be written first.
 */

import { getSharedBus } from './bus.ts'
import { readStepLedger, type StepLedgerEntry } from './step-ledger.ts'

const MUTATING_TOOLS = new Set(['edit', 'write', 'hashline_edit', 'ast_rewrite', 'patch'])
const BUGFIX_GATED_AGENTS = new Set(['hermes', 'talos'])

export interface ReproductionGateVerdict {
  readonly allowed: boolean
  readonly stepKey?: string
  readonly message?: string
}

function isTestOrReproFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/').toLowerCase()
  if (!norm) return false
  if (
    /(?:^|\/)(?:tests?|__tests__|spec|specs|repro|fixtures)\//.test(norm) ||
    /\.(?:test|spec|repro)\.[a-z0-9]+$/i.test(norm) ||
    /(?:^|\/)test_[^/]+\.py$/i.test(norm) ||
    /_test\.go$/i.test(norm)
  ) {
    return true
  }
  return false
}

function findActiveBugfixStep(
  cwd: string,
  agent: string,
  explicitStepKey?: string,
): StepLedgerEntry | null {
  try {
    const store = readStepLedger(cwd)
    if (explicitStepKey && store.steps[explicitStepKey]) {
      const s = store.steps[explicitStepKey]
      return s.taskType === 'bugfix' && s.state === 'in_progress' ? s : null
    }
    const normalized = agent.trim().toLowerCase()
    const matches = Object.values(store.steps).filter(
      (s) =>
        s.taskType === 'bugfix' &&
        s.state === 'in_progress' &&
        s.agent.trim().toLowerCase() === normalized,
    )
    if (matches.length === 0) return null
    matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return matches[0] ?? null
  } catch {
    return null
  }
}

export function evaluateReproductionGate(params: {
  readonly cwd: string
  readonly tool: string
  readonly agent?: string
  readonly args?: Record<string, unknown>
  readonly stepKey?: string
}): ReproductionGateVerdict {
  const toolName = params.tool.trim().toLowerCase()
  if (!MUTATING_TOOLS.has(toolName)) return { allowed: true }

  const normalizedAgent = (params.agent ?? '').trim().toLowerCase().replace(/^@/, '')
  if (!BUGFIX_GATED_AGENTS.has(normalizedAgent)) return { allowed: true }

  const activeStep = findActiveBugfixStep(params.cwd, normalizedAgent, params.stepKey)
  if (!activeStep) return { allowed: true }

  const rawArgs = params.args ?? {}
  const targetPath = String(
    rawArgs.filePath ?? rawArgs.file_path ?? rawArgs.file ?? rawArgs.path ?? '',
  )
  if (isTestOrReproFile(targetPath)) {
    return { allowed: true, stepKey: activeStep.stepKey }
  }

  const hasRedRepro =
    typeof activeStep.reproductionRecordedAt === 'number' &&
    activeStep.reproductionExitCode !== undefined &&
    activeStep.reproductionExitCode !== 0

  getSharedBus().emit('reproduction:gate', {
    stepKey: activeStep.stepKey,
    agent: normalizedAgent,
    tool: toolName,
    allowed: hasRedRepro,
    timestamp: Date.now(),
  })

  if (hasRedRepro) {
    return { allowed: true, stepKey: activeStep.stepKey }
  }

  return {
    allowed: false,
    stepKey: activeStep.stepKey,
    message:
      `[Reproduction-Gate] Blocked production edit on bugfix step "${activeStep.stepKey}" for @${normalizedAgent}: ` +
      'run fault localization + a failing RED test/probe first (test files are allowed) and record it via ' +
      `pantheon_step_ledger(action="record_reproduction", stepKey="${activeStep.stepKey}", command="...", exitCode=1).`,
  }
}
