/**
 * agents-md-carving.test.mjs — beta-10 Fase 1 (AGENTS.md global/project carve).
 *
 * Contracts under test:
 *   1. The build emits TWO artifacts from one source pass — AGENTS.md
 *      (project-specific) and AGENTS.global.md (repo-agnostic) — with ZERO
 *      content overlap (each rule lives in exactly one file).
 *   2. Both artifacts carry a version header (generated-at + git sha) so a
 *      stale artifact is detectable, and regeneration is byte-deterministic.
 *   3. The managed-region writer used by the installer/sync is conservative:
 *      user content outside the markers is never deleted; legacy generated
 *      files upgrade in place; foreign files are merged, not clobbered.
 *   4. The global artifact carries exactly the shared rules; agent-scoped
 *      rules stay out of it (agent-instruction-routing).
 *
 * Run: node --test tests/agents-md-carving.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  AGENTS_GLOBAL_MD_PATH,
  AGENTS_MD_PATH,
  generateGlobalAgentsMd,
  generateProjectAgentsMd,
  MANAGED_BEGIN,
  MANAGED_END,
  readGitInfo,
  readInstructions,
  stripVersionLine,
  writeAgentsMdManaged,
} from '../scripts/build-agents-md.mjs'

const GIT = { sha: 'deadbee', date: '2026-10-14T12:00:00-03:00' }

// ─── 1. Dual artifacts from one source pass ──────────────────────────────

test('both artifacts exist in the repo and carry the managed region', () => {
  assert.equal(existsSync(AGENTS_MD_PATH), true, 'project artifact committed')
  assert.equal(existsSync(AGENTS_GLOBAL_MD_PATH), true, 'global artifact committed')
  for (const path of [AGENTS_MD_PATH, AGENTS_GLOBAL_MD_PATH]) {
    const content = readFileSync(path, 'utf8')
    assert.ok(content.includes(MANAGED_BEGIN), `managed begin in ${path}`)
    assert.ok(content.includes(MANAGED_END), `managed end in ${path}`)
    assert.ok(content.indexOf(MANAGED_BEGIN) < content.indexOf(MANAGED_END))
  }
})

test('regeneration is byte-deterministic and matches the committed artifacts', () => {
  const instructions = readInstructions()
  const git = readGitInfo()
  const first = {
    global: generateGlobalAgentsMd(instructions, git),
    project: generateProjectAgentsMd(git),
  }
  const second = {
    global: generateGlobalAgentsMd(instructions, git),
    project: generateProjectAgentsMd(git),
  }
  assert.equal(first.global, second.global, 'global artifact is byte-stable')
  assert.equal(first.project, second.project, 'project artifact is byte-stable')
  assert.equal(
    stripVersionLine(readFileSync(AGENTS_GLOBAL_MD_PATH, 'utf8')),
    stripVersionLine(first.global),
    'committed global artifact matches the generator (version line aside)',
  )
  assert.equal(
    stripVersionLine(readFileSync(AGENTS_MD_PATH, 'utf8')),
    stripVersionLine(first.project),
    'committed project artifact matches the generator (version line aside)',
  )
})

test('version header is present in both artifacts and is stale-detectable', () => {
  const global = generateGlobalAgentsMd(readInstructions(), GIT)
  const project = generateProjectAgentsMd(GIT)
  for (const [name, content] of [
    ['global', global],
    ['project', project],
  ]) {
    assert.match(
      content,
      new RegExp(
        `^<!-- pantheon:agents-md v2 artifact=${name} generated-at=${GIT.date} sha=${GIT.sha} -->$`,
        'm',
      ),
      `version header in ${name} artifact`,
    )
  }
})

// ─── 2. Disjoint carving: zero overlap between the two artifacts ─────────

/** Drop comments, sentinels, blanks and trivially short lines. */
function contentLines(content) {
  return new Set(
    content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length >= 15)
      .filter((line) => !line.startsWith('<!--')),
  )
}

test('the global and project artifacts share ZERO content lines', () => {
  const globalLines = contentLines(readFileSync(AGENTS_GLOBAL_MD_PATH, 'utf8'))
  const projectLines = contentLines(readFileSync(AGENTS_MD_PATH, 'utf8'))
  const overlap = [...globalLines].filter((line) => projectLines.has(line))
  assert.deepEqual(overlap, [], `overlap lines: ${overlap.slice(0, 5).join(' | ')}`)
})

