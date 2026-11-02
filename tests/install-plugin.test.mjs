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
  installPlugin,
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

test('the TUI entry retains the plugin registration contract', () => {
  const source = readFileSync(join(REPO_ROOT, 'src', 'plugins', 'tui', 'src', 'index.tsx'), 'utf8')
  // The 2.x TUI plugin API surface and the Context sidebar slot the host reads.
  assert.match(source, /from ['"]@opencode\/plugin\/tui['"]/)
  assert.match(source, /append: 'sidebar\.content'/)
  const dist = join(REPO_ROOT, 'src', 'plugins', 'tui', 'dist', 'tui.js')
  assert.ok(existsSync(dist), `TUI dist must exist: ${dist}`)
  assert.match(readFileSync(dist, 'utf8'), /sidebar\.content/)
  const tuiEntrypoint = readFileSync(join(REPO_ROOT, 'src', 'plugins', 'tui', 'tui.ts'), 'utf8')
  assert.match(tuiEntrypoint, /export\s+\{\s*default\s*\}\s+from\s+['"]\.\/dist\/tui\.js['"];?/)
})

test('install copies the canonical TUI entrypoints and package exports verbatim', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-tui-copy-'))
  const source = join(REPO_ROOT, 'src', 'plugins', 'tui')
  try {
    copyPluginFiles(source, target)
    assert.equal(
      readFileSync(join(target, 'tui.ts'), 'utf8'),
      readFileSync(join(source, 'tui.ts'), 'utf8'),
    )
    assert.equal(
      readFileSync(join(target, 'index.ts'), 'utf8'),
      readFileSync(join(source, 'index.ts'), 'utf8'),
    )
    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    // The canonical exports already point at the compiled bundles; the copy
    // keeps them (plus the deprecated ./tui-v2 and ./server-v2 aliases).
    assert.equal(pkg.exports['./tui'], './dist/tui.js')
    assert.equal(pkg.exports['./tui-v2'], './dist/tui.js')
    assert.match(readFileSync(join(target, 'dist', 'tui.js'), 'utf8'), /sidebar\.content/)
    assert.match(readFileSync(join(target, 'dist', 'tui.js'), 'utf8'), /@opencode\/plugin\/tui/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('install copies the ./server export at the server bundle', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-tui-server-'))
  const source = join(REPO_ROOT, 'src', 'plugins', 'tui')
  try {
    copyPluginFiles(source, target)
    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    assert.equal(pkg.exports['./server'], './dist/server.js')
    assert.equal(pkg.exports['./server-v2'], './dist/server.js')
    assert.ok(existsSync(join(target, 'dist', 'server.js')))
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
    packed.files.some((file) => file.path === 'tui.ts'),
    'the published TUI package must contain the tui.ts entrypoint',
  )
  assert.ok(
    packed.files.some((file) => file.path === 'index.ts'),
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

// ---------------------------------------------------------------------------
// The TUI payload must be verifiable end-to-end and must fail closed when the
// packaged bundle is absent (a `tui.ts` that re-exports nothing is not an
// install, it is a plugin the host loads and then cannot resolve).
// ---------------------------------------------------------------------------

/** Run `fn` with a temp HOME/XDG so no real user config is read or written. */
async function withIsolatedHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'pantheon-tui-home-'))
  const xdg = mkdtempSync(join(tmpdir(), 'pantheon-tui-xdg-'))
  const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = xdg
  try {
    return await fn({ home, xdg })
  } finally {
    if (previous.HOME === undefined) delete process.env.HOME
    else process.env.HOME = previous.HOME
    if (previous.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous.XDG_CONFIG_HOME
  }
}

/**
 * Run `fn` with a no-op `npm` first on PATH: the installer's dependency step is
 * an npm ci with a network cost, and the behavior under test is the payload and
 * its registration, not the registry.
 */
async function withFakeNpm(fn) {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-tui-npm-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const npm = join(bin, 'npm')
  writeFileSync(npm, '#!/bin/sh\nexit 0\n')
  chmodSync(npm, 0o755)
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}${delimiter}${previousPath}`
  try {
    return await fn({ root })
  } finally {
    process.env.PATH = previousPath
    rmSync(root, { recursive: true, force: true })
  }
}

test('copyPluginFiles refuses to write an entrypoint for a missing bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-tui-nobundle-'))
  const src = join(root, 'src')
  const dst = join(root, 'dst')
  try {
    mkdirSync(join(src, 'dist'), { recursive: true })
    writeFileSync(join(src, 'dist', 'server.js'), 'export default {}\n')
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'pantheon-tui' }))
    writeFileSync(join(src, 'tui.ts'), "export { default } from './dist/tui.js'\n")
    writeFileSync(join(src, 'index.ts'), "export { default } from './dist/server.js'\n")

    const result = copyPluginFiles(src, dst)

    assert.equal(result.errors, 1, 'a missing bundle is an error, never a silent skip')
    assert.match(result.problems[0], /bundle not found/i)
    assert.equal(
      existsSync(join(dst, 'tui.ts')),
      false,
      'the re-export that points at a missing bundle must not be written',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('copyPluginFiles refuses a package missing its server bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-tui-no-server-bundle-'))
  const src = join(root, 'src')
  const dst = join(root, 'dst')
  try {
    mkdirSync(join(src, 'dist'), { recursive: true })
    writeFileSync(join(src, 'dist', 'tui.js'), 'export default () => ({})\n')
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'pantheon-tui' }))
    writeFileSync(join(src, 'tui.ts'), "export { default } from './dist/tui.js'\n")
    writeFileSync(join(src, 'index.ts'), "export { default } from './dist/server.js'\n")

    const result = copyPluginFiles(src, dst)

    assert.equal(result.errors, 1)
    assert.match(result.problems[0], /server bundle not found/i)
    assert.equal(existsSync(join(dst, 'index.ts')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installPlugin reports a missing bundle as an error instead of a partial install', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-tui-nobundle-install-'))
  const src = join(root, 'src')
  const dst = join(root, 'dst')
  try {
    mkdirSync(src, { recursive: true })
    mkdirSync(join(src, 'dist'), { recursive: true })
    writeFileSync(join(src, 'dist', 'server.js'), 'export default {}\n')
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'pantheon-tui' }))
    writeFileSync(join(src, 'tui.ts'), "export { default } from './dist/tui.js'\n")
    writeFileSync(join(src, 'index.ts'), "export { default } from './dist/server.js'\n")

    const result = installPlugin(src, dst, { dryRun: true })

    assert.equal(result.errors, 1)
    assert.equal(existsSync(join(dst, 'tui.ts')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installOpenCode with the plugins component writes the plugin discovery files', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-tui-install-'))
  try {
    await withIsolatedHome(() =>
      withFakeNpm(async () => {
        const { installOpenCode } = await import('../scripts/install/opencode.mjs')
        await installOpenCode(target, false, false, ['plugins'], {
          yes: true,
          headless: true,
          version: 'v2',
          quiet: true,
        })

        const configDir = join(target, '.opencode')
        const copyDir = join(configDir, 'plugins', 'pantheon-tui')
        assert.ok(existsSync(join(copyDir, 'dist', 'tui.js')), 'the bundle is copied')
        assert.ok(existsSync(join(copyDir, 'index.ts')), 'the local-plugin entrypoint is copied')
        const pkg = JSON.parse(readFileSync(join(copyDir, 'package.json'), 'utf8'))
        assert.equal(pkg.exports['./tui'], './dist/tui.js')
        assert.equal(
          existsSync(join(configDir, 'tui.json')),
          false,
          'V2 discovers local plugins and must not add a project tui.json',
        )
      }),
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('runNpmCi sanitizes the npm environment and bounds the call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-npm-ci-'))
  const bin = join(root, 'bin')
  const log = join(root, 'npm.log')
  mkdirSync(bin)
  const npm = join(bin, 'npm')
  writeFileSync(
    npm,
    [
      '#!/usr/bin/env bash',
      'printf "args=%s\\n" "$*" >> "$FAKE_NPM_LOG"',
      'g=$(printenv npm_config_global) || g=unset',
      'printf "global=%s\\n" "$g" >> "$FAKE_NPM_LOG"',
      'p=$(printenv npm_config_prefix) || p=unset',
      'printf "prefix=%s\\n" "$p" >> "$FAKE_NPM_LOG"',
      'exit 0',
      '',
    ].join('\n'),
  )
  chmodSync(npm, 0o755)
  const previous = {
    PATH: process.env.PATH,
    npm_config_global: process.env.npm_config_global,
    npm_config_prefix: process.env.npm_config_prefix,
    FAKE_NPM_LOG: process.env.FAKE_NPM_LOG,
  }
  process.env.PATH = `${bin}${delimiter}${previous.PATH}`
  process.env.npm_config_global = 'true'
  process.env.npm_config_prefix = '/usr/local'
  process.env.FAKE_NPM_LOG = log
  try {
    const { runNpmCi } = await import('../scripts/install/plugin.mjs')
    runNpmCi(root)
    const recorded = readFileSync(log, 'utf8')
    assert.match(recorded, /args=ci --omit=dev --no-audit --no-fund/)
    assert.match(recorded, /global=unset/, 'a global npm context must not leak into npm ci')
    assert.match(recorded, /prefix=unset/, 'a global prefix must not leak into npm ci')
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('runNpmCi reports a timeout with an actionable error instead of hanging', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-npm-timeout-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const npm = join(bin, 'npm')
  writeFileSync(npm, '#!/bin/sh\nsleep 5\n')
  chmodSync(npm, 0o755)
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}${delimiter}${previousPath}`
  try {
    const { runNpmCi } = await import('../scripts/install/plugin.mjs')
    assert.throws(() => runNpmCi(root, { timeoutMs: 200 }), /timed out after/i)
  } finally {
    process.env.PATH = previousPath
    rmSync(root, { recursive: true, force: true })
  }
})
