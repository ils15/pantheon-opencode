import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/docs-check-cookbook.mjs')
const tempDirs = []

function makeTempRepo({
  version = '2.2.0',
  serverCommands = ['pantheon', 'pantheon-forge'],
  tuiCommands = ['pantheon-cockpit'],
  cookbookEn = '',
  cookbookPt = '',
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-cookbook-check-'))
  tempDirs.push(dir)
  mkdirSync(join(dir, 'src/plugins/tui/src'), { recursive: true })
  mkdirSync(join(dir, 'docs/guides'), { recursive: true })
  mkdirSync(join(dir, 'docs/pt-BR/guides'), { recursive: true })

  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pantheon-opencode', version }))
  writeFileSync(
    join(dir, 'src/plugin.ts'),
    `const CANONICAL_SLASH_COMMANDS = [\n${serverCommands
      .map((name) => `  { name: '${name}', description: 'desc' },`)
      .join('\n')}\n]\n`,
  )
  writeFileSync(
    join(dir, 'src/plugins/tui/src/index.tsx'),
    `function PantheonSettingsCommandLayer() {\n  const cmds = [\n${tuiCommands
      .map((name) => `    { slash: { name: '${name}' } },`)
      .join('\n')}\n  ]\n}\n`,
  )
  writeFileSync(join(dir, 'docs/guides/cookbook.md'), cookbookEn)
  writeFileSync(join(dir, 'docs/pt-BR/guides/cookbook.md'), cookbookPt)
  return dir
}

const VALID_BODY = `
<!-- pantheon:cookbook-version v2.2 -->
Uses /pantheon, /pantheon-forge, /pantheon-cockpit,
ast_search, ast_rewrite, hashline_edit, pantheon_step_ledger,
pantheon_worktree, pantheon_review_verdict, detect_stack,
pantheon_agent_forge, memory_search, APPROVE, APPROVE_WITH_NOTES, BLOCK.
`

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

describe('scripts/docs-check-cookbook.mjs', () => {
  test('passes on synchronized EN and pt-BR cookbooks', async () => {
    const { checkCookbookParity } = await import(SCRIPT)
    const dir = makeTempRepo({ cookbookEn: VALID_BODY, cookbookPt: VALID_BODY })
    const result = checkCookbookParity(dir)
    assert.deepEqual(result.findings, [])
    assert.deepEqual(result.discoveredCommands.sort(), [
      'pantheon',
      'pantheon-cockpit',
      'pantheon-forge',
    ])
  })

  test('fails when package.json minor version advances without cookbook version bump', async () => {
    const { checkCookbookParity } = await import(SCRIPT)
    const dir = makeTempRepo({
      version: '2.3.0',
      cookbookEn: VALID_BODY,
      cookbookPt: VALID_BODY,
    })
    const result = checkCookbookParity(dir)
    assert.ok(result.findings.some((f) => /cookbook-version v2\.3/.test(f)))
  })

  test('fails when a new server or TUI slash command is missing from either cookbook', async () => {
    const { checkCookbookParity } = await import(SCRIPT)
    const dir = makeTempRepo({
      serverCommands: ['pantheon', 'pantheon-forge', 'pantheon-new-cmd'],
      tuiCommands: ['pantheon-cockpit'],
      cookbookEn: `${VALID_BODY}\n/pantheon-new-cmd`,
      cookbookPt: VALID_BODY,
    })
    const result = checkCookbookParity(dir)
    assert.ok(result.findings.some((f) => f.includes('pt-BR') && f.includes('/pantheon-new-cmd')))
  })

  test('fails when obsolete PASS_WITH_NOTES verdict marker appears', async () => {
    const { checkCookbookParity } = await import(SCRIPT)
    const dir = makeTempRepo({
      cookbookEn: `${VALID_BODY}\nVerdict: PASS_WITH_NOTES`,
      cookbookPt: VALID_BODY,
    })
    const result = checkCookbookParity(dir)
    assert.ok(result.findings.some((f) => f.includes('PASS_WITH_NOTES')))
  })

  test('repository cookbooks satisfy full CI parity check', () => {
    const output = execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' })
    assert.match(output, /docs:check-cookbook OK/)
  })
})
