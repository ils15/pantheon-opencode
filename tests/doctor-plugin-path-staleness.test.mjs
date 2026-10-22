/**
 * doctor-plugin-path-staleness.test.mjs — P0-6 regression (ADR-0014).
 *
 * The installer writes an ABSOLUTE path into the host config
 * (`resolveInstalledPlugin` → `join(ROOT, 'src/plugin-v2')`), and only `init`
 * re-resolves it. An upgrade route that does not run `init` (`npm i -g` into a
 * different prefix, a cleaned npx cache, a moved tree) leaves the config
 * pointing at a tree that no longer exists — and the host silently drops a
 * plugin it cannot load, so the old tool surface keeps "working" with no error.
 *
 * The doctor must therefore fail CLOSED on a Pantheon-owned registration whose
 * path does not resolve, and must stay silent for third-party refs and npm
 * specs (never a false positive on paths this installer does not own).
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPluginVersionDrift, managedPluginPath } from '../scripts/doctor.mjs'

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))
const PACKAGE_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

/** A project whose opencode.json registers `refs` under `key`. */
function makeFixture(refs, key = 'plugins') {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-doctor-stale-'))
  mkdirSync(join(dir, '.config', 'opencode'), { recursive: true })
  writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ [key]: refs }))
  return dir
}

/** Simulate an installed tree at `root` (dir + readable package.json). */
function seedInstalledTree(root, version) {
  mkdirSync(join(root, 'src', 'plugin-v2'), { recursive: true })
  writeFileSync(join(root, 'src', 'plugin-v2', 'index.ts'), '// plugin entry\n')
  writeFileSync(join(root, 'src', 'plugin.ts'), '// plugin entry\n')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'pantheon-opencode', version }))
  return root
}

function runDoctorCli(fixture) {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'doctor.mjs'), '--json'], {
    cwd: fixture,
    encoding: 'utf8',
    env: { ...process.env, HOME: fixture, XDG_CONFIG_HOME: join(fixture, '.config') },
  })
  const report = JSON.parse(result.stdout)
  return { status: result.status, report }
}

// ---------------------------------------------------------------------------
// Managed-ref classification
// ---------------------------------------------------------------------------
// Only refs this installer writes are managed. An absolute PATH built from the
// plugin identity, config-relative identities, and legacy V2 file refs are
// managed; third-party paths, npm specs and unrelated names are not.
assert.equal(managedPluginPath('src/plugin.ts'), 'src/plugin.ts', 'relative V1 identity is managed')
assert.equal(
  managedPluginPath('src/plugins/pantheon-hooks.ts'),
  'src/plugins/pantheon-hooks.ts',
  'relative hooks identity is managed',
)
assert.equal(
  managedPluginPath('src/plugin-v2'),
  'src/plugin-v2',
  'relative V2 directory is managed',
)
assert.equal(
  managedPluginPath('/home/u/.npm/_npx/abc/node_modules/pantheon-opencode/src/plugin-v2'),
  '/home/u/.npm/_npx/abc/node_modules/pantheon-opencode/src/plugin-v2',
  'installed-package V2 directory is managed',
)
assert.equal(
  managedPluginPath(
    'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\pantheon-opencode\\src\\plugin.ts',
  )
    ?.replaceAll('\\', '/')
    .endsWith('/node_modules/pantheon-opencode/src/plugin.ts'),
  true,
  'Windows-separated installed path is managed after normalization',
)
assert.equal(
  managedPluginPath('src/plugin-v2.ts'),
  'src/plugin-v2.ts',
  'legacy V2 file ref is managed',
)

assert.equal(
  managedPluginPath('/opt/third-party/vendor/src/plugin.ts'),
  null,
  'third-party path ending in src/plugin.ts is NOT managed',
)
assert.equal(
  managedPluginPath('/opt/node_modules/pantheon-opencode-fork/src/plugin.ts'),
  null,
  'similarly-named package is NOT managed',
)
assert.equal(
  managedPluginPath('pantheon-opencode/plugin-v2'),
  null,
  'npm package export is a spec, not a filesystem path',
)
assert.equal(managedPluginPath('@scope/custom-plugin'), null, 'third-party npm spec is not managed')
assert.equal(managedPluginPath(42), null, 'non-string ref is ignored')

