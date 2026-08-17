/**
 * install-opencode.test.mjs — TDD tests for the Hermetic plugin resolution in
 * scripts/install/opencode.mjs (resolveInstalledPlugin).
 *
 * Validates the packaging fix for PR #45 (delegation plugin at package root):
 *  - plugin ref `src/plugin.ts` (registered in the packaged opencode.json)
 *    resolves to <ROOT>/src/plugin.ts inside the INSTALLED package, never a
 *    developer-machine absolute path
 *  - `src/plugins/*` refs (pantheon-hooks) keep resolving to the package
 *  - non-src plugin refs (npm specs, etc.) pass through unchanged
 *
 * Run: node --test tests/install-opencode.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { installOpenCode, resolveInstalledPlugin } from '../scripts/install/opencode.mjs'
import { ROOT } from '../scripts/install/shared.mjs'

// Simulates the developer machine path being baked into the packaged config
// (the REAL dev path differs per machine — this one must never appear in
// resolver output regardless of the machine running the test).
const FOREIGN_DEV_PATH = '/home/otherdev/pantheon'

test('resolveInstalledPlugin maps root-level src/plugin.ts into the installed package', () => {
  const result = resolveInstalledPlugin(`${FOREIGN_DEV_PATH}/src/plugin.ts`)
  assert.equal(result, join(ROOT, 'src', 'plugin.ts'))
  assert.ok(!result.startsWith(FOREIGN_DEV_PATH), 'must not leak the developer path')
})

test('resolveInstalledPlugin maps relative src/plugin.ts into the installed package', () => {
  const result = resolveInstalledPlugin('src/plugin.ts')
  assert.equal(result, join(ROOT, 'src', 'plugin.ts'))
})

test('resolveInstalledPlugin still maps src/plugins/* hooks plugin into the installed package', () => {
  const result = resolveInstalledPlugin(`${FOREIGN_DEV_PATH}/src/plugins/pantheon-hooks.ts`)
  assert.equal(result, join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts'))
})

test('resolveInstalledPlugin never emits a developer-machine absolute path', () => {
  for (const ref of [
    `${FOREIGN_DEV_PATH}/src/plugin.ts`,
    `${FOREIGN_DEV_PATH}/src/plugins/pantheon-hooks.ts`,
    'src/plugin.ts',
    'src/plugins/pantheon-hooks.ts',
  ]) {
    const result = resolveInstalledPlugin(ref)
    assert.ok(
      !result.includes(FOREIGN_DEV_PATH),
      `leaked developer path for ref ${ref}: got ${result}`,
    )
  }
})

test('resolved plugin paths exist inside the package (ROOT-derived, not stale refs)', () => {
  for (const ref of ['src/plugin.ts', 'src/plugins/pantheon-hooks.ts']) {
    const result = resolveInstalledPlugin(ref)
    assert.ok(result.startsWith(join(ROOT, 'src')), `expected ROOT-derived path, got ${result}`)
    assert.ok(existsSync(result), `resolved path does not exist in package: ${result}`)
  }
})

test('resolveInstalledPlugin passes through non-src plugin refs unchanged', () => {
  assert.equal(resolveInstalledPlugin('@scope/custom-plugin'), '@scope/custom-plugin')
  assert.equal(resolveInstalledPlugin('pantheon-hooks'), 'pantheon-hooks')
})

// ─── End-to-end config merge (installOpenCode into temp dirs) ──────────────
// Exercises the full installer config pipeline: plugin registration, the
// instructions merge (section D) and the model/small_model merge. The
// 'runtime' component is excluded so no venv/health-check side effects run.

const COMPONENTS = ['agents', 'skills', 'instructions', 'commands', 'plugins']

/** Run a real (non-dry-run) install into `target`, optionally seeding an
 * existing opencode.json first. Returns the merged config. */
async function runInstall(target, existingConfig = null) {
  if (existingConfig !== null) {
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'opencode.json'), JSON.stringify(existingConfig, null, 2))
  }
  await installOpenCode(target, false, false, COMPONENTS, { yes: true, headless: true })
  return JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8'))
}

test('fresh install registers BOTH pantheon plugins (plugin.ts + pantheon-hooks.ts)', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-fresh-'))
  try {
    const config = await runInstall(target)
    assert.ok(Array.isArray(config.plugin), 'config.plugin must be an array')
    assert.ok(
      config.plugin.includes(join(ROOT, 'src', 'plugin.ts')),
      `delegation plugin missing from fresh install: ${JSON.stringify(config.plugin)}`,
    )
    assert.ok(
      config.plugin.includes(join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts')),
      `hooks plugin missing from fresh install: ${JSON.stringify(config.plugin)}`,
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('fresh install instructions key is exactly [AGENTS.md]', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-instr-'))
  try {
    const config = await runInstall(target)
    assert.deepEqual(config.instructions, ['AGENTS.md'])
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('upgrade strips stale instructions globs, keeps user entries + AGENTS.md', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-upgrade-'))
  try {
    const config = await runInstall(target, {
      instructions: [
        'AGENTS.md',
        'instructions/*.instructions.md',
        'src/instructions/*.instructions.md',
        'docs/user-guide.md',
      ],
    })
    assert.deepEqual(
      config.instructions,
      ['AGENTS.md', 'docs/user-guide.md'],
      'stale *.instructions.md globs must be stripped, user entries kept',
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('upgrade preserves user plugins and adds both pantheon plugins (dedupe)', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-upgrade-plugins-'))
  try {
    const config = await runInstall(target, {
      plugin: ['@scope/custom-plugin', '/home/otherdev/pantheon/src/plugin.ts'],
    })
    assert.ok(config.plugin.includes('@scope/custom-plugin'), 'user plugin preserved')
    // Stale dev-machine path replaced by the installed-package path.
    assert.ok(
      config.plugin.includes(join(ROOT, 'src', 'plugin.ts')),
      `delegation plugin not re-registered: ${JSON.stringify(config.plugin)}`,
    )
    assert.ok(
      config.plugin.includes(join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts')),
      `hooks plugin not registered: ${JSON.stringify(config.plugin)}`,
    )
    // No duplicate entries for the same plugin file.
    const pluginFiles = config.plugin.map((p) => p.split('/').pop())
    assert.equal(pluginFiles.filter((f) => f === 'plugin.ts').length, 1)
    assert.equal(pluginFiles.filter((f) => f === 'pantheon-hooks.ts').length, 1)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('model + small_model merged from repo config when absent', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-model-'))
  try {
    const config = await runInstall(target, {})
    assert.equal(config.model, 'opencode-go/deepseek-v4-flash')
    assert.equal(config.small_model, 'opencode-go/deepseek-v4-flash')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('user-set model is never overwritten by the merge', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-model-user-'))
  try {
    const config = await runInstall(target, { model: 'user/custom-model' })
    assert.equal(config.model, 'user/custom-model')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
