import { PANTHEON_SKILL_CATALOG, PANTHEON_SKILL_IDS } from './pantheon-decision-catalog.ts'

export type SkillSelectionReason = 'SELECTED_BY_KEYWORDS' | 'NO_LOCAL_MATCH' | 'INVALID_INPUT'

export interface LocalSkillSelection {
  skillIds: string[]
  reasonCode: SkillSelectionReason
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

/**
 * Select a small, deterministic set of allowlisted Pantheon skills for the
 * current request. This function never reads files, memory, transcripts, or
 * the network, and it never returns the whole catalog as a fallback.
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
    return { skillIds: [], reasonCode: 'INVALID_INPUT' }
  }

  const normalizedRequest = normalize(request)
  const tokens = tokenize(normalizedRequest)
  const scored: Array<{ id: string; score: number; order: number }> = []
  for (const skillId of PANTHEON_SKILL_IDS) {
    const score = scoreSkill(normalizedRequest, tokens, skillId)
    if (score <= 0) continue
    scored.push({ id: skillId, score, order: CATALOG_ORDER.get(skillId) ?? 0 })
  }
  if (scored.length === 0) return { skillIds: [], reasonCode: 'NO_LOCAL_MATCH' }

  scored.sort((left, right) => right.score - left.score || left.order - right.order)
  return {
    skillIds: scored.slice(0, maxSkills).map((entry) => entry.id),
    reasonCode: 'SELECTED_BY_KEYWORDS',
  }
}
