/**
 * Offline scaffolding for OpenCode V2.2.5's native Decisions API.
 *
 * This module intentionally has no host call site. It resolves only model refs
 * already present in the host model catalog, prepares a minimal current-turn
 * request, and consumes a mocked/host response as non-authoritative advice.
 * Nothing here calls a provider, reads credentials, or changes host behavior.
 */
import type { Model } from '@opencode/plugin'
import type { Context } from '@opencode/plugin/promise/plugin'
import type { SessionPrompt } from '@opencode/plugin/promise/session'
import { PANTHEON_AGENT_CATALOG } from './pantheon-decision-catalog.ts'

export const NATIVE_DECISION_ANSWER_NAME = 'specialist'
export const NATIVE_DECISION_MAX_PROMPT_LENGTH = 12_000

type NativeDecisionGenerator = Context['experimental']['generate']['decisions']
export type NativeDecisionRequest = Parameters<NativeDecisionGenerator>[0]
export type NativeDecisionResponse = Awaited<ReturnType<NativeDecisionGenerator>>
export type NativeDecisionModelRef = NativeDecisionRequest['model']

export const NATIVE_STOCK_DECISION_ROUTES = Object.freeze([
  Object.freeze({
    providerID: 'opencode',
    id: 'jev-1.13',
    kind: 'opencode-console-jev',
    billing: 'OpenCode Console',
  }),
  Object.freeze({
    providerID: 'openrouter',
    id: 'typesafe/jev-1.13',
    kind: 'openrouter-jev',
    billing: 'OpenRouter',
  }),
] as const)

type NativeDecisionRouteKind =
  | (typeof NATIVE_STOCK_DECISION_ROUTES)[number]['kind']
  | 'custom-decision'

export interface ResolvedNativeDecisionRoute {
  readonly model: NativeDecisionModelRef
  readonly kind: NativeDecisionRouteKind
  readonly billing: string
}

export type NativeDecisionRouteFailure =
  | 'AUTO_MODEL_UNAVAILABLE'
  | 'INVALID_MODEL_REF'
  | 'DIRECT_OPENAI_UNSUPPORTED'
  | 'MODEL_NOT_IN_CATALOG'
  | 'AMBIGUOUS_MODEL'
  | 'MODEL_NOT_DECISION'

export type NativeDecisionRouteResolution =
  | { readonly ok: true; readonly route: ResolvedNativeDecisionRoute }
  | { readonly ok: false; readonly reasonCode: NativeDecisionRouteFailure }

export type NativeDecisionSelection = 'auto' | NativeDecisionModelRef

type DecisionModelCatalogEntry = Pick<Model.Info, 'providerID' | 'id' | 'type'>

function readModelRef(value: unknown): NativeDecisionModelRef | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    typeof record.providerID !== 'string' ||
    record.providerID.length === 0 ||
    record.providerID.trim() !== record.providerID ||
    typeof record.id !== 'string' ||
    record.id.length === 0 ||
    record.id.trim() !== record.id ||
    (record.variant !== undefined && typeof record.variant !== 'string')
  ) {
    return null
  }
  return {
    providerID: record.providerID,
    id: record.id,
    ...(record.variant === undefined ? {} : { variant: record.variant }),
  }
}

function findRouteKind(
  model: NativeDecisionModelRef,
): Pick<ResolvedNativeDecisionRoute, 'kind' | 'billing'> {
  const stock = NATIVE_STOCK_DECISION_ROUTES.find(
    (candidate) => candidate.providerID === model.providerID && candidate.id === model.id,
  )
  if (stock !== undefined) return { kind: stock.kind, billing: stock.billing }
  if (model.providerID === 'openrouter') {
    return { kind: 'custom-decision', billing: 'OpenRouter' }
  }
  if (model.providerID === 'opencode') {
    return { kind: 'custom-decision', billing: 'OpenCode Console' }
  }
  return { kind: 'custom-decision', billing: 'Provider configured in OpenCode' }
}

/**
 * Resolve Auto strictly against the exact effective session model. It never
 * searches for a substitute, changes providers, or infers decision capability
 * from a chat model's provider or id.
 */
export function resolveNativeDecisionRoute(
  selection: NativeDecisionSelection,
  effectiveSessionModel: unknown,
  modelCatalog: readonly DecisionModelCatalogEntry[],
): NativeDecisionRouteResolution {
  const requested =
    selection === 'auto' ? readModelRef(effectiveSessionModel) : readModelRef(selection)
  if (selection === 'auto' && requested === null) {
    return { ok: false, reasonCode: 'AUTO_MODEL_UNAVAILABLE' }
  }
  if (requested === null) return { ok: false, reasonCode: 'INVALID_MODEL_REF' }
  if (requested.providerID === 'openai') {
    return { ok: false, reasonCode: 'DIRECT_OPENAI_UNSUPPORTED' }
  }

  const matches = modelCatalog.filter(
    (model) => model.providerID === requested.providerID && model.id === requested.id,
  )
  if (matches.length === 0) return { ok: false, reasonCode: 'MODEL_NOT_IN_CATALOG' }
  if (matches.length !== 1) return { ok: false, reasonCode: 'AMBIGUOUS_MODEL' }
  if (matches[0]?.type !== 'decision') {
    return { ok: false, reasonCode: 'MODEL_NOT_DECISION' }
  }

  return {
    ok: true,
    route: Object.freeze({ model: requested, ...findRouteKind(requested) }),
  }
}

