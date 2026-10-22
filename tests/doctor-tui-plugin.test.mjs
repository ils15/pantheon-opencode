/**
 * doctor-tui-plugin.test.mjs — check H5 (TUI payload + host registration).
 *
 * The TUI is the only component whose failure is silent: a missing payload or
 * a stale tui.json entry leaves the host loading nothing and logging nothing.
 * Each defect must therefore be reported fail-closed, with its own code.
 *
 * Run: node --test tests/doctor-tui-plugin.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkTuiPlugin, resolveTuiInstallPaths } from '../scripts/doctor.mjs'
import { createInitialState, writeState } from '../scripts/install/state.mjs'

process.env.LANG = 'C'
process.env.LC_ALL = 'C'

function projectTarget() {
  return mkdtempSync(join(tmpdir(), 'pantheon-doctor-tui-'))
}

/** Seed an install state that records the plugins component as installed. */
function seedPluginsInstalled(target) {
  const state = createInitialState('1.6.0')
  state.components.plugins = { version: 1, status: 'installed' }
  writeState(target, state)
}

function seedPayload(copyDir, { v1 = true, v2 = false } = {}) {
  mkdirSync(join(copyDir, 'dist'), { recursive: true })
  if (v1) writeFileSync(join(copyDir, 'dist', 'tui.js'), 'export default {}\n')
  if (v2) writeFileSync(join(copyDir, 'dist', 'tui-v2.js'), 'export default {}\n')
  writeFileSync(
    join(copyDir, 'package.json'),
    `${JSON.stringify({ name: 'pantheon-tui', exports: { './tui': v2 ? './dist/tui-v2.js' : './dist/tui.js' } }, null, 2)}\n`,
  )
  writeFileSync(join(copyDir, 'tui.ts'), "export { default } from './dist/tui.js'\n")
}

function writeTuiJson(path, plugin) {
  writeFileSync(path, `${JSON.stringify({ plugin }, null, 2)}\n`)
}

test('my layout resolver mirrors the installer (project target)', async () => {
  const target = projectTarget()
  try {
    const paths = await resolveTuiInstallPaths({ target })
    assert.equal(paths.isGlobal, false)
    assert.equal(paths.configDir, join(target, '.opencode'))
    assert.equal(paths.copyDir, join(target, '.opencode', 'plugins', 'pantheon-tui'))
    assert.equal(paths.tuiJsonPath, join(target, '.opencode', 'tui.json'))
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('a target without the plugins component is skipped, not failed', async () => {
  const target = projectTarget()
  try {
    assert.equal(await checkTuiPlugin({ target }), 'not-installed')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('a plugins component recorded as installed without its payload fails closed', async () => {
  const target = projectTarget()
  try {
    seedPluginsInstalled(target)
    assert.equal(await checkTuiPlugin({ target }), 'missing-dir')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('a copied plugin without a compiled bundle fails closed', async () => {
  const target = projectTarget()
  try {
    seedPluginsInstalled(target)
    const { copyDir } = await resolveTuiInstallPaths({ target })
    mkdirSync(join(copyDir, 'dist'), { recursive: true })
    writeFileSync(join(copyDir, 'tui.ts'), "export { default } from './dist/tui.js'\n")
    assert.equal(await checkTuiPlugin({ target }), 'missing-dist')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('a complete V1 payload that no tui.json references fails closed', async () => {
  const target = projectTarget()
  try {
    seedPluginsInstalled(target)
    const { copyDir } = await resolveTuiInstallPaths({ target })
    seedPayload(copyDir)
    assert.equal(await checkTuiPlugin({ target }), 'unregistered')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('a V1 payload registered by its copied directory passes', async () => {
  const target = projectTarget()
  try {
    seedPluginsInstalled(target)
    const { copyDir, tuiJsonPath } = await resolveTuiInstallPaths({ target })
    seedPayload(copyDir)
    writeTuiJson(tuiJsonPath, [copyDir])
    assert.equal(await checkTuiPlugin({ target }), 'ok')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('a stale Pantheon reference next to the current registration fails closed', async () => {
  const target = projectTarget()
  try {
    seedPluginsInstalled(target)
    const { copyDir, tuiJsonPath } = await resolveTuiInstallPaths({ target })
    seedPayload(copyDir)
    writeTuiJson(tuiJsonPath, [copyDir, 'plugins/pantheon-tui', 'npx -y pantheon-tui'])
    assert.equal(await checkTuiPlugin({ target }), 'stale-ref')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('a V2 payload discovered by the host (no tui.json) passes', async () => {
  const target = projectTarget()
  try {
    seedPluginsInstalled(target)
    const { copyDir } = await resolveTuiInstallPaths({ target })
    seedPayload(copyDir, { v1: true, v2: true })
    writeFileSync(join(copyDir, 'index.ts'), 'export const Pantheon = async () => ({})\n')
    assert.equal(await checkTuiPlugin({ target }), 'ok')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
