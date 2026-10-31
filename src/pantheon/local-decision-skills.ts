import { PANTHEON_SKILL_CATALOG, PANTHEON_SKILL_IDS } from './pantheon-decision-catalog.ts'

export type SkillSelectionReason =
  | 'SELECTED_BY_KEYWORDS'
  | 'SELECTED_BY_MATERIAL_REQUIREMENT'
  | 'NO_LOCAL_MATCH'
  | 'INVALID_INPUT'

/** Material requirement that must seat `artifact-management` (D2). */
export type MaterialRequirement = 'gate' | 'planning'

export interface LocalSkillSelection {
  skillIds: string[]
  reasonCode: SkillSelectionReason
  /** `null` unless the request materially requires a gate or a plan (D2). */
  materialRequirement: MaterialRequirement | null
}

/** Bounded so a malformed or huge prompt can never fan out local work. */
export const MAX_SELECTED_SKILLS = 4
const MAX_REQUEST_LENGTH = 20_000

/**
 * Small, allowlisted keyword table. It is intentionally local and
 * deterministic: no model, no embedding index, no network.
 */
const KEYWORDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'agent-coordination': [
    'agent',
    'agents',
    'delegate',
    'delegation',
    'orchestrate',
    'orchestration',
    'route',
    'routing',
    'subagent',
  ],
  'artifact-management': ['artifact', 'artifacts', 'planned', 'multi-phase', 'impl'],
  'auto-continue': ['continue', 'continuation', 'todo', 'todos', 'multi-step', 'idle'],
  clonedeps: ['clone', 'dependency', 'dependencies', 'internals', 'library', 'package'],
  'code-review-checklist': ['review', 'reviews', 'pull request', 'feedback', 'checklist'],
  codemap: ['codemap', 'structure', 'codebase', 'unfamiliar', 'repository', 'overview'],
  'context-compression': ['compact', 'compaction', 'compress', 'context', 'checkpoint', 'resume'],
  'git-workflow-and-versioning': [
    'commit',
    'commits',
    'git',
    'branch',
    'version',
    'release',
    'tag',
    'changelog',
  ],
  'incremental-implementation': [
    'increment',
    'incremental',
    'slice',
    'slices',
    'implement',
    'implementation',
  ],
  'loop-engineering': ['loop', 'iterate', 'iteration', 'refine', 'refinement', 'cycle'],
  'memory-bank': ['memory', 'adr', 'adrs', 'documentation', 'docs', 'knowledge'],
  reflect: ['reflect', 'reflection', 'retro', 'retrospective', 'friction', 'workflow'],
  'security-hardening': [
    'security',
    'secure',
    'owasp',
    'vulnerability',
    'vulnerabilities',
    'secret',
    'secrets',
    'cve',
    'audit',
  ],
  'session-goal': ['goal', 'objective', 'scope', 'alignment', 'session'],
  simplify: [
    'simplify',
    'simplification',
    'refactor',
    'complexity',
    'readable',
    'readability',
    'cleanup',
  ],
  'spec-driven-development': [
    'spec',
    'specification',
    'requirements',
    'prd',
    'acceptance',
    'criteria',
  ],
  'tdd-with-agents': ['tdd', 'test', 'tests', 'testing', 'pytest', 'vitest', 'jest', 'coverage'],
  'verification-planning': [
    'verification',
    'verify',
    'evidence',
    'validation',
    'validate',
    'reproduce',
  ],
  'visual-review-pipeline': [
    'visual',
    'screenshot',
    'screenshots',
    'ui',
    'ux',
    'accessibility',
    'wcag',
    'playwright',
    'responsive',
  ],
  worktrees: ['worktree', 'worktrees', 'parallel', 'isolation', 'isolated'],
})

/**
 * Material gate/planning signals (D2).
 *
 * `artifact-management` exists for planned or materially risky work. Keyword
 * scoring alone left it unreachable when the request demanded a gate or a plan
 * without naming the artifact: "breaking change with human approval and a
 * rollback plan" matched no keyword at all. These are static phrase/token
 * lists, so detection stays local, deterministic, and bounded: no file, memory,
 * catalog, or network read.
 */
const MATERIAL_GATE_TOKENS: ReadonlySet<string> = new Set([
  'approval',
  'cutover',
  'gate',
  'irreversible',
  'signoff',
])

const MATERIAL_GATE_PHRASES: readonly string[] = Object.freeze([
  'breaking change',
  'risk assessment',
  'risk review',
  'schema change',
  'sign off',
])

