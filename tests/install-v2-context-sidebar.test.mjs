/**
 * install-v2-context-sidebar.test.mjs — durable de-duplication of the V2
 * Context sidebar block.
 *
 * Pantheon's TUI plugin renders its own Context block, so the builtin
 * `opencode.sidebar.context` must be cancelled in V2's single global
 * terminal-client config (`<configDir>/cli.json`). The negation lives in the
 * installer so a re-install cannot revert it; these tests pin:
 *   (a) V2 adds the exact directive when absent,
 *   (b) a second run does not duplicate it,
 *   (c) other entries (strings and `{package, options}` objects) survive in order,
 *   (d) the V1 path never touches cli.json,
 *   (e) an unparseable cli.json is never overwritten.
 *
 * Run: node --test tests/install-v2-context-sidebar.test.mjs
 */
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  applyContextSidebarNegation,
  CONTEXT_SIDEBAR_NEGATION,
  withContextSidebarDisabled,
} from '../scripts/install/opencode.mjs'

const THIRD_PARTY_OBJECT = {
  package: './plugins/acme-local.ts',
  options: { enabled: true, retries: 2 },
}

/** Run `fn` with an isolated HOME/XDG so no test touches the real config. */
async function withIsolatedHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'pantheon-sidebar-home-'))
  const xdg = mkdtempSync(join(tmpdir(), 'pantheon-sidebar-xdg-'))
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