// ---------------------------------------------------------------------------
// Fail closed: a managed registration whose tree is gone
// ---------------------------------------------------------------------------
{
  // The "upgrade did not run init" shape: the config still registers the tree
  // the previous install lived in (an npx cache that was cleaned).
  const goneTree = join(
    mkdtempSync(join(tmpdir(), 'pantheon-gone-')),
    '.npm',
    '_npx',
    'deadbeef',
    'node_modules',
    'pantheon-opencode',
  )
  const staleRef = join(goneTree, 'src', 'plugin-v2')
  const fixture = makeFixture([staleRef])
  try {
    assert.equal(
      checkPluginVersionDrift({ target: fixture, env: { HOME: fixture } }),
      'stale',
      'V2 registration pointing at a nonexistent tree fails closed (stale)',
    )

    const { report } = runDoctorCli(fixture)
    const finding = report.findings.find((f) => f.code === 'plugin_path_missing')
    assert.ok(finding, 'doctor CLI reports the dangling Pantheon plugin path')
    assert.equal(finding.classification, 'error', 'dangling path is a blocking finding')
    assert.equal(report.status, 'error', 'dangling path makes the report status error')
    assert.match(finding.message, /does not exist/, 'finding states the path does not exist')
    assert.match(
      finding.message,
      /pantheon-opencode init/,
      'finding tells the user the command that re-resolves the registration',
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

{
  // Same defect on the V1 generation (singular `plugin` list).
  const goneRoot = join(
    mkdtempSync(join(tmpdir(), 'pantheon-gone-v1-')),
    'node_modules',
    'pantheon-opencode',
  )
  const fixture = makeFixture([join(goneRoot, 'src', 'plugin.ts')], 'plugin')
  try {
    assert.equal(
      checkPluginVersionDrift({ target: fixture, env: { HOME: fixture } }),
      'stale',
      'V1 registration pointing at a nonexistent tree fails closed (stale)',
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

{
  // The installer's V2 writer emits the OBJECT form `{ package: <abs>, options }`
  // whenever it preserves existing plugin options. That shape must be covered
  // too, or an install with `context_sandbox` set would stay invisible.
  const goneTree = join(
    mkdtempSync(join(tmpdir(), 'pantheon-gone-obj-')),
    'node_modules',
    'pantheon-opencode',
  )
  const fixture = makeFixture([
    { package: join(goneTree, 'src', 'plugin-v2'), options: { context_sandbox: 7 } },
  ])
  try {
    assert.equal(
      checkPluginVersionDrift({ target: fixture, env: { HOME: fixture } }),
      'stale',
      'object-shaped V2 entry (package + options) fails closed when the tree is gone',
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Re-resolution contract: a registration that points at the installed tree
// ---------------------------------------------------------------------------
{
  // `npm i -g` into a NEW prefix, then `init` (or a manual realign) rewrites the
  // ref to that tree. The doctor must accept it — and reject the old ref.
  const scratch = mkdtempSync(join(tmpdir(), 'pantheon-upgrade-'))
  const oldTree = seedInstalledTree(
    join(scratch, '.npm', '_npx', 'old', 'node_modules', 'pantheon-opencode'),
    '1.0.0',
  )
  const newTree = seedInstalledTree(
    join(scratch, '.nvm', 'v26', 'lib', 'node_modules', 'pantheon-opencode'),
    PACKAGE_VERSION,
  )
  const fixture = makeFixture([join(oldTree, 'src', 'plugin-v2')])
  try {
    assert.equal(
      checkPluginVersionDrift({ target: fixture, env: { HOME: fixture } }),
      'drift',
      'a registration still pointing at the OLD tree is reported (advisory drift)',
    )

    // What `init` writes after the upgrade: the NEW tree, resolved the same way
    // resolveInstalledPlugin does (ROOT + identity).
    writeFileSync(
      join(fixture, 'opencode.json'),
      JSON.stringify({ plugins: [join(newTree, 'src', 'plugin-v2')] }),
    )
    assert.equal(
      checkPluginVersionDrift({ target: fixture, env: { HOME: fixture } }),
      'sync',
      'after re-resolution the registration is accepted',
    )
    const { report } = runDoctorCli(fixture)
    assert.equal(
      report.findings.some((f) => f.code === 'plugin_path_missing'),
      false,
      'no dangling-path finding once the ref points at the installed tree',
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// No false positives
// ---------------------------------------------------------------------------
{
  // Third-party and npm-spec refs are not ours: an absent absolute third-party
  // path must never be turned into a Pantheon error.
  const fixture = makeFixture(['/opt/third-party/src/plugin.ts', 'pantheon-opencode@1.5.0'])
  try {
    assert.equal(
      checkPluginVersionDrift({ target: fixture, env: { HOME: fixture } }),
      'skip',
      'third-party/npm-spec registrations are not flagged',
    )
    const { report } = runDoctorCli(fixture)
    assert.equal(
      report.findings.some((f) => f.code === 'plugin_path_missing'),
      false,
      'no dangling-path finding for refs the installer does not own',
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

console.log('✅ Doctor plugin path staleness contract passed')
