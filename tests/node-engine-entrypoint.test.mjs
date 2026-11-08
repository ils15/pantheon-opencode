import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

// test:node runs on machines without an OpenCode binary, so the host gate
// could not confirm the generation it writes for. Pin it for this file: every
// install in here targets the only supported host line. Gate-specific tests
// that pass their own env/probe stay deterministic either way.
process.env.OPENCODE_VERSION = 'v2'
const ROOT = resolve(import.meta.dirname, '..')
const CLI = join(ROOT, 'bin', 'pantheon-init.mjs')
const POSTINSTALL = join(ROOT, 'scripts', 'postinstall.mjs')
const SYNC_TUI = join(ROOT, 'scripts', 'sync-tui.mjs')

function snapshotTree(root) {
  const result = new Map()
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'mock-node-version.mjs') continue
      const path = join(directory, entry.name)
      const relative = path.slice(root.length + 1)
      if (entry.isDirectory()) {
        result.set(`${relative}/`, 'directory')
        visit(path)
      } else {
        result.set(relative, readFileSync(path))
      }
    }
  }
  visit(root)
  return result
}

function runScript(script, { version, args = [], cwd, env }) {
  const preload = join(env.TEST_ROOT, 'mock-node-version.mjs')
  writeFileSync(
    preload,
    "Object.defineProperty(process.versions, 'node', { configurable: true, value: process.env.TEST_NODE_VERSION })\n",
  )
  return spawnSync(process.execPath, ['--import', preload, script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...env, TEST_NODE_VERSION: version },
  })
}

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-node-gate-'))
  const home = join(root, 'home')
  const xdg = join(root, 'xdg')
  const config = join(xdg, 'opencode')
  const project = join(root, 'project')
  const npm = join(root, 'npm')
  mkdirSync(config, { recursive: true })
  mkdirSync(project, { recursive: true })
  mkdirSync(npm, { recursive: true })
  writeFileSync(join(config, 'sentinel.json'), '{"untouched":true}\n')
  writeFileSync(join(project, 'sentinel.txt'), 'untouched\n')
  return {
    root,
    config,
    project,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      npm_config_cache: join(npm, 'cache'),
      npm_config_userconfig: join(npm, 'user.npmrc'),
      TEST_ROOT: root,
    },
  }
}

test('postinstall succeeds but skips all config sync on an unsupported Node runtime', () => {
  const sandbox = makeSandbox()
  try {
    const before = snapshotTree(sandbox.root)
    const postinstall = runScript(POSTINSTALL, {
      version: '24.15.0',
      cwd: sandbox.project,
      env: sandbox.env,
    })
    assert.equal(postinstall.status, 0, postinstall.stderr)
    assert.match(postinstall.stderr, /requires Node\.js >= 26\.4\.0/)
    assert.match(postinstall.stderr, /current: 24\.15\.0/)

    const sync = runScript(SYNC_TUI, {
      version: '24.15.0',
      cwd: sandbox.project,
      env: sandbox.env,
    })
    assert.equal(sync.status, 0, sync.stderr)
    assert.deepEqual(snapshotTree(sandbox.root), before)
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true })
  }
})

test('CLI hard-rejects Node 24.15 and 26.3 with manager guidance before setup writes', () => {
  for (const version of ['24.15.0', '26.3.0']) {
    const sandbox = makeSandbox()
    try {
      const before = snapshotTree(sandbox.root)
      const result = runScript(CLI, {
        version,
        args: ['init', '--yes', '--headless'],
        cwd: sandbox.project,
        env: sandbox.env,
      })
      assert.notEqual(result.status, 0, `${version} should be rejected`)
      const output = `${result.stdout}\n${result.stderr}`
      assert.match(output, new RegExp(`requires Node\\.js >= 26\\.4\\.0 \\(current: ${version}\\)`))
      assert.match(output, /nvm install 26\.4\.0/)
      assert.match(output, /fnm install 26\.4\.0/)
      assert.match(output, /volta install node@26\.4\.0/i)
      assert.deepEqual(snapshotTree(sandbox.root), before)
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true })
    }
  }
})

test('CLI accepts Node 26.4 and enters the dry-run setup path without writes', () => {
  const sandbox = makeSandbox()
  try {
    const before = snapshotTree(sandbox.root)
    const result = runScript(CLI, {
      version: '26.4.0',
      args: ['init', '--headless', '--dry-run', '--components', 'agents', '--project'],
      cwd: sandbox.project,
      env: sandbox.env,
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /requires Node\.js >=/)
    assert.match(result.stdout, /DRY RUN|dry run|plan/i)
    assert.deepEqual(snapshotTree(sandbox.root), before)
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true })
  }
})