const MATERIAL_PLANNING_TOKENS: ReadonlySet<string> = new Set([
  'deliverable',
  'deliverables',
  'milestone',
  'milestones',
  'plan',
  'planning',
  'roadmap',
  'rollback',
])

const MATERIAL_PLANNING_PHRASES: readonly string[] = Object.freeze([
  'across phases',
  'break down',
  'design doc',
  'implementation plan',
  'migration plan',
  'rollout plan',
  'work breakdown',
])

const ARTIFACT_SKILL_ID = 'artifact-management'

const CATALOG_ORDER = new Map(PANTHEON_SKILL_CATALOG.map((entry, index) => [entry.id, index]))

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

function scoreSkill(normalizedRequest: string, tokens: ReadonlySet<string>, skillId: string) {
  const keywords = KEYWORDS[skillId] ?? []
  let score = 0
  for (const keyword of keywords) {
    if (keyword.includes(' ')) {
      if (normalizedRequest.includes(keyword)) score += 3
      continue
    }
    if (tokens.has(keyword)) score += 2
  }
  return score
}

function hasMaterialSignal(
  normalizedRequest: string,
  tokens: ReadonlySet<string>,
  signalTokens: ReadonlySet<string>,
  signalPhrases: readonly string[],
): boolean {
  for (const token of signalTokens) {
    if (tokens.has(token)) return true
  }
  return signalPhrases.some((phrase) => normalizedRequest.includes(phrase))
}

/**
 * Detect a material gate or planning requirement (D2). A gate requirement wins
 * over a planning one, so the reported token is stable when both are present.
 */
function detectMaterialRequirement(
  normalizedRequest: string,
  tokens: ReadonlySet<string>,
): MaterialRequirement | null {
  if (hasMaterialSignal(normalizedRequest, tokens, MATERIAL_GATE_TOKENS, MATERIAL_GATE_PHRASES)) {
    return 'gate'
  }
  if (
    hasMaterialSignal(
      normalizedRequest,
      tokens,
      MATERIAL_PLANNING_TOKENS,
      MATERIAL_PLANNING_PHRASES,
    )
  ) {
    return 'planning'
  }
  return null
}

/**
 * Select a small, deterministic set of allowlisted Pantheon skills for the
 * current request. This function never reads files, memory, transcripts, or
 * the network, and it never returns the whole catalog as a fallback.
 *
 * D2 — when the request materially requires a gate or a plan, the artifact
 * skill is guaranteed a seat instead of depending on the literal keywords
 * `artifact`/`planned`/`multi-phase`/`impl`. That seat is first, so a hard
 * budget drops the lowest-scoring keyword skill rather than the required one.
 * This only ranks identifiers: it does not filter or mutate any prompt, and P2
 * remains an empirical no-op on the default path (F-09).
 */
export function selectPantheonSkills(
  request: unknown,
  maxSkills = MAX_SELECTED_SKILLS,
): LocalSkillSelection {
  if (
    typeof request !== 'string' ||
    request.trim().length === 0 ||
    request.length > MAX_REQUEST_LENGTH ||
    !Number.isInteger(maxSkills) ||
    maxSkills < 1 ||
    maxSkills > MAX_SELECTED_SKILLS
  ) {
    return { skillIds: [], reasonCode: 'INVALID_INPUT', materialRequirement: null }
  }

  const normalizedRequest = normalize(request)
  const tokens = tokenize(normalizedRequest)
  const material = detectMaterialRequirement(normalizedRequest, tokens)
  const scored: Array<{ id: string; score: number; order: number }> = []
  for (const skillId of PANTHEON_SKILL_IDS) {
    const score = scoreSkill(normalizedRequest, tokens, skillId)
    if (score <= 0) continue
    scored.push({ id: skillId, score, order: CATALOG_ORDER.get(skillId) ?? 0 })
  }
  if (material === null && scored.length === 0) {
    return { skillIds: [], reasonCode: 'NO_LOCAL_MATCH', materialRequirement: null }
  }

  scored.sort((left, right) => right.score - left.score || left.order - right.order)
  const ranked = scored.map((entry) => entry.id)
  const ordered =
    material === null
      ? ranked
      : [ARTIFACT_SKILL_ID, ...ranked.filter((id) => id !== ARTIFACT_SKILL_ID)]
  return {
    skillIds: ordered.slice(0, maxSkills),
    reasonCode: material === null ? 'SELECTED_BY_KEYWORDS' : 'SELECTED_BY_MATERIAL_REQUIREMENT',
    materialRequirement: material,
  }
}
