/**
 * install-v2-context-capability.test.mjs — the Context-block negation must
 * track what the DEPLOYED TUI bundle actually provides.
 *
 * Negating the native `opencode.sidebar.context` block is only safe when the
 * copied bundle draws Pantheon's replacement; against a stale bundle the
 * negation deleted the Context block from the sidebar entirely. These tests
 * pin:
 *   (a) the capability detector accepts a bundle with the marker and rejects a
 *       bundle without it, a missing file and an unreadable path,
 *   (b) cli.json gains the exact directive when the capability is present,
 *   (c) cli.json loses a previously written directive when it is absent,
 *   (d) both directions are idempotent (a second run is a byte no-op),
 *   (e) the failure is announced with the reason and the rebuild/redeploy step,
 *   (f) the exact `-<id>` directive is used — never a wildcard.
 *
 * Run: node --test tests/install-v2-context-capability.test.mjs
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
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  applyContextSidebarNegation,
  bundleProvidesContextBlock,
  CONTEXT_BLOCK_BUNDLE_MARKER,
  CONTEXT_SIDEBAR_NEGATION,
  inspectContextBlockCapability,
  resolveInstalledTuiBundlePath,
  TUI_V2_BUNDLE_RELATIVE_PATH,
} from '../scripts/install/opencode.mjs'
import { ROOT } from '../scripts/install/shared.mjs'

/** Minimal stand-in for the built bundle: the marker plus unrelated code. */
const BUNDLE_WITH_CONTEXT_BLOCK = [
  'function contextBlockRows(usage, cost) { return { usage, cost } }',
  'export { contextBlockRows, plugin as default };',
].join('\n')

/** A bundle that predates the Pantheon Context block. */
const BUNDLE_WITHOUT_CONTEXT_BLOCK = [
  'function gitBlockRows(snapshot) { return { snapshot } }',
  'export { gitBlockRows, plugin as default };',
].join('\n')

const THIRD_PARTY_OBJECT = { package: './plugins/acme-local.ts', options: { retries: 2 } }

function scratchDir() {
  return mkdtempSync(join(tmpdir(), 'pantheon-context-capability-'))
}

/** Write `<dir>/cli.json` with `plugins`, creating the dir if needed. */
function writeCliConfig(dir, config) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cli.json'), `${JSON.stringify(config, null, 2)}\n`)
}

/** Deploy a bundle fixture at the path the installer inspects. */
function writeBundle(configDir, contents) {
  const bundlePath = resolveInstalledTuiBundlePath(configDir)
  mkdirSync(dirname(bundlePath), { recursive: true })
  writeFileSync(bundlePath, contents)
  return bundlePath
}

function readCliConfig(dir) {
  return JSON.parse(readFileSync(join(dir, 'cli.json'), 'utf8'))
}

test('the installed bundle path is the copied TUI plugin dist, not the package source', () => {
  assert.equal(TUI_V2_BUNDLE_RELATIVE_PATH, 'dist/tui-v2.js')
  assert.equal(
    resolveInstalledTuiBundlePath('/tmp/config'),
    join('/tmp/config', 'plugins', 'pantheon-tui', 'dist', 'tui-v2.js'),
    'the check must read the copy the host loads',
  )
})

test('bundleProvidesContextBlock accepts a bundle that exports the Context block', () => {
  const verdict = bundleProvidesContextBlock(BUNDLE_WITH_CONTEXT_BLOCK)
  assert.equal(verdict.ok, true)
  assert.equal(verdict.reason, '')
})

test('bundleProvidesContextBlock rejects a bundle without the marker', () => {
  const verdict = bundleProvidesContextBlock(BUNDLE_WITHOUT_CONTEXT_BLOCK)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, new RegExp(CONTEXT_BLOCK_BUNDLE_MARKER))
  assert.match(verdict.reason, /predates/)
})

test('bundleProvidesContextBlock is a pure text check and rejects non-text input', () => {
  assert.equal(bundleProvidesContextBlock(null).ok, false)
  assert.equal(bundleProvidesContextBlock(undefined).ok, false)
  assert.equal(bundleProvidesContextBlock(Buffer.from(BUNDLE_WITH_CONTEXT_BLOCK)).ok, false)
})

