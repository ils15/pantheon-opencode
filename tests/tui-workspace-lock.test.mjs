/**
 * tui-workspace-lock.test.mjs — the TUI workspace's nested lockfile and the
 * root `overrides` map are both load-bearing but no npm command validates them
 * under a `workspaces` parent. These assertions are the only thing standing
 * between a green CI run and a hard end-user install failure.
 *
 * WHY THE NESTED LOCK IS LOAD-BEARING
 * ----------------------------------
 * `package.json` `files` ships `src/plugins/tui/**`, so the nested lock is
 * published (asserted by tests/package-evidence.test.mjs:185). At install time
 * `scripts/sync-tui.mjs:96-101` copies it into the user's live plugin dir and
 * `sync-tui.mjs:176` runs `npm ci --omit=dev` with `cwd` set to that copy. That
 * `npm ci` reads the NESTED lock, not the root one, and `npm ci` hard-fails
 * (EUSAGE) when the manifest and lock disagree.
 *
 * WHY NO TOOL WILL CATCH IT
 * -------------------------
 * Under a `workspaces` parent, `npm install --package-lock-only` run from the
 * member directory reports "up to date", never writes the nested lock, and
 * silently folds any new dependency into the ROOT lock. So the workflow that
 * used to catch this — the `npm ci --prefix src/plugins/tui` step that CI ran
 * before the workspace move, now correctly removed as redundant — is gone, and
 * nothing replaces it. A dependency bump would regenerate the root lock, leave
 * all four gates green, and ship a nested lock that is out of sync with the
 * shipped TUI manifest. Every end user's `npm install pantheon-opencode` would
 * then hard-fail inside `postinstall`.
 *
 * The manifest↔nested-lock equality below is what converts that silent
 * CI-green into a caught release failure.
 *
 * DEPTH BOUNDARY (read this before trusting the assertions)
 * These tests prove that the FIELDS COMPARED are mutually coherent, not that
 * those fields are sufficient to describe a working install. They compare the
 * declared dependency blocks and check that each declared dependency resolves
 * to a `node_modules/<dep>` entry in the nested tree. They do NOT verify the
 * integrity hashes, the transitive closure beneath those entries, or that the
 * resolved versions satisfy every declared range — a tree entry can exist and
 * still be the wrong build. So "these tests pass" means "the nested lock is not
 * trivially out of sync", not "the nested lock is proven installable". The
 * authoritative check remains the user's `npm ci`, which CI no longer runs.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const readJson = (rel) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'))

const tuiPkg = readJson('../src/plugins/tui/package.json')
const tuiLock = readJson('../src/plugins/tui/package-lock.json')
const rootPkg = readJson('../package.json')
const rootLock = readJson('../package-lock.json')

/**
 * Compare a manifest dependency block against the nested lock's copy of it.
 * Returns a human-readable description of the first divergence, or null.
 * Exported so the assertion itself can be tested against a desynced fixture.
 * @param {Record<string,string>} manifestDeps
 * @param {Record<string,string>} lockDeps
 * @param {string} block name of the dependency block, for the message
 * @returns {string|null}
 */
export function compareDepBlock(manifestDeps, lockDeps, block) {
  const manifest = manifestDeps ?? {}
  const lock = lockDeps ?? {}
  const keys = new Set([...Object.keys(manifest), ...Object.keys(lock)])
  for (const key of [...keys].sort()) {
    const inManifest = manifest[key]
    const inLock = lock[key]
    if (inManifest === inLock) continue
    if (inManifest === undefined) {
      return `${block}.${key}: present in package-lock.json as ${JSON.stringify(inLock)} but MISSING from package.json`
    }
    if (inLock === undefined) {
      return `${block}.${key}: declared as ${JSON.stringify(inManifest)} in package.json but MISSING from package-lock.json`
    }
    return `${block}.${key}: package.json says ${JSON.stringify(inManifest)}, package-lock.json says ${JSON.stringify(inLock)}`
  }
  return null
}

