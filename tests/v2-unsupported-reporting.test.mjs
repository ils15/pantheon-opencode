/** Behavioural tests for the V2 feature-reduction REPORTING (S0).
 *
 * On an OpenCode 2.x host `src/plugin-v2.ts` registers 3 tools; on a 1.x host
 * `src/plugin.ts` registers 6 plus a BackgroundJobBoard, the three goal tools
 * and a caller/target delegation matrix. A user migrating from V1 to V2 loses
 * that surface, and at install time nothing said so.
 *
 * `getUnsupportedFeatures()` already returns the right marker strings, but it
 * had NO production caller — only tests read it. These tests pin the two places
 * that must now report it (the V2-generation installer and `doctor`), and pin
 * that both take their strings from the one shared seed rather than from a
 * hand-copied duplicate that could drift.
 *
 * The assertions are on PRESENCE OF THE LIST, not on log formatting: prefix,
 * wrapping and wording are the reporting surface's business and must stay free
 * to change without breaking this file.
 *
 * Run: node --test tests/v2-unsupported-reporting.test.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  checkV2UnsupportedFeatures,
  collectV2UnsupportedFeatures,
  describeV2Reduction,
  isV2GenerationRegistered,
} from '../scripts/doctor.mjs'
import { installOpenCode } from '../scripts/install/opencode.mjs'
import { listV2UnsupportedFeatures } from '../src/pantheon/v2-unsupported.mjs'

/** The seed every reporter must surface. */
const SEED = listV2UnsupportedFeatures()

/** Capture everything written to stdout while `fn` runs. */
async function captureOutput(fn) {
  const lines = []
  const original = console.log
  console.log = (...args) => {
    lines.push(args.map(String).join(' '))
  }
  try {
    await fn()
  } finally {
    console.log = original
  }
  return lines.join('\n')
}

/** Assert every seed marker appears in `output`. */
function assertReportsEveryFeature(output, surface) {
  for (const feature of SEED) {
    assert.ok(
      output.includes(feature),
      `${surface} must report the "${feature}" marker; got:\n${output}`,
    )
  }
}

test('the shared seed is a non-empty list of feature markers', () => {
  assert.ok(Array.isArray(SEED), 'the seed must be an array')
  assert.ok(SEED.length > 0, 'the seed must not be empty')
  // The two reductions a migrating user actually loses.
  assert.ok(SEED.includes('goal-tools'), 'goal-tools must be in the seed')
  assert.equal(SEED.includes('delegation-matrix'), false, 'the matrix is enforced in V2')
})

test('a returned seed is a copy — a reporter cannot mutate the shared list', () => {
  const first = listV2UnsupportedFeatures()
  first.push('not-a-real-feature')
  assert.deepEqual(
    listV2UnsupportedFeatures(),
    SEED,
    'the seed must not be mutable through callers',
  )
})

// ─── Install ───────────────────────────────────────────────────────────

