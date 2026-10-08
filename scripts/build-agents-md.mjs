#!/usr/bin/env node
/**
 * build-agents-md.mjs — Generate the repo AGENTS.md from canonical sources.
 *
 * AGENTS.md is the single instruction file BOTH OpenCode V1 and V2 load
 * (V1 auto-discovers it, V2 loads it explicitly; the `instructions` config
 * key is accepted-but-ignored by V2). To keep instruction content in parity
 * across both versions without duplication, this script consolidates:
 *
 *   (a) a static header (project description + agent table + setup notes)
 *   (b) shared instruction bodies embedded under a `## <name>` section marker;
 *       agent-scoped bodies are rendered into only their matching agent prompt
 *
 * into AGENTS.md plus selective agent prompt content. The instruction files
 * remain the source of truth; AGENTS.md is a committed build artifact, never
 * hand-edited.
 *
 * Usage:
 *   node scripts/build-agents-md.mjs            # write AGENTS.md to repo root
 *   node scripts/build-agents-md.mjs --check    # exit 1 if AGENTS.md is stale
 *
 * No runtime dependencies (Node >= 18, stdlib only). Idempotent: running it
 * twice produces byte-identical output.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(__dirname, '..')
const INSTRUCTIONS_DIR = join(ROOT, 'src', 'instructions')
const AGENTS_MD_PATH = join(ROOT, 'AGENTS.md')

// ---------------------------------------------------------------------------
// Static header — preserved verbatim from the original AGENTS.md (agent table,
// setup notes, sandbox rules, conventions). Backticks are escaped for the
// template literal.
// ---------------------------------------------------------------------------
const STATIC_HEADER = `# Pantheon Agent System — OpenCode

This project uses the Pantheon multi-agent framework with 14 specialized agents.

## Available Agents

| Agent | Role |
|-------|------|
| @aphrodite | Frontend specialist — React 19, TypeScript strict, WCAG accessibility, responsive design, TDD, modern API patterns, deprecated npm detection. Uses discovery/review proportionally to scope and risk. |
| @apollo | Read-only investigation scout — 3–10 parallel searches across codebase, external docs, and GitHub. Called by: athena, zeus, hermes, aphrodite, demeter. No edits, no commands. |
| @athena | Strategic planner & architect — research-first, plan-only, never implements. Plans include quality gates (ruff/Biome, dep detection, LTS policy). Calls apollo for discovery. |
| @demeter | Database specialist — SQLAlchemy 2.0, Alembic, query optimization, N+1 prevention, TDD migrations, modern DB libs. Preserves review gates for schema/data changes. |
| @gaia | Remote sensing domain specialist — satellite image processing, spectral analysis, SAR, change detection, time series, ML/DL classification. Read-only analysis of geospatial data. |
| @hephaestus | AI tooling & pipelines specialist — LangChain/LangGraph chains, RAG architecture, vector stores, embedding strategies. Forges AI infrastructure. Calls apollo, sends to themis. |
| @hermes | Backend specialist — FastAPI, Python, async, TDD (RED→GREEN→REFACTOR), modern Python stdlib, obsolete lib detection. Uses discovery/review proportionally to scope and risk. |
| @iris | GitHub operations specialist — branches, pull requests, issues, releases, tags. Called by zeus after review. Never pushes or merges without explicit human approval. Integrates with VS Code GitHub Pull Requests extension. |
| @mnemosyne | Memory bank quality owner — initializes .pantheon/memory-bank/, writes ADRs and task records on explicit request. Called by zeus. Never invoked automatically after phases. |
| @nyx | Observability & monitoring specialist — OpenTelemetry tracing, token/cost tracking, agent performance analytics, LangSmith integration. Calls apollo for discovery, sends to themis. |
| @prometheus | Infrastructure + model provider specialist — Docker, CI/CD, multi-model routing, cost optimization, provider abstraction |
| @talos | Hotfix express lane — direct fixes for small bugs, CSS, typos, minor logic. No TDD ceremony, no orchestration overhead. Standalone, no subagents. Escalates complex issues to zeus. |
| @themis | Quality & security gate — ruff/Biome linting, dead/legacy code detection, OWASP Top 10, applicable coverage requirements, correctness, deprecation audit. Reviews material/sensitive changes. |
| @zeus | Central orchestrator — never implements. Delegates to: athena, apollo, hermes, aphrodite, demeter, prometheus, themis, iris, mnemosyne, talos, hephaestus, nyx |

## OpenCode Setup

See [INSTALLATION.md](docs/INSTALLATION.md) for setup instructions.

- Build: \`npm test\`
- Test: \`npm test\`
- Lint: \`npm run lint\`

## Teste de Instalação Global (sandbox)

Para validar a instalação global do pacote pantheon-opencode COMO UM USUÁRIO REAL, use o sandbox isolado em \`~/pantheon-sandbox/\` (fora do repo, HOME + prefix npm + venv próprios). O ambiente de dev mistura 3 instalações + config global + venv — NÃO serve para testar instalação/empacotamento.

- Rodar: \`bash ~/pantheon-sandbox/run-test.sh\` (opencode mcp list 5/5 connected + doctor 0 erros + abre TUI isolado)
- Regra para agentes: ao validar instalação global (npm pack, \`init\`, MCPs, hooks), usar o sandbox — NUNCA testar no ambiente de dev
- Descarte: \`rm -rf ~/pantheon-sandbox\`
- Detalhes: ver \`~/pantheon-sandbox/README.md\`

## Conventions

- TDD: RED→GREEN→REFACTOR for testable behavior; use focused checks for micro-edits
- Honor repository coverage thresholds when relevant; preserve stronger auth/security/data-integrity gates
- Async/await on all I/O
- Type hints on all functions
- PRs always update the README — every pull request must document newly added features, behaviors, env vars, or commands in the README before being opened.
`

// ---------------------------------------------------------------------------
// Frontmatter parsing (stdlib only — no yaml dependency)
// ---------------------------------------------------------------------------

/**
 * Parse YAML-ish frontmatter from an instruction file.
 *
 * Preserve the file-scope `applyTo` glob separately from the explicit
 * `agents` selectors. In particular, a Python workspace glob is never
 * interpreted as an agent name. The frontmatter block is stripped from
 * the embedded body.
 *
 * @param {string} content - Raw file content
 * @returns {{ name: string, body: string, applyTo: string | null,
 *   agents: string[], fallback: string | null, appliesToAgent: (name: string) => boolean } | null}
 */
