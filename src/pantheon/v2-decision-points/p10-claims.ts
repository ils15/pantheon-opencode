/**
 * P10 (claims) shadow adapter — `verify` per counsellor claim.
 *
 * A council member's claims are not evidence: each one carries
 * `{ id, mandatory }` and the response a verifier already produced, and gets
 * its own explicit `PASS | FAIL | BLOCK` verdict. A claim that produced no
 * usable response is `BLOCK` when mandatory and `FAIL` when advisory; it is
 * never `PASS`. Per-counsellor and council-level verdicts follow the same
 * precedence, BLOCK over FAIL over PASS.
 *
 * Two properties are structural, because a claims adapter is exactly where
 * unverified prose would otherwise be laundered into a verdict:
 *
 *   - **No claim text is retained.** The result holds ids, verdicts and reason
 *     codes only, so no counsellor output can reach a sink, a log or telemetry.
 *   - **An incomplete council has no aggregate verdict.** A member with no
 *     claims, a duplicate id or a missing `mandatory` flag yields `null` for the
 *     council, not a PASS over claims that were never counted.
 *
 * Shadow: the verdicts are recorded and the record always says `effect: 'none'`.
 * Per-counsellor claims were never designed or measured on the host
 * (DISCOVERY §4), so this module is contract-shaped and claims no execution.
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

export interface ClaimVerdict {
  readonly counsellorId: string
  readonly claimId: string
  readonly mandatory: boolean
  readonly verdict: VerifyVerdict
  readonly reasonCode: VerifyOutcome['reasonCode']
}

export interface CounsellorVerdict {
  readonly counsellorId: string
  /** `null` when the member declared no claim at all. */
  readonly verdict: VerifyVerdict | null
  readonly reason: string
}

export interface ClaimsPointResult {
  readonly record: ShadowRecord
  /** Claims verified, in declaration order; empty when none could be read. */
  readonly claimVerdicts: readonly ClaimVerdict[]
  /** One entry per member, including members with no claim. */
  readonly byCounsellor: readonly CounsellorVerdict[]
  /** Council verdict; `null` whenever any member is incomplete. */
  readonly aggregate: VerifyVerdict | null
  /** Token explaining the decision; always present. */
  readonly reason: string
}

interface ParsedClaim extends VerifyRequirement {
  readonly counsellorId: string
}

interface ParsedCounsellor {
  readonly id: string
  readonly claims: readonly ParsedClaim[]
}

type CouncilParse =
  | { readonly ok: true; readonly counsellors: readonly ParsedCounsellor[] }
  | { readonly ok: false; readonly reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value)
}

/**
 * Parse the council. Structural damage (unreadable shape, duplicate ids,
 * missing flag) is fatal; a member with zero claims is kept, because it has to
 * cancel the aggregate rather than disappear from it.
 */
function parseCouncil(input: unknown): CouncilParse {
  const counsellors = isRecord(input) ? input.counsellors : undefined
  if (!Array.isArray(counsellors) || counsellors.length === 0) {
    return { ok: false, reason: 'claims.absent' }
  }
  const parsed: ParsedCounsellor[] = []
  const counsellorIds = new Set<string>()
  for (const entry of counsellors) {
    if (!isRecord(entry) || !isToken(entry.id)) {
      return { ok: false, reason: 'claims.counsellor.invalid' }
    }
    if (counsellorIds.has(entry.id)) {
      return { ok: false, reason: 'claims.counsellor.duplicate' }
    }
    counsellorIds.add(entry.id)
    if (!Array.isArray(entry.claims)) {
      return { ok: false, reason: 'claims.counsellor.invalid' }
    }
    const claims: ParsedClaim[] = []
    const claimIds = new Set<string>()
    for (const claim of entry.claims) {
      if (!isRecord(claim) || !isToken(claim.id) || typeof claim.mandatory !== 'boolean') {
        return { ok: false, reason: 'claims.claim.invalid' }
      }
      if (claimIds.has(claim.id)) {
        return { ok: false, reason: 'claims.claim.duplicate' }
      }
      claimIds.add(claim.id)
      claims.push({ id: claim.id, mandatory: claim.mandatory, counsellorId: entry.id })
    }
    parsed.push({ id: entry.id, claims })
  }
  return { ok: true, counsellors: parsed }
}

