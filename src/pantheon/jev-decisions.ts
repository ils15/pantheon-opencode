/**
 * Native Jev Decisions selection, preparation, and consumption.
 *
 * This is the production half of the offline scaffold in
 * `v2-native-decisions.ts`: it selects a decision-capable model route from the
 * user-level decision-router configuration, prepares a bounded typed request,
 * and consumes a host response as non-authoritative advice. It performs no
 * I/O of its own: no fetch, no credentials, no transport — egress happens only
 * when the caller invokes the host's native `experimental.generate.decisions`
 * API with a request this module prepared, behind the consent, budget, and
 * permission gates wired in `jev-decision-tool.ts`.
 *
 * The config provider namespace is Pantheon's own (the installer's provider
 * matrix); the host model catalog uses the host's provider IDs. The mapping is
 * a frozen table here — the single place the two namespaces meet. Direct
 * OpenAI has no native Decisions route and is never mapped.
 */

import type { UserDecisionRouterCandidate } from '../../scripts/install/decision-router-config.mjs'
import type { BudgetProvider } from './local-decision-budget.ts'
import {
  DECISION_PROVIDER_ADAPTERS,
  type DecisionProviderId,
} from './local-decision-provider-matrix.ts'
import { selectPantheonSkills } from './local-decision-skills.ts'
import { PANTHEON_AGENT_CATALOG, PANTHEON_SKILL_CATALOG } from './pantheon-decision-catalog.ts'
import {
  NATIVE_DECISION_MAX_PROMPT_LENGTH,
  type NativeDecisionRequest,
  type ResolvedNativeDecisionRoute,
  resolveNativeDecisionRoute,
} from './v2-native-decisions.ts'

/** Catalog entry shape the route resolver needs from the host model list. */
export type JevDecisionCatalogEntry = Parameters<typeof resolveNativeDecisionRoute>[2][number]

/** Config-level providers that have a native host Decisions route. */
export type NativeJevProviderId = Extract<
  DecisionProviderId,
  'typesafe-jev' | 'opencode-console-jev' | 'opencode-console-jev-free'
>

/**
 * Config provider → host `providerID`. `openai-decisions` is deliberately
 * absent: direct OpenAI Decisions are not a native route, and an OpenRouter
 * Jev route is reachable only as a host-configured model, not through this
 * matrix (the installer's candidate list has no `openrouter` provider).
 */
export const NATIVE_JEV_HOST_PROVIDERS = Object.freeze({
  'typesafe-jev': 'typesafe-ai',
  'opencode-console-jev': 'opencode',
  'opencode-console-jev-free': 'opencode',
} satisfies Record<NativeJevProviderId, string>)

export function isNativeJevProvider(provider: unknown): provider is NativeJevProviderId {
  return typeof provider === 'string' && Object.hasOwn(NATIVE_JEV_HOST_PROVIDERS, provider)
}

export type NativeJevRouteFailure = 'NO_ELIGIBLE_CANDIDATE' | 'ROUTE_UNRESOLVED'

export interface NativeJevRouteSelection {
  readonly route: ResolvedNativeDecisionRoute
  readonly provider: NativeJevProviderId
  readonly accountingProvider: BudgetProvider
  readonly model: string
}

export type NativeJevRouteResolution =
  | { readonly ok: true; readonly selection: NativeJevRouteSelection }
  | { readonly ok: false; readonly reasonCode: NativeJevRouteFailure }

/**
 * Keep only candidates that both map to a native route and pass the caller's
 * admission check. Pure: the admission check is injected so tests can run
 * without a ledger; the production caller passes `ledger.canReserve(...)`.
 */
export function filterNativeCapValidCandidates(
  candidates: readonly UserDecisionRouterCandidate[],
  checkAdmission: (provider: BudgetProvider, model: string) => boolean,
): UserDecisionRouterCandidate[] {
  const valid: UserDecisionRouterCandidate[] = []
  for (const candidate of candidates) {
    if (!isNativeJevProvider(candidate.provider)) continue
    const adapter = DECISION_PROVIDER_ADAPTERS[candidate.provider]
    if (!checkAdmission(adapter.accountingProvider, candidate.model)) continue
    valid.push(candidate)
  }
  return valid
}

