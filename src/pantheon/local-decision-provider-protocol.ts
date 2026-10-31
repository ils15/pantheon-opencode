/**
 * Private provider protocol: payload construction, fixed request bodies, and
 * strict response decoding. This module performs no network I/O and accepts no
 * fetch, env, config, or ledger.
 */
import {
  DECISION_PROVIDER_ADAPTERS,
  type DecisionProtocol,
  type DecisionProviderId,
} from './local-decision-provider-matrix.ts'
import {
  agentCatalogSubset,
  isPantheonAgentId,
  isPantheonSkillId,
  skillCatalogSubset,
} from './pantheon-decision-catalog.ts'

const MAX_REQUEST_LENGTH = 12_000
const MIN_CONFIDENCE = 0.8
/**
 * Best-effort rejection of high-confidence credential shapes. This is a
 * denylist, not a secret scanner: an unrecognized credential can still be sent
 * with the request text, so prompts must not contain secrets in the first
 * place. The `sk-` family requires a token boundary and a structured prefix
 * (`sk-proj-`, `sk-svcacct-`, `sk-admin-`, `sk-ant-…-`) or a long bare token, so
 * prose such as `task-force-…`, `risk-based-…`, `disk-usage-…`,
 * `desk-organization-…`, or `mask-generation-…` is not mistaken for a key.
 * Also covers Stripe, cloud/SaaS tokens, JWTs, bearer values, and
 * `password=`/`api_key=` assignments.
 */
const SECRET_PATTERN = new RegExp(
  [
    '(?<![A-Za-z0-9])sk-(?:proj-|svcacct-|admin-|ant-[a-z0-9]+-)?[A-Za-z0-9]{20,}',
    'sk_live_[A-Za-z0-9]{20,}',
    'sk_test_[A-Za-z0-9]{20,}',
    'rk_live_[A-Za-z0-9]{20,}',
    'AKIA[0-9A-Z]{16}',
    'gh[pousr]_[A-Za-z0-9_]{36,}',
    'glpat-[A-Za-z0-9_-]{20}',
    'xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24}',
    'bearer[ \t]+[A-Za-z0-9_.-]{20,}',
    'eyJ[A-Za-z0-9_-]*\\.eyJ[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]*',
    '(?:password|passwd|pwd|api[_-]?key|apikey|client[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token)[ \\t]*[:=][ \\t]*[\'"]?[^\\s\'"&]{8,}',
  ].join('|'),
  'i',
)
export interface DecisionPayload {
  request: string
  skills: Array<{ id: string; description: string }>
  agents?: Array<{ id: string; description: string }>
}

export interface DecisionPayloadInput {
  request: unknown
  skillIds: readonly string[]
  agentIds?: readonly string[]
}

/**
 * Build the only authorized provider payload: the current user request plus a
 * short allowlisted skill catalog, and eligible agent IDs only when delegation
 * is under consideration. Transcripts, files, paths, memory, and instructions
 * are rejected by construction.
 */
export function buildDecisionPayload(input: DecisionPayloadInput): DecisionPayload | null {
  try {
    const request =
      typeof input.request === 'string' && input.request.trim().length > 0
        ? input.request.trim()
        : ''
    if (request.length === 0 || request.length > MAX_REQUEST_LENGTH) return null
    if (SECRET_PATTERN.test(request)) return null
    if (!Array.isArray(input.skillIds) || input.skillIds.length === 0) return null
    if (new Set(input.skillIds).size !== input.skillIds.length) return null
    if (!input.skillIds.every((id) => isPantheonSkillId(id))) return null
    const skills = skillCatalogSubset(input.skillIds)
    if (skills.length !== input.skillIds.length) return null

    if (input.agentIds === undefined) return { request, skills }
    if (!Array.isArray(input.agentIds) || input.agentIds.length === 0) return null
    if (new Set(input.agentIds).size !== input.agentIds.length) return null
    if (!input.agentIds.every((id) => id !== 'zeus' && isPantheonAgentId(id))) return null
    const agents = agentCatalogSubset(input.agentIds)
    if (agents.length !== input.agentIds.length) return null
    return { request, skills, agents }
  } catch {
    return null
  }
}