test('global artifact: agent table + shared rules, no repo-specific setup', () => {
  const global = readFileSync(AGENTS_GLOBAL_MD_PATH, 'utf8')
  assert.ok(global.includes('## Available Agents'), 'agent table stays global')
  assert.ok(global.includes('## Agent Return Format'))
  assert.ok(global.includes('## Memory Protocol'))
  assert.ok(global.includes('## YAGNI Anti-overengineering'))
  assert.ok(global.includes('## Zeus Communication Rules'))
  assert.ok(!global.includes('npm test'), 'no repo build commands in global')
  assert.ok(!global.includes('pantheon-sandbox'), 'no sandbox rules in global')
  assert.ok(!global.includes('## Conventions'), 'repo conventions stay project-side')
})

test('project artifact: repo-specific setup only, no shared rule bodies', () => {
  const project = readFileSync(AGENTS_MD_PATH, 'utf8')
  assert.ok(project.includes('## OpenCode Setup'), 'repo setup stays project-side')
  assert.ok(project.includes('## Teste de Instalação Global (sandbox)'))
  assert.ok(project.includes('## Conventions'))
  assert.ok(!project.includes('## Available Agents'), 'agent table is not duplicated')
  assert.ok(!project.includes('## Agent Return Format'))
  assert.ok(!project.includes('## Memory Protocol'))
  assert.ok(!project.includes('## YAGNI Anti-overengineering'))
  assert.ok(!project.includes('## Zeus Communication Rules'))
})

test('global artifact excludes every agent-scoped instruction body', () => {
  const global = readFileSync(AGENTS_GLOBAL_MD_PATH, 'utf8')
  assert.ok(!global.includes('Backend Development Standards (Hermes)'))
  assert.ok(!global.includes('Frontend Development Standards (Aphrodite)'))
  assert.ok(!global.includes('INLINE COUNCIL SYNTHESIS'))
  assert.ok(!global.includes('STALL DETECTION'))
})

test('carving shrinks the per-session instruction payload', () => {
  const globalBytes = Buffer.byteLength(readFileSync(AGENTS_GLOBAL_MD_PATH, 'utf8'))
  const projectBytes = Buffer.byteLength(readFileSync(AGENTS_MD_PATH, 'utf8'))
  // The stale double-copy baseline was ~23.4KB across both files; the carve
  // must remove the duplicated shared-rule body from the project artifact.
  assert.ok(projectBytes < 4_000, `project artifact is ${projectBytes} bytes (want < 4KB)`)
  assert.ok(globalBytes < 14_000, `global artifact is ${globalBytes} bytes (want < 14KB)`)
  assert.ok(
    globalBytes + projectBytes < 16_000,
    `combined payload is ${globalBytes + projectBytes} bytes (was ~23.4KB duplicated)`,
  )
})

// ─── 3. Managed-region writer (installer/sync semantics) ────────────────

