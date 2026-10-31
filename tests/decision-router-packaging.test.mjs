import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { buildDecisionRouterBudget } from '../scripts/build-decision-router.mjs'

const ROOT = process.cwd()
const CLI = join(ROOT, 'scripts', 'decision-router.mjs')
const BUNDLE = join(ROOT, 'scripts', 'decision-router-budget.mjs')

/** Relative TypeScript specifiers that Node cannot load from a published .mjs. */
function relativeTypeScriptImports(text) {
  return [...text.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.{1,2}\/[^'"]+\.ts)['"]/g)].map(
    (match) => match[1],
  )
}

test('published decision-router CLI has no TypeScript import', () => {
  const cli = readFileSync(CLI, 'utf8')
  assert.deepEqual(relativeTypeScriptImports(cli), [])
  assert.ok(existsSync(BUNDLE), 'the committed ESM ledger bundle must ship with the CLI')
  assert.deepEqual(relativeTypeScriptImports(readFileSync(BUNDLE, 'utf8')), [])
})

test('committed ledger bundle matches a fresh build', async () => {
  const rebuilt = await buildDecisionRouterBudget({ outfile: BUNDLE })
  assert.equal(
    readFileSync(BUNDLE, 'utf8'),
    rebuilt,
    'run `npm run build:decision-router` and commit the regenerated bundle',
  )
})

test('CLI runs from an installed package layout inside node_modules', () => {
  const work = mkdtempSync(join(tmpdir(), 'pantheon-decision-install-'))
  const packageRoot = join(work, 'node_modules', 'pantheon-opencode')
  const home = join(work, 'home')
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_STATE_HOME: join(home, 'state'),
  }
  try {
    for (const rel of [
      'scripts/decision-router.mjs',
      'scripts/decision-router-budget.mjs',
      'scripts/install/decision-router-config.mjs',
      'scripts/install/verify.mjs',
    ]) {
      const target = join(packageRoot, rel)
      mkdirSync(dirname(target), { recursive: true })
      cpSync(join(ROOT, rel), target)
    }
    mkdirSync(home, { recursive: true })

    const run = (args) =>
      spawnSync(process.execPath, [join(packageRoot, 'scripts', 'decision-router.mjs'), ...args], {
        encoding: 'utf8',
        env,
      })

    const status = run(['status'])
    assert.equal(status.status, 0, status.stderr)
    assert.match(status.stdout, /Enabled: no/)
    assert.doesNotMatch(status.stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/)

    const holds = run(['holds'])
    assert.equal(holds.status, 0, holds.stderr)
    assert.match(holds.stdout, /No unresolved provider holds/)

    const usage = run(['unknown-command'])
    assert.equal(usage.status, 1)
    assert.match(usage.stderr, /Usage: decision-router status\|select\|enable/)
    assert.doesNotMatch(usage.stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