interface ChoiceQuestion {
  name: 'skill' | 'agent'
  choices: string[]
}

function createQuestions(payload: DecisionPayload): ChoiceQuestion[] {
  const questions: ChoiceQuestion[] = [
    { name: 'skill', choices: [...payload.skills.map((skill) => skill.id), 'abstain'] },
  ]
  if (payload.agents !== undefined) {
    questions.push({
      name: 'agent',
      choices: [...payload.agents.map((agent) => agent.id), 'abstain'],
    })
  }
  return questions
}

/** Build the fixed provider request body for one adapter. */
export function buildProviderRequest(
  provider: DecisionProviderId,
  payload: DecisionPayload,
): Record<string, unknown> | null {
  const adapter = DECISION_PROVIDER_ADAPTERS[provider]
  if (adapter === undefined || !adapter.egressEligible) return null
  const questions = createQuestions(payload)
  if (questions.length === 0) return null

  if (adapter.protocol === 'openai') {
    return {
      model: adapter.model,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_json', data: payload }],
        },
      ],
      questions: questions.map((question) => ({
        type: 'choice',
        name: question.name,
        instructions:
          question.name === 'skill'
            ? 'Choose one supplied skill ID, or choose abstain.'
            : 'Choose one supplied specialist ID, or choose abstain.',
        choices: question.choices.map((value) => ({ value, description: value })),
      })),
    }
  }

  return {
    model: adapter.model,
    state: payload,
    questions: Object.fromEntries(
      questions.map((question) => [
        question.name,
        {
          type: 'choice',
          instructions:
            question.name === 'skill'
              ? 'Choose one supplied skill ID, or choose abstain.'
              : 'Choose one supplied specialist ID, or choose abstain.',
          criteria: Object.fromEntries(question.choices.map((choice) => [choice, choice])),
        },
      ]),
    ),
  }
}

export type ProviderDecision =
  | { status: 'decided'; skillIds: string[]; agent: string | null }
  | { status: 'abstain'; reasonCode: 'PROVIDER_ABSTAIN' }
  | { status: 'invalid'; reasonCode: 'INVALID_PROVIDER_RESPONSE' }

interface DecodedAnswer {
  choice: string | null
}

function parseProbabilities(
  value: unknown,
  choices: readonly string[],
  protocol: DecisionProtocol,
): { selected: string; max: number } | null {
  let entries: Array<[string, unknown]>
  if (protocol === 'openai' && Array.isArray(value)) {
    if (value.length !== choices.length) return null
    const seen = new Set<string>()
    entries = []
    for (const item of value) {
      if (!isPlainRecord(item) || !hasExactKeys(item, ['probability', 'value'])) return null
      if (typeof item.value !== 'string' || !choices.includes(item.value) || seen.has(item.value)) {
        return null
      }
      seen.add(item.value)
      entries.push([item.value, item.probability])
    }
    if (seen.size !== choices.length) return null
  } else if (protocol === 'systemone' && isPlainRecord(value)) {
    const keys = Object.keys(value).sort()
    const expected = [...choices].sort()
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
      return null
    }
    entries = keys.map((key) => [key, value[key]])
  } else {
    return null
  }

  let total = 0
  let selected = ''
  let maximum = -1
  let maximumCount = 0
  for (const [choice, probability] of entries) {
    if (
      typeof probability !== 'number' ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    ) {
      return null
    }
    total += probability
    if (probability > maximum) {
      maximum = probability
      selected = choice
      maximumCount = 1
    } else if (probability === maximum) {
      maximumCount += 1
    }
  }
  if (Math.abs(total - 1) > 1e-6 || maximumCount !== 1) return null
  return { selected, max: maximum }
}

