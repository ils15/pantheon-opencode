/**
 * rename-safety.test.mjs — the 2.0 v2-nomenclature sweep must stay complete.
 *
 * The 2.0 cycle dropped the `v2` prefix from every module that names current
 * surface (`v2-shell` → `shell`, `plugin-v2` → `plugin`, …). This test pins
 * the result so a new file cannot quietly reintroduce the old names, and so a
 * future reader can see which legacy strings are DELIBERATE (recognition of
 * pre-rename user configs, kept forever for migration).
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

test('no file under src/pantheon keeps a v2- prefix', () => {
  const stale = readdirSync(join(ROOT, 'src', 'pantheon'), { withFileTypes: true })
    .map((entry) => entry.name)
    .filter((name) => name.startsWith('v2-'))
  assert.deepEqual(stale, [], 'v2-prefixed modules must be renamed: drop the prefix')
})

test('no src/plugin-v2* path exists and the current entry ships', () => {
  assert.equal(existsSync(join(ROOT, 'src', 'plugin-v2.ts')), false)
  assert.equal(existsSync(join(ROOT, 'src', 'plugin-v2')), false)
  assert.equal(existsSync(join(ROOT, 'src', 'plugin.ts')), true)
  assert.equal(existsSync(join(ROOT, 'src', 'plugin', 'index.ts')), true)
})

test('the package exports map the canonical and the deprecated alias to one file', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.exports['./plugin'], './src/plugin.ts')
  // Legacy recognition: configs written before the 2.0 rename register
  // pantheon-opencode/plugin-v2; the alias must keep loading until 2.1.
  assert.equal(pkg.exports['./plugin-v2'], './src/plugin.ts')
})