export interface NativeDecisionConsentEntry {
  readonly providerID: string
  readonly modelID: string
  readonly enabled: boolean
}

export type NativeDecisionConsentResult =
  | { readonly allowed: true; readonly reasonCode: 'EXACT_ROUTE_CONSENT' }
  | {
      readonly allowed: false
      readonly reasonCode: 'CONSENT_MISSING' | 'CONSENT_AMBIGUOUS' | 'CONSENT_DISABLED'
    }

/** Pure provider+model-specific consent check. Missing consent is always off. */
export function evaluateNativeDecisionConsent(
  route: ResolvedNativeDecisionRoute,
  entries: readonly NativeDecisionConsentEntry[] = [],
): NativeDecisionConsentResult {
  const exact = entries.filter(
    (entry) => entry.providerID === route.model.providerID && entry.modelID === route.model.id,
  )
  if (exact.length === 0) return { allowed: false, reasonCode: 'CONSENT_MISSING' }
  if (exact.length !== 1) return { allowed: false, reasonCode: 'CONSENT_AMBIGUOUS' }
  if (exact[0]?.enabled !== true) return { allowed: false, reasonCode: 'CONSENT_DISABLED' }
  return { allowed: true, reasonCode: 'EXACT_ROUTE_CONSENT' }
}

/**
 * Evidence required to bind a prompt callback to exactly one current turn.
 * OpenCode V2.2.5's SessionPrompt event does not supply these queue/activity
 * facts, so this contract is currently test-only and cannot authorize a call.
 */
export interface NativeDecisionCorrelationEvidence {
  readonly sessionID: string
  readonly messageID: string
  readonly currentMessageID: string
  readonly delivery: 'steer' | 'queue'
  readonly pendingMessageIDs: readonly string[]
  readonly activeMessageID: string | null
  readonly continuation: boolean
}

export type NativeDecisionCorrelationFailure =
  | 'CORRELATION_UNAVAILABLE'
  | 'CORRELATION_MISMATCH'
  | 'QUEUED_TURN'
  | 'CONCURRENT_TURN'
  | 'CONTINUATION_TURN'

function isNonBlankID(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function validateNativeDecisionCorrelation(
  event: SessionPrompt,
  evidence: NativeDecisionCorrelationEvidence | undefined,
): NativeDecisionCorrelationFailure | null {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    return 'CORRELATION_MISMATCH'
  }
  if (!isNonBlankID(event.sessionID) || !isNonBlankID(event.messageID)) {
    return 'CORRELATION_MISMATCH'
  }
  if (evidence === undefined) return 'CORRELATION_UNAVAILABLE'
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return 'CORRELATION_UNAVAILABLE'
  }
  if (
    !isNonBlankID(evidence.sessionID) ||
    !isNonBlankID(evidence.messageID) ||
    !isNonBlankID(evidence.currentMessageID) ||
    (evidence.delivery !== 'steer' && evidence.delivery !== 'queue') ||
    !Array.isArray(evidence.pendingMessageIDs) ||
    evidence.pendingMessageIDs.some((id) => !isNonBlankID(id)) ||
    (evidence.activeMessageID !== null && !isNonBlankID(evidence.activeMessageID)) ||
    typeof evidence.continuation !== 'boolean'
  ) {
    return 'CORRELATION_UNAVAILABLE'
  }
  if (
    event.sessionID !== evidence.sessionID ||
    event.messageID !== evidence.messageID ||
    event.messageID !== evidence.currentMessageID
  ) {
    return 'CORRELATION_MISMATCH'
  }
  if (event.delivery !== 'steer' || evidence.delivery !== 'steer') return 'QUEUED_TURN'
  if (
    evidence.activeMessageID !== null ||
    evidence.pendingMessageIDs.length !== 1 ||
    evidence.pendingMessageIDs[0] !== event.messageID
  ) {
    return 'CONCURRENT_TURN'
  }
  if (evidence.continuation) return 'CONTINUATION_TURN'
  return null
}

const DECISION_AGENT_IDS = new Set(
  PANTHEON_AGENT_CATALOG.filter((agent) => agent.id !== 'zeus').map((agent) => agent.id),
)

export type NativeDecisionPreparationFailure =
  | NativeDecisionRouteFailure
  | NativeDecisionCorrelationFailure
  | 'CONSENT_MISSING'
  | 'CONSENT_AMBIGUOUS'
  | 'CONSENT_DISABLED'
  | 'PROMPT_EMPTY'
  | 'PROMPT_TOO_LONG'
  | 'FILES_NOT_ALLOWED'
  | 'INVALID_CANDIDATES'

export type NativeDecisionPreparation =
  | { readonly ok: true; readonly request: NativeDecisionRequest }
  | { readonly ok: false; readonly reasonCode: NativeDecisionPreparationFailure }

