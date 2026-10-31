import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runDecisionRouterCommand } from '../scripts/decision-router.mjs'
import {
  applyDecisionLayerPlan,
  buildDecisionLayerPlan,
  formatDecisionLayerPlan,
} from '../scripts/install/decision-layer-preview.mjs'
import {
  explainUserDecisionRouterAutoSelection,
  readUserDecisionRouterConfig,
  resolveUserDecisionRouterConfigPath,
} from '../scripts/install/decision-router-config.mjs'

const OPENAI = { provider: 'openai-decisions', model: 'gpt-6-luna' }
const JEV = { provider: 'typesafe-jev', model: 'jev-1.14.0' }

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-decision-phase7-'))
  return {
    root,
    project: join(root, 'project'),
    env: {
      HOME: root,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_STATE_HOME: join(root, 'state'),
    },
  }
}

function runner(env) {
  const output = []
  return {
    output,
    run: (args) => runDecisionRouterCommand(args, { env, stdout: (line) => output.push(line) }),
    text: () => output.join('\n'),
    reset: () => {
      output.length = 0
    },
  }
}

function listTree(root) {
  if (!existsSync(root)) return []
  const entries = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      entries.push(path)
      if (entry.isDirectory()) walk(path)
    }
  }
  walk(root)
  return entries.sort()
}

