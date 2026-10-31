/**
 * install-state-migration.test.mjs — regression for the undefined `.push`
 * crash that blocked `pantheon-opencode init` after the health checks.
 *
 * Root cause: the postinstall version marker (sync-tui.mjs) wrote a partial
 * object through writeState(), which stamped it `schema_version: 2` while
 * dropping `applied_migrations`. The next `init` then ran migrations and
 * crashed with:
 *   Cannot read properties of undefined (reading 'push')
 *
 * Run: node --test tests/install-state-migration.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseSemver, rollbackMigration, runMigrations } from '../scripts/install/migrate.mjs'
import { installOpenCode } from '../scripts/install/opencode.mjs'
import { createInitialState, readState, writeState } from '../scripts/install/state.mjs'

/** Write the exact partial v2 marker shape produced by the buggy sync-tui. */
function seedPartialMarker(target, version = '1.5.1') {
  mkdirSync(join(target, '.pantheon'), { recursive: true })
  writeFileSync(
    join(target, '.pantheon', 'install-state.json'),
    `${JSON.stringify(
      {
        pantheon_version: version,
        previous_version: null,
        updated_at: new Date().toISOString(),
        schema_version: 2,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

function seedSchemaMarker(target, marker) {
  const state = createInitialState('1.5.1', '2026-10-29T00:00:00.000Z')
  state.migration_schema_version = marker
  writeState(target, state, { updatedAt: '2026-10-29T00:00:00.000Z' })
  return join(target, '.pantheon', 'install-state.json')
}

function withTarget(fn) {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-state-'))
  try {
    return fn(target)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
}

async function withTargetAsync(fn) {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-state-'))
  try {
    return await fn(target)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
}

test('readState backfills a partial v2 marker (no applied_migrations array)', () => {
  withTarget((target) => {
    seedPartialMarker(target)
    const state = readState(target)
    assert.ok(state, 'partial marker must still be readable')
    assert.ok(
      Array.isArray(state.applied_migrations),
      'applied_migrations must be normalized to an array',
    )
    assert.equal(state.applied_migrations.length, 0)
    assert.ok(state.components && typeof state.components === 'object')
    assert.deepEqual(state.file_inventory.entries, [])
    assert.equal(state.file_inventory.legacy_unknown, true)
    assert.deepEqual(state.decision_router, {
      schema_version: 1,
      provider: 'local',
      egress_consent: false,
    })
  })
})

test('runMigrations upgrades its own schema marker without overwriting the package version', () => {
  withTarget((target) => {
    seedPartialMarker(target)
    let result
    assert.doesNotThrow(() => {
      result = runMigrations(target, { dryRun: false })
    }, 'runMigrations must not throw "reading push" on a partial state')
    assert.ok(result.applied > 0, 'legacy 1.5.1 state must apply the migration ladder')

    const persisted = JSON.parse(
      readFileSync(join(target, '.pantheon', 'install-state.json'), 'utf8'),
    )
    assert.ok(Array.isArray(persisted.applied_migrations))
    assert.equal(persisted.applied_migrations.length, result.applied)
    assert.equal(persisted.pantheon_version, '1.5.1', 'package version remains independent')
    assert.equal(persisted.migration_schema_version, '3.19.2')

    // The upgraded state must be idempotent on the next run.
    const again = runMigrations(target, { dryRun: false })
    assert.equal(again.applied, 0, 'second run must apply nothing')
  })
})

test('runMigrations preserves a future schema marker without recording migrations', () => {
  withTarget((target) => {
    const statePath = seedSchemaMarker(target, '3.20.0')
    const before = readFileSync(statePath)
    const changes = []

    const result = runMigrations(target, {
      dryRun: false,
      recorder: (change) => changes.push(change),
    })

    assert.equal(result.status, 'unsupported')
    assert.equal(result.applied, 0)
    assert.deepEqual(changes, [])
    assert.deepEqual(readFileSync(statePath), before)
    assert.equal(readState(target).migration_schema_version, '3.20.0')
    assert.deepEqual(readState(target).applied_migrations, [])
  })
})

test('runMigrations preserves an invalid schema marker without recording migrations', () => {
  withTarget((target) => {
    const statePath = seedSchemaMarker(target, 'not-a-schema-version')
    const before = readFileSync(statePath)
    const changes = []

    const result = runMigrations(target, {
      dryRun: false,
      recorder: (change) => changes.push(change),
    })

    assert.equal(result.status, 'invalid')
    assert.equal(result.applied, 0)
    assert.deepEqual(changes, [])
    assert.deepEqual(readFileSync(statePath), before)
    assert.equal(readState(target).migration_schema_version, 'not-a-schema-version')
    assert.deepEqual(readState(target).applied_migrations, [])
  })
})

for (const [label, article, marker, status] of [
  ['future', 'a', '3.20.0', 'unsupported'],
  ['invalid', 'an', 'not-a-schema-version', 'invalid'],
]) {
  test(`installOpenCode refuses ${article} ${label} schema marker before writing files`, async () => {
    await withTargetAsync(async (target) => {
      const statePath = seedSchemaMarker(target, marker)
      const before = readFileSync(statePath)

      await assert.rejects(
        installOpenCode(target, false, false, ['agents'], {
          yes: true,
          headless: true,
          version: 'v2',
          global: true,
          quiet: true,
        }),
        new RegExp(
          status === 'unsupported' ? 'newer than supported' : '[Ii]nvalid migration schema',
        ),
      )

      assert.deepEqual(readFileSync(statePath), before)
      assert.deepEqual(readdirSync(target), ['.pantheon'])
    })
  })
}

test('migration semver parser compares prereleases before the matching final release', () => {
  assert.deepEqual(parseSemver('v3.19.2-beta.4+build.7'), {
    major: 3,
    minor: 19,
    patch: 2,
    prerelease: ['beta', 4],
  })
  assert.equal(parseSemver('3.19.2-beta.4').compare(parseSemver('3.19.2')), -1)
  assert.equal(parseSemver('3.19.2-beta.10').compare(parseSemver('3.19.2-beta.2')), 1)
  assert.equal(parseSemver('3.19.2').compare(parseSemver('3.19.2-beta.10')), 1)
})

test('an init-style migration run is independent of runtime selection and idempotent', () => {
  withTarget((target) => {
    seedPartialMarker(target, '1.6.2-beta.2')
    const first = runMigrations(target, { dryRun: false })
    const second = runMigrations(target, { dryRun: false })
    assert.ok(first.applied > 0)
    assert.equal(second.applied, 0)
    assert.equal(readState(target).pantheon_version, '1.6.2-beta.2')
  })
})

test('writeState round-trips applied_migrations/components (marker-safe writes)', () => {
  withTarget((target) => {
    const state = createInitialState('1.5.1')
    state.applied_migrations.push({
      from: '1.0.0',
      to: '1.5.1',
      applied_at: new Date().toISOString(),
      status: 'completed',
    })
    writeState(target, state)

    const reread = readState(target)
    assert.equal(reread.applied_migrations.length, 1)
    assert.equal(reread.pantheon_version, '1.5.1')
    assert.ok(reread.components.agents, 'components survive a write/read cycle')
    assert.deepEqual(reread.file_inventory.entries, [])
    assert.equal(reread.file_inventory.legacy_unknown, false)
  })
})

test('rollback updates the migration marker without changing the installed package version', () => {
  withTarget((target) => {
    const state = createInitialState('1.6.2-beta.2')
    state.applied_migrations.push({
      from: '3.19.1',
      to: '3.19.2',
      applied_at: new Date().toISOString(),
      status: 'completed',
    })
    writeState(target, state)

    assert.equal(rollbackMigration(target, '3.19.2').success, true)
    const persisted = readState(target)
    assert.equal(persisted.pantheon_version, '1.6.2-beta.2')
    assert.equal(persisted.migration_schema_version, '3.19.1')
  })
})

test('v1 migration initializes an empty unknown inventory instead of claiming legacy files', () => {
  withTarget((target) => {
    mkdirSync(join(target, '.pantheon'), { recursive: true })
    writeFileSync(
      join(target, '.pantheon', 'install-state.json'),
      JSON.stringify({ version: '1.0.0', components: { agents: { status: 'installed' } } }),
    )
    const state = readState(target)
    assert.equal(state.schema_version, 2)
    assert.equal(state.file_inventory.schema_version, 1)
    assert.equal(state.file_inventory.legacy_unknown, true)
    assert.deepEqual(state.file_inventory.entries, [])
  })
})