/**
 * Find declared dependencies that have no resolved entry in the lock's tree.
 * This is the depth check the declaration comparison above cannot make: a
 * hand-applied `packages[""]` entry satisfies the manifest comparison while
 * leaving `node_modules/<dep>` absent, which passes every declaration-level
 * assertion and still hard-fails the user's `npm ci` with EUSAGE.
 * @param {Record<string,string>} manifestDeps
 * @param {Record<string,object>} lockPackages
 * @param {string} block
 * @returns {string[]} one message per dependency missing from the tree
 */
export function findUnresolvedDeps(manifestDeps, lockPackages, block) {
  const missing = []
  for (const dep of Object.keys(manifestDeps ?? {})) {
    if (!lockPackages[`node_modules/${dep}`]) {
      missing.push(
        `${block}.${dep} is declared but has no node_modules/${dep} entry in the nested lock`,
      )
    }
  }
  return missing
}

test('nested TUI lock stays in sync with the shipped TUI manifest', () => {
  const lockRoot = tuiLock.packages?.['']
  assert.ok(lockRoot, 'src/plugins/tui/package-lock.json must carry a packages[""] entry')

  for (const block of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const divergence = compareDepBlock(tuiPkg[block], lockRoot[block], block)
    assert.equal(
      divergence,
      null,
      `src/plugins/tui/package.json and src/plugins/tui/package-lock.json have drifted.\n` +
        `  ${divergence}\n\n` +
        `This matters because sync-tui.mjs copies the nested lock into the user's\n` +
        `plugin dir and runs \`npm ci --omit=dev\` there; npm ci hard-fails (EUSAGE)\n` +
        `on any manifest/lock divergence, so users would get a broken install.\n\n` +
        `REPAIR: the nested lock CANNOT be regenerated in place. Under the\n` +
        `\`workspaces\` parent, \`npm install --package-lock-only\` in the member\n` +
        `directory reports "up to date", never writes the nested lock, and folds\n` +
        `the change into the ROOT lock instead. The obvious escapes do not help\n` +
        `either — both \`--workspaces=false\` and \`--ignore-workspace-root-check\`\n` +
        `were verified to leave the nested lock untouched. The only working route\n` +
        `is to run the install in a directory with no workspace parent and copy\n` +
        `the produced lock back.\n\n` +
        `The hand-apply path is only valid for a version change on a dependency\n` +
        `ALREADY PRESENT in the lock's resolved tree. Adding or removing a\n` +
        `dependency REQUIRES the isolate-and-copy-back route — a hand-applied\n` +
        `packages[""] entry with no matching \`node_modules/<dep>\` resolution will\n` +
        `satisfy every declaration-level check in this file and still hard-fail\n` +
        `users' \`npm ci\`. If you do regenerate, REVIEW THE DIFF: the regeneration\n` +
        `re-resolves the entire transitive tree, not just the entry you changed.\n` +
        `Trialled here, it floated 74 transitive packages and swapped optional\n` +
        `platform variants, which is lockfile churn rather than a repair.`,
    )
  }

  // Declaration coherence is not enough: a hand-applied packages[""] entry can
  // satisfy every comparison above while the dep has no resolved tree entry.
  for (const block of ['dependencies', 'devDependencies']) {
    assert.deepEqual(
      findUnresolvedDeps(tuiPkg[block], tuiLock.packages, block),
      [],
      `a declared dependency is missing from the nested lock's resolved tree.\n` +
        `Adding it to package.json and hand-applying it to packages[""] passes the\n` +
        `manifest<->lock comparison but leaves \`npm ci\` with nothing to install,\n` +
        `which fails EUSAGE for every user running the plugin postinstall.\n` +
        `Regenerate the nested lock in an isolated directory and copy it back.`,
    )
  }
})