function readEnabledCandidates(config: unknown): UserDecisionRouterCandidate[] {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return []
  const value = (config as { enabled_candidates?: unknown }).enabled_candidates
  if (!Array.isArray(value)) return []
  return value.filter(
    (candidate): candidate is UserDecisionRouterCandidate =>
      candidate !== null &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      typeof (candidate as { provider?: unknown }).provider === 'string' &&
      typeof (candidate as { model?: unknown }).model === 'string',
  )
}

/**
 * Resolve the one explicit-or-auto native route for a migrated user config.
 *
 * The legacy `resolveUserDecisionRouterCandidate` policy only admits
 * remotely-eligible direct-fetch providers, so it can never select the Console
 * routes; this resolver repeats its shape (explicit wins, auto requires
 * exactly one cap-valid candidate) over the native-eligible candidate set.
 * A selection that resolves to a provider without a native route (explicit
 * `openai-decisions`) is a refusal, never a substitution.
 */
export function resolveNativeJevRoute(
  config: unknown,
  catalog: readonly JevDecisionCatalogEntry[],
  checkAdmission: (provider: BudgetProvider, model: string) => boolean,
): NativeJevRouteResolution {
  const record =
    config !== null && typeof config === 'object' && !Array.isArray(config)
      ? (config as {
          enabled?: unknown
          egress_consent?: unknown
          selection?: unknown
        })
      : undefined
  if (record?.enabled !== true || record.egress_consent !== true) {
    return { ok: false, reasonCode: 'NO_ELIGIBLE_CANDIDATE' }
  }
  const selection =
    record.selection !== null &&
    typeof record.selection === 'object' &&
    !Array.isArray(record.selection)
      ? (record.selection as { mode?: unknown; provider?: unknown; model?: unknown })
      : undefined
  if (typeof selection?.mode !== 'string' || selection.mode === 'local') {
    return { ok: false, reasonCode: 'NO_ELIGIBLE_CANDIDATE' }
  }

  const capValid = filterNativeCapValidCandidates(readEnabledCandidates(config), checkAdmission)
  const selected =
    selection.mode === 'explicit'
      ? capValid.find(
          (candidate) =>
            candidate.provider === selection.provider && candidate.model === selection.model,
        )
      : capValid.length === 1
        ? capValid[0]
        : undefined
  if (selected === undefined || !isNativeJevProvider(selected.provider)) {
    return { ok: false, reasonCode: 'NO_ELIGIBLE_CANDIDATE' }
  }

  const hostProvider = NATIVE_JEV_HOST_PROVIDERS[selected.provider]
  const resolution = resolveNativeDecisionRoute(
    { providerID: hostProvider, id: selected.model },
    undefined,
    catalog,
  )
  if (!resolution.ok) return { ok: false, reasonCode: 'ROUTE_UNRESOLVED' }
  return {
    ok: true,
    selection: {
      route: resolution.route,
      provider: selected.provider,
      accountingProvider: DECISION_PROVIDER_ADAPTERS[selected.provider].accountingProvider,
      model: selected.model,
    },
  }
}

// ─── Request preparation ────────────────────────────────────────────────

export const JEV_DECISION_MAX_QUESTIONS = 4
/** Wide enough for the full skill catalog (20) plus `none` in preset mode. */
export const JEV_DECISION_MAX_CHOICES = 24
export const JEV_DECISION_MIN_CHOICES = 2
export const JEV_DECISION_MAX_SCORE_LEVELS = 10
export const JEV_DECISION_MIN_SCORE_LEVELS = 2
export const JEV_DECISION_MAX_NAME_LENGTH = 64
export const JEV_DECISION_MAX_INSTRUCTIONS_LENGTH = 2_000
export const JEV_DECISION_MAX_DESCRIPTION_LENGTH = 500
const QUESTION_NAME_PATTERN = /^[a-z0-9_.-]{1,64}$/i

export type JevDecisionQuestionInput = {
  readonly type: unknown
  readonly name: unknown
  readonly instructions: unknown
  readonly choices?: unknown
  readonly levels?: unknown
}

export type JevDecisionPreparationFailure = 'STATE_INVALID' | 'QUESTIONS_INVALID' | 'PRESET_INVALID'

export type JevDecisionPreparation =
  | { readonly ok: true; readonly request: NativeDecisionRequest }
  | { readonly ok: false; readonly reasonCode: JevDecisionPreparationFailure }

function isBoundedNonBlankString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