function decodeAnswer(
  value: unknown,
  question: ChoiceQuestion,
  protocol: DecisionProtocol,
): DecodedAnswer | null {
  if (!isPlainRecord(value)) return null
  if (value.type === 'refusal') {
    if (protocol !== 'openai' || !hasExactKeys(value, ['name', 'type'])) return null
    return value.name === question.name ? { choice: null } : null
  }
  const keys =
    protocol === 'openai'
      ? ['choice', 'confidence', 'name', 'probabilities', 'type']
      : ['choice', 'confidence', 'probabilities', 'type']
  if (
    !hasExactKeys(value, keys) ||
    value.type !== 'choice' ||
    (protocol === 'openai' && value.name !== question.name) ||
    typeof value.choice !== 'string' ||
    !question.choices.includes(value.choice) ||
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    return null
  }
  const distribution = parseProbabilities(value.probabilities, question.choices, protocol)
  if (distribution === null || distribution.selected !== value.choice) return null
  if (value.choice === 'abstain') return { choice: null }
  if (value.confidence < MIN_CONFIDENCE || distribution.max < MIN_CONFIDENCE) {
    return { choice: null }
  }
  return { choice: value.choice }
}

/**
 * Decode only documented answer fields. IDs must be exactly the supplied
 * candidates; the model cannot introduce, grant, or dispatch anything.
 */
export function parseProviderDecision(
  provider: DecisionProviderId,
  response: unknown,
  payload: DecisionPayload,
): ProviderDecision {
  try {
    const adapter = DECISION_PROVIDER_ADAPTERS[provider]
    if (adapter === undefined || !isPlainRecord(response) || response.model !== adapter.model) {
      return { status: 'invalid', reasonCode: 'INVALID_PROVIDER_RESPONSE' }
    }
    const questions = createQuestions(payload)
    const answers = new Map<ChoiceQuestion['name'], DecodedAnswer>()

    if (adapter.protocol === 'openai') {
      const rawAnswers = response.answers
      if (!Array.isArray(rawAnswers) || rawAnswers.length !== questions.length) {
        return { status: 'invalid', reasonCode: 'INVALID_PROVIDER_RESPONSE' }
      }
      for (const [index, question] of questions.entries()) {
        const decoded = decodeAnswer(rawAnswers[index], question, 'openai')
        if (decoded === null) return { status: 'invalid', reasonCode: 'INVALID_PROVIDER_RESPONSE' }
        answers.set(question.name, decoded)
      }
    } else {
      const rawAnswers = response.answers
      if (
        !isPlainRecord(rawAnswers) ||
        !hasExactKeys(
          rawAnswers,
          questions.map((question) => question.name),
        )
      ) {
        return { status: 'invalid', reasonCode: 'INVALID_PROVIDER_RESPONSE' }
      }
      for (const question of questions) {
        const decoded = decodeAnswer(rawAnswers[question.name], question, 'systemone')
        if (decoded === null) return { status: 'invalid', reasonCode: 'INVALID_PROVIDER_RESPONSE' }
        answers.set(question.name, decoded)
      }
    }

    const skill = answers.get('skill')?.choice ?? null
    const agent = answers.get('agent')?.choice ?? null
    if (skill !== null && !payload.skills.some((entry) => entry.id === skill)) {
      return { status: 'invalid', reasonCode: 'INVALID_PROVIDER_RESPONSE' }
    }
    if (agent !== null && !(payload.agents ?? []).some((entry) => entry.id === agent)) {
      return { status: 'invalid', reasonCode: 'INVALID_PROVIDER_RESPONSE' }
    }
    if (skill === null && agent === null) {
      return { status: 'abstain', reasonCode: 'PROVIDER_ABSTAIN' }
    }
    return { status: 'decided', skillIds: skill === null ? [] : [skill], agent }
  } catch {
    return { status: 'invalid', reasonCode: 'INVALID_PROVIDER_RESPONSE' }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  return (
    actualKeys.length === expected.length &&
    actualKeys.every((key, index) => key === expected[index])
  )
}