test('inspectContextBlockCapability reads the deployed bundle', () => {
  const dir = scratchDir()
  try {
    const bundlePath = writeBundle(dir, BUNDLE_WITH_CONTEXT_BLOCK)
    const verdict = inspectContextBlockCapability(dir)
    assert.equal(verdict.ok, true)
    assert.equal(verdict.bundlePath, bundlePath)

    writeBundle(dir, BUNDLE_WITHOUT_CONTEXT_BLOCK)
    assert.equal(inspectContextBlockCapability(dir).ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('inspectContextBlockCapability evaluates the in-package bundle on a dry run', () => {
  const dir = scratchDir()
  try {
    // A dry run copies nothing, so the deployed copy is absent by definition.
    // The verdict must describe the bundle that WOULD be deployed.
    const verdict = inspectContextBlockCapability(dir, { dryRun: true })
    assert.equal(
      verdict.bundlePath,
      join(ROOT, 'src', 'plugins', 'tui', TUI_V2_BUNDLE_RELATIVE_PATH),
      'the preview reads the package artifact, not the (still missing) copy',
    )
    assert.equal(
      verdict.ok,
      bundleProvidesContextBlock(readFileSync(verdict.bundlePath, 'utf8')).ok,
    )

    // An existing deployed copy wins even in a preview, so the plan describes
    // the payload the host would actually load.
    writeBundle(dir, BUNDLE_WITHOUT_CONTEXT_BLOCK)
    assert.equal(
      inspectContextBlockCapability(dir, { dryRun: true }).bundlePath,
      resolveInstalledTuiBundlePath(dir),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('inspectContextBlockCapability fails closed when the bundle is missing', () => {
  const dir = scratchDir()
  try {
    const verdict = inspectContextBlockCapability(dir)
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /missing or unreadable/)
    assert.match(verdict.reason, /tui-v2\.js/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('inspectContextBlockCapability fails closed when the bundle path is not a file', () => {
  const dir = scratchDir()
  try {
    // A directory at the bundle path makes readFileSync throw EISDIR without
    // depending on file permissions (which behave differently as root).
    mkdirSync(resolveInstalledTuiBundlePath(dir), { recursive: true })
    const verdict = inspectContextBlockCapability(dir)
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /missing or unreadable/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('inspectContextBlockCapability fails closed on an unreadable bundle', () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    // root bypasses the permission bits; the EISDIR case above covers it.
    return
  }
  const dir = scratchDir()
  try {
    const bundlePath = writeBundle(dir, BUNDLE_WITH_CONTEXT_BLOCK)
    chmodSync(bundlePath, 0o000)
    try {
      const verdict = inspectContextBlockCapability(dir)
      assert.equal(verdict.ok, false)
      assert.match(verdict.reason, /missing or unreadable/)
    } finally {
      chmodSync(bundlePath, 0o644)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('capability present: cli.json gains the exact directive, then is a byte no-op', () => {
  const dir = scratchDir()
  try {
    writeBundle(dir, BUNDLE_WITH_CONTEXT_BLOCK)
    writeCliConfig(dir, { theme: { name: 'opencode' }, plugins: ['alpha-plugin'] })

    assert.equal(applyContextSidebarNegation(dir), 'created')
    const written = readCliConfig(dir)
    assert.deepEqual(written.plugins, ['alpha-plugin', CONTEXT_SIDEBAR_NEGATION])
    assert.deepEqual(
      written.plugins.filter((entry) => typeof entry === 'string' && entry.startsWith('-')),
      [CONTEXT_SIDEBAR_NEGATION],
      'exactly one exact -<id> directive is written',
    )
    assert.ok(
      !written.plugins.some((entry) => typeof entry === 'string' && entry.includes('*')),
      'never a wildcard: it would also cancel the mcp and footer blocks',
    )

    const afterFirst = readFileSync(join(dir, 'cli.json'), 'utf8')
    assert.equal(applyContextSidebarNegation(dir), 'skipped')
    assert.equal(readFileSync(join(dir, 'cli.json'), 'utf8'), afterFirst)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('capability absent: a previously written directive is removed, then a no-op', () => {
  const dir = scratchDir()
  try {
    // The bundle regressed (stale dist): the native block must keep rendering.
    writeBundle(dir, BUNDLE_WITHOUT_CONTEXT_BLOCK)
    writeCliConfig(dir, {
      theme: { name: 'opencode' },
      plugins: ['alpha-plugin', THIRD_PARTY_OBJECT, CONTEXT_SIDEBAR_NEGATION],
    })

    const warnings = []
    assert.equal(
      applyContextSidebarNegation(dir, { warn: (message) => warnings.push(message) }),
      'removed',
    )
    const written = readCliConfig(dir)
    assert.deepEqual(
      written.plugins,
      ['alpha-plugin', THIRD_PARTY_OBJECT],
      'the exact directive is gone and every other entry survives in order',
    )
    assert.deepEqual(Object.keys(written), ['theme', 'plugins'], 'key order is preserved')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /Builtin Context sidebar block left ENABLED/)
    assert.match(warnings[0], /Removed -opencode\.sidebar\.context/)
    assert.match(warnings[0], /Rebuild the TUI bundle/)

    const afterFirst = readFileSync(join(dir, 'cli.json'), 'utf8')
    assert.equal(
      applyContextSidebarNegation(dir, { warn: () => {} }),
      'unverified',
      'a second run still reports the missing capability without rewriting the file',
    )
    assert.equal(readFileSync(join(dir, 'cli.json'), 'utf8'), afterFirst)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('capability absent with no directive: cli.json is not created, the user is warned', () => {
  const dir = scratchDir()
  try {
    writeBundle(dir, BUNDLE_WITHOUT_CONTEXT_BLOCK)
    const warnings = []
    assert.equal(
      applyContextSidebarNegation(dir, { warn: (message) => warnings.push(message) }),
      'unverified',
    )
    assert.equal(existsSync(join(dir, 'cli.json')), false, 'no client config is invented')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /no "contextBlockRows" export/)
    assert.match(warnings[0], /re-run init/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an explicitly injected capability verdict overrides the on-disk bundle', () => {
  const dir = scratchDir()
  try {
    // A good bundle on disk, but the caller proved the payload is not there.
    writeBundle(dir, BUNDLE_WITH_CONTEXT_BLOCK)
    writeCliConfig(dir, { plugins: [CONTEXT_SIDEBAR_NEGATION] })
    const warnings = []
    assert.equal(
      applyContextSidebarNegation(dir, {
        capability: { ok: false, reason: 'injected absence' },
        warn: (message) => warnings.push(message),
      }),
      'removed',
    )
    assert.deepEqual(readCliConfig(dir).plugins, [])
    assert.match(warnings[0], /injected absence/)

    // ... and vice versa: a stale bundle on disk but the capability is proven.
    writeBundle(dir, BUNDLE_WITHOUT_CONTEXT_BLOCK)
    assert.equal(
      applyContextSidebarNegation(dir, {
        capability: { ok: true, reason: '' },
        warn: () => {},
      }),
      'created',
    )
    assert.deepEqual(readCliConfig(dir).plugins, [CONTEXT_SIDEBAR_NEGATION])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
