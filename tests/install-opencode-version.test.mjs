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
      yes: true,
      headless: true,
      version,
      ...extra,
    })
    return JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8'))
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
}

/** The registered Pantheon V2 entry, whatever shape the writer used. */
function v2EntryOf(config) {
  return (config.plugins ?? []).find(
    (entry) => pluginReferenceIdentity(entry) === pluginReferenceIdentity(V2_PLUGIN),
  )
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

// The refusal contract: Pantheon 2.0 requires OpenCode 2.x. The message names
// the product and the requirement and points at the v2/auto selectors.
const V1_REFUSAL = /Pantheon 2\.0 requires OpenCode 2\.x/

/** V1-only file paths the V1 generation registered in the singular `plugin` key. */
const V1_TS_PATHS = [
  join(ROOT, 'src', 'plugin.ts'),
  join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts'),
]

test('parses --opencode-version v2 and auto', () => {
  assert.equal(parseOpenCodeVersion(['init', '--opencode-version=v2']), 'v2')
  assert.equal(parseOpenCodeVersion(['init', '--opencode-version=auto']), 'auto')
  assert.equal(parseOpenCodeVersion(['init', '--opencode-version', 'v2']), 'v2')
  assert.equal(parseOpenCodeVersion(['init', '--opencode-version', 'auto']), 'auto')
})

test('an explicit v1 selector is a hard refusal naming Pantheon 2.0 and OpenCode 2.x', () => {
  // The V1 plugin line was removed in 2.0. The string is still accepted by the
  // parser ONLY so the refusal can be specific instead of a generic
  // "invalid value" — pointing at v2/auto.
  for (const args of [
    ['init', '--opencode-version=v1'],
    ['init', '--opencode-version', 'v1'],
    ['init', '--version=v1'],
    ['init', '--version', 'v1'],
  ]) {
    assert.throws(() => parseOpenCodeVersion(args), V1_REFUSAL)
    assert.throws(() => parseOpenCodeVersion(args), /v2.*auto|auto.*v2/)
  }
})

test('rejects invalid values and missing values', () => {
  assert.throws(
    () => parseOpenCodeVersion(['init', '--opencode-version=v3']),
    /expected v2 or auto/,
  )
  assert.throws(() => parseOpenCodeVersion(['init', '--version', 'v3']), /expected v2 or auto/)
  assert.throws(() => parseOpenCodeVersion(['init', '--version', 'banana']), /expected v2 or auto/)
  assert.throws(() => parseOpenCodeVersion(['init', '--version=banana']), /expected v2 or auto/)
  assert.throws(() => parseOpenCodeVersion(['init', '--version']), /--version requires a value/i)
})

test('rejects explicit version selectors with missing values', () => {
  for (const [args, flag] of [
    [['init', '--version'], '--version'],
    [['init', '--version', '--dry-run'], '--version'],
    [['init', '--version='], '--version'],
    [['init', '--opencode-version'], '--opencode-version'],
    [['init', '--opencode-version', '--yes'], '--opencode-version'],
    [['init', '--opencode-version='], '--opencode-version'],
  ]) {
    assert.throws(
      () => parseOpenCodeVersion(args),
      new RegExp(`${flag.replaceAll('-', '\\-')} requires a value`, 'i'),
    )
  }
})

test('auto resolves an explicit environment or opencode2 binary hint; v1 env is refused', () => {
  assert.equal(resolveOpenCodeVersion('auto', { env: { OPENCODE_VERSION: 'v2' } }), 'v2')
  assert.equal(resolveOpenCodeVersion('auto', { env: {}, binary: '/usr/bin/opencode2' }), 'v2')
  // OPENCODE_VERSION=v1 is a hard refusal, same as the explicit flag.
  assert.throws(
    () => resolveOpenCodeVersion('auto', { env: { OPENCODE_VERSION: 'v1' } }),
    V1_REFUSAL,
  )
  // An explicit 'v1' argument is refused before anything else is consulted.
  assert.throws(
    () => resolveOpenCodeVersion('v1', { env: {}, probe: hostSays('2.0.22') }),
    V1_REFUSAL,
  )
  assert.throws(() => resolveOpenCodeVersion('v3'), /expected v2 or auto/)
})

test('v2 leaves an UNLOADABLE third-party config.plugin entry where it is', async () => {
  const config = await installConfig(
    {
      plugin: ['user-v1-plugin'],
      plugins: ['user-v2-plugin'],
    },
    'v2',
  )

  // `user-v1-plugin` is a package shorthand: the V2 loader would resolve it
  // through npm install and fail (NpmInstallFailedError), so migrating it into
  // `plugins` would turn "ignored" into "the config fails to load". It stays in
  // the singular key, which the V2 host ignores.
  assert.equal(config.plugins[0], 'user-v2-plugin')
  assert.ok(!config.plugins.includes('user-v1-plugin'))
  assert.deepEqual(config.plugin, ['user-v1-plugin'])
  assert.equal(v2EntryOf(config).package, V2_PLUGIN)
  assert.deepEqual(v2EntryOf(config).options, {}, 'the entry must be able to carry options')
  assert.ok(!config.plugins.includes(V2_EXPORT))
  assert.ok(!config.plugins.includes(join(ROOT, 'src', 'plugin-v2.ts')))
  assert.ok(!config.plugins.some((entry) => pluginReferenceIdentity(entry) === 'src/plugin.ts'))
})

test('auto migrates a legacy config to the V2 entry without mixing Pantheon refs', async () => {
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
    // Neither entry is a directory the V2 loader can load — one is a shorthand,
    // the other a path that does not exist — so neither is migrated; both stay
    // in the legacy list, which V2 ignores, instead of breaking the V2 config.
    assert.ok(!v2.plugins.includes('third-party-v1'))
    assert.ok(!v2.plugins.includes('/tmp/vendor/pantheon-opencode/src/plugin.ts'))
    assert.deepEqual(v2.plugin, ['/tmp/vendor/pantheon-opencode/src/plugin.ts', 'third-party-v1'])
    assert.deepEqual(v2EntryOf(v2).options, {})
  } finally {
    if (previousVersion === undefined) delete process.env.OPENCODE_VERSION
    else process.env.OPENCODE_VERSION = previousVersion
  }
})

