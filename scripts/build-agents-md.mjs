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
 *   (b) every src/instructions/*.instructions.md body, embedded under a
 *       `## <name>` section marker (name taken from frontmatter)
 *
 * into one generated AGENTS.md. src/instructions/*.instructions.md remains
 * the source of truth — AGENTS.md is a committed build artifact, never
 * hand-edited.
 *
 * Usage:
 *   node scripts/build-agents-md.mjs            # write AGENTS.md to repo root
 *   node scripts/build-agents-md.mjs --check    # exit 1 if AGENTS.md is stale
 *
 * No runtime dependencies (Node >= 18, stdlib only). Idempotent: running it
 * twice produces byte-identical output.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
| @aphrodite | Frontend specialist — React 19, TypeScript strict, WCAG accessibility, responsive design, TDD, modern API patterns, deprecated npm detection. Calls apollo for discovery, sends to themis for review. |
| @apollo | Read-only investigation scout — 3–10 parallel searches across codebase, external docs, and GitHub. Called by: athena, zeus, hermes, aphrodite, demeter. No edits, no commands. |
| @athena | Strategic planner & architect — research-first, plan-only, never implements. Plans include quality gates (ruff/Biome, dep detection, LTS policy). Calls apollo for discovery. |
| @demeter | Database specialist — SQLAlchemy 2.0, Alembic, query optimization, N+1 prevention, TDD migrations, modern DB libs. Calls apollo for discovery, sends to themis. |
| @gaia | Remote sensing domain specialist — satellite image processing, spectral analysis, SAR, change detection, time series, ML/DL classification. Read-only analysis of geospatial data. |
| @hephaestus | AI tooling & pipelines specialist — LangChain/LangGraph chains, RAG architecture, vector stores, embedding strategies. Forges AI infrastructure. Calls apollo, sends to themis. |
| @hermes | Backend specialist — FastAPI, Python, async, TDD (RED→GREEN→REFACTOR), modern Python stdlib, obsolete lib detection. Calls apollo for discovery, sends to themis. |
| @iris | GitHub operations specialist — branches, pull requests, issues, releases, tags. Called by zeus after review. Never pushes or merges without explicit human approval. Integrates with VS Code GitHub Pull Requests extension. |
| @mnemosyne | Memory bank quality owner — initializes .pantheon/memory-bank/, writes ADRs and task records on explicit request. Called by zeus. Never invoked automatically after phases. |
| @nyx | Observability & monitoring specialist — OpenTelemetry tracing, token/cost tracking, agent performance analytics, LangSmith integration. Calls apollo for discovery, sends to themis. |
| @prometheus | Infrastructure + model provider specialist — Docker, CI/CD, multi-model routing, cost optimization, provider abstraction |
| @talos | Hotfix express lane — direct fixes for small bugs, CSS, typos, minor logic. No TDD ceremony, no orchestration overhead. Standalone, no subagents. Escalates complex issues to zeus. |
| @themis | Quality & security gate — ruff/Biome linting, dead/legacy code detection, OWASP Top 10, coverage >80%, correctness, deprecation audit. Called by implementers; escalates blockers to zeus. |
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

- TDD: Write failing test first, then implement
- Coverage minimum: 80%
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
 * Only the `name` field is extracted (single-line scalar). The frontmatter
 * block itself is stripped from the embedded body.
 *
 * @param {string} content - Raw file content
 * @returns {{ name: string, body: string } | null}
 */
function parseInstruction(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return null
  const fm = match[1]
  const nameMatch = fm.match(/^name:\s*["']?([^"'\r\n]+)["']?\s*$/m)
  if (!nameMatch) return null
  return {
    name: nameMatch[1].trim(),
    body: content.slice(match[0].length).trimEnd() + '\n',
  }
}

/**
 * Read all src/instructions/*.instructions.md files, sorted by filename for
 * deterministic output.
 *
 * @returns {Array<{ file: string, name: string, body: string }>}
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
 * @param {Array<{ file: string, name: string, body: string }>} instructions
 * @returns {string}
 */
export function generateAgentsMd(instructions) {
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
    '`instructions` config key) receive identical instruction content.',
    '',
  ]
  for (const instr of instructions) {
    sections.push(
      `<!-- Source: src/instructions/${instr.file} -->`,
      `## ${instr.name}`,
      '',
      instr.body.trimEnd(),
      '',
    )
  }
  return sections.join('\n').trimEnd() + '\n'
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main() {
  const checkOnly = process.argv.includes('--check')
  const instructions = readInstructions()
  const content = generateAgentsMd(instructions)

  if (checkOnly) {
    const existing = existsSync(AGENTS_MD_PATH) ? readFileSync(AGENTS_MD_PATH, 'utf8') : ''
    if (existing !== content) {
      console.error(`❌ AGENTS.md is stale — run: node scripts/build-agents-md.mjs`)
      process.exit(1)
    }
    console.log(`✅ AGENTS.md is up to date (${instructions.length} instruction sections)`)
    return
  }

  writeFileSync(AGENTS_MD_PATH, content, 'utf8')
  const lines = content.split('\n').length
  console.log(
    `✅ Generated AGENTS.md (${instructions.length} instruction sections, ${lines} lines)`,
  )
}

main()
