/**
 * Private per-turn provider runner.
 *
 * Egress boundary: this module never accepts a fetch implementation, base URL,
 * environment, configuration, or ledger from a caller. It reads the user-level
 * configuration and ledger itself, uses fixed endpoints, and performs at most
 * one POST with no redirect, retry, failover, or fan-out.
 *
 * The user-level configuration is the source of truth: `enabled`,
 * `egress_consent`, one cap-valid candidate, a confirmed period, and positive
 * caps. The only caller-provided capability is the host's kill-switch
 * (`ctx.permission.assert`), which is asked after the config gate passes and
 * must not deny. A missing or denying gate means no network call at all.
 */
import {
  openLocalDecisionBudgetLedger,
  resolveLocalDecisionBudgetDbPath,
} from './local-decision-budget.ts'
import {
  assertDecisionEgressPermission,
  buildDecisionEgressRequest,
  type PermissionAssert,
  resolveDecisionEgressConsent,
} from './local-decision-egress-gate.ts'
import {
  type DecisionProviderId,
  PROVIDER_MAX_RESPONSE_BYTES,
  PROVIDER_REQUEST_TIMEOUT_MS,
} from './local-decision-provider-matrix.ts'
import {
  buildProviderRequest,
  type DecisionPayload,
  parseProviderDecision,
} from './local-decision-provider-protocol.ts'
import { verifyProviderUsageForReservation } from './local-decision-usage-evidence.internal.ts'

export type {
  DecisionProtocol,
  DecisionProviderAdapter,
  DecisionProviderId,
} from './local-decision-provider-matrix.ts'
export { DECISION_PROVIDER_ADAPTERS } from './local-decision-provider-matrix.ts'
export type {
  DecisionPayload,
  DecisionPayloadInput,
} from './local-decision-provider-protocol.ts'
export {
  buildDecisionPayload,
  parseProviderDecision,
} from './local-decision-provider-protocol.ts'

export type ProviderRunReason =
  | 'PROVIDER_RECOMMENDATION'
  | 'PROVIDER_ABSTAIN'
  | 'DISABLED'
  | 'CONFIG_UNAVAILABLE'
  | 'CONSENT_MISSING'
  | 'NO_ELIGIBLE_CANDIDATE'
  | 'CAP_OR_PERIOD_DENIED'
  | 'PERMISSION_UNAVAILABLE'
  | 'PERMISSION_DENIED'
  | 'CREDENTIAL_MISSING'
  | 'RESERVATION_DENIED'
  | 'TRANSPORT_FAILED'
  | 'USAGE_UNRECONCILED'
  | 'INVALID_PROVIDER_RESPONSE'

export interface ProviderRunResult {
  status: 'decided' | 'abstain' | 'fallback'
  skillIds: string[]
  agent: string | null
  provider: DecisionProviderId | null
  reasonCode: ProviderRunReason
}

export interface ProviderRunInput {
  payload: DecisionPayload | null
  /** Host capability only; never a fetch, config, env, or ledger injection. */
  permissionAssert?: PermissionAssert | undefined
  sessionID: string
  messageID: string
}

function fallback(reasonCode: ProviderRunReason): ProviderRunResult {
  return { status: 'fallback', skillIds: [], agent: null, provider: null, reasonCode }
}

/**
 * Run the one-and-only authorized provider decision for a turn. Any missing
 * gate, cap, credential, usage proof, or valid response falls back to local.
 */