test('writer: fresh target is created with exactly the generated content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-carve-'))
  try {
    const target = join(dir, 'AGENTS.md')
    const generated = generateGlobalAgentsMd(readInstructions(), GIT)
    assert.equal(writeAgentsMdManaged(target, generated, false), 'created')
    assert.equal(readFileSync(target, 'utf8'), generated)
    assert.equal(writeAgentsMdManaged(target, generated, false), 'skipped', 'idempotent')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writer: user content around the managed region is preserved on refresh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-carve-'))
  try {
    const target = join(dir, 'AGENTS.md')
    const prefix = '# My project rules\n\nAlways answer in French.\n\n'
    const suffix = '\n## Team addendum\n\nNever deploy on Fridays.\n'
    const stale = `${prefix}${generateProjectAgentsMd({ sha: 'oldold1', date: '2026-01-01T00:00:00Z' })}${suffix}`
    writeFileSync(target, stale)
    const fresh = generateProjectAgentsMd(GIT)
    assert.equal(writeAgentsMdManaged(target, fresh, false), 'merged')
    const result = readFileSync(target, 'utf8')
    assert.ok(result.startsWith(prefix), 'user prefix preserved verbatim')
    assert.ok(result.endsWith(suffix), 'user suffix preserved verbatim')
    assert.ok(result.includes(`sha=${GIT.sha}`), 'managed region refreshed')
    assert.ok(!result.includes('sha=oldold1'), 'stale region gone')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writer: legacy stale generated file upgrades in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-carve-'))
  try {
    const target = join(dir, 'AGENTS.md')
    writeFileSync(
      target,
      '<!-- Generated by scripts/build-agents-md.mjs — do not edit directly. -->\n# Pantheon Agent System — OpenCode\n\nstale full copy\n',
    )
    const generated = generateGlobalAgentsMd(readInstructions(), GIT)
    assert.equal(writeAgentsMdManaged(target, generated, false), 'upgraded')
    assert.equal(readFileSync(target, 'utf8'), generated)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writer: a foreign (non-Pantheon) file is merged, never clobbered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-carve-'))
  try {
    const target = join(dir, 'AGENTS.md')
    const foreign = '# My own agent rules\n\nBe concise.\n'
    writeFileSync(target, foreign)
    const generated = generateGlobalAgentsMd(readInstructions(), GIT)
    assert.equal(writeAgentsMdManaged(target, generated, false), 'merged')
    const result = readFileSync(target, 'utf8')
    assert.ok(result.startsWith(foreign), 'foreign content kept verbatim at the top')
    assert.ok(result.includes(MANAGED_BEGIN), 'managed region appended below')
    assert.ok(result.includes('## YAGNI Anti-overengineering'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writer: dry-run never writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-carve-'))
  try {
    const target = join(dir, 'AGENTS.md')
    assert.equal(writeAgentsMdManaged(target, generateProjectAgentsMd(GIT), true), 'created')
    assert.equal(existsSync(target), false, 'no file written on dry-run')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── 4. Installer integration (global layout) ────────────────────────────

test('installer instructions component emits the global artifact into a global config dir', async () => {
  const { installOpenCode } = await import('../scripts/install/opencode.mjs')
  const home = mkdtempSync(join(tmpdir(), 'pantheon-carve-xdg-'))
  const previousXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = home
  const target = join(home, 'opencode')
  try {
    // Legacy stale global: the installer must upgrade it, not skip it.
    mkdirSync(target, { recursive: true })
    writeFileSync(
      join(target, 'AGENTS.md'),
      '<!-- Generated by scripts/build-agents-md.mjs — do not edit directly. -->\nstale\n',
    )
    await installOpenCode(target, false, false, ['instructions'], {
      yes: true,
      headless: true,
      version: 'v1',
    })
    const installed = readFileSync(join(target, 'AGENTS.md'), 'utf8')
    assert.equal(
      stripVersionLine(installed),
      stripVersionLine(generateGlobalAgentsMd(readInstructions(), readGitInfo())),
      'global config dir receives the global artifact',
    )
    assert.ok(installed.includes('## Available Agents'))
    assert.ok(!installed.includes('pantheon-sandbox'), 'no project content in global install')
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
    rmSync(home, { recursive: true, force: true })
  }
})

test('installer instructions component preserves user content in a global config dir', async () => {
  const { installOpenCode } = await import('../scripts/install/opencode.mjs')
  const home = mkdtempSync(join(tmpdir(), 'pantheon-carve-xdg2-'))
  const previousXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = home
  const target = join(home, 'opencode')
  try {
    const custom = '# House rules\n\nLog every decision.\n\n'
    mkdirSync(target, { recursive: true })
    writeFileSync(
      join(target, 'AGENTS.md'),
      `${custom}<!-- pantheon:generated:begin placeholder -->\nold region\n<!-- pantheon:generated:end placeholder -->\n`,
    )
    await installOpenCode(target, false, false, ['instructions'], {
      yes: true,
      headless: true,
      version: 'v1',
    })
    const installed = readFileSync(join(target, 'AGENTS.md'), 'utf8')
    assert.ok(installed.startsWith(custom), 'user house rules preserved')
    assert.ok(installed.includes('## YAGNI Anti-overengineering'), 'managed region installed')
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
    rmSync(home, { recursive: true, force: true })
  }
})

test('postinstall artifact sync refreshes the global AGENTS.md from the global artifact', async () => {
  const { syncCopyArtifacts } = await import('../scripts/sync-artifacts.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-carve-sync-'))
  try {
    syncCopyArtifacts(dir)
    const installed = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    assert.equal(
      stripVersionLine(installed),
      stripVersionLine(readFileSync(AGENTS_GLOBAL_MD_PATH, 'utf8')),
      'config dir AGENTS.md mirrors AGENTS.global.md, not the project artifact',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
