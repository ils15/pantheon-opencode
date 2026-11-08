/**
 * V2 verification contract — explicit verdicts, never inferred.
 *
 * `failed_to_respond` during mandatory verification is `BLOCK`; during advisory
 * verification it is `FAIL`. Neither is ever `PASS`, and no scalar can stand in
 * for a verdict.
 */

export const VERIFY_VERDICTS = ['PASS', 'FAIL', 'BLOCK'] as const
export type VerifyVerdict = (typeof VERIFY_VERDICTS)[number]

export interface VerifyRequirement {
  readonly id: string
  readonly mandatory: boolean
}

export type VerifyReasonCode = 'VERDICT' | 'FAILED_TO_RESPOND' | 'UNRECOGNIZED_VERDICT'

export interface VerifyOutcome {
  readonly requirementId: string
  readonly verdict: VerifyVerdict
  readonly reasonCode: VerifyReasonCode
  readonly mandatory: boolean
}

/**
 * Resolve a verification verdict.
 *
 * The verdict must be stated explicitly. `failed_to_respond` during a
 * mandatory verification is `BLOCK`; during an advisory verification it is
 * `FAIL`. Neither case is ever `PASS`, and no certainty scalar can stand in
 * for a verdict.
 */
export function resolveVerify(requirement: VerifyRequirement, response: unknown): VerifyOutcome {
  const base = { requirementId: requirement.id, mandatory: requirement.mandatory }
  if (typeof response === 'string') {
    if (response === 'PASS' || response === 'FAIL' || response === 'BLOCK') {
      return { ...base, verdict: response, reasonCode: 'VERDICT' }
    }
    return {
      ...base,
      verdict: requirement.mandatory ? 'BLOCK' : 'FAIL',
      reasonCode: 'UNRECOGNIZED_VERDICT',
    }
  }
  return {
    ...base,
    verdict: requirement.mandatory ? 'BLOCK' : 'FAIL',
    reasonCode: 'FAILED_TO_RESPOND',
  }
}
