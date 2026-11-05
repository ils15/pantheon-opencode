import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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

test('holds release refuses live providers and demands provider and reason', async () => {
  const { home, env } = sandbox()
  try {
    // The strict named-option parser rejects an incomplete flag set before
    // the command's own usage line is reachable.
    await assert.rejects(
      runDecisionRouterCommand(['holds', 'release', '--provider', 'jev-free'], { env }),
      /Missing or extra command options/,
    )
    await assert.rejects(
      runDecisionRouterCommand(['holds', 'release', '--reason', 'no provider'], { env }),
      /Missing or extra command options/,
    )
    await assert.rejects(
      runDecisionRouterCommand(['holds', 'release'], { env }),
      /Missing or extra command options/,
    )
    await assert.rejects(
      runDecisionRouterCommand(
        ['holds', 'release', '--provider', 'openrouter-jev', '--reason', 'x'],
        { env },
      ),
      /live catalog route/,
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('holds release archives dead-route holds and frees the reserved budget', async () => {
  const { home, env } = sandbox()
  try {
    const { openLocalDecisionBudgetLedger, resolveLocalDecisionBudgetDbPath } = await import(
      '../src/pantheon/local-decision-budget.ts'
    )
    const path = resolveLocalDecisionBudgetDbPath(env)
    const seeded = openLocalDecisionBudgetLedger({
      dbPath: path,
      clock: () => Date.parse('2026-01-10T00:00:00.000Z'),
    })
    try {
      seeded.configureUserCaps({ monthlyCapMicros: 5_000_000, perDecisionCapMicros: 1_000_000 })
      seeded.confirmBudgetPeriod(null, '2026-01').status
    } finally {
      seeded.close()
    }
    // A dead route's hold cannot be reserved through the API; legacy ledgers
    // carry it as a plain row.
    const dead = new DatabaseSync(path)
    dead
      .prepare(
        'INSERT INTO reservations (id, provider, model, period_utc, reserved_micros, actual_micros, state, created_at_ms, updated_at_ms) VALUES (?,?,?,?,?,NULL,?,11,11)',
      )
      .run('hold-dead-1', 'jev-free', 'jev-1.13-free', '2026-01', 100_000, 'pending')
    dead.close()

    const output = []
    await runDecisionRouterCommand(
      ['holds', 'release', '--provider', 'jev-free', '--reason', 'route removed'],
      {
        env,
        stdout: (line) => output.push(line),
      },
    )
    const report = output.join('\n')
    assert.match(report, /Released 1 hold\(s\) of provider jev-free/)
    assert.match(report, /freed 0\.10 USD/)
    assert.match(report, /Archived hold-dead-1/)
    assert.match(report, /state_at_release=pending/)
    assert.match(report, /reason="route removed"/)

    const reopened = openLocalDecisionBudgetLedger({ dbPath: path })
    try {
      assert.equal(reopened.listUncertainReservations().length, 0)
      assert.equal(reopened.listReleasedHolds(10).length, 1)
    } finally {
      reopened.close()
    }
    const listing = []
    await runDecisionRouterCommand(['holds'], { env, stdout: (line) => listing.push(line) })
    assert.match(listing.join('\n'), /No unresolved provider holds/)
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

test('setup-model performs the whole activation chain in one command', async () => {
  const { home, env } = sandbox()
  const output = []
  await runDecisionRouterCommand(
    [
      'setup-model',
      'opencode-console-jev/jev-1.13',
      '--monthly-usd',
      '5',
      '--per-decision-usd',
      '0.10',
    ],
    { env, stdout: (line) => output.push(line) },
  )
  const config = readUserDecisionRouterConfig({ env })
  assert.equal(config.enabled, true)
  assert.deepEqual(config.selection, {
    mode: 'explicit',
    provider: 'opencode-console-jev',
    model: 'jev-1.13',
  })
  assert.equal(config.egress_consent, true)
  assert.deepEqual(config.enabled_candidates, [
    { provider: 'opencode-console-jev', model: 'jev-1.13' },
  ])

  // Caps and period are in the ledger, admission open (reuse the status path).
  const status = []
  await runDecisionRouterCommand(['status'], { env, stdout: (line) => status.push(line) })
  assert.ok(status.some((line) => line.startsWith('Egress: opt-in')))
  assert.ok(status.some((line) => line.includes('Budget period: 20')))
  assert.ok(output.some((line) => line.includes('Native route checklist:')))
  assert.ok(home.length > 0)
})

test('setup-model activates the OpenRouter Jev route from the configured provider matrix', async () => {
  const { home, env } = sandbox()
  try {
    await runDecisionRouterCommand(
      [
        'setup-model',
        'openrouter-jev/typesafe/jev-1.13',
        '--monthly-usd',
        '5',
        '--per-decision-usd',
        '0.10',
      ],
      { env, stdout: () => {} },
    )
    const config = readUserDecisionRouterConfig({ env })
    assert.equal(config.enabled, true)
    assert.equal(config.egress_consent, true)
    assert.deepEqual(config.selection, {
      mode: 'explicit',
      provider: 'openrouter-jev',
      model: 'typesafe/jev-1.13',
    })
    assert.deepEqual(config.enabled_candidates, [
      { provider: 'openrouter-jev', model: 'typesafe/jev-1.13' },
    ])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('Cloudflare setup-model requires a provisionable account entry before enabling the route', async () => {
  const { home, env } = sandbox()
  const hostConfigDir = join(env.XDG_CONFIG_HOME, 'opencode')
  mkdirSync(hostConfigDir, { recursive: true, mode: 0o700 })
  const hostConfigPath = join(hostConfigDir, 'opencode.json')
  writeFileSync(hostConfigPath, '{}\n')
  try {
    await assert.rejects(
      runDecisionRouterCommand(
        [
          'setup-model',
          'cloudflare-workers-jev/clef',
          '--monthly-usd',
          '5',
          '--per-decision-usd',
          '0.10',
        ],
        { env, stdout: () => {} },
      ),
      /requires --account-id=<32-hex-id>; route was not activated/,
    )
    assert.equal(readUserDecisionRouterConfig({ env }).enabled, false)
    assert.equal(readFileSync(hostConfigPath, 'utf8'), '{}\n')

    await runDecisionRouterCommand(
      [
        'setup-model',
        'cloudflare-workers-jev/clef',
        '--monthly-usd',
        '5',
        '--per-decision-usd',
        '0.10',
        '--account-id=0123456789abcdef0123456789abcdef',
      ],
      { env, stdout: () => {} },
    )
    assert.equal(readUserDecisionRouterConfig({ env }).enabled, true)
    const hostConfig = JSON.parse(readFileSync(hostConfigPath, 'utf8'))
    assert.equal(
      hostConfig.providers['cloudflare-workers-ai'].options.accountId,
      '0123456789abcdef0123456789abcdef',
    )
    assert.equal(hostConfig.providers['cloudflare-workers-ai'].models.clef.type, 'decision')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('Cloudflare setup-model activates with a matching accountId and rejects a conflicting one', async () => {
  const accountId = '0123456789abcdef0123456789abcdef'
  const otherAccountId = 'fedcba9876543210fedcba9876543210'
  const args = [
    'setup-model',
    'cloudflare-workers-jev/clef',
    '--monthly-usd',
    '5',
    '--per-decision-usd',
    '0.10',
    `--account-id=${accountId}`,
  ]

  const matching = sandbox()
  const matchingConfigDir = join(matching.env.XDG_CONFIG_HOME, 'opencode')
  mkdirSync(matchingConfigDir, { recursive: true, mode: 0o700 })
  const matchingConfigPath = join(matchingConfigDir, 'opencode.json')
  writeFileSync(
    matchingConfigPath,
    `${JSON.stringify({ providers: { 'cloudflare-workers-ai': { options: { accountId } } } })}\n`,
  )
  try {
    await runDecisionRouterCommand(args, { env: matching.env, stdout: () => {} })
    assert.equal(readUserDecisionRouterConfig({ env: matching.env }).enabled, true)
    assert.equal(
      JSON.parse(readFileSync(matchingConfigPath, 'utf8')).providers['cloudflare-workers-ai']
        .options.accountId,
      accountId,
    )
  } finally {
    rmSync(matching.home, { recursive: true, force: true })
  }

  const conflicting = sandbox()
  const conflictingConfigDir = join(conflicting.env.XDG_CONFIG_HOME, 'opencode')
  mkdirSync(conflictingConfigDir, { recursive: true, mode: 0o700 })
  const conflictingConfigPath = join(conflictingConfigDir, 'opencode.json')
  const existingConfig = {
    providers: { 'cloudflare-workers-ai': { options: { accountId: otherAccountId } } },
  }
  const existingConfigText = `${JSON.stringify(existingConfig)}\n`
  writeFileSync(conflictingConfigPath, existingConfigText)
  try {
    await assert.rejects(
      runDecisionRouterCommand(args, { env: conflicting.env, stdout: () => {} }),
      /existing accountId conflicts with --account-id/,
    )
    assert.equal(readUserDecisionRouterConfig({ env: conflicting.env }).enabled, false)
    assert.equal(readFileSync(conflictingConfigPath, 'utf8'), existingConfigText)
  } finally {
    rmSync(conflicting.home, { recursive: true, force: true })
  }
})

test('setup-model --no-consent configures everything except egress consent', async () => {
  const { env } = sandbox()
  await runDecisionRouterCommand(
    [
      'setup-model',
      'typesafe-jev/jev-1.14.0',
      '--monthly-usd',
      '2',
      '--per-decision-usd',
      '0.05',
      '--no-consent',
    ],
    { env, stdout: () => {} },
  )
  const config = readUserDecisionRouterConfig({ env })
  assert.equal(config.enabled, true)
  assert.deepEqual(config.enabled_candidates, [{ provider: 'typesafe-jev', model: 'jev-1.14.0' }])
  assert.equal(config.egress_consent, false)
})

test('setup-model rejects local/auto targets and requires both caps flags', async () => {
  const { env } = sandbox()
  await assert.rejects(
    runDecisionRouterCommand(
      ['setup-model', 'local', '--monthly-usd', '1', '--per-decision-usd', '1'],
      {
        env,
        stdout: () => {},
      },
    ),
  )
  await assert.rejects(
    runDecisionRouterCommand(
      ['setup-model', 'opencode-console-jev/jev-1.13', '--monthly-usd', '1'],
      {
        env,
        stdout: () => {},
      },
    ),
  )
})

test('doctor diagnoses the chain read-only with route-aware native-route checks', async () => {
  const { home, env } = sandbox()
  const output = []
  await runDecisionRouterCommand(
    [
      'setup-model',
      'opencode-console-jev/jev-1.13',
      '--monthly-usd',
      '5',
      '--per-decision-usd',
      '0.10',
    ],
    { env, stdout: () => {} },
  )
  // Console routes are host-native: the row passes without probing any
  // catalog (decision models are not chat models and never appear in the
  // flat `opencode models` list — field evidence 2.2.5).
  await runDecisionRouterCommand(['doctor'], { env, stdout: (line) => output.push(line) })
  assert.ok(output.some((line) => line.startsWith('✔ config: enabled')))
  assert.ok(output.some((line) => line.startsWith('✔ consent: recorded')))
  assert.ok(output.some((line) => line.startsWith('✔ selection: opencode-console-jev/jev-1.13')))
  assert.ok(output.some((line) => line.startsWith('✔ budget: admission open')))
  assert.ok(
    output.some((line) => line.startsWith('✔ native-route: host-native opencode route')),
    'console route passes without a catalog probe',
  )
  assert.ok(output.some((line) => line.includes('Read-only: doctor never creates')))

  // The TypeSafe route is checked against the host provider entry: a typesafe
  // selection without one fails with the provisioning fix.
  const typesafe = sandbox()
  const tsConfigHome = join(typesafe.env.XDG_CONFIG_HOME, 'pantheon')
  mkdirSync(tsConfigHome, { recursive: true, mode: 0o700 })
  const tsConfigPath = join(tsConfigHome, 'decision-router.json')
  writeFileSync(
    tsConfigPath,
    JSON.stringify({
      schema_version: 2,
      enabled: true,
      egress_consent: true,
      selection: { mode: 'explicit', provider: 'typesafe-jev', model: 'jev-1.14.0' },
      enabled_candidates: [{ provider: 'typesafe-jev', model: 'jev-1.14.0' }],
    }),
  )
  chmodSync(tsConfigPath, 0o600)
  // A real OpenCode install already has a host config; create the minimal one.
  const ocDir = join(typesafe.env.XDG_CONFIG_HOME, 'opencode')
  mkdirSync(ocDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(ocDir, 'opencode.json'), '{}\n')

  // Caps are required for the budget gate; write a ledger via setup-model.
  await runDecisionRouterCommand(
    ['setup-model', 'typesafe-jev/jev-1.14.0', '--monthly-usd', '3', '--per-decision-usd', '0.05'],
    { env: typesafe.env, stdout: () => {} },
  )
  const tsOutput = []
  await runDecisionRouterCommand(['doctor'], { env: typesafe.env, stdout: (l) => tsOutput.push(l) })
  assert.ok(
    tsOutput.some((line) => line.startsWith('✔ native-route:')),
    'setup-model provisioned the host provider entry',
  )
  const opencodeJson = JSON.parse(
    readFileSync(join(typesafe.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'), 'utf8'),
  )
  assert.equal(opencodeJson.providers['typesafe-ai'].models['jev-1.14.0'].type, 'decision')

  // Doctor on a fresh environment flags everything with actionable fixes.
  const fresh = sandbox()
  const freshOutput = []
  await runDecisionRouterCommand(['doctor'], {
    env: fresh.env,
    stdout: (line) => freshOutput.push(line),
  })
  assert.ok(freshOutput.some((line) => line.startsWith('✖ config:')))
  assert.ok(freshOutput.some((line) => line.includes('fix →')))
  rmSync(fresh.home, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
  rmSync(typesafe.home, { recursive: true, force: true })
})
