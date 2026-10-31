import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runDecisionRouterCommand } from '../scripts/decision-router.mjs'
import { readUserDecisionRouterConfig } from '../scripts/install/decision-router-config.mjs'
import { isSupportedNodeVersion } from '../scripts/node-engine-policy.mjs'

const ROOT = process.cwd()

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'pantheon-decision-admin-'))
  return {
    home,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_STATE_HOME: join(home, 'state'),
    },
  }
}

test('admin selection, candidate enablement, consent, caps, and period are separate user-level actions', async () => {
  const { home, env } = sandbox()
  const output = []
  const run = (args) => runDecisionRouterCommand(args, { env, stdout: (line) => output.push(line) })
  try {
    await run(['select', 'openai-decisions/gpt-6-luna'])
    let config = readUserDecisionRouterConfig({ env })
    assert.deepEqual(config.selection, {
      mode: 'explicit',
      provider: 'openai-decisions',
      model: 'gpt-6-luna',
    })
    assert.equal(config.egress_consent, false)
    assert.deepEqual(config.enabled_candidates, [])

    await run(['enable', 'openai-decisions', 'gpt-6-luna'])
    config = readUserDecisionRouterConfig({ env })
    assert.equal(config.egress_consent, false)
    assert.equal(config.enabled_candidates.length, 1)
    await run(['consent', 'yes'])

    await assert.rejects(
      run(['caps', 'user', '--monthly-usd', '1.0000001', '--per-decision-usd', '0.1']),
    )
    await run(['caps', 'user', '--monthly-usd', '10', '--per-decision-usd', '1'])
    await run([
      'caps',
      'provider',
      'openai-decisions',
      '--monthly-usd',
      '10',
      '--per-decision-usd',
      '1',
    ])
    await run([
      'caps',
      'model',
      'openai-decisions',
      'gpt-6-luna',
      '--monthly-usd',
      '10',
      '--per-decision-usd',
      '1',
    ])

    const period = new Date().toISOString().slice(0, 7)
    await run(['period', 'confirm', '--current', 'none', '--next', period])
    const { openLocalDecisionBudgetLedger } = await import(
      '../src/pantheon/local-decision-budget.ts'
    )
    const ledger = openLocalDecisionBudgetLedger({
      dbPath: join(env.XDG_STATE_HOME, 'pantheon', 'decision-budget.sqlite'),
    })
    try {
      assert.equal(ledger.canReserve('openai-decisions', 'gpt-6-luna').status, 'eligible')
      assert.equal(ledger.getActiveBudgetPeriod(), period)
    } finally {
      ledger.close()
    }
    assert.ok(output.some((line) => line.includes('Explicit period confirmed')))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('new admin ledger has no default caps and Auto selection never implies consent', async () => {
  const { home, env } = sandbox()
  try {
    const { openLocalDecisionBudgetLedger } = await import(
      '../src/pantheon/local-decision-budget.ts'
    )
    const ledger = openLocalDecisionBudgetLedger({
      dbPath: join(env.XDG_STATE_HOME, 'pantheon', 'decision-budget.sqlite'),
    })
    assert.equal(ledger.canReserve('openai-decisions', 'gpt-6-luna').reason, 'no-cap')
    ledger.close()

    await runDecisionRouterCommand(['select', 'auto'], { env, stdout: () => {} })
    const config = readUserDecisionRouterConfig({ env })
    assert.deepEqual(config.selection, { mode: 'auto' })
    assert.equal(config.egress_consent, false)
    assert.deepEqual(config.enabled_candidates, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('admin rejects unsupported providers, models, implicit period changes, and unknown flags', async () => {
  const { home, env } = sandbox()
  try {
    await assert.rejects(runDecisionRouterCommand(['enable', 'jev', 'jev-1.13-free'], { env }))
    await assert.rejects(runDecisionRouterCommand(['consent', 'maybe'], { env }))
    await assert.rejects(
      runDecisionRouterCommand(['period', 'confirm', '--next', '2026-10'], { env }),
    )
    await assert.rejects(runDecisionRouterCommand(['caps', 'user', '--monthly-usd', '2'], { env }))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('holds lists unresolved reservations without mutating them', async () => {
  const { home, env } = sandbox()
  try {
    const { openLocalDecisionBudgetLedger, resolveLocalDecisionBudgetDbPath } = await import(
      '../src/pantheon/local-decision-budget.ts'
    )
    const path = resolveLocalDecisionBudgetDbPath(env)
    const missingOutput = []
    await runDecisionRouterCommand(['holds'], {
      env,
      stdout: (line) => missingOutput.push(line),
    })
    assert.match(missingOutput.join('\n'), /No unresolved provider holds/)
    assert.equal(existsSync(path), false, 'a listing of a missing ledger must not create it')

    const seeded = openLocalDecisionBudgetLedger({
      dbPath: path,
      clock: () => Date.parse('2026-01-10T00:00:00.000Z'),
    })
    let reservation
    try {
      const caps = { monthlyCapMicros: 5_000_000, perDecisionCapMicros: 1_000_000 }
      seeded.configureUserCaps(caps)
      seeded.configureProviderCaps('typesafe-jev', caps)
      seeded.configureModelCaps('typesafe-jev', 'jev-1.14.0', caps)
      assert.equal(seeded.confirmBudgetPeriod(null, '2026-01').status, 'confirmed')
      reservation = seeded.reserve('typesafe-jev', 'jev-1.14.0')
      assert.equal(reservation.status, 'reserved')
    } finally {
      seeded.close()
    }
    assert.equal(reservation.status, 'reserved')

    const output = []
    await runDecisionRouterCommand(['holds'], { env, stdout: (line) => output.push(line) })
    const listing = output.join('\n')
    assert.match(listing, new RegExp(`Hold ${reservation.reservationId}:`))
    assert.match(listing, /status=pending/)
    assert.match(listing, /provider=typesafe-jev/)
    assert.match(listing, /model=jev-1\.14\.0/)
    assert.match(listing, /period=2026-01/)
    assert.match(listing, new RegExp(`reserved_micros=${reservation.reservedMicros}`))
    assert.match(listing, /does not reserve, reconcile, release or prune/)
    assert.match(listing, /never creates or migrates the ledger/)

    const reopened = openLocalDecisionBudgetLedger({ dbPath: path })
    try {
      const holds = reopened.listUncertainReservations()
      assert.equal(holds.length, 1)
      assert.equal(holds[0]?.reservationId, reservation.reservationId)
      assert.equal(holds[0]?.state, 'pending')
      assert.equal(holds[0]?.reservedMicros, reservation.reservedMicros)
      assert.equal(reopened.getActiveBudgetPeriod(), '2026-01')
      assert.equal(reopened.canReserve('typesafe-jev', 'jev-1.14.0').status, 'denied')
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('router enablement is a separate explicit switch and uses the canonical provider matrix', async () => {
  const { home, env } = sandbox()
  try {
    assert.equal(readUserDecisionRouterConfig({ env }).enabled, false)
    await runDecisionRouterCommand(['enable'], { env, stdout: () => {} })
    assert.equal(readUserDecisionRouterConfig({ env }).enabled, true)
    await runDecisionRouterCommand(['disable'], { env, stdout: () => {} })
    assert.equal(readUserDecisionRouterConfig({ env }).enabled, false)

    await runDecisionRouterCommand(['select', 'typesafe-jev/jev-1.14.0'], {
      env,
      stdout: () => {},
    })
    await runDecisionRouterCommand(['enable', 'typesafe-jev', 'jev-1.14.0'], {
      env,
      stdout: () => {},
    })
    const config = readUserDecisionRouterConfig({ env })
    assert.deepEqual(config.selection, {
      mode: 'explicit',
      provider: 'typesafe-jev',
      model: 'jev-1.14.0',
    })
    assert.deepEqual(config.enabled_candidates, [{ provider: 'typesafe-jev', model: 'jev-1.14.0' }])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('caps without flags names both required flags and opens no ledger', async () => {
  const { home, env } = sandbox()
  try {
    await assert.rejects(runDecisionRouterCommand(['caps', 'user'], { env, stdout: () => {} }), {
      name: 'DecisionRouterUsageError',
      message: 'Both --monthly-usd and --per-decision-usd are required',
    })
    assert.equal(
      existsSync(env.XDG_STATE_HOME),
      false,
      'a rejected usage must not create the SQLite ledger directory',
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('CLI reports a usage error as one line without a stack', (t) => {
  if (!isSupportedNodeVersion(process.versions.node)) {
    t.skip(`the CLI refuses Node < 26.4.0 (current: ${process.versions.node})`)
    return
  }
  const { home, env } = sandbox()
  try {
    const result = spawnSync(
      process.execPath,
      [join(ROOT, 'bin', 'pantheon-init.mjs'), 'decision-router', 'caps', 'user'],
      { encoding: 'utf8', env: { ...process.env, ...env } },
    )
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /^Error: Both --monthly-usd and --per-decision-usd are required$/m)
    assert.doesNotMatch(result.stderr, /\n\s+at /, 'usage errors must not print a stack')
    assert.doesNotMatch(result.stderr, /DecisionRouterUsageError/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