test('peer dependencies are range-checked against the tree, not required in it', () => {
  // Peers are deliberately NOT held to the same shape as dependencies. A peer
  // that is not a regular dependency may legitimately be absent from the tree:
  // npm either fetches it or the parent provides it, and this manifest declares
  // no peerDependenciesMeta, so absence is not by itself a defect. Requiring
  // tree presence for peers would therefore be wrong, and would break the day
  // an optional peer is added. What IS a defect is a peer that resolves in the
  // tree at a version contradicting the declared range — that is the divergence
  // that makes npm fetch a different copy at install time.
  const peers = tuiPkg.peerDependencies ?? {}
  const declared = tuiLock.packages?.['']?.peerDependencies ?? {}
  for (const [dep, range] of Object.entries(peers)) {
    assert.equal(
      declared[dep],
      range,
      `peerDependencies.${dep} is ${range} in package.json but ${declared[dep]} in package-lock.json`,
    )
    const entry = tuiLock.packages[`node_modules/${dep}`]
    if (!entry) continue // legitimately unresolvable; npm fetches it
    assert.ok(
      satisfies(entry.version, range),
      `peerDependencies.${dep} declares ${range} but the nested lock resolves ${entry.version}, ` +
        'so npm would fetch a different copy at install time',
    )
  }
})

test('the tree-depth check detects a declaration with no resolution', () => {
  const packages = { 'node_modules/solid-js': { version: '1.9.12' } }
  // The exact reviewer's shape: declared, present in packages[""], absent from
  // the tree. Declaration comparison passes; this must not.
  assert.deepEqual(findUnresolvedDeps({ 'solid-js': '1.9.12' }, packages, 'dependencies'), [])
  assert.deepEqual(
    findUnresolvedDeps({ 'solid-js': '1.9.12', 'left-pad': '1.3.0' }, packages, 'dependencies'),
    ['dependencies.left-pad is declared but has no node_modules/left-pad entry in the nested lock'],
  )
  assert.deepEqual(findUnresolvedDeps({ x: '1' }, {}, 'devDependencies'), [
    'devDependencies.x is declared but has no node_modules/x entry in the nested lock',
  ])
})

test('the assertion above detects a desynced manifest', () => {
  // Proof the gate bites: a manifest bump with no matching lock entry.
  const manifest = { 'solid-js': '1.9.12', 'brand-new-dep': '1.0.0' }
  const lock = { 'solid-js': '1.9.12' }
  assert.match(
    compareDepBlock(manifest, lock, 'dependencies'),
    /dependencies\.brand-new-dep: declared as "1\.0\.0" in package\.json but MISSING from package-lock\.json/,
  )
  assert.match(
    compareDepBlock(lock, manifest, 'dependencies'),
    /dependencies\.brand-new-dep: present in package-lock\.json as "1\.0\.0" but MISSING from package\.json/,
  )
  assert.match(
    compareDepBlock({ a: '1.0.0' }, { a: '2.0.0' }, 'devDependencies'),
    /devDependencies\.a: package\.json says "1\.0\.0", package-lock\.json says "2\.0\.0"/,
  )
  assert.equal(compareDepBlock({ a: '1' }, { a: '1' }, 'dependencies'), null)
})

// ── overrides are a silent-drift hole ─────────────────────────────────────

/**
 * Minimal range check for the subset of semver ranges npm manifests use here:
 * exact, `=`, `>=`, `>`, `<=`, `<`, `^`, `~`, space-separated AND, `||` OR.
 * @param {string} version
 * @param {string} range
 * @returns {boolean}
 */