/**
 * Prepare only the current user text and a fixed question. This function does
 * not invoke the native API and does not accept history, tools, paths, files,
 * system instructions, memory, or catalog descriptions as inputs.
 */
export function prepareNativeDecisionRequest(
  route: ResolvedNativeDecisionRoute,
  event: SessionPrompt,
  eligibleAgentIDs: readonly string[],
  consentEntries: readonly NativeDecisionConsentEntry[] = [],
  correlationEvidence?: NativeDecisionCorrelationEvidence,
): NativeDecisionPreparation {
  if (
    event === null ||
    typeof event !== 'object' ||
    event.prompt === null ||
    typeof event.prompt !== 'object'
  ) {
    return { ok: false, reasonCode: 'CORRELATION_MISMATCH' }
  }
  const consent = evaluateNativeDecisionConsent(route, consentEntries)
  if (!consent.allowed) return { ok: false, reasonCode: consent.reasonCode }

  const correlationFailure = validateNativeDecisionCorrelation(event, correlationEvidence)
  if (correlationFailure !== null) return { ok: false, reasonCode: correlationFailure }

  const promptFiles = (event.prompt as { files?: unknown }).files
  if (promptFiles !== undefined && (!Array.isArray(promptFiles) || promptFiles.length > 0)) {
    return { ok: false, reasonCode: 'FILES_NOT_ALLOWED' }
  }
  const promptText = event.prompt.text
  if (typeof promptText !== 'string' || promptText.trim().length === 0) {
    return { ok: false, reasonCode: 'PROMPT_EMPTY' }
  }
  if (promptText.length > NATIVE_DECISION_MAX_PROMPT_LENGTH) {
    return { ok: false, reasonCode: 'PROMPT_TOO_LONG' }
  }

  const candidates = new Set<string>()
  for (const id of eligibleAgentIDs) {
    if (typeof id !== 'string' || !DECISION_AGENT_IDS.has(id) || candidates.has(id)) {
      return { ok: false, reasonCode: 'INVALID_CANDIDATES' }
    }
    candidates.add(id)
  }
  if (candidates.size > DECISION_AGENT_IDS.size) {
    return { ok: false, reasonCode: 'INVALID_CANDIDATES' }
  }

  const request = {
    model: route.model,
    input: [{ type: 'text', text: promptText }],
    questions: [
      {
        type: 'choice',
        name: NATIVE_DECISION_ANSWER_NAME,
        instructions:
          'Choose one listed specialist only when the current request clearly needs it; otherwise choose none. This is advisory only.',
        choices: [...[...candidates].map((value) => ({ value })), { value: 'none' }],
      },
    ],
  } satisfies NativeDecisionRequest

  return { ok: true, request: Object.freeze(request) }
}

export interface NativeDecisionAdvice {
  readonly agent: string | null
  readonly reasonCode: 'RECOMMENDED' | 'ABSTAIN' | 'INVALID_RESPONSE' | 'LOW_CONFIDENCE'
  readonly effect: 'none'
}

/** Bounded consumer: validates one candidate and returns advice only. */
export function consumeNativeDecisionAdvice(
  response: unknown,
  eligibleAgentIDs: readonly string[],
): NativeDecisionAdvice {
  const abstain = (reasonCode: NativeDecisionAdvice['reasonCode']): NativeDecisionAdvice =>
    Object.freeze({ agent: null, reasonCode, effect: 'none' })
  if (response === null || typeof response !== 'object' || Array.isArray(response)) {
    return abstain('INVALID_RESPONSE')
  }
  const answers = (response as { answers?: unknown }).answers
  if (!Array.isArray(answers)) return abstain('INVALID_RESPONSE')
  const matches = answers.filter(
    (answer): answer is Record<string, unknown> =>
      answer !== null &&
      typeof answer === 'object' &&
      !Array.isArray(answer) &&
      answer.name === NATIVE_DECISION_ANSWER_NAME,
  )
  if (matches.length !== 1) return abstain(matches.length === 0 ? 'ABSTAIN' : 'INVALID_RESPONSE')

  const answer = matches[0]
  if (answer?.type !== 'choice') return abstain('ABSTAIN')
  if (answer.choice === 'none') return abstain('ABSTAIN')
  if (typeof answer.choice !== 'string' || !eligibleAgentIDs.includes(answer.choice)) {
    return abstain('INVALID_RESPONSE')
  }
  if (
    typeof answer.confidence !== 'number' ||
    !Number.isFinite(answer.confidence) ||
    answer.confidence < 0 ||
    answer.confidence > 1
  ) {
    return abstain('INVALID_RESPONSE')
  }
  if (!DECISION_AGENT_IDS.has(answer.choice)) return abstain('INVALID_RESPONSE')
  return Object.freeze({ agent: answer.choice, reasonCode: 'RECOMMENDED', effect: 'none' })
}

// This type assertion keeps the source contract tied to @opencode/plugin@2.2.5.
// Any removal or schema change to the native method fails `npm run typecheck`.
export type OpenCodeV225DecisionApi = Pick<Context['experimental']['generate'], 'decisions'>