function writeInstallState(target, decisionRouter) {
  const dir = join(target, '.pantheon')
  mkdirSync(dir, { recursive: true })
  const state = {
    schema_version: 2,
    pantheon_version: '1.6.2-beta.4',
    migration_schema_version: '3.19.2',
    previous_version: null,
    updated_at: '2026-10-30T00:00:00.000Z',
    migration_checkpoint: null,
    applied_migrations: [],
    components: {},
    decision_router: decisionRouter,
    file_inventory: {
      schema_version: 1,
      target_root: null,
      legacy_unknown: true,
      entries: [],
    },
  }
  const path = join(dir, 'install-state.json')
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`)
  return path
}

/** D8: `help` and `status` are read-only, proven by the filesystem they leave behind. */
test('help and status are read-only and create no config, ledger or state file', async () => {
  const { root, env } = sandbox()
  const io = runner(env)
  try {
    const before = listTree(root)
    await io.run(['help'])
    await io.run(['status'])
    await io.run(['holds'])
    assert.deepEqual(io.output.length > 0, true)
    assert.deepEqual(listTree(root), before, 'read-only commands must not create anything')
    assert.match(io.text(), /Read-only \(never create, migrate or write anything\)/)
    assert.match(
      io.text(),
      /Mode: read-only — status and help never create, migrate or write nothing\.|Mode: read-only/,
    )
    assert.match(io.text(), /No unresolved provider holds\./)
    assert.equal(existsSync(resolveUserDecisionRouterConfigPath(env)), false)
    assert.equal(existsSync(join(env.XDG_STATE_HOME, 'pantheon')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** D9: `select` can never enable anything, and it revokes consent it does not carry. */
test('select records a preference only: it never enables, consents or opens the ledger', async () => {
  const { root, env } = sandbox()
  const io = runner(env)
  try {
    await io.run(['select', `${OPENAI.provider}/${OPENAI.model}`])
    let config = readUserDecisionRouterConfig({ env })
    assert.equal(config.enabled, false)
    assert.equal(config.egress_consent, false)
    assert.deepEqual(config.enabled_candidates, [])
    assert.equal(existsSync(join(env.XDG_STATE_HOME, 'pantheon')), false, 'select opens no ledger')

    await io.run(['enable', `${OPENAI.provider}`, OPENAI.model])
    await io.run(['enable'])
    await io.run(['consent', 'yes'])
    config = readUserDecisionRouterConfig({ env })
    assert.equal(config.enabled, true)
    assert.equal(config.egress_consent, true)

    io.reset()
    // Consent was recorded for openai-decisions; moving the target must not
    // carry it over, and must not change enablement or candidate enablement.
    await io.run(['select', `${JEV.provider}/${JEV.model}`])
    const after = readUserDecisionRouterConfig({ env })
    assert.equal(after.egress_consent, false, 'a new target is not covered by the old consent')
    assert.equal(after.enabled, true, 'select does not enable and does not disable')
    assert.deepEqual(after.enabled_candidates, [{ provider: OPENAI.provider, model: OPENAI.model }])
    assert.match(io.text(), /Egress consent was revoked/)
    assert.match(io.text(), /nothing was enabled/)
    assert.equal(
      resolveUserDecisionRouterConfigPath(env) === null,
      false,
      'the config path stays the same',
    )
    assert.equal(existsSync(join(env.XDG_STATE_HOME, 'pantheon')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** D5: zero, one and two-or-more Auto candidates are three explicit outcomes. */
test('Auto cardinality reports none, single and ambiguous as distinct outcomes', () => {
  const base = {
    schema_version: 2,
    enabled: true,
    selection: { mode: 'auto' },
    egress_consent: true,
    enabled_candidates: [OPENAI, JEV],
  }
  assert.deepEqual(explainUserDecisionRouterAutoSelection(base, []), {
    outcome: 'none',
    reason: 'NO_ELIGIBLE_CANDIDATE',
    count: 0,
  })
  const single = explainUserDecisionRouterAutoSelection(base, [JEV])
  assert.equal(single.outcome, 'single')
  assert.deepEqual(single.candidate, JEV)
  assert.deepEqual(explainUserDecisionRouterAutoSelection(base, [OPENAI, JEV]), {
    outcome: 'ambiguous',
    reason: 'MULTIPLE_ELIGIBLE_CANDIDATES',
    count: 2,
  })
  // Preconditions are reported as ineligible, not as a cardinality branch.
  assert.deepEqual(explainUserDecisionRouterAutoSelection({ ...base, enabled: false }, [OPENAI]), {
    outcome: 'ineligible',
    reason: 'DISABLED',
  })
  assert.deepEqual(
    explainUserDecisionRouterAutoSelection({ ...base, egress_consent: false }, [OPENAI]),
    { outcome: 'ineligible', reason: 'CONSENT_MISSING' },
  )
  assert.deepEqual(
    explainUserDecisionRouterAutoSelection(
      { ...base, selection: { mode: 'explicit', ...OPENAI } },
      [OPENAI],
    ),
    { outcome: 'ineligible', reason: 'NOT_AUTO' },
  )
})

/** D7 + PM-13: the preview is a computed artifact diff, and it is idempotent. */
test('preview is a content diff: apply then preview reports zero creates and zero updates', async () => {
  const { root, project, env } = sandbox()
  const io = runner(env)
  try {
    const statePath = writeInstallState(project, {
      schema_version: 1,
      provider: 'auto',
      egress_consent: true,
    })
    const configPath = resolveUserDecisionRouterConfigPath(env)

    // 1. Preview writes nothing at all.
    await io.run(['setup', '--target', project])
    assert.equal(existsSync(configPath), false, 'a preview must not create the config')
    assert.match(io.text(), /0 create · 0 update · 0 unchanged|1 create/)
    assert.match(io.text(), /computed artifact diff, not a change plan/)
    assert.match(io.text(), /No files were written\./)
    assert.match(io.text(), /Backup notice: installer backup sets accumulate/)
    assert.match(io.text(), /decision_router\.egress_consent: true -> false/)

    // 2. Apply writes exactly the two planned artifacts.
    io.reset()
    await io.run(['setup', '--target', project, '--apply'])
    assert.equal(existsSync(configPath), true)
    assert.match(io.text(), /Applied: 2 written, 0 unchanged/)
    const applied = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.deepEqual(applied.decision_router, {
      schema_version: 1,
      provider: 'local',
      egress_consent: false,
    })
    assert.equal(applied.updated_at, '2026-10-30T00:00:00.000Z', 'apply must not churn timestamps')

    // 3. The same command again is a no-op — the defect PM-13 measured is that
    //    the installer announced 112 creates on an apply that created nothing.
    io.reset()
    await io.run(['setup', '--target', project])
    assert.match(io.text(), /0 create · 0 update · 2 unchanged/)
    assert.doesNotMatch(io.text(), /^\s+create\s/m, 'no artifact may be announced as a create')
    assert.equal(listTree(root).filter((path) => path.includes('backups')).length, 0)

    // 4. Status agrees with install-state, without writing.
    io.reset()
    await io.run(['status', '--target', project])
    assert.match(io.text(), /Install-state: consistent with/)
    assert.equal(existsSync(join(env.XDG_STATE_HOME, 'pantheon')), false)

    // 5. A byte-level change is reported as an update naming exactly that field.
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    writeFileSync(configPath, `${JSON.stringify({ ...config, egress_consent: true }, null, 2)}\n`)
    io.reset()
    await io.run(['setup', '--target', project])
    assert.match(io.text(), /update\s+\S*decision-router\.json/)
    assert.match(io.text(), /egress_consent: true -> false/)
    assert.match(io.text(), /0 create · 1 update · 1 unchanged/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a plan that would migrate a legacy file into an enabled router is blocked', async () => {
  const { root, env } = sandbox()
  const io = runner(env)
  try {
    const configPath = resolveUserDecisionRouterConfigPath(env)
    mkdirSync(join(env.XDG_CONFIG_HOME, 'pantheon'), { recursive: true, mode: 0o700 })
    const legacy = {
      schema_version: 1,
      selection: { mode: 'explicit', provider: 'jev', model: 'jev-1.14.0' },
      egress_consent: true,
      enabled_candidates: [{ provider: 'jev', model: 'jev-1.14.0' }],
    }
    writeFileSync(configPath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 })

    const plan = buildDecisionLayerPlan({ env })
    assert.equal(plan.blocked.length, 1)
    assert.equal(plan.blocked[0].reason, 'MIGRATION_WOULD_ENABLE_TURN_ROUTER')
    assert.match(formatDecisionLayerPlan(plan), /BLOCKED/)
    const before = readFileSync(configPath, 'utf8')
    assert.throws(() => applyDecisionLayerPlan(plan, { env }), /MIGRATION_WOULD_ENABLE_TURN_ROUTER/)
    assert.equal(readFileSync(configPath, 'utf8'), before, 'a blocked plan writes nothing')

    // The same plan is allowed when the activation is accepted explicitly.
    io.reset()
    await io.run(['setup', '--accept-migration', '--apply'])
    assert.equal(readUserDecisionRouterConfig({ env }).enabled, true)
    assert.equal(readUserDecisionRouterConfig({ env }).egress_consent, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('preview refuses --apply and setup rejects unknown flags', async () => {
  const { root, env } = sandbox()
  const io = runner(env)
  try {
    await assert.rejects(io.run(['preview', '--apply']), { name: 'DecisionRouterUsageError' })
    await assert.rejects(io.run(['setup', '--nope']), { name: 'DecisionRouterUsageError' })
    await assert.rejects(io.run(['status', '--target']), { name: 'DecisionRouterUsageError' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
