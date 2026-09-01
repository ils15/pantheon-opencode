import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (relativePath) => JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'))

test('plugin manifest paths resolve to published source directories', () => {
  const manifest = readJson('plugin.json')

  for (const field of ['agents', 'skills', 'instructions', 'prompts']) {
    assert.equal(typeof manifest[field], 'string')
    assert.ok(
      existsSync(join(ROOT, manifest[field].replace(/^\.\//, ''))),
      `${field} path must exist in the package: ${manifest[field]}`,
    )
  }
  assert.equal(manifest.agents, './src/agents')
  assert.equal(manifest.skills, './src/skills')
  assert.equal(manifest.instructions, './src/instructions')
})

test('package allow-list contains manifests, plugin entrypoints, and TUI payload', () => {
  const packageJson = readJson('package.json')
  const tuiPackage = readJson('src/plugins/tui/package.json')

  assert.ok(packageJson.files.includes('plugin.json'))
  for (const [exportName, target] of Object.entries(packageJson.exports)) {
    assert.ok(exportName === './plugin' || exportName === './plugin-v2')
    assert.ok(existsSync(join(ROOT, target.replace(/^\.\//, ''))), `${exportName} target exists`)
  }
  for (const target of ['./dist/tui.js', './dist/server.js']) {
    assert.ok(
      existsSync(join(ROOT, 'src/plugins/tui', target)),
      `TUI export target exists: ${target}`,
    )
  }
  assert.ok(packageJson.files.includes('src/plugin.ts'))
  assert.ok(packageJson.files.includes('src/plugin-v2.ts'))
  assert.ok(packageJson.files.includes('src/plugins/tui/**'))
  assert.equal(tuiPackage.exports['./tui'], './dist/tui.js')
  assert.equal(tuiPackage.exports['./server'], './dist/server.js')
})
