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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runMigrations } from '../scripts/install/migrate.mjs'
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

function withTarget(fn) {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-state-'))
  try {
    return fn(target)
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
  })
})

test('runMigrations does not crash on a partial v2 marker and records migrations', () => {
  withTarget((target) => {
    seedPartialMarker(target)
    let result
    assert.doesNotThrow(() => {
      result = runMigrations(target, '1.5.1', { dryRun: false })
    }, 'runMigrations must not throw "reading push" on a partial state')
    assert.ok(result.applied > 0, 'legacy 1.5.1 state must apply the migration ladder')

    const persisted = JSON.parse(
      readFileSync(join(target, '.pantheon', 'install-state.json'), 'utf8'),
    )
    assert.ok(Array.isArray(persisted.applied_migrations))
    assert.equal(persisted.applied_migrations.length, result.applied)

    // The upgraded state must be idempotent on the next run.
    const again = runMigrations(target, persisted.pantheon_version, { dryRun: false })
    assert.equal(again.applied, 0, 'second run must apply nothing')
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
  })
})