/** Run `fn` with a no-op `npm` first on PATH (the plugin deps step is network). */
async function withFakeNpm(fn) {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-sidebar-npm-'))
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

function scratchDir() {
  return mkdtempSync(join(tmpdir(), 'pantheon-sidebar-cli-'))
}

/**
 * Deploy a bundle fixture that proves the Context-block capability. Without it
 * the installer keeps the native block enabled (and warns), which is the
 * contract covered by install-v2-context-capability.test.mjs.
 */
function writeContextCapableBundle(dir) {
  const bundlePath = join(dir, 'plugins', 'pantheon-tui', 'dist', 'tui-v2.js')
  mkdirSync(dirname(bundlePath), { recursive: true })
  writeFileSync(bundlePath, 'export { contextBlockRows, plugin as default };\n')
}

test('withContextSidebarDisabled appends the exact negation and is idempotent', () => {
  const first = withContextSidebarDisabled(undefined)
  assert.deepEqual(first.plugins, [CONTEXT_SIDEBAR_NEGATION])
  assert.equal(first.changed, true)
  assert.equal(CONTEXT_SIDEBAR_NEGATION, '-opencode.sidebar.context')

  const existing = [CONTEXT_SIDEBAR_NEGATION, 'echo-plugin']
  const again = withContextSidebarDisabled(existing)
  assert.equal(again.changed, false)
  assert.deepEqual(again.plugins, existing, 'an already-disabled array is returned untouched')
})

test('withContextSidebarDisabled preserves entries, object form and order', () => {
  const plugins = ['alpha-plugin', THIRD_PARTY_OBJECT, { package: 'beta' }]
  const result = withContextSidebarDisabled(plugins)
  assert.deepEqual(result.plugins, [...plugins, CONTEXT_SIDEBAR_NEGATION])
  assert.deepEqual(
    plugins,
    ['alpha-plugin', THIRD_PARTY_OBJECT, { package: 'beta' }],
    'input is not mutated',
  )
})

test('applyContextSidebarNegation creates cli.json and keeps the user config intact', () => {
  const dir = scratchDir()
  const cliConfigPath = join(dir, 'cli.json')
  try {
    const userConfig = {
      theme: { name: 'opencode', mode: 'system' },
      session: { sidebar: 'auto' },
      plugins: ['alpha-plugin', THIRD_PARTY_OBJECT],
    }
    writeFileSync(cliConfigPath, `${JSON.stringify(userConfig, null, 2)}\n`)
    writeContextCapableBundle(dir)

    assert.equal(applyContextSidebarNegation(dir), 'created')

    const written = JSON.parse(readFileSync(cliConfigPath, 'utf8'))
    assert.deepEqual(written, {
      theme: { name: 'opencode', mode: 'system' },
      session: { sidebar: 'auto' },
      plugins: ['alpha-plugin', THIRD_PARTY_OBJECT, CONTEXT_SIDEBAR_NEGATION],
    })
    assert.deepEqual(
      Object.keys(written),
      ['theme', 'session', 'plugins'],
      'key order is preserved',
    )

    // (b) second run: no duplicate, no rewrite.
    const afterFirst = readFileSync(cliConfigPath, 'utf8')
    assert.equal(applyContextSidebarNegation(dir), 'skipped')
    assert.equal(readFileSync(cliConfigPath, 'utf8'), afterFirst)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('applyContextSidebarNegation creates the directive for a config with no plugins key', () => {
  const dir = scratchDir()
  try {
    writeContextCapableBundle(dir)
    assert.equal(applyContextSidebarNegation(dir), 'created')
    const written = JSON.parse(readFileSync(join(dir, 'cli.json'), 'utf8'))
    assert.deepEqual(written, { plugins: [CONTEXT_SIDEBAR_NEGATION] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('applyContextSidebarNegation never overwrites an unparseable or unexpected cli.json', () => {
  const dir = scratchDir()
  const cliConfigPath = join(dir, 'cli.json')
  const warnings = []
  try {
    const invalidJson = '{ "theme": "opencode", '
    writeFileSync(cliConfigPath, invalidJson)
    assert.equal(applyContextSidebarNegation(dir, { warn: (m) => warnings.push(m) }), 'invalid')
    assert.equal(
      readFileSync(cliConfigPath, 'utf8'),
      invalidJson,
      'invalid JSON is left byte-identical',
    )
    assert.match(warnings[0], /not valid JSON/)

    const nonArrayPlugins = `${JSON.stringify({ plugins: { keep: true } }, null, 2)}\n`
    writeFileSync(cliConfigPath, nonArrayPlugins)
    assert.equal(applyContextSidebarNegation(dir, { warn: (m) => warnings.push(m) }), 'invalid')
    assert.equal(
      readFileSync(cliConfigPath, 'utf8'),
      nonArrayPlugins,
      'a non-array "plugins" value is never replaced',
    )
    assert.match(warnings[1], /not an array/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the installer writes the negation for V2 globals only, once per install', async () => {
  const v1Target = mkdtempSync(join(tmpdir(), 'pantheon-sidebar-v1-'))
  const v2Target = mkdtempSync(join(tmpdir(), 'pantheon-sidebar-v2-'))
  try {
    await withIsolatedHome(() =>
      withFakeNpm(async () => {
        const { installOpenCode } = await import('../scripts/install/opencode.mjs')

        // (d) V1: the legacy path is untouched — no cli.json, tui.json instead.
        await installOpenCode(v1Target, false, false, ['plugins'], {
          yes: true,
          headless: true,
          version: 'v1',
          global: true,
          quiet: true,
        })
        assert.equal(
          existsSync(join(v1Target, 'cli.json')),
          false,
          'V1 must not gain a V2 cli.json',
        )

        // (a) V2 global: the directive lands in the client config.
        await installOpenCode(v2Target, false, false, ['plugins'], {
          yes: true,
          headless: true,
          version: 'v2',
          global: true,
          quiet: true,
        })
        const cliConfigPath = join(v2Target, 'cli.json')
        assert.ok(existsSync(cliConfigPath), 'V2 global install writes cli.json')
        const afterFirst = readFileSync(cliConfigPath, 'utf8')
        const firstPlugins = JSON.parse(afterFirst).plugins
        assert.deepEqual(
          firstPlugins.filter((entry) => entry === CONTEXT_SIDEBAR_NEGATION),
          [CONTEXT_SIDEBAR_NEGATION],
          'the builtin Context block is cancelled exactly once',
        )

        // (b) reinstall: same bytes, no duplicate.
        await installOpenCode(v2Target, false, false, ['plugins'], {
          yes: true,
          headless: true,
          version: 'v2',
          global: true,
          quiet: true,
        })
        assert.equal(
          readFileSync(cliConfigPath, 'utf8'),
          afterFirst,
          'a second init is a byte no-op',
        )
      }),
    )
  } finally {
    rmSync(v1Target, { recursive: true, force: true })
    rmSync(v2Target, { recursive: true, force: true })
  }
})
