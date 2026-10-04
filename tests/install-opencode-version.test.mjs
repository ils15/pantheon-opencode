import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  deduplicatePluginReferences,
  installOpenCode,
  parseOpenCodeVersion,
  pluginReferenceIdentity,
  resolveInstalledPlugin,
  resolveOpenCodeVersion,
} from '../scripts/install/opencode.mjs'
import { ROOT } from '../scripts/install/shared.mjs'

const NO_COMPONENTS = []
// Canonical V2 entry: the plugin directory inside the installed package.
// V2_EXPORT / V2_LEGACY_FILE are pre-directory-contract refs the installer
// migrates into V2_PLUGIN.
const V2_PLUGIN = join(ROOT, 'src', 'plugin-v2')
const V2_EXPORT = 'pantheon-opencode/plugin-v2'
const _V2_LEGACY_FILE = 'src/plugin-v2.ts'
const THIRD_PARTY_PANTHEON_OPENCODE_PLUGIN = '/tmp/vendor/pantheon-opencode/src/plugin.ts'
const THIRD_PARTY_PANTHEON_PLUGIN = '/tmp/vendor/pantheon/src/plugin.ts'

// `extra` is merged into the installer options bag. It exists so a test can
// omit `version` (exercising the real default gate) while still pinning the
// host probe — CI has no `opencode` binary on PATH, so an unpinned probe would
// make these assertions environment-dependent instead of deterministic.
async function installConfig(existingConfig, version, extra = {}) {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-version-'))
  try {
    writeFileSync(join(target, 'opencode.json'), JSON.stringify(existingConfig, null, 2))
    await installOpenCode(target, false, false, NO_COMPONENTS, {
      headless: true,
      version,
      ...extra,
    })
    return JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8'))
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
}

/** A host probe that reports a fixed `--version` string. */
const hostSays = (output) => () => output
/**
 * A host probe that reports fixed stdout AND stderr, the shape the real
 * `spawnSync` probe returns. `hostSays` stays for the stdout-only callers.
 */
const hostStreams =
  ({ stdout = '', stderr = '' }) =>
  () => ({ stdout, stderr })
/** A host probe whose binary cannot be executed. */
const hostProbeFails = () => {
  throw new Error('spawnSync opencode ENOENT')
}
/** Swallow the soft-fail warning so test output stays readable. */
const silentWarn = () => {}

/**
 * A very long `--version` banner: `tokens` version-shaped noise tokens followed
 * by the host's own name-anchored version. Every noise token is one iteration
 * of the anchor scan, so the token count is what a quadratic parse shows up in.
 */
function verboseBanner(tokens) {
  const noise = []
  for (let index = 0; index < tokens; index += 1) {
    noise.push(`node v22.${index % 30}.${index % 17} `)
  }
  return `${noise.join('')}opencode v2.0.22\n`
}

/** Resolve with an isolated env and a swallowed warning — for the gate tests. */
const resolveVersion = (options) =>
  resolveOpenCodeVersion('auto', { env: {}, warn: silentWarn, ...options })

/** V1-only file paths the V1 generation registers in the singular `plugin` key. */
const V1_TS_PATHS = [
  join(ROOT, 'src', 'plugin.ts'),
  join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts'),
]

test('parses --opencode-version=v1, v2, and auto', () => {
  assert.equal(parseOpenCodeVersion(['init', '--opencode-version=v1']), 'v1')
  assert.equal(parseOpenCodeVersion(['init', '--opencode-version=v2']), 'v2')
  assert.equal(parseOpenCodeVersion(['init', '--opencode-version=auto']), 'auto')
})

test('parses separated version values and rejects invalid values', () => {
  assert.equal(parseOpenCodeVersion(['init', '--opencode-version', 'v1']), 'v1')
  assert.equal(parseOpenCodeVersion(['init', '--opencode-version', 'v2']), 'v2')
  assert.equal(parseOpenCodeVersion(['init', '--opencode-version', 'auto']), 'auto')
  assert.throws(
    () => parseOpenCodeVersion(['init', '--opencode-version=v3']),
    /expected v1, v2, or auto/,
  )
  assert.throws(() => parseOpenCodeVersion(['init', '--version', 'v3']), /expected v1, v2, or auto/)
})

test('auto resolves an explicit environment or opencode2 binary hint', () => {
  assert.equal(resolveOpenCodeVersion('auto', { env: { OPENCODE_VERSION: 'v2' } }), 'v2')
  assert.equal(resolveOpenCodeVersion('auto', { env: {}, binary: '/usr/bin/opencode2' }), 'v2')
  // A plain `opencode` basename carries no hint, so the decision now falls
  // through to the host probe. Pin a failing probe: leaving the real binary to
  // answer would make this assertion depend on the developer's PATH.
  assert.equal(
    resolveOpenCodeVersion('auto', {
      env: {},
      binary: '/usr/bin/opencode',
      probe: hostProbeFails,
      warn: silentWarn,
    }),
    'v1',
  )
  assert.throws(() => resolveOpenCodeVersion('v3'), /expected v1, v2, or auto/)
})

test('v1 preserves config.plugins and third-party paths in config.plugin', async () => {
  const config = await installConfig(
    {
      plugin: [THIRD_PARTY_PANTHEON_PLUGIN, '@scope/custom-plugin'],
      plugins: ['custom-v2-plugin'],
    },
    'v1',
  )

  assert.deepEqual(config.plugins, ['custom-v2-plugin'])
  assert.equal(config.plugin.filter((entry) => entry.endsWith('/plugin.ts')).length, 2)
  assert.ok(config.plugin.includes(THIRD_PARTY_PANTHEON_PLUGIN))
  assert.equal(config.plugin.filter((entry) => entry.endsWith('/pantheon-hooks.ts')).length, 1)
  assert.ok(config.plugin.includes('@scope/custom-plugin'))
  assert.ok(config.plugin.includes(join(ROOT, 'src', 'plugin.ts')))
  assert.ok(config.plugin.includes(join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts')))
})

test('v2 preserves config.plugin and registers the shipped V2 entrypoint', async () => {
  const config = await installConfig(
    {
      plugin: ['user-v1-plugin'],
      plugins: ['user-v2-plugin'],
    },
    'v2',
  )

  assert.deepEqual(config.plugin, ['user-v1-plugin'])
  assert.equal(config.plugins[0], 'user-v2-plugin')
  assert.ok(config.plugins.includes(V2_PLUGIN))
  assert.ok(!config.plugins.includes(V2_EXPORT))
  assert.ok(!config.plugins.includes(join(ROOT, 'src', 'plugin-v2.ts')))
  assert.ok(!config.plugins.some((entry) => entry === join(ROOT, 'src', 'plugin.ts')))
})

test('auto selects V2 and V1 during migrations without mixing Pantheon refs', async () => {
  const previousVersion = process.env.OPENCODE_VERSION
  try {
    process.env.OPENCODE_VERSION = 'v2'
    const v2 = await installConfig(
      {
        plugin: [THIRD_PARTY_PANTHEON_OPENCODE_PLUGIN, 'third-party-v1'],
        plugins: [V2_PLUGIN, 'third-party-v2'],
      },
      'auto',
    )
    assert.deepEqual(v2.plugin, [THIRD_PARTY_PANTHEON_OPENCODE_PLUGIN, 'third-party-v1'])
    assert.deepEqual(v2.plugins, ['third-party-v2', V2_PLUGIN])

    process.env.OPENCODE_VERSION = 'v1'
    const v1 = await installConfig(
      {
        plugin: ['third-party-v1'],
        plugins: [V2_PLUGIN, 'third-party-v2'],
      },
      'auto',
    )
    assert.deepEqual(v1.plugins, ['third-party-v2'])
    assert.ok(v1.plugin.includes(join(ROOT, 'src', 'plugin.ts')))
    assert.ok(!v1.plugin.includes(V2_PLUGIN))
  } finally {
    if (previousVersion === undefined) delete process.env.OPENCODE_VERSION
    else process.env.OPENCODE_VERSION = previousVersion
  }
})

test('does not install or register TUI when the plugins component is omitted', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-no-plugins-'))
  try {
    await installOpenCode(target, false, false, NO_COMPONENTS, {
      headless: true,
      version: 'v1',
    })
    assert.equal(existsSync(join(target, '.opencode', 'tui.json')), false)
    assert.equal(existsSync(join(target, '.opencode', 'plugins', 'pantheon-tui')), false)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('exact installed package plugin paths remain managed', () => {
  const delegation = resolveInstalledPlugin(join(ROOT, 'src', 'plugin.ts'))
  const hooks = resolveInstalledPlugin(join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts'))
  assert.equal(delegation, join(ROOT, 'src', 'plugin.ts'))
  assert.equal(hooks, join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts'))
  assert.ok(existsSync(delegation))
  assert.ok(existsSync(hooks))
})

test('external plugin paths under pantheon-named directories remain untouched', () => {
  assert.equal(
    resolveInstalledPlugin(THIRD_PARTY_PANTHEON_OPENCODE_PLUGIN),
    THIRD_PARTY_PANTHEON_OPENCODE_PLUGIN,
  )
  assert.equal(resolveInstalledPlugin(THIRD_PARTY_PANTHEON_PLUGIN), THIRD_PARTY_PANTHEON_PLUGIN)
})

test('plugin deduplication uses Pantheon identity or full path, never basename', () => {
  const refs = deduplicatePluginReferences([
    '/home/old/src/plugin.ts',
    join(ROOT, 'src', 'plugin.ts'),
    '/user/plugin.ts',
    '/another/plugin.ts',
    'custom-plugin',
    'custom-plugin',
  ])
  assert.equal(refs.filter((entry) => pluginReferenceIdentity(entry) === 'src/plugin.ts').length, 1)
  assert.ok(refs.includes('/user/plugin.ts'))
  assert.ok(refs.includes('/another/plugin.ts'))
  assert.equal(refs.filter((entry) => entry === 'custom-plugin').length, 1)
})

// ─── Host-version gate ──────────────────────────────────────────────────────

test('default resolution on a 2.x host registers the V2 directory, never .ts file paths', async () => {
  // Reproduces the shipped bug: on an OpenCode 2.x host the default gate used to
  // resolve V1, whose branch writes .ts FILE paths into the singular `plugin`
  // key. A 2.x host rejects those ("configured plugin path must be a directory")
  // and the loader drops the entry, so the plugin surface silently dies.
  // No `version` is passed — this exercises the real production default.
  const config = await installConfig({ plugin: [], plugins: [V2_PLUGIN] }, undefined, {
    env: {},
    probe: hostSays('2.0.22'),
    warn: silentWarn,
  })

  assert.deepEqual(
    {
      hasV2Directory: config.plugins.includes(V2_PLUGIN),
      tsFilePaths: config.plugin.filter((entry) => entry.endsWith('.ts')).length,
    },
    { hasV2Directory: true, tsFilePaths: 0 },
  )
})

test('the default gate follows the host probe, with explicit > env > basename > probe precedence', () => {
  const resolve = (options) =>
    resolveOpenCodeVersion('auto', { env: {}, warn: silentWarn, ...options })

  // The probe decides when nothing above it is set.
  assert.equal(resolve({ probe: hostSays('2.0.22') }), 'v2')
  assert.equal(resolve({ probe: hostSays('v2.4.1') }), 'v2', 'a leading "v" is tolerated')
  assert.equal(resolve({ probe: hostSays('1.18.33') }), 'v1')
  // Real hosts print the binary name first: `opencode --version` emits
  // "opencode v2.0.22". An anchored ^\d parser silently reads that as
  // unparseable and soft-fails every 2.x host back to v1.
  assert.equal(resolve({ probe: hostSays('opencode v2.0.22\n') }), 'v2')
  assert.equal(resolve({ probe: hostSays('opencode v1.18.33\n') }), 'v1')
  // Soft failure: an unrunnable or unparseable host must not throw.
  assert.equal(resolve({ probe: hostProbeFails }), 'v1')
  assert.equal(resolve({ probe: hostSays('not-a-version') }), 'v1')
  assert.equal(resolve({ probe: hostSays('') }), 'v1')

  // ...and it must never be SILENT. Landing on V1 is the failure this gate
  // exists to prevent, so both soft-fail paths have to warn. Only the CALL is
  // asserted — never the message text, which is free to change.
  for (const probe of [hostProbeFails, hostSays('not-a-version'), hostSays('')]) {
    let warnings = 0
    resolveOpenCodeVersion('auto', { env: {}, probe, warn: () => (warnings += 1) })
    assert.equal(warnings, 1, 'a soft-failed probe must warn exactly once')
  }
  // A resolved host stays quiet.
  let quiet = 0
  resolveOpenCodeVersion('auto', {
    env: {},
    probe: hostSays('opencode v2.0.22'),
    warn: () => (quiet += 1),
  })
  assert.equal(quiet, 0, 'a successfully probed host must not warn')

  // OPENCODE_VERSION beats a contradicting probe.
  assert.equal(resolve({ env: { OPENCODE_VERSION: 'v2' }, probe: hostSays('1.18.33') }), 'v2')
  assert.equal(resolve({ env: { OPENCODE_VERSION: 'v1' }, probe: hostSays('2.0.22') }), 'v1')

  // An explicit argument beats a contradicting probe.
  assert.equal(
    resolveOpenCodeVersion('v1', { env: {}, probe: hostSays('2.0.22'), warn: silentWarn }),
    'v1',
  )
  assert.equal(
    resolveOpenCodeVersion('v2', { env: {}, probe: hostSays('1.18.33'), warn: silentWarn }),
    'v2',
  )

  // The ordering trap: an `opencode2` basename is an OPERATOR hint and must win
  // over the probe's heuristic read of a version string. See the precedence
  // rationale in scripts/install/opencode-version.mjs.
  assert.equal(
    resolve({
      env: { OPENCODE_BIN: '/usr/local/bin/opencode2' },
      // Fictional string from this repo's history, NOT an observation of any
      // host — see the historical note in scripts/install/opencode-version.mjs.
      // The basename short-circuits before the probe is read, so the value is
      // irrelevant to what this test pins.
      probe: hostSays('0.0.0-next-17444'),
    }),
    'v2',
  )
})

test('a version-like token ahead of the tool name cannot flip the generation', () => {
  // Reviewer-proven silent misclassification: first-match-wins took "22.1.0"
  // from the NODE token and resolved a genuine 1.x host to v2, with no warning.
  // The token that follows the tool name is the one that describes the host.
  const warnings = []
  const resolved = resolveOpenCodeVersion('auto', {
    env: {},
    probe: hostSays('node v22.1.0 (opencode 1.18.33)'),
    warn: (message) => warnings.push(message),
  })

  assert.equal(resolved, 'v1', 'a 1.x host behind a node 22 prefix must not resolve to v2')
  // The tool name disambiguated it, so this is a RESOLVED host, not a soft
  // failure: it stays quiet. The pin that matters is `resolved !== 'v2'`.
  assert.equal(warnings.length, 0, 'a name-anchored match is a resolution, not a warning')
})

test('the tool-name match wins over later unrelated version-like tokens', () => {
  // Pins that we do NOT anchor to the last token: last-token anchoring matches
  // "2026.10.04" here and flips this 1.x host to v2.
  assert.equal(resolveVersion({ probe: hostSays('opencode v1.18.33 built 2026.10.04') }), 'v1')
  // Symmetric case, so the rule is not accidentally "always pick the first".
  assert.equal(resolveVersion({ probe: hostSays('opencode v2.0.22 built 2026.10.04') }), 'v2')
  // A leading runtime token must not outrank the tool's own version either way.
  assert.equal(resolveVersion({ probe: hostSays('node v20.11.0 (opencode 2.0.22)') }), 'v2')
})

test('the "v" prefix is matched case-insensitively', () => {
  // A case-sensitive "v" failed to parse and soft-failed to v1 with a warning.
  assert.equal(resolveVersion({ probe: hostSays('OpenCode V2.0.22') }), 'v2')
  assert.equal(resolveVersion({ probe: hostSays('opencode V1.18.33') }), 'v1')
  assert.equal(resolveVersion({ probe: hostSays('OPENCODE v2.0.22') }), 'v2')
})

test('contradicting version tokens with no tool name warn loudly and fall back to v1', () => {
  // Nothing here says which token is the host's, so the gate must not guess.
  // "Wrong but loud" is the accepted outcome; a silent pick is the defect.
  const warnings = []
  const resolved = resolveOpenCodeVersion('auto', {
    env: {},
    probe: hostSays('1.18.33 (runtime 2.0.0)'),
    warn: (message) => warnings.push(message),
  })

  assert.equal(resolved, 'v1', 'an unresolvable contradiction must fall back to v1')
  assert.equal(warnings.length, 1, 'the contradiction must produce exactly one visible warning')
})

test('a date is never read as a major version', () => {
  // "2026.10.04" is version-SHAPED but is a build date. Reading its leading
  // "2026" as a major would flip an unknown host to v2 in silence.
  for (const output of ['2026.10.04', 'opencode built 2026.10.04', 'dev build 2026.10.04 12:00']) {
    const warnings = []
    const resolved = resolveOpenCodeVersion('auto', {
      env: {},
      probe: hostSays(output),
      warn: (message) => warnings.push(message),
    })

    assert.equal(resolved, 'v1', `a bare date must not resolve to v2: ${JSON.stringify(output)}`)
    assert.equal(warnings.length, 1, `a bare date must warn: ${JSON.stringify(output)}`)
  }
  // A date alongside a real version is noise, not a contradiction: the
  // name-anchored version decides and the host stays quiet.
  const warnings = []
  assert.equal(
    resolveOpenCodeVersion('auto', {
      env: {},
      probe: hostSays('opencode v2.0.22 built 2026.10.04'),
      warn: (message) => warnings.push(message),
    }),
    'v2',
  )
  assert.equal(warnings.length, 0, 'a trailing build date is noise, not ambiguity')
})

test('a major-0 prerelease banner is unresolvable rather than a silent v1', () => {
  // The original defect class — V1 config written on a 2.x host — recurring for a
  // build that reports major 0. "0.0.0-next-17444" is the exact string this
  // repo's own comments cite, so the code has to reject it rather than quietly
  // read it as "older than 2". A genuine 0.x host is a decade away; if one ever
  // exists, a loud fallback is the correct direction to fail.
  for (const output of ['opencode 0.0.0-next-17444', 'opencode 0.1.0', '0.0.0-next-17444']) {
    const warnings = []
    const resolved = resolveOpenCodeVersion('auto', {
      env: {},
      probe: hostSays(output),
      warn: (message) => warnings.push(message),
    })

    assert.equal(resolved, 'v1', `a major-0 banner must fall back to v1: ${JSON.stringify(output)}`)
    assert.equal(warnings.length, 1, `a major-0 banner must warn: ${JSON.stringify(output)}`)
  }
  // An UNANCHORED 0 alongside a real version stays noise, like a date: the
  // surviving token still decides, because nothing claims the 0 is the host's.
  const warnings = []
  assert.equal(
    resolveOpenCodeVersion('auto', {
      env: {},
      probe: hostSays('opencode v2.0.22 (build 0.9.9)'),
      warn: (message) => warnings.push(message),
    }),
    'v2',
  )
  assert.equal(warnings.length, 0, 'an unanchored 0 next to a real host version is noise')
})

test('an anchored major we cannot interpret is loud even when a runtime token survives', () => {
  // A name-anchored token IS the host's own version. When its major is one we
  // refuse to interpret (0, or a calendar year >= 100), dropping it and letting
  // a surviving `node v22` promote itself to deciding power is a SILENT wrong
  // answer — the exact defect this gate exists to prevent. So a refused ANCHORED
  // major is reported, not discarded.
  for (const output of ['opencode 100.0.0 (node v22.1.0)', 'opencode 100.0.0 (runtime 2.0.0)']) {
    const warnings = []
    const resolved = resolveOpenCodeVersion('auto', {
      env: {},
      probe: hostSays(output),
      warn: (message) => warnings.push(message),
    })

    assert.equal(
      resolved,
      'v1',
      `an uninterpretable anchored major must fall back to v1: ${JSON.stringify(output)}`,
    )
    assert.equal(
      warnings.length,
      1,
      `an uninterpretable anchored major must warn: ${JSON.stringify(output)}`,
    )
  }
  // The quiet counterpart stays quiet: an UNANCHORED date is noise, not an
  // unreadable host version. Only the anchored case is loud.
  const warnings = []
  assert.equal(
    resolveOpenCodeVersion('auto', {
      env: {},
      probe: hostSays('opencode v2.0.22 built 2026.10.04'),
      warn: (message) => warnings.push(message),
    }),
    'v2',
  )
  assert.equal(warnings.length, 0, 'a dropped unanchored date must stay silent')
})

test('parsing cost stays linear in the size of the probe output', () => {
  // Anchoring used to copy the entire prefix once per match
  // (`source.slice(0, match.index)`), which is quadratic in output size: ~4x
  // per doubling of token count. The 5s spawn timeout guards the spawn, not the
  // parse, so a verbose host could hang the installer well past it.
  const stdout = verboseBanner(80000)
  assert.ok(
    Buffer.byteLength(stdout) > 1_000_000,
    'the case must be large enough for a quadratic prefix copy to show',
  )

  const startedAt = process.hrtime.bigint()
  const resolved = resolveVersion({ probe: hostSays(stdout) })
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6

  // Correctness first: the bound must never be passable by resolving less.
  assert.equal(resolved, 'v2', 'a long banner must still resolve to the host version')
  // Measured 4824ms for this case with the full-prefix copy, and ~50ms with the
  // bounded anchor window. The copy's cost also varies ~3.5x with GC history
  // (the same input measured 1200ms at 40k tokens mid-suite vs 4400ms cold), so
  // the bound sits well under the fastest old measurement: >10x headroom to catch
  // the quadratic, ~8x of slack below it so a loaded CI box cannot flake this.
  assert.ok(
    elapsedMs < 400,
    `parsing a ${Buffer.byteLength(stdout)}-byte banner took ${elapsedMs.toFixed(0)}ms, expected <400ms`,
  )
})

test('an anchor beyond the bounded window loses its anchor but never resolves silently wrong', () => {
  // The anchor window is bounded (ANCHOR_WINDOW_BYTES in the parser) because
  // `[\s:=]*` is unbounded — no finite window is exact. Past the budget the
  // anchor is missed, so the parse falls back to consensus among all tokens,
  // which either agrees with the anchored answer or goes LOUD. It can never turn
  // one resolution into a different resolution.
  const warnings = []
  const resolved = resolveOpenCodeVersion('auto', {
    env: {},
    probe: hostSays(`opencode${' '.repeat(200)}2.0.22 node v1.18.33`),
    warn: (message) => warnings.push(message),
  })
  assert.equal(
    resolved,
    'v1',
    'a missed anchor must not silently read the host version from a runtime token',
  )
  assert.equal(warnings.length, 1, 'a missed anchor must go loud, not guess')

  // Inside the budget the anchor still decides, which is the whole point of it.
  assert.equal(
    resolveVersion({ probe: hostSays(`opencode${' '.repeat(8)}2.0.22 node v1.18.33`) }),
    'v2',
    'an anchor within the budget must still outrank a contradicting runtime token',
  )
})

test('the probe reads stdout first and only falls back to stderr', () => {
  // A host that prints its version to stderr must not soft-fail to v1.
  assert.equal(resolveVersion({ probe: hostStreams({ stderr: 'opencode v2.0.22\n' }) }), 'v2')
  assert.equal(resolveVersion({ probe: hostStreams({ stdout: 'opencode v2.0.22\n' }) }), 'v2')
  // When BOTH parse, stdout wins — stderr is the fallback, not a second vote.
  // If it were a second vote this 1.x host would flip to v2.
  assert.equal(
    resolveVersion({ probe: hostStreams({ stdout: 'opencode v1.18.33\n', stderr: 'v2.0.22\n' }) }),
    'v1',
  )
  // stderr is consulted only when stdout yields nothing.
  assert.equal(
    resolveVersion({
      probe: hostStreams({ stdout: 'built 2026.10.04\n', stderr: 'opencode v2.0.22\n' }),
    }),
    'v2',
  )
  // Neither stream readable is still a loud, soft v1.
  const warnings = []
  assert.equal(
    resolveOpenCodeVersion('auto', {
      env: {},
      probe: hostStreams({ stdout: '', stderr: '' }),
      warn: (message) => warnings.push(message),
    }),
    'v1',
  )
  assert.equal(warnings.length, 1, 'an empty probe on both streams must warn')
})

test('an explicit v1 install removes a registered V2 directory entry from config.plugins', async () => {
  // Coverage gap: the adjacent migration test already asserts this through
  // `auto` + OPENCODE_VERSION=v1, so the explicit-argument path was never
  // asserted on its own.
  const config = await installConfig({ plugins: [V2_PLUGIN, 'third-party-v2'] }, 'v1')

  assert.ok(!config.plugins.includes(V2_PLUGIN), 'V1 must not leave a V2 directory configured')
  assert.ok(config.plugins.includes('third-party-v2'), 'user entries must survive')
})

test('a corrupted install is repaired: V2 directory registered, both .ts paths purged', async () => {
  // Exact field state left behind by a V1 default run against a 2.x host: two
  // .ts file paths in the singular key, and nothing in the plural key.
  const config = await installConfig({ plugin: V1_TS_PATHS, plugins: [] }, undefined, {
    env: {},
    probe: hostSays('2.0.22'),
    warn: silentWarn,
  })

  assert.ok(config.plugins.includes(V2_PLUGIN), 'the V2 directory must be registered')
  for (const tsPath of V1_TS_PATHS) {
    assert.ok(!config.plugin.includes(tsPath), `stale V1 path must be purged: ${tsPath}`)
  }
})