export async function runProviderDecision(input: ProviderRunInput): Promise<ProviderRunResult> {
  if (
    input.payload === null ||
    typeof input.sessionID !== 'string' ||
    input.sessionID.trim().length === 0 ||
    typeof input.messageID !== 'string' ||
    input.messageID.trim().length === 0
  ) {
    return fallback('CONFIG_UNAVAILABLE')
  }

  // Config first: an invalid configuration is not worth an interactive host
  // prompt, and the host must never be asked to approve what the user's own
  // configuration already forbids.
  const consent = resolveDecisionEgressConsent()
  if (!consent.ok) return fallback(consent.reasonCode)
  const { provider, adapter } = consent.selected

  if (typeof input.permissionAssert !== 'function') return fallback('PERMISSION_UNAVAILABLE')
  const assertion = await assertDecisionEgressPermission(
    input.permissionAssert,
    buildDecisionEgressRequest({
      sessionID: input.sessionID,
      messageID: input.messageID,
      endpoint: adapter.endpoint,
    }),
  )
  if (assertion === 'deny') return fallback('PERMISSION_DENIED')

  const credential = readCredential(adapter.credentialEnv)
  if (credential === null) return fallback('CREDENTIAL_MISSING')
  if (typeof globalThis.fetch !== 'function') return fallback('TRANSPORT_FAILED')

  const body = buildProviderRequest(provider, input.payload)
  if (body === null) return fallback('NO_ELIGIBLE_CANDIDATE')

  const ledger = openLocalDecisionBudgetLedger({ dbPath: resolveLocalDecisionBudgetDbPath() })
  try {
    let reservation: ReturnType<typeof ledger.reserve>
    try {
      reservation = ledger.reserve(adapter.accountingProvider, adapter.model)
    } catch {
      return fallback('RESERVATION_DENIED')
    }
    if (reservation.status !== 'reserved') return fallback('RESERVATION_DENIED')

    let response: Response
    try {
      response = await globalThis.fetch(adapter.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      })
    } catch {
      return fallback('TRANSPORT_FAILED')
    }
    if (!response.ok) return fallback('TRANSPORT_FAILED')

    let responseBody: unknown
    try {
      responseBody = await readBoundedResponseJson(response)
    } catch {
      return fallback('TRANSPORT_FAILED')
    }

    const evidence = verifyProviderUsageForReservation(
      {
        reservationId: reservation.reservationId,
        provider: adapter.accountingProvider,
        model: adapter.model,
        period: reservation.period,
      },
      responseBody,
    )
    if (evidence === null) return fallback('USAGE_UNRECONCILED')
    const reconciliation = ledger.reconcileVerified(reservation.reservationId, evidence)
    if (reconciliation.status !== 'reconciled' || reconciliation.frozen) {
      return fallback('USAGE_UNRECONCILED')
    }

    const decision = parseProviderDecision(provider, responseBody, input.payload)
    if (decision.status === 'invalid') return fallback('INVALID_PROVIDER_RESPONSE')
    if (decision.status === 'abstain') {
      return {
        status: 'abstain',
        skillIds: [],
        agent: null,
        provider,
        reasonCode: 'PROVIDER_ABSTAIN',
      }
    }
    return {
      status: 'decided',
      skillIds: decision.skillIds,
      agent: decision.agent,
      provider,
      reasonCode: 'PROVIDER_RECOMMENDATION',
    }
  } finally {
    ledger.close()
  }
}

function readCredential(name: string): string | null {
  try {
    const credential = process.env[name]
    return typeof credential === 'string' &&
      credential.length > 0 &&
      credential.trim() === credential
      ? credential
      : null
  } catch {
    return null
  }
}

async function readBoundedResponseJson(response: Response): Promise<unknown> {
  const body = response.body
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    const parsedLength = Number(contentLength)
    if (
      !/^\d+$/.test(contentLength) ||
      !Number.isSafeInteger(parsedLength) ||
      parsedLength > PROVIDER_MAX_RESPONSE_BYTES
    ) {
      await body?.cancel(new RangeError('Provider response exceeds the size limit')).catch(() => {})
      throw new RangeError('Provider response exceeds the size limit')
    }
  }
  if (body === null) throw new TypeError('Provider response body is missing')

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > PROVIDER_MAX_RESPONSE_BYTES) {
        const error = new RangeError('Provider response exceeds the size limit')
        await reader.cancel(error).catch(() => {})
        throw error
      }
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return JSON.parse(text) as unknown
}
