/**
 * The deterministic local advisory decision for one turn.
 *
 * The production V2 prompt hook uses `decideLocalForTurn` only. It is
 * deterministic and local-only: no provider branch, no consent/credential/
 * permission path, no transport, no cache — the legacy provider-capable
 * `decideForTurn` and its one-call-per-turn cache were removed with the
 * direct-fetch provider runner (the native route is the explicit
 * `pantheon_jev_decide` tool, which correlates its own turn).
 */
import {
  isUserDecisionRouterEnabled,
  readUserDecisionRouterConfig,
  type UserDecisionRouterConfig,
} from '../../scripts/install/decision-router-config.mjs'
import { hasDelegationSignal, recommendLocalDecisionAgent } from './local-decision-agents.ts'
import { selectPantheonSkills } from './local-decision-skills.ts'
import { type LocalDecisionPolicy, loadLocalDecisionPolicy } from './local-orchestration.ts'

export type TurnDecisionSource = 'local'

export interface TurnDecision {
  schemaVersion: 1
  active: boolean
  source: TurnDecisionSource
  skillIds: string[]
  agent: string | null
  reasonCode: string
  /** Deterministic refinement flag (no model judgment): the request looks
   * multi-concern and without acceptance criteria — refine BEFORE executing. */
  refineRecommended: boolean
}

export interface TurnDecisionInput {
  request: unknown
  sessionID: unknown
  messageID: unknown
}

const MAX_REQUEST_LENGTH = 20_000

function inactive(reasonCode: string): TurnDecision {
  return {
    schemaVersion: 1,
    active: false,
    source: 'local',
    skillIds: [],
    agent: null,
    reasonCode,
    refineRecommended: false,
  }
}

function readConfig(): UserDecisionRouterConfig | undefined {
  try {
    return readUserDecisionRouterConfig()
  } catch {
    return undefined
  }
}

/**
 * Delegation-relevant skills per specialist (D3 fix, field reports beta.13-16:
 * a PT-Brasil delegation matched the agent lexically but starved on skills —
 * the English-lexical prefilter returned [] for the same domain). When the
 * prefilter matches nothing but an agent was selected, these curated subsets
 * of the agent's own grants keep the delegation fed. Pinned against the
 * canonical frontmatter by tests/pantheon/local-decision-turn.test.ts.
 */
const AGENT_SKILL_FALLBACK: Readonly<Record<string, readonly string[]>> = Object.freeze({
  athena: ['spec-driven-development', 'verification-planning'],
  apollo: ['codemap'],
  themis: ['code-review-checklist', 'security-hardening'],
  hermes: ['incremental-implementation', 'tdd-with-agents'],
  aphrodite: ['incremental-implementation', 'visual-review-pipeline'],
  demeter: ['incremental-implementation', 'tdd-with-agents'],
  prometheus: ['git-workflow-and-versioning'],
  hephaestus: ['tdd-with-agents'],
  nyx: ['auto-continue'],
  gaia: ['auto-continue'],
  iris: ['artifact-management', 'git-workflow-and-versioning'],
  mnemosyne: ['memory-bank', 'context-compression'],
  talos: ['incremental-implementation'],
})

/** Pure decision core exposed for offline tests (D3 contract).
 * @internal
 */
export function localDecisionForTest(
  request: string,
  policy: LocalDecisionPolicy | undefined,
  reasonCode: string,
): TurnDecision {
  const selection = selectPantheonSkills(request)
  const agent = hasDelegationSignal(request)
    ? recommendLocalDecisionAgent(request, policy).agent
    : null
  // D3: the prefilter is English-lexical; a PT state for the SAME domain
  // starved. When it matches nothing but the agent is known, fall back to the
  // agent's own curated grants — never an empty recommendation for a routed
  // specialist.
  const skillIds =
    selection.skillIds.length > 0 || agent === null || !(agent in AGENT_SKILL_FALLBACK)
      ? selection.skillIds
      : AGENT_SKILL_FALLBACK[agent]
  return {
    schemaVersion: 1,
    active: true,
    source: 'local',
    skillIds,
    agent,
    reasonCode,
    refineRecommended: shouldRefine(request),
  }
}

/**
 * DETERMINISTIC refinement trigger (field beta.22→23: the owner wants
 * accessibility — badly structured prompts must not degrade processing, and
 * deciding "should I refine?" via Jev is negative economics). Pure text
 * signals, no model: (a) 2+ distinct action concerns, (b) long multi-clause
 * text, AND (c) no acceptance-criteria markers. One positive concern OR the
 * long-multi-clause shape plus absent criteria fires it.
 */
const CONCERN_MARKERS: readonly string[] = [
  // EN + PT: fix / improve / redesign / create / refactor / add
  'corrigir',
  'corrija',
  'arrumar',
  'consertar',
  'melhorar',
  'melhora',
  'refatorar',
  'refatora',
  'redesign',
  'redesenhar',
  'criar',
  'crie',
  'adicionar',
  'adicione',
  'implementar',
  'trocar',
  'fix',
  'improve',
  'refactor',
  'redesign',
  'create',
  'add',
  'rewrite',
  'restructure',
]

const CRITERIA_MARKERS: readonly string[] = [
  'critério',
  'criterio',
  'critérios',
  'acceptance',
  'aceite',
  'testes de aceitação',
  'acceptance criteria',
  'done when',
  'pronto quando',
  'definition of done',
]

export function shouldRefine(request: string): boolean {
  if (typeof request !== 'string') return false
  const text = request.trim()
  if (text.length < 24) return false // a one-liner fix never refines
  const lowered = text.toLowerCase()
  if (CRITERIA_MARKERS.some((marker) => lowered.includes(marker))) return false
  const concerns = CONCERN_MARKERS.filter((marker) =>
    new RegExp(`(^|\\s|[^a-zà-ú])${marker}`, 'i').test(lowered),
  ).length
  if (concerns >= 2) return true
  // Long multi-clause text with a single concern also refines (the shape of a
  // vague brief): 3+ clauses via separators.
  const clauses = text
    .split(/[,;.]|(?:\s[eE]\s)|(?:\sy\s)/)
    .filter((part) => part.trim().length > 8)
  return concerns >= 1 && clauses.length >= 3
}

/**
 * Produce the deterministic local recommendation without entering the
 * provider, consent, credential, permission, or transport path. The legacy
 * per-turn `enabled` preference gates this advisory behavior; provider-selection
 * and egress settings do not.
 */
export async function decideLocalForTurn(input: TurnDecisionInput): Promise<TurnDecision> {
  const request = typeof input.request === 'string' ? input.request : ''
  const sessionID = typeof input.sessionID === 'string' ? input.sessionID.trim() : ''
  const messageID = typeof input.messageID === 'string' ? input.messageID.trim() : ''
  if (
    request.trim().length === 0 ||
    request.length > MAX_REQUEST_LENGTH ||
    sessionID.length === 0 ||
    messageID.length === 0
  ) {
    return inactive('INVALID_INPUT')
  }

  const config = readConfig()
  if (config === undefined || !isUserDecisionRouterEnabled(config)) return inactive('DISABLED')

  const policy = await loadLocalDecisionPolicy().catch(() => undefined)
  return localDecisionForTest(request, policy, 'LOCAL_SELECTION')
}
