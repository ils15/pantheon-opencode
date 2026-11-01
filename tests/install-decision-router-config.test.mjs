import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createDecisionRouterConfig,
  DECISION_PROVIDER_BUDGET_MAPPING,
  DECISION_ROUTER_MODELS,
  DEFAULT_DECISION_ROUTER_CONFIG,
  DEFAULT_USER_DECISION_ROUTER_CONFIG,
  diffDecisionRouterSurfaces,
  isUserDecisionRouterEnabled,
  migrateDecisionRouterConfig,
  migrateUserDecisionRouterConfig,
  projectDecisionRouterInstallState,
  REMOTELY_ELIGIBLE_DECISION_PROVIDERS,
  readUserDecisionRouterConfig,
  resolveUserDecisionRouterCandidate,
  resolveUserDecisionRouterConfigPath,
  updateUserDecisionRouterConfig,
  writeUserDecisionRouterConfig,
} from '../scripts/install/decision-router-config.mjs'
import { createInitialState, readState, writeState } from '../scripts/install/state.mjs'

test('missing and malformed legacy config migrates to Local with external egress disabled', () => {
  assert.deepEqual(migrateDecisionRouterConfig(undefined), DEFAULT_DECISION_ROUTER_CONFIG)
  assert.deepEqual(migrateDecisionRouterConfig({ provider: 'openai-decisions' }), {
    schema_version: 1,
    provider: 'local',
    egress_consent: false,
  })
})

test('versioned preferences preserve provider and only an explicit boolean consent', () => {
  assert.deepEqual(
    migrateDecisionRouterConfig({
      schema_version: 1,
      provider: 'jev',
      egress_consent: true,
    }),
    { schema_version: 1, provider: 'jev', egress_consent: true },
  )
  assert.deepEqual(createDecisionRouterConfig('local', true), {
    schema_version: 1,
    provider: 'local',
    egress_consent: false,
  })
  assert.deepEqual(createDecisionRouterConfig('auto', false), {
    schema_version: 1,
    provider: 'auto',
    egress_consent: false,
  })
})

