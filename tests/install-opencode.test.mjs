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
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveInstalledPlugin } from '../scripts/install/opencode.mjs'
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