function readBoundedDescription(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return typeof value === 'string' && value.length > 0 && value.length <= 500 ? value : undefined
}

function readChoiceQuestion(
  question: JevDecisionQuestionInput,
): NativeDecisionRequest['questions'][number] | null {
  if (!Array.isArray(question.choices)) return null
  if (
    question.choices.length < JEV_DECISION_MIN_CHOICES ||
    question.choices.length > JEV_DECISION_MAX_CHOICES
  ) {
    return null
  }
  const seen = new Set<string>()
  const choices: Array<{ value: string; description?: string }> = []
  for (const raw of question.choices) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const record = raw as { value?: unknown; description?: unknown }
    if (!isBoundedNonBlankString(record.value, JEV_DECISION_MAX_NAME_LENGTH)) return null
    if (seen.has(record.value)) return null
    seen.add(record.value)
    const description = readBoundedDescription(record.description)
    choices.push(
      description === undefined ? { value: record.value } : { value: record.value, description },
    )
  }
  return {
    type: 'choice',
    name: question.name as string,
    instructions: question.instructions as string,
    choices,
  }
}

function readScoreQuestion(
  question: JevDecisionQuestionInput,
): NativeDecisionRequest['questions'][number] | null {
  if (!Array.isArray(question.levels)) return null
  if (
    question.levels.length < JEV_DECISION_MIN_SCORE_LEVELS ||
    question.levels.length > JEV_DECISION_MAX_SCORE_LEVELS
  ) {
    return null
  }
  const seen = new Set<string>()
  const levels: Array<{ label: string; description?: string }> = []
  for (const raw of question.levels) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const record = raw as { label?: unknown; description?: unknown }
    if (!isBoundedNonBlankString(record.label, JEV_DECISION_MAX_NAME_LENGTH)) return null
    if (seen.has(record.label)) return null
    seen.add(record.label)
    const description = readBoundedDescription(record.description)
    levels.push(
      description === undefined ? { label: record.label } : { label: record.label, description },
    )
  }
  return {
    type: 'score',
    name: question.name as string,
    instructions: question.instructions as string,
    levels,
  }
}

/**
 * Build one bounded native Decisions request from the tool input.
 *
 * The state is the only input part, carried verbatim as a single text part —
 * the same payload rule as the hook scaffold: no files, no history, no system
 * instructions, no memory. The host schema allows JSON and file parts; this
 * preparer never produces them.
 */
export function prepareJevDecisionRequest(
  route: ResolvedNativeDecisionRoute,
  input: { readonly state?: unknown; readonly questions?: unknown },
): JevDecisionPreparation {
  const state = input.state
  if (!isBoundedNonBlankString(state, NATIVE_DECISION_MAX_PROMPT_LENGTH)) {
    return { ok: false, reasonCode: 'STATE_INVALID' }
  }
  const rawQuestions = input.questions
  if (!Array.isArray(rawQuestions)) return { ok: false, reasonCode: 'QUESTIONS_INVALID' }
  if (rawQuestions.length < 1 || rawQuestions.length > JEV_DECISION_MAX_QUESTIONS) {
    return { ok: false, reasonCode: 'QUESTIONS_INVALID' }
  }

  const names = new Set<string>()
  const questions: NativeDecisionRequest['questions'][number][] = []
  for (const raw of rawQuestions) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, reasonCode: 'QUESTIONS_INVALID' }
    }
    const question = raw as JevDecisionQuestionInput
    if (!isBoundedNonBlankString(question.name, JEV_DECISION_MAX_NAME_LENGTH)) {
      return { ok: false, reasonCode: 'QUESTIONS_INVALID' }
    }
    if (!QUESTION_NAME_PATTERN.test(question.name) || names.has(question.name)) {
      return { ok: false, reasonCode: 'QUESTIONS_INVALID' }
    }
    if (!isBoundedNonBlankString(question.instructions, JEV_DECISION_MAX_INSTRUCTIONS_LENGTH)) {
      return { ok: false, reasonCode: 'QUESTIONS_INVALID' }
    }
    names.add(question.name)

    if (question.type === 'choice') {
      const built = readChoiceQuestion(question)
      if (built === null) return { ok: false, reasonCode: 'QUESTIONS_INVALID' }
      questions.push(built)
    } else if (question.type === 'score') {
      const built = readScoreQuestion(question)
      if (built === null) return { ok: false, reasonCode: 'QUESTIONS_INVALID' }
      questions.push(built)
    } else if (question.type === 'predicate') {
      if (question.choices !== undefined || question.levels !== undefined) {
        return { ok: false, reasonCode: 'QUESTIONS_INVALID' }
      }
      questions.push({
        type: 'predicate',
        name: question.name,
        instructions: question.instructions,
      })
    } else {
      return { ok: false, reasonCode: 'QUESTIONS_INVALID' }
    }
  }

  const request = {
    model: route.model,
    input: [{ type: 'text', text: state }],
    questions,
  } satisfies NativeDecisionRequest
  return { ok: true, request: Object.freeze(request) }
}

