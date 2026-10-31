/**
 * Allowlisted, short Pantheon catalog used by the per-turn decision router.
 *
 * Only IDs and one-line descriptions live here. Full skill bodies, agent
 * prompts, file paths, memory contents, and transcripts are never included in
 * a provider payload.
 */

export interface DecisionCatalogEntry {
  id: string
  description: string
}

export const PANTHEON_SKILL_CATALOG: readonly DecisionCatalogEntry[] = Object.freeze([
  { id: 'agent-coordination', description: 'Multi-agent orchestration, routing, and delegation.' },
  { id: 'artifact-management', description: 'Structured artifacts for planned or risky work.' },
  { id: 'auto-continue', description: 'Continue multi-step todos while keeping safety gates.' },
  { id: 'clonedeps', description: 'Clone dependency source locally for inspection.' },
  { id: 'code-review-checklist', description: 'Systematic code review and quality gates.' },
  { id: 'codemap', description: 'Map repository structure before deep reading.' },
  { id: 'context-compression', description: 'Explicit compaction and resumable checkpoints.' },
  { id: 'git-workflow-and-versioning', description: 'Atomic commits and versioning workflow.' },
  { id: 'incremental-implementation', description: 'Thin, testable, rollback-safe slices.' },
  { id: 'loop-engineering', description: 'Controlled iterative refinement cycles.' },
  { id: 'memory-bank', description: 'Memory-bank structure, rules, and maintenance.' },
  { id: 'reflect', description: 'Turn repeated workflow friction into reusable assets.' },
  { id: 'security-hardening', description: 'Security gate: OWASP, secrets, dependencies.' },
  { id: 'session-goal', description: 'Pin the session objective against scope creep.' },
  { id: 'simplify', description: 'Behavior-preserving code simplification.' },
  {
    id: 'spec-driven-development',
    description: 'Spec-first requirements and acceptance criteria.',
  },
  {
    id: 'tdd-with-agents',
    description: 'RED, GREEN, REFACTOR test-driven implementation.',
  },
  { id: 'verification-planning', description: 'Plan the evidence path before changing code.' },
  {
    id: 'visual-review-pipeline',
    description: 'Automated visual review with screenshots and fixes.',
  },
  { id: 'worktrees', description: 'Isolated git worktrees for parallel or risky work.' },
])

export const PANTHEON_AGENT_CATALOG: readonly DecisionCatalogEntry[] = Object.freeze([
  { id: 'zeus', description: 'Central orchestrator; never implements.' },
  { id: 'athena', description: 'Plan-only architect and strategic planner.' },
  { id: 'apollo', description: 'Read-only investigation and discovery scout.' },
  { id: 'hermes', description: 'Backend specialist: FastAPI, Python, async.' },
  { id: 'aphrodite', description: 'Frontend specialist: React, TypeScript, WCAG.' },
  { id: 'demeter', description: 'Database specialist: SQLAlchemy, migrations, queries.' },
  { id: 'themis', description: 'Quality and security review gate.' },
  { id: 'prometheus', description: 'Infrastructure, Docker, CI, and model providers.' },
  { id: 'hephaestus', description: 'AI pipelines: LangChain, RAG, vector stores.' },
  { id: 'nyx', description: 'Observability, tracing, and cost analytics.' },
  { id: 'gaia', description: 'Remote sensing and geospatial analysis.' },
  { id: 'iris', description: 'GitHub branches, pull requests, issues, releases.' },
  { id: 'mnemosyne', description: 'Memory bank and ADR authoring on request.' },
  { id: 'talos', description: 'Small hotfixes, typos, and CSS fixes.' },
])

const SKILL_IDS = new Set(PANTHEON_SKILL_CATALOG.map((entry) => entry.id))
const AGENT_IDS = new Set(PANTHEON_AGENT_CATALOG.map((entry) => entry.id))

export const PANTHEON_SKILL_IDS: ReadonlySet<string> = SKILL_IDS
export const PANTHEON_AGENT_IDS: ReadonlySet<string> = AGENT_IDS

export function isPantheonSkillId(value: unknown): value is string {
  return typeof value === 'string' && SKILL_IDS.has(value)
}

export function isPantheonAgentId(value: unknown): value is string {
  return typeof value === 'string' && AGENT_IDS.has(value)
}

export function skillCatalogEntry(id: string): DecisionCatalogEntry | undefined {
  return PANTHEON_SKILL_CATALOG.find((entry) => entry.id === id)
}

export function agentCatalogEntry(id: string): DecisionCatalogEntry | undefined {
  return PANTHEON_AGENT_CATALOG.find((entry) => entry.id === id)
}

/** Build the short skill catalog subset for an explicit ID list. */
export function skillCatalogSubset(ids: readonly string[]): DecisionCatalogEntry[] {
  const selected = new Set(ids)
  return PANTHEON_SKILL_CATALOG.filter((entry) => selected.has(entry.id)).map((entry) => ({
    id: entry.id,
    description: entry.description,
  }))
}

/** Build the short agent catalog subset for an explicit ID list. */
export function agentCatalogSubset(ids: readonly string[]): DecisionCatalogEntry[] {
  const selected = new Set(ids)
  return PANTHEON_AGENT_CATALOG.filter((entry) => selected.has(entry.id)).map((entry) => ({
    id: entry.id,
    description: entry.description,
  }))
}
