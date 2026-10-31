import type { LocalDecisionPolicy } from './local-orchestration.ts'
import { PANTHEON_AGENT_CATALOG, PANTHEON_AGENT_IDS } from './pantheon-decision-catalog.ts'
import { isAgentAllowed } from './permission-globs.ts'
import { PANTHEON_AGENTS } from './v2-delegation-enforce.ts'

export type AgentRecommendationReason =
  | 'RECOMMENDED'
  | 'NO_DELEGATION_SIGNAL'
  | 'NO_ELIGIBLE_CANDIDATE'
  | 'AMBIGUOUS_CANDIDATE'
  | 'POLICY_UNAVAILABLE'
  | 'INVALID_INPUT'

export interface LocalAgentRecommendation {
  agent: string | null
  reasonCode: AgentRecommendationReason
}

const MAX_REQUEST_LENGTH = 20_000
const CATALOG_ORDER = new Map(PANTHEON_AGENT_CATALOG.map((entry, index) => [entry.id, index]))

const EXPLICIT_DELEGATION_TOKENS = new Set([
  'delegate',
  'delegation',
  'delegar',
  'delegacao',
  'handoff',
  'subagent',
  'specialist',
  'especialista',
  'route',
  'routing',
  'parallel',
  'paralelo',
])

const ACTION_TOKENS = new Set([
  'add',
  'audit',
  'build',
  'change',
  'create',
  'debug',
  'design',
  'fix',
  'implement',
  'implementar',
  'investigate',
  'migrate',
  'optimize',
  'plan',
  'planejar',
  'refactor',
  'research',
  'review',
  'revisar',
  'update',
])

/** Specialist keywords. Scores are local only and never grant permission. */
const AGENT_KEYWORDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  athena: ['plan', 'planning', 'architecture', 'architect', 'strategy', 'spec', 'requirements'],
  apollo: ['investigate', 'investigation', 'research', 'discovery', 'explore', 'find', 'search'],
  hermes: ['api', 'backend', 'fastapi', 'python', 'endpoint', 'async', 'server', 'pytest'],
  aphrodite: [
    'frontend',
    'react',
    'typescript',
    'css',
    'component',
    'ui',
    'accessibility',
    'wcag',
    'responsive',
  ],
  demeter: ['database', 'sql', 'schema', 'migration', 'alembic', 'sqlalchemy', 'query', 'index'],
  themis: ['security', 'owasp', 'audit', 'lint', 'coverage', 'quality', 'vulnerability', 'cve'],
  prometheus: ['docker', 'ci', 'pipeline', 'deploy', 'infrastructure', 'provider', 'container'],
  hephaestus: ['langchain', 'langgraph', 'rag', 'vector', 'embedding', 'llm', 'pipeline', 'ai'],
  nyx: ['observability', 'telemetry', 'opentelemetry', 'tracing', 'metrics', 'langsmith', 'cost'],
  gaia: ['satellite', 'spectral', 'sar', 'geospatial', 'imagery', 'remote', 'sensing'],
  iris: ['github', 'pull', 'request', 'issue', 'branch', 'release', 'tag', 'pr'],
  mnemosyne: ['memory', 'adr', 'documentation', 'knowledge', 'persistent'],
  talos: ['typo', 'hotfix', 'small', 'quick', 'minor', 'css'],
})

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function tokenize(value: string): Set<string> {
  const tokens = value.match(/[a-z0-9]+(?:[+#.-][a-z0-9]+)*/g) ?? []
  return new Set(tokens)
}

/** True when the request plausibly considers delegating to a specialist. */
export function hasDelegationSignal(request: unknown): boolean {
  if (typeof request !== 'string' || request.trim().length === 0) return false
  if (request.length > MAX_REQUEST_LENGTH) return false
  const tokens = tokenize(normalize(request))
  for (const token of EXPLICIT_DELEGATION_TOKENS) {
    if (tokens.has(token)) return true
  }
  if (![...tokens].some((token) => ACTION_TOKENS.has(token))) return false
  return [...tokens].some((token) =>
    Object.values(AGENT_KEYWORDS).some((keywords) => keywords.includes(token)),
  )
}

/** Intersect canonical agents with Zeus grants, routing defaults, and task rules. */
export function listEligibleDecisionAgents(policy: LocalDecisionPolicy | undefined): string[] {
  if (policy === undefined || !PANTHEON_AGENTS.has('zeus')) return []
  const zeus = policy.agents.zeus
  if (zeus === undefined) return []
  return PANTHEON_AGENT_CATALOG.filter(({ id }) => id !== 'zeus')
    .filter(({ id }) => {
      const target = policy.agents[id]
      return (
        PANTHEON_AGENT_IDS.has(id) &&
        target?.canReceiveDelegation === true &&
        zeus.canDelegateTo.includes(id) &&
        isAgentAllowed(policy.permissionTask, id)
      )
    })
    .map(({ id }) => id)
}

/**
 * Recommend at most one canonical specialist, or abstain. The result is
 * advisory only: it neither dispatches nor grants anything.
 */
export function recommendLocalDecisionAgent(
  request: unknown,
  policy: LocalDecisionPolicy | undefined,
): LocalAgentRecommendation {
  if (typeof request !== 'string' || request.trim().length === 0) {
    return { agent: null, reasonCode: 'INVALID_INPUT' }
  }
  if (request.length > MAX_REQUEST_LENGTH) {
    return { agent: null, reasonCode: 'INVALID_INPUT' }
  }
  if (policy === undefined) return { agent: null, reasonCode: 'POLICY_UNAVAILABLE' }
  if (!hasDelegationSignal(request)) {
    return { agent: null, reasonCode: 'NO_DELEGATION_SIGNAL' }
  }

  const eligible = new Set(listEligibleDecisionAgents(policy))
  if (eligible.size === 0) return { agent: null, reasonCode: 'NO_ELIGIBLE_CANDIDATE' }

  const tokens = tokenize(normalize(request))
  const scored: Array<{ id: string; score: number; order: number }> = []
  for (const id of eligible) {
    const keywords = AGENT_KEYWORDS[id] ?? []
    const score = keywords.reduce((total, keyword) => total + (tokens.has(keyword) ? 1 : 0), 0)
    if (score <= 0) continue
    scored.push({ id, score, order: CATALOG_ORDER.get(id) ?? 0 })
  }
  if (scored.length === 0) return { agent: null, reasonCode: 'NO_ELIGIBLE_CANDIDATE' }

  scored.sort((left, right) => right.score - left.score || left.order - right.order)
  const [first, second] = scored
  if (first === undefined) return { agent: null, reasonCode: 'NO_ELIGIBLE_CANDIDATE' }
  if (second !== undefined && second.score === first.score) {
    return { agent: null, reasonCode: 'AMBIGUOUS_CANDIDATE' }
  }
  return { agent: first.id, reasonCode: 'RECOMMENDED' }
}