test('a V2-generation install reports the unsupported feature list', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-v2-report-install-'))
  try {
    const output = await captureOutput(() =>
      installOpenCode(target, true, false, ['plugins'], {
        yes: true,
        headless: true,
        version: 'v2',
      }),
    )
    assertReportsEveryFeature(output, 'the V2-generation installer')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('a V1-generation install does not report the V2 reduction', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-v1-silent-install-'))
  try {
    const output = await captureOutput(() =>
      installOpenCode(target, true, false, ['plugins'], {
        yes: true,
        headless: true,
        version: 'v1',
      }),
    )
    for (const feature of ['goal-tools']) {
      assert.ok(
        !output.includes(feature),
        `a V1-generation install must not report the V2-only "${feature}" marker; got:\n${output}`,
      )
    }
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// ─── Doctor ────────────────────────────────────────────────────────────

/** A collected config as `collectMcpConfigs` produces it. */
function config(label, data) {
  return { label, path: join('/nonexistent', 'opencode.json'), data }
}

test('doctor collects the reduction for a V2-registered config', () => {
  const configs = [config('project root', { plugins: ['src/plugin-v2'] })]
  assert.deepEqual(
    collectV2UnsupportedFeatures(configs),
    SEED,
    'doctor must collect the seed verbatim, not a reworded copy',
  )
})

test('doctor recognises the absolute and package-export forms of the V2 entry', () => {
  for (const ref of [
    'src/plugin-v2',
    '/opt/pantheon/src/plugin-v2',
    'pantheon-opencode/plugin-v2',
    { path: '/opt/pantheon/src/plugin-v2' },
  ]) {
    assert.deepEqual(
      collectV2UnsupportedFeatures([config('project root', { plugins: [ref] })]),
      SEED,
      `doctor must treat ${JSON.stringify(ref)} as a V2 registration`,
    )
  }
})

test('doctor collects nothing for a V1-registered config', () => {
  const configs = [
    config('project root', {
      plugin: ['/opt/pantheon/src/plugin.ts', '/opt/pantheon/src/plugins/pantheon-hooks.ts'],
    }),
  ]
  assert.deepEqual(collectV2UnsupportedFeatures(configs), [])
})

test('doctor reports the reduction through its own output shape', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'pantheon-v2-report-doctor-'))
  try {
    // A V2-generation project config: the plural `plugins` key holds the V2 entry.
    writeFileSync(
      join(sandbox, 'opencode.json'),
      JSON.stringify({ plugins: ['/opt/pantheon/src/plugin-v2'] }, null, 2),
    )
    const output = captureOutputSync(() =>
      checkV2UnsupportedFeatures({
        target: sandbox,
        env: { HOME: sandbox, PANTHEON_HOME: sandbox },
      }),
    )
    assertReportsEveryFeature(output, 'doctor')
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

test('doctor stays quiet when no V2 generation is registered', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'pantheon-v1-quiet-doctor-'))
  try {
    writeFileSync(
      join(sandbox, 'opencode.json'),
      JSON.stringify({ plugin: ['/opt/pantheon/src/plugin.ts'] }, null, 2),
    )
    const output = captureOutputSync(() =>
      checkV2UnsupportedFeatures({
        target: sandbox,
        env: { HOME: sandbox, PANTHEON_HOME: sandbox },
      }),
    )
    for (const feature of SEED) {
      assert.ok(!output.includes(feature), `doctor must not report "${feature}" for a V1 install`)
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

// ─── Registration vs seed emptiness (N1) ────────────────────────────────

test('registration and seed emptiness are separate facts, not one list length', () => {
  const v2 = [config('project root', { plugins: ['src/plugin-v2'] })]
  const v1 = [config('project root', { plugin: ['/opt/pantheon/src/plugin.ts'] })]
  assert.equal(isV2GenerationRegistered(v2), true, 'a V2 registration must be detected')
  assert.equal(isV2GenerationRegistered(v1), false, 'a V1-only config must not read as V2')
})

test('an EMPTY seed on a registered V2 generation never reports "nothing reduced"', () => {
  // The bug this pins: doctor branched on `features.length === 0`, which
  // conflates "no V2 generation registered" with "the seed is empty". An emptied
  // seed therefore printed the reassuring and FALSE "No V2 plugin generation
  // registered — nothing reduced" on a V2 install, hiding the very reduction
  // H4 exists to report.
  const verdict = describeV2Reduction({ registered: true, features: [] })
  assert.ok(
    !verdict.message.includes('nothing reduced'),
    `a registered V2 generation with an empty seed must not be reported as reducing nothing; got: ${verdict.message}`,
  )
  assert.ok(
    !verdict.message.includes('No V2 plugin generation registered'),
    'the message must not claim the generation is unregistered while it is registered',
  )
  assert.match(
    verdict.message,
    /seed/i,
    'the message must name the empty seed as the cause it can actually see',
  )
  assert.equal(verdict.level, 'warn', 'a packaging fault is worth a warning, not an info line')
  assert.equal(verdict.status, 'empty-seed', "an emptied seed must not report as 'reported'")
})

test('no V2 generation registered still reports "nothing reduced", quietly', () => {
  const verdict = describeV2Reduction({ registered: false, features: [] })
  assert.equal(verdict.level, 'info', 'an ordinary V1 install is not a finding')
  assert.equal(verdict.status, 'no-v2-generation')
  assert.match(verdict.message, /No V2 plugin generation registered — nothing reduced/)
})

test('a registered V2 generation with a populated seed reports every marker', () => {
  const verdict = describeV2Reduction({ registered: true, features: SEED })
  assert.equal(verdict.level, 'warn')
  assert.equal(verdict.status, 'reported')
  assertReportsEveryFeature(verdict.message, "doctor's H4 verdict")
})

/** Synchronous variant of {@link captureOutput}. */
function captureOutputSync(fn) {
  const lines = []
  const original = console.log
  console.log = (...args) => {
    lines.push(args.map(String).join(' '))
  }
  try {
    fn()
  } finally {
    console.log = original
  }
  return lines.join('\n')
}