test('does not install or register TUI when the plugins component is omitted', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-no-plugins-'))
  try {
    await installOpenCode(target, false, false, NO_COMPONENTS, {
      yes: true,
      headless: true,
      version: 'v2',
    })
    assert.equal(existsSync(join(target, '.opencode', 'tui.json')), false)
    assert.equal(existsSync(join(target, '.opencode', 'plugins', 'pantheon-tui')), false)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('exact installed package plugin paths remain managed', () => {
  // The legacy .ts sources were removed from the package in 2.0, so only the
  // IDENTITY mapping is asserted here — the installer must still recognize a
  // legacy registration (existing user installs) as Pantheon-owned so
  // migrations/cleanup keep working. Recognition only; nothing registers them.
  const delegation = resolveInstalledPlugin(join(ROOT, 'src', 'plugin.ts'))
  const hooks = resolveInstalledPlugin(join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts'))
  assert.equal(delegation, join(ROOT, 'src', 'plugin.ts'))
  assert.equal(hooks, join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts'))
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
      hasV2Directory: v2EntryOf(config)?.package === V2_PLUGIN,
      tsFilePaths: (config.plugin ?? []).filter((entry) => entry.endsWith('.ts')).length,
    },
    { hasV2Directory: true, tsFilePaths: 0 },
  )
})

test('the default gate follows the host probe, with explicit > env > basename > probe precedence', () => {
  const resolve = (options) =>
    resolveOpenCodeVersion('auto', { env: {}, warn: silentWarn, ...options })

  // The probe decides when nothing above it is set. A definitive 2.x host
  // resolves to v2; a definitive 1.x host is REFUSED — Pantheon 2.0 cannot
  // install into it, and writing the V2 config there would silently drop the
  // plugin.
  assert.equal(resolve({ probe: hostSays('2.0.22') }), 'v2')
  assert.equal(resolve({ probe: hostSays('v2.4.1') }), 'v2', 'a leading "v" is tolerated')
  assert.throws(() => resolve({ probe: hostSays('1.18.33') }), /requires OpenCode 2\.x/)
  // Real hosts print the binary name first: `opencode --version` emits
  // "opencode v2.0.22". An anchored ^\d parser silently reads that as
  // unparseable and soft-fails every 2.x host to the fallback.
  assert.equal(resolve({ probe: hostSays('opencode v2.0.22\n') }), 'v2')
  assert.throws(() => resolve({ probe: hostSays('opencode v1.18.33\n') }), /requires OpenCode 2\.x/)

  // Soft failure: an unrunnable or unparseable host must not throw — it assumes
  // v2, the only supported generation, and warns.
  assert.equal(resolve({ probe: hostProbeFails }), 'v2')
  assert.equal(resolve({ probe: hostSays('not-a-version') }), 'v2')
  assert.equal(resolve({ probe: hostSays('') }), 'v2')

  // ...and it must never be SILENT. Assuming a generation the probe could not
  // read is the failure this gate exists to surface, so every inconclusive
  // path warns exactly once. Only the CALL is asserted — never the message
  // text, which is free to change.
  for (const probe of [hostProbeFails, hostSays('not-a-version'), hostSays('')]) {
    let warnings = 0
    resolveOpenCodeVersion('auto', { env: {}, probe, warn: () => (warnings += 1) })
    assert.equal(warnings, 1, 'an inconclusive probe must warn exactly once')
  }
  // A resolved host stays quiet.
  let quiet = 0
  resolveOpenCodeVersion('auto', {
    env: {},
    probe: hostSays('opencode v2.0.22'),
    warn: () => (quiet += 1),
  })
  assert.equal(quiet, 0, 'a successfully probed host must not warn')

  // OPENCODE_VERSION beats a contradicting probe; a v1 env var is refused.
  assert.equal(resolve({ env: { OPENCODE_VERSION: 'v2' }, probe: hostSays('1.18.33') }), 'v2')
  assert.throws(
    () => resolve({ env: { OPENCODE_VERSION: 'v1' }, probe: hostSays('2.0.22') }),
    V1_REFUSAL,
  )

  // An explicit argument beats a contradicting probe.
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
  // from the NODE token and flipped a genuine 1.x host to v2, with no warning.
  // The token that follows the tool name is the one that describes the host.
  // Under 2.0 the host is read correctly (1.x) and REFUSED — it must not be
  // misread as 2.x, and it must not be written a V2 config either.
  const warnings = []
  assert.throws(
    () =>
      resolveOpenCodeVersion('auto', {
        env: {},
        probe: hostSays('node v22.1.0 (opencode 1.18.33)'),
        warn: (message) => warnings.push(message),
      }),
    /requires OpenCode 2\.x/,
  )
  assert.equal(warnings.length, 0, 'a name-anchored match is a resolution, not a warning')
})

test('the tool-name match wins over later unrelated version-like tokens', () => {
  // Pins that we do NOT anchor to the last token: last-token anchoring matches
  // "2026.10.04" here and misreads this 1.x host. Under 2.0 the correct read
  // (1.x) refuses.
  assert.throws(
    () => resolveVersion({ probe: hostSays('opencode v1.18.33 built 2026.10.04') }),
    /requires OpenCode 2\.x/,
  )
  // Symmetric case, so the rule is not accidentally "always pick the first".
  assert.equal(resolveVersion({ probe: hostSays('opencode v2.0.22 built 2026.10.04') }), 'v2')
  // A leading runtime token must not outrank the tool's own version either way.
  assert.equal(resolveVersion({ probe: hostSays('node v20.11.0 (opencode 2.0.22)') }), 'v2')
})

test('the "v" prefix is matched case-insensitively', () => {
  // A case-sensitive "v" failed to parse and soft-failed with a warning.
  assert.equal(resolveVersion({ probe: hostSays('OpenCode V2.0.22') }), 'v2')
  assert.throws(() => resolveVersion({ probe: hostSays('opencode V1.18.33') }), V1_REFUSAL)
  assert.equal(resolveVersion({ probe: hostSays('OPENCODE v2.0.22') }), 'v2')
})

test('contradicting version tokens with no tool name warn loudly and assume v2', () => {
  // Nothing here says which token is the host's, so the gate must not guess a
  // HOST READ. It assumes v2 — the only generation it can write — and says so.
  const warnings = []
  const resolved = resolveOpenCodeVersion('auto', {
    env: {},
    probe: hostSays('1.18.33 (runtime 2.0.0)'),
    warn: (message) => warnings.push(message),
  })

  assert.equal(resolved, 'v2', 'an unresolvable contradiction must assume v2')
  assert.equal(warnings.length, 1, 'the contradiction must produce exactly one visible warning')
  assert.match(warnings[0], /Assuming v2/)
})

test('a date is never read as a major version', () => {
  // "2026.10.04" is version-SHAPED but is a build date. Reading its leading
  // "2026" as a major would misread the host in silence.
  for (const output of ['2026.10.04', 'opencode built 2026.10.04', 'dev build 2026.10.04 12:00']) {
    const warnings = []
    const resolved = resolveOpenCodeVersion('auto', {
      env: {},
      probe: hostSays(output),
      warn: (message) => warnings.push(message),
    })

    assert.equal(resolved, 'v2', `a bare date must assume v2: ${JSON.stringify(output)}`)
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

test('a major-0 prerelease banner is unresolvable rather than a silent guess', () => {
  // The original defect class — a config written for the wrong host — recurring
  // for a build that reports major 0. "0.0.0-next-17444" is the exact string
  // this repo's own comments cite, so the code has to reject it rather than
  // quietly read it as "older than 2". A genuine 0.x host is a decade away; if
  // one ever exists, a loud assumption of v2 is the correct direction to fail.
  for (const output of ['opencode 0.0.0-next-17444', 'opencode 0.1.0', '0.0.0-next-17444']) {
    const warnings = []
    const resolved = resolveOpenCodeVersion('auto', {
      env: {},
      probe: hostSays(output),
      warn: (message) => warnings.push(message),
    })

    assert.equal(resolved, 'v2', `a major-0 banner must assume v2: ${JSON.stringify(output)}`)
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
      'v2',
      `an uninterpretable anchored major must assume v2: ${JSON.stringify(output)}`,
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
    'v2',
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
  // A host that prints its version to stderr must not soft-fail.
  assert.equal(resolveVersion({ probe: hostStreams({ stderr: 'opencode v2.0.22\n' }) }), 'v2')
  assert.equal(resolveVersion({ probe: hostStreams({ stdout: 'opencode v2.0.22\n' }) }), 'v2')
  // When BOTH parse, stdout wins — stderr is the fallback, not a second vote.
  // If it were a second vote this 1.x host would flip to v2; under 2.0 the
  // correct stdout read (1.x) refuses the host outright.
  assert.throws(
    () =>
      resolveVersion({
        probe: hostStreams({ stdout: 'opencode v1.18.33\n', stderr: 'v2.0.22\n' }),
      }),
    /requires OpenCode 2\.x/,
  )
  // stderr is consulted only when stdout yields nothing.
  assert.equal(
    resolveVersion({
      probe: hostStreams({ stdout: 'built 2026.10.04\n', stderr: 'opencode v2.0.22\n' }),
    }),
    'v2',
  )
  // Neither stream readable is still a loud assumption of v2.
  const warnings = []
  assert.equal(
    resolveOpenCodeVersion('auto', {
      env: {},
      probe: hostStreams({ stdout: '', stderr: '' }),
      warn: (message) => warnings.push(message),
    }),
    'v2',
  )
  assert.equal(warnings.length, 1, 'an empty probe on both streams must warn')
})

test('a corrupted install is repaired: V2 directory registered, both .ts paths purged', async () => {
  // Exact field state left behind by a V1 default run against a 2.x host: two
  // .ts file paths in the singular key, and nothing in the plural key. The
  // migration (recognition of a legacy install) must purge both.
  const config = await installConfig({ plugin: V1_TS_PATHS, plugins: [] }, undefined, {
    env: {},
    probe: hostSays('2.0.22'),
    warn: silentWarn,
  })

  assert.equal(v2EntryOf(config)?.package, V2_PLUGIN, 'the V2 directory must be registered')
  for (const tsPath of V1_TS_PATHS) {
    assert.ok(!(config.plugin ?? []).includes(tsPath), `stale V1 path must be purged: ${tsPath}`)
  }
})