// ─── Preset requests: skill stacking and delegation ─────────────────────

/**
 * Ready-made single-question requests over Pantheon's own catalog.
 *
 * The point is speed with breadth: a free deterministic local prefilter picks
 * the skill shortlist when it can (≤ 4 skills), and Jev decides over it in one
 * typed call; when nothing pre-matches, the whole skill catalog is offered
 * instead. Both presets always include `none` — advice may abstain, and
 * `effect` stays `none` no matter what comes back.
 */
export type JevDecisionPreset = 'skills' | 'delegation'

export const JEV_DECISION_PRESETS = Object.freeze(['skills', 'delegation'] as const)

export function isJevDecisionPreset(value: unknown): value is JevDecisionPreset {
  return typeof value === 'string' && (JEV_DECISION_PRESETS as readonly string[]).includes(value)
}

/** Every canonical specialist except the orchestrator itself. */
const SPECIALIST_CHOICES: ReadonlyArray<{ value: string }> = Object.freeze(
  PANTHEON_AGENT_CATALOG.filter((agent) => agent.id !== 'zeus').map((agent) => ({
    value: agent.id,
  })),
)

const SKILL_DESCRIPTIONS = new Map(
  PANTHEON_SKILL_CATALOG.map((entry) => [entry.id, entry.description]),
)

function choiceList(values: readonly string[]): Array<{ value: string; description?: string }> {
  return values.map((value) => {
    const description = SKILL_DESCRIPTIONS.get(value)
    return description
      ? { value, description: description.slice(0, JEV_DECISION_MAX_DESCRIPTION_LENGTH) }
      : { value }
  })
}

/**
 * Build a preset request: one choice question over catalog-backed options.
 * `skills` stacks the local skill shortlist (falling back to the whole
 * catalog); `delegation` offers every canonical specialist except Zeus.
 */
export function prepareJevPresetRequest(
  route: ResolvedNativeDecisionRoute,
  mode: JevDecisionPreset,
  input: { readonly state?: unknown; readonly questions?: unknown },
): JevDecisionPreparation {
  if (input.questions !== undefined) return { ok: false, reasonCode: 'PRESET_INVALID' }
  const state = input.state
  if (!isBoundedNonBlankString(state, NATIVE_DECISION_MAX_PROMPT_LENGTH)) {
    return { ok: false, reasonCode: 'STATE_INVALID' }
  }

  const shortlist = mode === 'skills' ? selectPantheonSkills(state).skillIds : []
  const options =
    mode === 'skills'
      ? [
          ...choiceList(
            shortlist.length > 0 ? shortlist : PANTHEON_SKILL_CATALOG.map((entry) => entry.id),
          ),
          { value: 'none' },
        ]
      : [...SPECIALIST_CHOICES, { value: 'none' }]
  const question =
    mode === 'skills'
      ? {
          type: 'choice' as const,
          name: 'stack',
          instructions:
            'Choose the skills worth stacking for the described task, or none when none apply. ' +
            'This is advisory only; nothing is loaded or executed by this decision.',
          choices: options,
        }
      : {
          type: 'choice' as const,
          name: 'specialist',
          instructions:
            'Choose one listed specialist only when the described task clearly needs it; ' +
            'otherwise choose none. This is advisory only; nothing is dispatched.',
          choices: options,
        }
  const request = {
    model: route.model,
    input: [{ type: 'text', text: state }],
    questions: [question],
  } satisfies NativeDecisionRequest
  return { ok: true, request: Object.freeze(request) }
}
// ─── Response consumption ───────────────────────────────────────────────