export function parseInstruction(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return null
  const fm = match[1]
  const nameMatch = fm.match(/^name:\s*["']?([^"'\r\n]+)["']?\s*$/m)
  if (!nameMatch) return null
  const applyToMatch = fm.match(/^applyTo:\s*["']?([^"'\r\n]+)["']?\s*$/m)
  const agentsMatch = fm.match(/^agents:\s*\[([^\]\r\n]*)\]\s*$/m)
  const agents = agentsMatch
    ? agentsMatch[1]
        .split(',')
        .map((agent) => agent.trim().replace(/^(["'])(.*)\1$/, '$2'))
        .filter(Boolean)
    : fm.match(/^agents:/m)
      ? [] // Malformed explicit selector: fail closed; never make it global.
      : applyToMatch
        ? [] // File-scoped instructions need an explicit agent association.
        : ['*'] // Legacy instructions without selectors remain shared.
  const fallbackMatch = fm.match(/^fallback:\s*["']?([^"'\r\n]+)["']?\s*$/m)
  const appliesToAgent = (agent) => agents.includes('*') || agents.includes(agent)
  return {
    name: nameMatch[1].trim(),
    applyTo: applyToMatch?.[1].trim() ?? null,
    agents,
    fallback: fallbackMatch?.[1].trim() ?? null,
    appliesToAgent,
    body: `${content.slice(match[0].length).trimEnd()}\n`,
  }
}

/**
 * Read all src/instructions/*.instructions.md files, sorted by filename for
 * deterministic output.
 *
 * @returns {Array<{ file: string, name: string, body: string, applyTo: string | null,
 *   agents: string[], fallback: string | null, appliesToAgent: (name: string) => boolean }>}
 */
export function readInstructions() {
  if (!existsSync(INSTRUCTIONS_DIR)) return []
  const files = readdirSync(INSTRUCTIONS_DIR)
    .filter((f) => f.endsWith('.instructions.md'))
    .sort()
  const out = []
  for (const file of files) {
    const content = readFileSync(join(INSTRUCTIONS_DIR, file), 'utf8')
    const parsed = parseInstruction(content)
    if (parsed) out.push({ file, ...parsed })
  }
  return out
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Generate the full AGENTS.md content.
 *
 * @param {Array<{ file: string, name: string, body: string, agents?: string[] }>} instructions
 * @returns {string}
 */
export function generateAgentsMd(instructions) {
  const sharedInstructions = instructions.filter(
    (instr) => !instr.agents || instr.agents.includes('*'),
  )
  const sections = [
    '<!-- Generated by scripts/build-agents-md.mjs — do not edit directly. -->',
    '<!-- Source of truth: src/instructions/*.instructions.md (AGENTS.md is a committed build artifact). -->',
    '',
    STATIC_HEADER.trimEnd(),
    '',
    '---',
    '',
    '# Agent Instructions',
    '',
    'The following sections are consolidated from `src/instructions/*.instructions.md`',
    'so both OpenCode V1 (auto-loads AGENTS.md) and V2 (loads AGENTS.md, ignores the',
    '`instructions` config key) receive identical shared rules. Agent-scoped rules',
    'are rendered into only the matching installed agent prompts.',
    '',
  ]
  for (const instr of sharedInstructions) {
    sections.push(
      `<!-- Source: src/instructions/${instr.file} -->`,
      `## ${instr.name}`,
      '',
      instr.body.trimEnd(),
      '',
    )
  }
  return `${sections.join('\n').trimEnd()}\n`
}

const GENERATED_AGENT_BLOCK =
  /\n?<!-- Pantheon selective instructions: generated -->[\s\S]*?<!-- \/Pantheon selective instructions -->\n?/g

/**
 * Render the agent-specific instruction set into the supported agent prompt.
 * The shared rules remain in AGENTS.md; file globs are retained as scope
 * guidance and are never used as agent selectors.
 *
 * @param {string} agentName - Canonical agent name from the prompt filename
 * @param {string} prompt - Canonical source agent prompt
 * @param {Array<{ file: string, name: string, body: string, applyTo?: string | null,
 *   agents?: string[], fallback?: string | null }>} instructions
 * @returns {string}
 */
export function generateAgentPrompt(agentName, prompt, instructions = readInstructions()) {
  const basePrompt = prompt.replace(GENERATED_AGENT_BLOCK, '').trimEnd()
  const selected = instructions.filter(
    (instr) => instr.agents && !instr.agents.includes('*') && instr.agents.includes(agentName),
  )
  if (selected.length === 0) {
    return [
      basePrompt,
      '',
      '<!-- Pantheon selective instructions: generated -->',
      'No agent-specific instructions are assigned; follow the shared rules in AGENTS.md.',
      '<!-- /Pantheon selective instructions -->',
      '',
    ].join('\n')
  }

  const sections = selected.map((instr) => {
    const scope = instr.applyTo
      ? `\n\n> Apply only when a target workspace file matches \`${instr.applyTo}\`.`
      : ''
    const fallback =
      instr.fallback === 'shared'
        ? '\n\n> For work outside this scope, use the shared rules in AGENTS.md.'
        : ''
    return [
      `<!-- Source: src/instructions/${instr.file} -->`,
      `## ${instr.name}${scope}`,
      '',
      `${instr.body.trimEnd()}${fallback}`,
    ].join('\n')
  })
  return [
    basePrompt,
    '',
    '<!-- Pantheon selective instructions: generated -->',
    sections.join('\n\n'),
    '<!-- /Pantheon selective instructions -->',
    '',
  ].join('\n')
}

/**
 * Copy agent prompts with scoped instructions embedded in each actual prompt.
 * Used by both init and postinstall sync so the installed runtime receives the
 * same selection without a per-turn injection hook.
 *
 * @param {string} sourceDir - Canonical src/agents directory
 * @param {string} targetDir - OpenCode agents directory
 * @param {boolean} dryRun - Do not write when true
 * @param {boolean} existingOnly - Refresh installed prompts without adding missing agents
 * @returns {{ created: number, skipped: number }}
 */
export function copyAgentPrompts(sourceDir, targetDir, dryRun = false, existingOnly = false) {
  const instructions = readInstructions()
  if (!dryRun && !existingOnly) mkdirSync(targetDir, { recursive: true })
  let created = 0
  let skipped = 0
  for (const file of readdirSync(sourceDir)
    .filter((entry) => entry.endsWith('.md'))
    .sort()) {
    if (file.toLowerCase() === 'readme.md') continue
    const sourcePath = join(sourceDir, file)
    if (!statSync(sourcePath).isFile()) continue
    const agentName = file.replace(/\.md$/, '')
    const output = generateAgentPrompt(agentName, readFileSync(sourcePath, 'utf8'), instructions)
    const targetPath = join(targetDir, file)
    if (existingOnly && !existsSync(targetPath)) continue
    const existing = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null
    if (existing === output) {
      skipped++
    } else {
      if (!dryRun) writeFileSync(targetPath, output, 'utf8')
      created++
    }
  }
  return { created, skipped }
}

/**
 * Count LF-delimited logical lines without assuming a trailing newline.
 *
 * @param {string} content - File content
 * @returns {number}
 */
export function logicalLineCount(content) {
  if (content.length === 0) return 0
  const separators = content.match(/\n/g)?.length ?? 0
  return separators + (content.endsWith('\n') ? 0 : 1)
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main() {
  const checkOnly = process.argv.includes('--check')
  const instructions = readInstructions()
  const sharedCount = instructions.filter(
    (instr) => !instr.agents || instr.agents.includes('*'),
  ).length
  const content = generateAgentsMd(instructions)

  if (checkOnly) {
    const existing = existsSync(AGENTS_MD_PATH) ? readFileSync(AGENTS_MD_PATH, 'utf8') : ''
    if (existing !== content) {
      console.error(`❌ AGENTS.md is stale — run: node scripts/build-agents-md.mjs`)
      process.exit(1)
    }
    console.log(`✅ AGENTS.md is up to date (${sharedCount} shared instruction sections)`)
    return
  }

  writeFileSync(AGENTS_MD_PATH, content, 'utf8')
  const lines = logicalLineCount(content)
  console.log(`✅ Generated AGENTS.md (${sharedCount} shared instruction sections, ${lines} lines)`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