test('install-state migration gives old installs Local/disabled and persists versioned preference', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-decision-router-state-'))
  try {
    const stateDir = join(target, '.pantheon')
    mkdirSync(stateDir)
    const statePath = join(stateDir, 'install-state.json')
    writeFileSync(statePath, `${JSON.stringify({ pantheon_version: 'legacy' })}\n`)

    assert.deepEqual(readState(target).decision_router, DEFAULT_DECISION_ROUTER_CONFIG)
    const state = createInitialState('test-version', '2026-10-29T00:00:00.000Z')
    state.decision_router = createDecisionRouterConfig('jev', true)
    writeState(target, state, { updatedAt: '2026-10-29T00:00:00.000Z' })

    const persisted = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.deepEqual(persisted.decision_router, {
      schema_version: 1,
      provider: 'jev',
      egress_consent: true,
    })
    assert.deepEqual(readState(target).decision_router, persisted.decision_router)
    assert.doesNotMatch(readFileSync(statePath, 'utf8'), /api[_-]?key|token|secret/i)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('user-level config migrates invalid data to local-only without consent', () => {
  assert.deepEqual(migrateUserDecisionRouterConfig(undefined), DEFAULT_USER_DECISION_ROUTER_CONFIG)
  assert.deepEqual(
    migrateUserDecisionRouterConfig({
      schema_version: 1,
      selection: { mode: 'explicit', provider: 'openai-decisions', model: 'wrong-model' },
      egress_consent: true,
      enabled_candidates: [{ provider: 'openai-decisions', model: 'gpt-6-luna' }],
    }),
    DEFAULT_USER_DECISION_ROUTER_CONFIG,
  )
})

test('user config uses a private user-level path and survives atomic read/write', () => {
  const home = mkdtempSync(join(tmpdir(), 'pantheon-user-router-'))
  try {
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, '.config') }
    const config = {
      schema_version: 2,
      enabled: true,
      selection: { mode: 'explicit', provider: 'openai-decisions', model: 'gpt-6-luna' },
      egress_consent: true,
      enabled_candidates: [{ provider: 'openai-decisions', model: 'gpt-6-luna' }],
    }
    const target = writeUserDecisionRouterConfig(config, { env })
    assert.equal(target, resolveUserDecisionRouterConfigPath(env))
    assert.equal(readUserDecisionRouterConfig({ env }).selection.provider, 'openai-decisions')
    assert.equal(readFileSync(target, 'utf8').includes('secret'), false)
    assert.equal(statSync(target).mode & 0o777, 0o600)
    assert.equal(statSync(join(home, '.config', 'pantheon')).mode & 0o777, 0o700)
    assert.notEqual(target.includes('install-state.json'), true)
    chmodSync(target, 0o644)
    assert.throws(() => readUserDecisionRouterConfig({ env }), /permissions must be private/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('provider selection, egress consent, candidate enablement, and cap validity are independent', () => {
  const enabled = [{ provider: 'openai-decisions', model: 'gpt-6-luna' }]
  const selectedButNoConsent = {
    schema_version: 1,
    selection: { mode: 'explicit', provider: 'openai-decisions', model: 'gpt-6-luna' },
    egress_consent: false,
    enabled_candidates: enabled,
  }
  assert.equal(resolveUserDecisionRouterCandidate(selectedButNoConsent, enabled), null)
  assert.equal(
    resolveUserDecisionRouterCandidate(
      {
        ...selectedButNoConsent,
        egress_consent: true,
        enabled_candidates: [],
      },
      enabled,
    ),
    null,
  )
  assert.equal(
    resolveUserDecisionRouterCandidate(
      {
        ...selectedButNoConsent,
        egress_consent: true,
      },
      [],
    ),
    null,
  )
  assert.deepEqual(
    resolveUserDecisionRouterCandidate({ ...selectedButNoConsent, egress_consent: true }, enabled),
    enabled[0],
  )
})

test('Auto cardinality counts exact provider/model candidates and excludes unverified Console variants', () => {
  assert.deepEqual(DECISION_ROUTER_MODELS['opencode-console-jev-free'], ['jev-1.13-free'])
  const config = {
    schema_version: 1,
    selection: { mode: 'auto' },
    egress_consent: true,
    enabled_candidates: [
      { provider: 'openai-decisions', model: 'gpt-6-luna' },
      { provider: 'jev', model: 'jev-1.14.0' },
      { provider: 'opencode-console-jev-free', model: 'jev-1.13-free' },
    ],
  }
  assert.equal(resolveUserDecisionRouterCandidate(config, config.enabled_candidates), null)
  assert.deepEqual(
    resolveUserDecisionRouterCandidate(config, [config.enabled_candidates[0]]),
    config.enabled_candidates[0],
  )
})

test('config update does not couple explicit provider selection to consent or enablement', () => {
  const next = updateUserDecisionRouterConfig(DEFAULT_USER_DECISION_ROUTER_CONFIG, {
    selection: { mode: 'explicit', provider: 'typesafe-jev', model: 'jev-1.14.0' },
  })
  assert.equal(next.selection.provider, 'typesafe-jev')
  assert.equal(next.egress_consent, false)
  assert.deepEqual(next.enabled_candidates, [])
})

test('turn selection stays off unless explicitly enabled, even with consent and candidates', () => {
  const config = {
    schema_version: 2,
    enabled: false,
    selection: { mode: 'explicit', provider: 'openai-decisions', model: 'gpt-6-luna' },
    egress_consent: true,
    enabled_candidates: [{ provider: 'openai-decisions', model: 'gpt-6-luna' }],
  }
  assert.equal(isUserDecisionRouterEnabled(config), false)
  assert.equal(resolveUserDecisionRouterCandidate(config, config.enabled_candidates), null)
  assert.equal(isUserDecisionRouterEnabled({ ...config, enabled: true }), true)
})

test('legacy v1 user config migrates intent to the explicit enabled switch', () => {
  const migrated = migrateUserDecisionRouterConfig({
    schema_version: 1,
    selection: { mode: 'explicit', provider: 'jev', model: 'jev-1.14.0' },
    egress_consent: true,
    enabled_candidates: [{ provider: 'jev', model: 'jev-1.14.0' }],
  })
  assert.equal(migrated.schema_version, 2)
  assert.equal(migrated.enabled, true)
  assert.deepEqual(migrated.selection, {
    mode: 'explicit',
    provider: 'typesafe-jev',
    model: 'jev-1.14.0',
  })
  assert.deepEqual(migrated.enabled_candidates, [{ provider: 'typesafe-jev', model: 'jev-1.14.0' }])
  assert.equal(
    migrateUserDecisionRouterConfig({
      schema_version: 1,
      selection: { mode: 'local' },
      egress_consent: true,
      enabled_candidates: [],
    }).enabled,
    false,
  )
})

test('the user provider matrix maps onto ledger accounting providers exactly once', async () => {
  const { LOCAL_DECISION_BUDGET_PROVIDERS } = await import(
    '../src/pantheon/local-decision-budget.ts'
  )
  const ledgerProviders = new Set(LOCAL_DECISION_BUDGET_PROVIDERS)
  for (const [provider, accounting] of Object.entries(DECISION_PROVIDER_BUDGET_MAPPING)) {
    assert.ok(DECISION_ROUTER_MODELS[provider], `${provider} is missing from the model matrix`)
    assert.equal(DECISION_ROUTER_MODELS[provider].length, 1)
    assert.ok(ledgerProviders.has(accounting), `${provider} maps outside the ledger`)
  }
  assert.deepEqual(REMOTELY_ELIGIBLE_DECISION_PROVIDERS, ['openai-decisions', 'typesafe-jev'])
})

/** D7: install-state is a projection of the user config and round-trips. */
test('install-state projection round-trips and reports divergence instead of drifting', () => {
  const userConfig = {
    schema_version: 2,
    enabled: true,
    selection: { mode: 'explicit', provider: 'typesafe-jev', model: 'jev-1.14.0' },
    egress_consent: true,
    enabled_candidates: [{ provider: 'typesafe-jev', model: 'jev-1.14.0' }],
  }
  const projection = projectDecisionRouterInstallState(userConfig)
  assert.deepEqual(projection, {
    schema_version: 1,
    provider: 'typesafe-jev',
    egress_consent: true,
  })
  // The canonical id must survive a read/write round trip instead of resetting
  // to Local, which is what made setup and install-state disagree.
  assert.deepEqual(migrateDecisionRouterConfig(projection), projection)
  assert.deepEqual(diffDecisionRouterSurfaces(userConfig, projection).differences, [])

  // A stale record that claims consent the config does not have is reported.
  const stale = { schema_version: 1, provider: 'auto', egress_consent: true }
  const noConsent = { ...userConfig, egress_consent: false }
  const diff = diffDecisionRouterSurfaces(noConsent, stale)
  assert.deepEqual(diff.differences.map((entry) => entry.field).sort(), [
    'egress_consent',
    'provider',
  ])
  assert.equal(
    diff.differences.find((entry) => entry.field === 'egress_consent')?.installState,
    true,
  )
  assert.equal(
    diff.differences.find((entry) => entry.field === 'egress_consent')?.userConfig,
    false,
  )
  assert.equal(projectDecisionRouterInstallState(noConsent).egress_consent, false)

  // A local selection can never carry consent in the projected record.
  assert.deepEqual(
    projectDecisionRouterInstallState({ ...userConfig, selection: { mode: 'local' } }),
    { schema_version: 1, provider: 'local', egress_consent: false },
  )
})

/** D9: `select` cannot transfer a consent decision to a different target. */
test('changing the selection revokes the previous consent and never enables', () => {
  const consented = {
    schema_version: 2,
    enabled: false,
    selection: { mode: 'explicit', provider: 'openai-decisions', model: 'gpt-6-luna' },
    egress_consent: true,
    enabled_candidates: [{ provider: 'openai-decisions', model: 'gpt-6-luna' }],
  }
  const moved = updateUserDecisionRouterConfig(consented, {
    selection: { mode: 'explicit', provider: 'typesafe-jev', model: 'jev-1.14.0' },
  })
  assert.equal(moved.egress_consent, false)
  assert.equal(moved.enabled, false, 'select never enables')
  assert.deepEqual(moved.enabled_candidates, consented.enabled_candidates)

  // Re-selecting the same target keeps the recorded consent.
  const same = updateUserDecisionRouterConfig(consented, {
    selection: { mode: 'explicit', provider: 'openai-decisions', model: 'gpt-6-luna' },
  })
  assert.equal(same.egress_consent, true)

  // A selection moving to Local also clears consent.
  assert.equal(
    updateUserDecisionRouterConfig(consented, { selection: { mode: 'local' } }).egress_consent,
    false,
  )
})