export interface JevDecisionAdviceAnswer {
  readonly type: 'choice' | 'score' | 'predicate' | 'error'
  readonly name: string
  /** `choice` answers only, when the value is one of the question's choices. */
  readonly choice?: string
  /** `score` answers only. */
  readonly score?: number
  /** `predicate` answers only. */
  readonly probability?: number
  /** `choice` and `score` answers only, when finite in [0, 1]. */
  readonly confidence?: number
  /** `error` answers only. */
  readonly reason?: string
}

export interface JevDecisionAdvice {
  readonly answers: readonly JevDecisionAdviceAnswer[]
  /** Requested question names the host did not answer. */
  readonly missing: readonly string[]
  readonly costUsd: number | null
  readonly tokens: { readonly input: number | null; readonly output: number | null } | null
  /** Always `none`: advice never dispatches, narrows, or alters permissions. */
  readonly effect: 'none'
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function answerForQuestion(
  answer: unknown,
  question: NativeDecisionRequest['questions'][number],
): JevDecisionAdviceAnswer | null {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return null
  const record = answer as Record<string, unknown>
  if (record.name !== question.name) return null
  if (record.type === 'error') {
    if (typeof record.reason !== 'string' || record.reason.length === 0) return null
    return { type: 'error', name: question.name, reason: record.reason }
  }
  if (record.type !== question.type) return null
  if (question.type === 'choice') {
    if (typeof record.choice !== 'string') return null
    if (!question.choices.some((option) => option.value === record.choice)) return null
    return {
      type: 'choice',
      name: question.name,
      choice: record.choice,
      ...(isUnitInterval(record.confidence) ? { confidence: record.confidence } : {}),
    }
  }
  if (question.type === 'score') {
    if (!isNonNegativeFinite(record.score)) return null
    return {
      type: 'score',
      name: question.name,
      score: record.score,
      ...(isUnitInterval(record.confidence) ? { confidence: record.confidence } : {}),
    }
  }
  if (!isUnitInterval(record.probability)) return null
  return { type: 'predicate', name: question.name, probability: record.probability }
}

/**
 * Validate one host Decisions result against the prepared request.
 *
 * Every requested question must be answered by exactly one well-typed answer;
 * a missing answer lands in `missing`, an answer whose choice is outside the
 * prepared options is dropped. The consumer copies only allowlisted fields, so
 * unbounded host metadata (`native`, extra probability rows) never reaches the
 * tool output. The result is always advice: `effect` stays `none`.
 */
export function consumeJevDecisionResult(
  response: unknown,
  request: NativeDecisionRequest,
): JevDecisionAdvice {
  const empty: JevDecisionAdvice = {
    answers: [],
    missing: request.questions.map((question) => question.name),
    costUsd: null,
    tokens: null,
    effect: 'none',
  }
  if (response === null || typeof response !== 'object' || Array.isArray(response)) return empty
  const record = response as Record<string, unknown>
  if (!Array.isArray(record.answers)) return empty

  const answers: JevDecisionAdviceAnswer[] = []
  const missing: string[] = []
  for (const question of request.questions) {
    const matches = record.answers
      .map((candidate) => answerForQuestion(candidate, question))
      .filter((answer): answer is JevDecisionAdviceAnswer => answer !== null)
    if (matches.length === 0) {
      missing.push(question.name)
      continue
    }
    // One answer per question is the host contract; duplicates are untrustworthy.
    answers.push(
      matches.length === 1
        ? (matches[0] as JevDecisionAdviceAnswer)
        : {
            type: 'error',
            name: question.name,
            reason: 'DUPLICATE_ANSWER',
          },
    )
  }

  const costUsd = isNonNegativeFinite(record.cost) ? record.cost : null
  let tokens: JevDecisionAdvice['tokens'] = null
  if (
    record.tokens !== undefined &&
    record.tokens !== null &&
    typeof record.tokens === 'object' &&
    !Array.isArray(record.tokens)
  ) {
    const usage = record.tokens as Record<string, unknown>
    tokens = {
      input: isNonNegativeFinite(usage.input) ? usage.input : null,
      output: isNonNegativeFinite(usage.output) ? usage.output : null,
    }
  }
  return Object.freeze({
    answers: Object.freeze(answers),
    missing: Object.freeze(missing),
    costUsd,
    tokens,
    effect: 'none' as const,
  })
}