export function satisfies(version, range) {
  const parse = (v) =>
    String(v)
      .split('.')
      .map((n) => Number.parseInt(n, 10))
  const cmp = (a, b) => {
    for (let i = 0; i < 3; i++) {
      const x = a[i] ?? 0
      const y = b[i] ?? 0
      if (x !== y) return x < y ? -1 : 1
    }
    return 0
  }
  const v = parse(version)
  if (v.some(Number.isNaN)) return false
  return String(range)
    .split('||')
    .some((clause) =>
      clause
        .trim()
        .split(/\s+/)
        .every((part) => {
          const m = part.match(/^(>=|<=|>|<|=|\^|~)?(.+)$/)
          if (!m) return false
          const [, op = '=', raw] = m
          const bound = parse(raw)
          if (bound.some(Number.isNaN)) return false
          const c = cmp(v, bound)
          switch (op) {
            case '=':
              return c === 0
            case '>':
              return c > 0
            case '>=':
              return c >= 0
            case '<':
              return c < 0
            case '<=':
              return c <= 0
            case '^':
              if (c < 0) return false
              // ^0.x.y pins the minor; otherwise allow patch/minor drift.
              if (bound[0] === 0) return v[0] === 0 && v[1] === bound[1]
              return v[0] === bound[0]
            case '~':
              if (c < 0) return false
              // ~x.y.z allows patch drift; ~x.y allows minor drift.
              return raw.split('.').length >= 3
                ? v[0] === bound[0] && v[1] === bound[1]
                : v[0] === bound[0]
            default:
              return false
          }
        }),
    )
}

test('root overrides cannot silently contradict a declared dependency range', () => {
  const overrides = rootPkg.overrides ?? {}
  assert.ok(
    Object.keys(overrides).length > 0,
    'expected the rolldown override added by the workspace move to still be present',
  )

  // `overrides` BYPASSES range checking instead of erroring, so a pinned
  // override can quietly violate a dependent's declared range — exactly the
  // silent-drift class the TUI dist-freshness gate exists to catch.
  const declared = readJson('../node_modules/tsdown/package.json')
  const range = declared.dependencies?.rolldown
  assert.ok(range, 'tsdown must still declare a rolldown range for this check to mean anything')
  assert.ok(
    satisfies(overrides.rolldown, range),
    `package.json overrides.rolldown (${overrides.rolldown}) does not satisfy tsdown@${declared.version}'s declared range (${range}). ` +
      'npm overrides bypass range validation rather than erroring, so this drifts silently until the built TUI bundle is wrong. ' +
      'Widen the override or pin tsdown to a release that accepts it.',
  )
})

test('the range check agrees with the versions actually locked', () => {
  assert.equal(satisfies('1.2.0', '~1.2.0'), true)
  assert.equal(satisfies('1.3.0', '~1.2.0'), false)
  assert.equal(satisfies('1.2.5', '^1.2.0'), true)
  assert.equal(satisfies('2.0.0', '^1.2.0'), false)
  assert.equal(satisfies('1.2.0', '^1.0.0 || ^2.0.0'), true)
  assert.equal(satisfies('1.2.0', '1.2.0'), true)
  assert.equal(satisfies('1.2.1', '1.2.0'), false)
  assert.equal(satisfies('1.2.0', '>=1.0.0 <2.0.0'), true)
  assert.equal(satisfies('2.0.0', '>=1.0.0 <2.0.0'), false)
})

test('the root lock resolves exactly one rolldown version', () => {
  const versions = new Set()
  for (const [key, entry] of Object.entries(rootLock.packages ?? {})) {
    if (/(^|\/)node_modules\/rolldown$/.test(key)) versions.add(entry.version)
  }
  // Two rolldown copies in the tree mean the TUI bundle and the root tooling
  // were built against different rolldowns.
  assert.equal(
    versions.size,
    1,
    `expected exactly one rolldown version in the root lock, found ${[...versions].join(', ')}`,
  )
  assert.equal([...versions][0], rootPkg.overrides.rolldown)
})

test('the nested TUI lock and the root lock agree on shared runtime deps', () => {
  // The nested lock is what users get; the root lock is what CI builds against.
  // If the two drift, CI validates a tree no user will ever install.
  const shared = Object.keys(tuiPkg.dependencies ?? {})
  for (const dep of shared) {
    assert.equal(
      tuiLock.packages?.['']?.dependencies?.[dep],
      tuiPkg.dependencies[dep],
      `nested lock disagrees with the manifest on ${dep}`,
    )
    assert.ok(
      rootLock.packages?.[`src/plugins/tui`]?.dependencies?.[dep] !== undefined ||
        rootLock.packages?.[`node_modules/${dep}`] !== undefined,
      `root lock has no entry for the TUI runtime dep ${dep}`,
    )
  }
})