/** Responses are read by claim id; an unreadable map yields none at all. */
function responseFor(candidates: readonly unknown[], index: number): unknown {
  const entry = candidates[index]
  return isRecord(entry) ? entry.response : undefined
}

function precedence(verdicts: readonly VerifyVerdict[]): VerifyVerdict | null {
  if (verdicts.length === 0) return null
  if (verdicts.includes('BLOCK')) return 'BLOCK'
  if (verdicts.includes('FAIL')) return 'FAIL'
  return 'PASS'
}

interface ClaimsAnalysis {
  readonly decision: ShadowDecision
  readonly claimVerdicts: readonly ClaimVerdict[]
  readonly byCounsellor: readonly CounsellorVerdict[]
  readonly aggregate: VerifyVerdict | null
}

function refusal(reason: string): ClaimsAnalysis {
  return {
    decision: { decision: 'refusal', reason },
    claimVerdicts: [],
    byCounsellor: [],
    aggregate: null,
  }
}

function analyze(input: unknown): ClaimsAnalysis {
  const parsed = parseCouncil(input)
  if (!parsed.ok) return refusal(parsed.reason)

  const raw = isRecord(input) && Array.isArray(input.counsellors) ? input.counsellors : []
  const claimVerdicts: ClaimVerdict[] = []
  const byCounsellor: CounsellorVerdict[] = []

  for (const [counsellorIndex, counsellor] of parsed.counsellors.entries()) {
    const rawCounsellor = raw[counsellorIndex]
    const rawClaims =
      isRecord(rawCounsellor) && Array.isArray(rawCounsellor.claims) ? rawCounsellor.claims : []
    const memberVerdicts: VerifyVerdict[] = []
    for (const [claimIndex, claim] of counsellor.claims.entries()) {
      const outcome = resolveVerify(
        { id: claim.id, mandatory: claim.mandatory },
        responseFor(rawClaims, claimIndex),
      )
      claimVerdicts.push({
        counsellorId: claim.counsellorId,
        claimId: outcome.requirementId,
        mandatory: outcome.mandatory,
        verdict: outcome.verdict,
        reasonCode: outcome.reasonCode,
      })
      memberVerdicts.push(outcome.verdict)
    }
    const memberVerdict = precedence(memberVerdicts)
    byCounsellor.push({
      counsellorId: counsellor.id,
      verdict: memberVerdict,
      reason:
        memberVerdict === null
          ? 'claims.counsellor.empty'
          : `claims.${memberVerdict.toLowerCase()}`,
    })
  }

  const incomplete = byCounsellor.some((entry) => entry.verdict === null)
  if (incomplete) {
    return {
      decision: { decision: 'refusal', reason: 'claims.counsellor.empty' },
      claimVerdicts,
      byCounsellor,
      aggregate: null,
    }
  }
  const aggregate = precedence(
    byCounsellor.flatMap((entry) => (entry.verdict === null ? [] : [entry.verdict])),
  )
  if (aggregate === null) return refusal('claims.absent')
  return {
    decision: { decision: `verify.${aggregate.toLowerCase()}`, reason: 'claims.verified' },
    claimVerdicts,
    byCounsellor,
    aggregate,
  }
}

/**
 * Observe P10 in shadow.
 *
 * @param input `{ counsellors: [{ id, claims: [{ id, mandatory, response? }] }] }`.
 *              Never mutated; responses are read, never retained.
 * @param sink  Optional shadow-record observer.
 */
export function evaluateClaimsPoint(input: unknown, sink?: ShadowSink): ClaimsPointResult {
  let analysis: ClaimsAnalysis = refusal('claims.absent')
  const record = observeShadow(
    'P10',
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
    claimVerdicts: contained ? [] : analysis.claimVerdicts,
    byCounsellor: contained ? [] : analysis.byCounsellor,
    aggregate: contained ? null : analysis.aggregate,
    reason: record.reason,
  }
}
