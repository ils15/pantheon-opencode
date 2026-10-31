/**
 * P5 (Themis) shadow adapter — `verify` in the `execute.after` position.
 *
 * The verdict vocabulary is exactly `PASS | FAIL | BLOCK`. Nothing else is
 * promoted: a response the contract does not recognize is `BLOCK` when the
 * verification is mandatory and `FAIL` when it is advisory, and
 * `failed_to_respond` follows the same rule. A verdict is never `PASS` because
 * a verification was skipped, missing or unreadable.
 *
 * Shadow, and not only by configuration. `execute.before` remains the **only**
 * hard barrier in this design: this adapter runs after the host already ran the
 * tool, returns a record and nothing else, and is synchronous. It cannot deny
 * an admission, cannot delay a tool result and cannot mutate the event it
 * observes — the payload is cloned and frozen before any reading, and the
 * record always says `effect: 'none'`.
 *
 * `execute.after` itself was never fired in a probe (PM-09: `execute.before`
 * and `permission.evaluate` were registered and never invoked), so this module
 * is a contract-shaped recorder, not evidence that verification runs in
 * production.
 */

import {
  observeShadow,
  type ShadowDecision,
  type ShadowRecord,
  type ShadowSink,
} from '../v2-decision-shadow.ts'
import {
  resolveVerify,
  type VerifyOutcome,
  type VerifyRequirement,
  type VerifyVerdict,
} from '../v2-decision-verify.ts'

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

export type ThemisVerificationSource = 'declared' | 'none'

export interface ThemisPointResult {
  readonly record: ShadowRecord
  /** `declared` when at least one usable requirement was observed. */
  readonly verificationSource: ThemisVerificationSource
  /** One outcome per requirement, in declaration order; empty when none was usable. */
  readonly verdicts: readonly VerifyOutcome[]
  /** BLOCK over FAIL over PASS; `null` when no verdict could be stated. */
  readonly verdict: VerifyVerdict | null
  /** Whether an `execute.after` event was observed at all. */
  readonly executionObserved: boolean
  /** Token explaining the decision; always present. */
  readonly reason: string
}

interface RequirementParse {
  readonly ok: boolean
  /** Usable requirements, in declaration order. */
  readonly requirements: readonly VerifyRequirement[]
  /** Token naming why the parse failed; empty when it succeeded. */
  readonly reason: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value)
}

/**
 * Parse the declared verifications.
 *
 * A requirement is usable only when it names a token id and states `mandatory`
 * as a boolean. Duplicate ids are refused: the same requirement counted twice
 * would let one gap look like two checks.
 */
function parseRequirements(candidate: unknown): RequirementParse {
  if (!Array.isArray(candidate) || candidate.length === 0) {
    return { ok: false, requirements: [], reason: 'themis.requirements.absent' }
  }
  const requirements: VerifyRequirement[] = []
  const ids = new Set<string>()
  for (const entry of candidate) {
    if (!isRecord(entry) || !isToken(entry.id) || typeof entry.mandatory !== 'boolean') {
      return { ok: false, requirements: [], reason: 'themis.requirement.invalid' }
    }
    if (ids.has(entry.id)) {
      return { ok: false, requirements: [], reason: 'themis.requirements.duplicate' }
    }
    ids.add(entry.id)
    requirements.push({ id: entry.id, mandatory: entry.mandatory })
  }
  return { ok: true, requirements, reason: '' }
}

/** Read one response by requirement id; an unreadable map yields none at all. */
function responseFor(responses: unknown, requirementId: string): unknown {
  if (!isRecord(responses)) return undefined
  return responses[requirementId]
}

/** BLOCK dominates FAIL, FAIL dominates PASS. */
function aggregateVerdict(verdicts: readonly VerifyOutcome[]): VerifyVerdict | null {
  if (verdicts.length === 0) return null
  if (verdicts.some((outcome) => outcome.verdict === 'BLOCK')) return 'BLOCK'
  if (verdicts.some((outcome) => outcome.verdict === 'FAIL')) return 'FAIL'
  return 'PASS'
}

interface ThemisAnalysis {
  readonly decision: ShadowDecision
  readonly source: ThemisVerificationSource
  readonly verdicts: readonly VerifyOutcome[]
  readonly verdict: VerifyVerdict | null
  readonly executionObserved: boolean
}

function analyze(input: unknown): ThemisAnalysis {
  const executionObserved = isRecord(input) && isRecord(input.execution)
  const parsed = parseRequirements(isRecord(input) ? input.requirements : undefined)
  if (!parsed.ok) {
    return {
      decision: { decision: 'refusal', reason: parsed.reason },
      source: 'none',
      verdicts: [],
      verdict: null,
      executionObserved,
    }
  }
  const responses = isRecord(input) ? input.responses : undefined
  const verdicts = parsed.requirements.map((requirement) =>
    resolveVerify(requirement, responseFor(responses, requirement.id)),
  )
  const verdict = aggregateVerdict(verdicts)
  if (verdict === null) {
    return {
      decision: { decision: 'refusal', reason: 'themis.verdict.absent' },
      source: 'none',
      verdicts: [],
      verdict: null,
      executionObserved,
    }
  }
  return {
    decision: {
      decision: `verify.${verdict.toLowerCase()}`,
      reason: `themis.verified.${verdict.toLowerCase()}`,
    },
    source: 'declared',
    verdicts,
    verdict,
    executionObserved,
  }
}

/**
 * Observe P5 in shadow.
 *
 * @param input `{ execution, requirements, responses }`. The `execute.after`
 *              event is observed, never written back.
 * @param sink  Optional shadow-record observer.
 */
export function evaluateThemisPoint(input: unknown, sink?: ShadowSink): ThemisPointResult {
  let analysis: ThemisAnalysis = {
    decision: { decision: 'refusal', reason: 'themis.requirements.absent' },
    source: 'none',
    verdicts: [],
    verdict: null,
    executionObserved: false,
  }
  const record = observeShadow(
    'P5',
    input,
    (isolated) => {
      analysis = analyze(isolated)
      return analysis.decision
    },
    sink,
  )

  const contained = record.decision === 'unavailable'
  return {
    record,
    verificationSource: contained ? 'none' : analysis.source,
    verdicts: contained ? [] : analysis.verdicts,
    verdict: contained ? null : analysis.verdict,
    executionObserved: contained ? false : analysis.executionObserved,
    reason: record.reason,
  }
}
