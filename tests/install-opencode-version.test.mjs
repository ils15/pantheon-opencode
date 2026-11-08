import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  deduplicatePluginReferences,
  installOpenCode,
  pluginReferenceIdentity,
  resolveInstalledPlugin,
  resolveOpenCodeVersion,
  unsupportedHostMessage,
} from '../scripts/install/opencode.mjs'
import { ROOT } from '../scripts/install/shared.mjs'

const NO_COMPONENTS = []
// Canonical V2 entry: the plugin directory inside the installed package.
const V2_PLUGIN = join(ROOT, 'src', 'plugin')
const THIRD_PARTY_PANTHEON_OPENCODE_PLUGIN = '/tmp/vendor/pantheon-opencode/src/plugin.ts'
const THIRD_PARTY_PANTHEON_PLUGIN = '/tmp/vendor/pantheon/src/plugin.ts'

// `extra` is merged into the installer options bag. It exists so a test can
// omit any host pin (exercising the real default gate) while still pinning the
// host probe — CI has no `opencode` binary on PATH, so an unpinned probe would
// make these assertions environment-dependent instead of deterministic.
async function installConfig(existingConfig, extra = {}) {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-version-'))
  try {
    writeFileSync(join(target, 'opencode.json'), JSON.stringify(existingConfig, null, 2))
    await installOpenCode(target, false, false, NO_COMPONENTS, {
      yes: true,
      headless: true,
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
/** Swallow the unknown-host warning so test output stays readable. */
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
  resolveOpenCodeVersion({ env: {}, warn: silentWarn, ...options })

/** V1-only file paths the removed V1 generation registered in the singular key. */
const V1_TS_PATHS = [
  join(ROOT, 'src', 'plugin.ts'),
  join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts'),
]

test('the env pin accepts only v2 and refuses the v1 generation explicitly', () => {
  assert.equal(resolveOpenCodeVersion({ env: { OPENCODE_VERSION: 'v2' } }), 'v2')
  assert.throws(
    () => resolveOpenCodeVersion({ env: { OPENCODE_VERSION: 'v1' } }),
    (err) => {
      assert.match(err.message, /Pantheon 2\.0 requires OpenCode 2\.x/)
      assert.match(err.message, /this host is 1\.x/)
      return true
    },
  )
  assert.throws(
    () => resolveOpenCodeVersion({ env: { OPENCODE_VERSION: 'banana' } }),
    /Invalid OPENCODE_VERSION/,
  )
})

test('an opencode2 basename is a 2.x hint that skips the probe', () => {
  assert.equal(resolveOpenCodeVersion({ env: {}, binary: '/usr/bin/opencode2' }), 'v2')
  // A plain `opencode` basename carries no hint: the gate falls through to
  // the host probe. Pin a failing probe so the assertion cannot depend on
  // the developer's PATH — and there is no generation to fall back to, so
  // an unprobeable host is a refusal, not a warning.
  assert.throws(
    () =>
      resolveOpenCodeVersion({
        env: {},
        binary: '/usr/bin/opencode',
        probe: hostProbeFails,
        warn: silentWarn,
      }),
    /Could not probe the host OpenCode version/,
  )
})
test('V2-only installs never write .ts file paths and register the V2 directory', async () => {
  const config = await installConfig(
    { plugin: [], plugins: [V2_PLUGIN] },
    { env: {}, probe: hostSays('2.0.22'), warn: silentWarn },
  )

  assert.deepEqual(
    {
      hasV2Directory: v2EntryOf(config)?.package === V2_PLUGIN,
      tsFilePaths: (config.plugin ?? []).filter((entry) => entry.endsWith('.ts')).length,
    },
    { hasV2Directory: true, tsFilePaths: 0 },
  )
})

test('an UNLOADABLE third-party config.plugin entry stays where it is', async () => {
  const config = await installConfig(
    {
      plugin: ['user-v1-plugin'],
      plugins: ['user-v2-plugin'],
    },
    { env: {}, probe: hostSays('2.0.22'), warn: silentWarn },
  )

  // `user-v1-plugin` is a package shorthand: the loader would resolve it
  // through npm install and fail (NpmInstallFailedError), so migrating it into
  // `plugins` would turn "ignored" into "the config fails to load". It stays in
  // the singular key, which the host ignores.
  assert.equal(config.plugins[0], 'user-v2-plugin')
  assert.ok(!config.plugins.includes('user-v1-plugin'))
  assert.deepEqual(config.plugin, ['user-v1-plugin'])
  assert.equal(v2EntryOf(config).package, V2_PLUGIN)
  assert.deepEqual(v2EntryOf(config).options, {}, 'the entry must be able to carry options')
  assert.ok(!config.plugins.includes('pantheon-opencode/plugin'))
  assert.ok(!config.plugins.includes(join(ROOT, 'src', 'plugin.ts')))
  assert.ok(!config.plugins.some((entry) => pluginReferenceIdentity(entry) === 'src/plugin.ts'))
})

test('unloadable third-party entries in the singular key are named, not migrated', async () => {
  const config = await installConfig(
    {
      plugin: [THIRD_PARTY_PANTHEON_OPENCODE_PLUGIN, 'third-party-v1'],
      plugins: [V2_PLUGIN, 'third-party-v2'],
    },
    { env: {}, probe: hostSays('2.0.22'), warn: silentWarn },
  )
  // Neither entry is a directory the loader can load — one is a shorthand,
  // the other a path that does not exist — so neither is migrated; both stay
  // in the singular list, which the host ignores, instead of breaking the config.
  assert.ok(!v2EntryOf(config) === false, 'the V2 entry must still be registered')
  assert.ok(!config.plugins.includes('third-party-v1'))
  assert.ok(!config.plugins.includes('/tmp/vendor/pantheon-opencode/src/plugin.ts'))
  assert.deepEqual(v2EntryOf(config).options, {})
})

test('does not install or register TUI when the plugins component is omitted', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-no-plugins-'))
  try {
    await installOpenCode(target, false, false, NO_COMPONENTS, {
      yes: true,
      headless: true,
      env: {},
      probe: hostSays('2.0.22'),
      warn: silentWarn,
    })
    assert.equal(existsSync(join(target, '.opencode', 'tui.json')), false)
    assert.equal(existsSync(join(target, '.opencode', 'plugins', 'pantheon-tui')), false)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('legacy V1 plugin paths heal to the canonical directory, and the files are gone', () => {
  // The .ts files are gone from this package. A stale ref to the plugin entry
  // HEALS to the canonical directory identity (the only shape the loader
  // accepts), while non-entry legacy paths keep their verbatim identity so
  // cleanup can still strip them.
  assert.equal(resolveInstalledPlugin(join(ROOT, 'src', 'plugin.ts')), join(ROOT, 'src', 'plugin'))
  assert.equal(
    resolveInstalledPlugin(join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts')),
    join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts'),
  )
  assert.equal(existsSync(join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts')), false)
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
    join(ROOT, 'src', 'plugin'),
    '/user/plugin.ts',
    '/another/plugin.ts',
    'custom-plugin',
    'custom-plugin',
  ])
  // The .ts ref and the directory share one Pantheon identity: exactly one
  // survives (the first seen). Basenames never collapse anything: both
  // /user/plugin.ts and /another/plugin.ts stay.
  assert.equal(refs.filter((entry) => pluginReferenceIdentity(entry) === 'src/plugin').length, 1)
  assert.ok(refs.includes('/user/plugin.ts'))
  assert.ok(refs.includes('/another/plugin.ts'))
  assert.equal(refs.filter((entry) => entry === 'custom-plugin').length, 1)
})
// ─── Host-version gate ──────────────────────────────────────────────────────

test('a confirmed 1.x host is refused with the exact unsupported-host message', () => {
  const refusal = unsupportedHostMessage(1)
  assert.match(refusal, /Pantheon 2\.0 requires OpenCode 2\.x/)
  assert.match(refusal, /this host is 1\.x — uninstall Pantheon 1\.x or upgrade the host/)
  for (const output of ['1.18.33', 'opencode v1.18.33\n', 'node v22.1.0 (opencode 1.18.33)']) {
    let warnings = 0
    assert.throws(
      () =>
        resolveOpenCodeVersion({
          env: {},
          probe: hostSays(output),
          warn: () => (warnings += 1),
        }),
      /Pantheon 2\.0 requires OpenCode 2\.x; this host is 1\.x/,
      `a 1.x host must be refused: ${JSON.stringify(output)}`,
    )
    assert.equal(warnings, 0, 'a 1.x refusal is an error, not a warning')
  }
})

test('an anchored 2.x probe resolves quietly, and the probe decides when nothing else is set', () => {
  const resolve = (options) => resolveOpenCodeVersion({ env: {}, warn: silentWarn, ...options })

  assert.equal(resolve({ probe: hostSays('2.0.22') }), 'v2')
  assert.equal(resolve({ probe: hostSays('v2.4.1') }), 'v2', 'a leading "v" is tolerated')
  // Real hosts print the binary name first: `opencode --version` emits
  // "opencode v2.0.22". An anchored-^\d parser would read that as unparseable.
  assert.equal(resolve({ probe: hostSays('opencode v2.0.22\n') }), 'v2')
  // A resolved host stays quiet.
  let quiet = 0
  resolveOpenCodeVersion({
    env: {},
    probe: hostSays('opencode v2.0.22'),
    warn: () => (quiet += 1),
  })
  assert.equal(quiet, 0, 'a successfully probed host must not warn')
})

test('an unknown host is refused loudly — there is no generation to fall back to', () => {
  // A failed or unreadable probe says nothing about the generation, and the
  // installer cannot confirm the one premise it writes for, so it refuses.
  // OPENCODE_VERSION=v2 is the deterministic escape hatch.
  for (const [probe, cause] of [
    [hostProbeFails, /Could not probe the host OpenCode version/],
    [hostSays('not-a-version'), /Could not parse the host OpenCode version/],
    [hostSays(''), /Could not parse the host OpenCode version/],
  ]) {
    let warnings = 0
    assert.throws(
      () =>
        resolveOpenCodeVersion({
          env: {},
          probe,
          warn: () => (warnings += 1),
        }),
      cause,
      'an unknown host must refuse, naming the pin escape hatch',
    )
    assert.equal(warnings, 0, 'a refusal is an error, not a warning')
  }
})
test('the env pin beats a contradicting probe', () => {
  assert.equal(
    resolveOpenCodeVersion({ env: { OPENCODE_VERSION: 'v2' }, probe: hostSays('1.18.33') }),
    'v2',
  )
})

test('the ordering trap: an `opencode2` basename wins over the probe read', () => {
  assert.equal(
    resolveOpenCodeVersion({
      env: { OPENCODE_BIN: '/usr/local/bin/opencode2' },
      // The basename short-circuits before the probe is read, so the value is
      // irrelevant to what this test pins.
      probe: hostSays('not-a-version'),
    }),
    'v2',
  )
})

test('a version-like token ahead of the tool name cannot flip the verdict', () => {
  // Reviewer-proven silent misclassification: first-match-wins took "22.1.0"
  // from the NODE token and read a genuine 1.x host as 2.x, with no warning.
  // The token that follows the tool name is the one that describes the host —
  // and with V2-only, that means the difference between a quiet pass and the
  // hard 1.x refusal.
  assert.throws(
    () => resolveVersion({ probe: hostSays('node v22.1.0 (opencode 1.18.33)') }),
    /this host is 1\.x/,
    'a 1.x host behind a node 22 prefix must still be refused',
  )
  // The tool name disambiguated it, so this is a RESOLVED host, not an unknown:
  // a genuine 2.x behind the same prefix stays quiet.
  let warnings = 0
  assert.equal(
    resolveOpenCodeVersion({
      env: {},
      probe: hostSays('node v22.1.0 (opencode 2.0.22)'),
      warn: () => (warnings += 1),
    }),
    'v2',
  )
  assert.equal(warnings, 0, 'a name-anchored match is a resolution, not a warning')
})

test('the tool-name match wins over later unrelated version-like tokens', () => {
  // Pins that we do NOT anchor to the last token: last-token anchoring matches
  // "2026.10.04" here and misreads this 1.x host — the refusal below proves the
  // host token decided.
  assert.throws(
    () => resolveVersion({ probe: hostSays('opencode v1.18.33 built 2026.10.04') }),
    /this host is 1\.x/,
  )
  // Symmetric case, so the rule is not accidentally "always pick the first".
  assert.equal(resolveVersion({ probe: hostSays('opencode v2.0.22 built 2026.10.04') }), 'v2')
  // A leading runtime token must not outrank the tool's own version either way.
  assert.equal(resolveVersion({ probe: hostSays('node v20.11.0 (opencode 2.0.22)') }), 'v2')
})

test('the "v" prefix is matched case-insensitively', () => {
  // A case-sensitive "v" would fail to parse and push a genuine 1.x host into
  // the unknown fallback instead of the refusal — this pins both directions.
  assert.throws(() => resolveVersion({ probe: hostSays('opencode V1.18.33') }), /this host is 1\.x/)
  assert.equal(resolveVersion({ probe: hostSays('OpenCode V2.0.22') }), 'v2')
  assert.equal(resolveVersion({ probe: hostSays('OPENCODE v2.0.22') }), 'v2')
})

test('contradicting version tokens with no tool name refuse loudly', () => {
  // Nothing here says which token is the host's, so the gate must not treat
  // it as a fact. With no generation left to fall back to, the contradiction
  // refuses instead of warning.
  let warnings = 0
  assert.throws(
    () =>
      resolveOpenCodeVersion({
        env: {},
        probe: hostSays('1.18.33 (runtime 2.0.0)'),
        warn: () => (warnings += 1),
      }),
    /contradictory versions/,
  )
  assert.equal(warnings, 0, 'a refusal is an error, not a warning')
})
test('a date is never read as a major version', () => {
  // "2026.10.04" is version-SHAPED but a build date. Unanchored and
  // implausible it is noise — and when nothing version-shaped survives, the
  // gate refuses instead of guessing.
  for (const output of ['2026.10.04', 'opencode built 2026.10.04', 'dev build 2026.10.04 12:00']) {
    assert.throws(
      () => resolveVersion({ probe: hostSays(output) }),
      /Could not parse the host OpenCode version/,
      `a bare date must refuse: ${JSON.stringify(output)}`,
    )
  }
  // A date alongside a real version is noise, not a contradiction: the
  // name-anchored version decides and the host stays quiet.
  let warnings = 0
  assert.equal(
    resolveOpenCodeVersion({
      env: {},
      probe: hostSays('opencode v2.0.22 built 2026.10.04'),
      warn: () => (warnings += 1),
    }),
    'v2',
  )
  assert.equal(warnings, 0, 'a trailing build date is noise, not ambiguity')
})
test('a major-0 prerelease banner is an unreadable self-report and refuses', () => {
  // "0.0.0-next-17444" is NOT a release number, so it must never read as
  // "older than 2" (a 2.x beta refused as a 1.x host is the defect class).
  // Anchored, it is the host's own version and this gate will not interpret
  // it: with no fallback generation left, that is a loud refusal. Bare, the
  // 0 is unanchored noise, so the refusal arrives through the nothing-shaped
  // path instead — either way it is loud.
  for (const output of ['opencode 0.0.0-next-17444', 'opencode 0.1.0', '0.0.0-next-17444']) {
    assert.throws(
      () => resolveVersion({ probe: hostSays(output) }),
      /Pantheon 2\.0 requires OpenCode 2\.x/,
      `a major-0 banner must refuse loudly: ${JSON.stringify(output)}`,
    )
  }
  // An UNANCHORED 0 alongside a real version stays noise, like a date: the
  // surviving token still decides, and the host stays quiet.
  let warnings = 0
  assert.equal(
    resolveOpenCodeVersion({
      env: {},
      probe: hostSays('opencode v2.0.22 (build 0.9.9)'),
      warn: () => (warnings += 1),
    }),
    'v2',
  )
  assert.equal(warnings, 0, 'an unanchored 0 next to a real host version is noise')
})
test('an anchored major we cannot interpret refuses even when a runtime token survives', () => {
  // A name-anchored token IS the host's own version. When its major is one
  // this gate refuses to interpret (0, or a calendar year >= 100), dropping
  // it and letting a surviving `node v22` promote itself to deciding power
  // would be a silent wrong answer. With no fallback generation left, the
  // unreadable self-report refuses.
  for (const output of ['opencode 100.0.0 (node v22.1.0)', 'opencode 100.0.0 (runtime 2.0.0)']) {
    assert.throws(
      () => resolveVersion({ probe: hostSays(output) }),
      /Pantheon 2\.0 requires OpenCode 2\.x/,
      `an uninterpretable anchored major must refuse: ${JSON.stringify(output)}`,
    )
  }
  // The quiet counterpart stays quiet: an UNANCHORED date is noise, not an
  // unreadable host version. Only the anchored case is loud.
  let warnings = 0
  assert.equal(
    resolveOpenCodeVersion({
      env: {},
      probe: hostSays('opencode v2.0.22 built 2026.10.04'),
      warn: () => (warnings += 1),
    }),
    'v2',
  )
  assert.equal(warnings, 0, 'a dropped unanchored date must stay silent')
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

test('an anchor beyond the bounded window refuses instead of guessing', () => {
  // The anchor window is bounded (ANCHOR_WINDOW_BYTES) because the separator
  // run is unbounded — no finite window is exact. Past the budget the anchor
  // is missed and the parse falls back to consensus among all tokens, which
  // here disagrees: with no generation to fall back to, that is a refusal,
  // never a silent pick.
  assert.throws(
    () =>
      resolveVersion({
        probe: hostSays(`opencode${' '.repeat(200)}2.0.22 node v1.18.33`),
      }),
    /contradictory versions/,
    'a missed anchor must not silently read the host version from a runtime token',
  )
  // Inside the budget the anchor still decides, which is the whole point of it.
  assert.equal(
    resolveVersion({
      probe: hostSays(`opencode${' '.repeat(8)}2.0.22 node v1.18.33`),
    }),
    'v2',
    'an anchor within the budget must still outrank a contradicting runtime token',
  )
})
test('the probe reads stdout first and only falls back to stderr', () => {
  // A host that prints its version to stderr is not unknown: stderr is the
  // fallback stream, never a second vote.
  assert.equal(resolveVersion({ probe: hostStreams({ stderr: 'opencode v2.0.22\n' }) }), 'v2')
  assert.equal(resolveVersion({ probe: hostStreams({ stdout: 'opencode v2.0.22\n' }) }), 'v2')
  // When BOTH parse, stdout wins — otherwise this 1.x host would slip past
  // the refusal on the strength of its stderr.
  assert.throws(
    () =>
      resolveVersion({
        probe: hostStreams({ stdout: 'opencode v1.18.33\n', stderr: 'v2.0.22\n' }),
      }),
    /this host is 1\.x/,
  )
  // stderr is consulted only when stdout yields nothing.
  assert.equal(
    resolveVersion({
      probe: hostStreams({ stdout: 'built 2026.10.04\n', stderr: 'opencode v2.0.22\n' }),
    }),
    'v2',
  )
  // Both streams empty: nothing version-shaped anywhere — a refusal.
  assert.throws(
    () => resolveVersion({ probe: hostStreams({ stdout: '', stderr: '' }) }),
    /Could not parse the host OpenCode version/,
    'an empty probe on both streams must refuse',
  )
})
test('a corrupted stale-V1 install is repaired: V2 directory registered, both .ts paths purged', async () => {
  // Exact field state left behind by the old V1 branch: two .ts file paths in
  // the singular key, and nothing in the plural key.
  const config = await installConfig(
    { plugin: V1_TS_PATHS, plugins: [] },
    {
      env: {},
      probe: hostSays('2.0.22'),
      warn: silentWarn,
    },
  )

  assert.equal(v2EntryOf(config)?.package, V2_PLUGIN, 'the V2 directory must be registered')
  for (const tsPath of V1_TS_PATHS) {
    assert.ok(!(config.plugin ?? []).includes(tsPath), `stale V1 path must be purged: ${tsPath}`)
  }
})
