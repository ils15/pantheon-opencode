/**
 * Adversarial tests for the installer's TUI cleanup markers.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  copyPluginFiles,
  isPantheonTuiRef,
  staleTuiRefs,
  unregisterPlugin,
} from '../scripts/install/plugin.mjs'
import { ROOT } from '../scripts/install/shared.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const THIRD_PARTY_TUI = '/tmp/acme/pantheon-opencode/plugins/pantheon-tui'
const THIRD_PARTY_SOURCE = '/tmp/acme/pantheon-opencode/src/plugins/tui'
const THIRD_PARTY_NODE_MODULE = '/tmp/acme/pantheon-opencode/node_modules/pantheon-tui'

test('TUI cleanup does not classify third-party paths by basename or path text', () => {
  for (const ref of [THIRD_PARTY_TUI, THIRD_PARTY_SOURCE, THIRD_PARTY_NODE_MODULE]) {
    assert.equal(isPantheonTuiRef(ref), false, `third-party path was classified as managed: ${ref}`)
  }

  assert.equal(isPantheonTuiRef(join(ROOT, 'src', 'plugins', 'tui')), true)
  assert.equal(isPantheonTuiRef('plugins/pantheon-tui'), true)
  assert.equal(isPantheonTuiRef('npx pantheon-tui'), true)
})

test('TUI cleanup accepts an explicit absolute path created by this installer', () => {
  const ownedPath = '/tmp/project/.opencode/plugins/pantheon-tui'
  assert.equal(isPantheonTuiRef(ownedPath), false)
  assert.equal(isPantheonTuiRef(ownedPath, [ownedPath]), true)
  assert.equal(isPantheonTuiRef(`${ownedPath}\\dist\\tui.js`, [`${ownedPath}\\dist\\tui.js`]), true)
})

test('staleTuiRefs only returns exact installer markers', () => {
  const refs = [
    'plugins/pantheon-tui',
    'plugins/pantheon-tui/dist/tui.js',
    'npx -y pantheon-tui',
    THIRD_PARTY_TUI,
    THIRD_PARTY_SOURCE,
    THIRD_PARTY_NODE_MODULE,
    'npx --package pantheon-tui unrelated-command',
  ]

  assert.deepEqual(staleTuiRefs(refs), refs.slice(0, 3))
})

test('unregisterPlugin preserves unmanaged paths containing pantheon-opencode', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-plugin-cleanup-'))
  const configPath = join(target, 'tui.json')
  const ownedPath = join(target, 'plugins', 'pantheon-tui')
  const config = {
    plugin: [
      'plugins/pantheon-tui',
      'plugins/pantheon-tui/dist/tui.js',
      ownedPath,
      THIRD_PARTY_TUI,
      THIRD_PARTY_SOURCE,
      THIRD_PARTY_NODE_MODULE,
      'npx pantheon-tui',
      'npx --package pantheon-tui unrelated-command',
    ],
  }

  try {
    writeFileSync(configPath, `${JSON.stringify(config)}\n`)
    unregisterPlugin(configPath, 'plugins/pantheon-tui', { knownPantheonPaths: [ownedPath] })
    const cleaned = JSON.parse(readFileSync(configPath, 'utf8'))

    assert.deepEqual(cleaned.plugin, [
      THIRD_PARTY_TUI,
      THIRD_PARTY_SOURCE,
      THIRD_PARTY_NODE_MODULE,
      'npx --package pantheon-tui unrelated-command',
    ])
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 TUI entry retains the legacy plugin setup contract', () => {
  const source = readFileSync(join(REPO_ROOT, 'src', 'plugins', 'tui', 'src', 'index.tsx'), 'utf8')
  assert.match(source, /setup:\s*async\s*\(\)\s*=>\s*\{\}/)
  assert.match(source, /id:\s*['"]pantheon\.tui['"]/)
  const dist = join(REPO_ROOT, 'src', 'plugins', 'tui', 'dist', 'tui.js')
  assert.ok(existsSync(dist), `TUI dist must exist: ${dist}`)
  assert.match(readFileSync(dist, 'utf8'), /setup/)
  const tuiEntrypoint = readFileSync(join(REPO_ROOT, 'src', 'plugins', 'tui', 'tui.ts'), 'utf8')
  assert.match(tuiEntrypoint, /export\s+\{\s*default\s*\}\s+from\s+['"]\.\/dist\/tui\.js['"];?/)
})

test('V2 install selects the V2 TUI API and V1 reinstall removes that entrypoint', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-tui-generation-'))
  const source = join(REPO_ROOT, 'src', 'plugins', 'tui')
  try {
    copyPluginFiles(source, target, { version: 'v2' })
    assert.equal(
      readFileSync(join(target, 'tui.ts'), 'utf8'),
      readFileSync(join(source, 'tui-v2.ts'), 'utf8'),
    )
    assert.equal(
      readFileSync(join(target, 'index.ts'), 'utf8'),
      readFileSync(join(source, 'index-v2.ts'), 'utf8'),
    )
    const v2Package = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    assert.equal(v2Package.exports['./tui'], './dist/tui-v2.js')
    assert.match(readFileSync(join(target, 'dist', 'tui-v2.js'), 'utf8'), /sidebar\.content/)
    assert.match(readFileSync(join(target, 'dist', 'tui-v2.js'), 'utf8'), /@opencode\/plugin\/tui/)

    copyPluginFiles(source, target, { version: 'v1' })
    assert.equal(existsSync(join(target, 'index.ts')), false)
    assert.equal(
      readFileSync(join(target, 'tui.ts'), 'utf8'),
      readFileSync(join(source, 'tui.ts'), 'utf8'),
    )
    const v1Package = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    assert.equal(v1Package.exports['./tui'], './dist/tui.js')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('plugin legacy cleanup rejects a symlinked destination parent without touching outside files', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-plugin-linked-parent-'))
  const outside = join(target, 'outside')
  const linkedPlugins = join(target, 'plugins')
  const pluginDir = join(linkedPlugins, 'pantheon-tui')
  const sentinel = join(outside, 'pantheon-tui', 'index.tsx')
  const before = 'outside legacy plugin source'
  mkdirSync(join(outside, 'pantheon-tui'), { recursive: true })
  writeFileSync(sentinel, before)
  symlinkSync(outside, linkedPlugins, 'dir')

  try {
    assert.throws(() => copyPluginFiles(join(ROOT, 'src', 'plugins', 'tui'), pluginDir), /symlink/i)
    assert.equal(readFileSync(sentinel, 'utf8'), before)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('force plugin cleanup rejects a symlinked destination parent without deleting outside data', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-plugin-force-linked-'))
  const bin = join(target, 'bin')
  const outside = join(target, 'outside')
  const linkedPlugins = join(target, 'plugins')
  const pluginDir = join(linkedPlugins, 'pantheon-tui')
  const sentinel = join(outside, 'pantheon-tui', 'user-data')
  const before = 'preserve outside plugin data'
  mkdirSync(bin)
  mkdirSync(join(outside, 'pantheon-tui'), { recursive: true })
  writeFileSync(sentinel, before)
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'npm'), 0o755)
  symlinkSync(outside, linkedPlugins, 'dir')

  try {
    const code = `import { installPlugin } from ${JSON.stringify(new URL('../scripts/install/plugin.mjs', import.meta.url).href)}; installPlugin(${JSON.stringify(join(ROOT, 'src', 'plugins', 'tui'))}, ${JSON.stringify(pluginDir)}, { clean: true });`
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
    })
    assert.notEqual(result.status, 0, result.stdout + result.stderr)
    assert.equal(readFileSync(sentinel, 'utf8'), before)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('npm package tarball includes both host TUI entrypoints', () => {
  const packageDir = join(REPO_ROOT, 'src', 'plugins', 'tui')
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: packageDir,
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  const [packed] = JSON.parse(result.stdout)
  assert.ok(
    packed.files.some((file) => file.path === 'tui.ts'),
    'the published TUI package must contain the V1 tui.ts entrypoint',
  )
  assert.ok(
    packed.files.some((file) => file.path === 'tui-v2.ts'),
    'the published TUI package must contain the V2 tui-v2.ts entrypoint',
  )
  assert.ok(
    packed.files.some((file) => file.path === 'index-v2.ts'),
    'the published TUI package must contain the V2 local plugin entrypoint',
  )
})

test('plugin installation propagates npm ci failure and never invokes npm install', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-plugin-install-'))
  const bin = join(target, 'bin')
  const log = join(target, 'npm.log')
  const dst = join(target, 'plugin')
  mkdirSync(bin)
  const npm = join(bin, 'npm')
  writeFileSync(npm, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$FAKE_NPM_LOG"\nexit 29\n`)
  chmodSync(npm, 0o755)
  try {
    const code = `import { installPlugin } from ${JSON.stringify(new URL('../scripts/install/plugin.mjs', import.meta.url).href)}; installPlugin(${JSON.stringify(join(REPO_ROOT, 'src', 'plugins', 'tui'))}, ${JSON.stringify(dst)});`
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        FAKE_NPM_LOG: log,
        PANTHEON_ALLOW_NPM_INSTALL_FALLBACK: '1',
      },
    })
    assert.notEqual(result.status, 0, result.stdout + result.stderr)
    const calls = readFileSync(log, 'utf8').trim().split('\n')
    assert.equal(calls.length, 1)
    assert.match(calls[0], /^ci /)
    assert.doesNotMatch(calls[0], /install/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
