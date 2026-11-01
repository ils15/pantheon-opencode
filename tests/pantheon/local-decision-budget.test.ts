import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  type BudgetProvider,
  openLocalDecisionBudgetLedger,
  resolveLocalDecisionBudgetDbPath,
} from '../../src/pantheon/local-decision-budget.ts'
import { verifyNativeUsageForReservation } from '../../src/pantheon/local-decision-usage-evidence.internal.ts'

const openai: BudgetProvider = 'openai-decisions'
const openaiModel = 'gpt-6-luna'
const jev: BudgetProvider = 'typesafe-jev'
const jevModel = 'jev-1.14.0'

/** Minimal native host DecisionResult the evidence minter accepts. */
function nativeResult({ costUsd }: { costUsd?: number } = {}): object {
  const result: Record<string, unknown> = {
    answers: [{ type: 'choice', name: 'specialist', choice: 'none' }],
  }
  if (costUsd !== undefined) result.cost = costUsd
  return result
}

function withTempDir(test: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'pantheon-budget-'))
  try {
    test(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function configure(
  ledger: ReturnType<typeof openLocalDecisionBudgetLedger>,
  options: {
    user?: { monthly: number; decision: number }
    provider?: BudgetProvider
    providerCaps?: { monthly: number; decision: number }
    model?: string
    modelCaps?: { monthly: number; decision: number }
    period?: string
  } = {},
): void {
  const provider = options.provider ?? openai
  const model = options.model ?? openaiModel
  const userCaps = options.user ?? { monthly: 100, decision: 70 }
  const providerCaps = options.providerCaps ?? { monthly: 100, decision: 70 }
  const modelCaps = options.modelCaps ?? { monthly: 100, decision: 70 }
  ledger.configureUserCaps({
    monthlyCapMicros: userCaps.monthly,
    perDecisionCapMicros: userCaps.decision,
  })
  ledger.configureProviderCaps(provider, {
    monthlyCapMicros: providerCaps.monthly,
    perDecisionCapMicros: providerCaps.decision,
  })
  ledger.configureModelCaps(provider, model, {
    monthlyCapMicros: modelCaps.monthly,
    perDecisionCapMicros: modelCaps.decision,
  })
  const initialPeriod = options.period ?? new Date().toISOString().slice(0, 7)
  assert.equal(ledger.confirmBudgetPeriod(null, initialPeriod).status, 'confirmed')
}

function runConcurrentReserve(
  dbPath: string,
  provider: BudgetProvider,
  model: string,
): Promise<string> {
  const moduleUrl = new URL('../../src/pantheon/local-decision-budget.ts', import.meta.url).href
  const script = `
    const { openLocalDecisionBudgetLedger } = await import(${JSON.stringify(moduleUrl)});
    const ledger = openLocalDecisionBudgetLedger({ dbPath: ${JSON.stringify(dbPath)} });
    const result = ledger.reserve(${JSON.stringify(provider)}, ${JSON.stringify(model)});
    console.log(result.status);
    ledger.close();
  `
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`child exited ${code}: ${stderr}`))
      else resolve(stdout.trim())
    })
  })
}

function runConcurrentConfirm(
  dbPath: string,
  expectedPeriod: string,
  targetPeriod: string,
): Promise<string> {
  const moduleUrl = new URL('../../src/pantheon/local-decision-budget.ts', import.meta.url).href
  const clockMs = Date.parse(`${targetPeriod}-01T00:00:00.000Z`)
  const script = `
    const { openLocalDecisionBudgetLedger } = await import(${JSON.stringify(moduleUrl)});
    const ledger = openLocalDecisionBudgetLedger({ dbPath: ${JSON.stringify(dbPath)}, clock: () => ${clockMs} });
    const result = ledger.confirmBudgetPeriod(${JSON.stringify(expectedPeriod)}, ${JSON.stringify(targetPeriod)});
    console.log(result.status === 'confirmed' ? result.status : result.reason);
    ledger.close();
  `
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`child exited ${code}: ${stderr}`))
      else resolve(stdout.trim())
    })
  })
}

function testDefaultPathUsesUserStateDirectory(): void {
  assert.equal(
    resolveLocalDecisionBudgetDbPath({ XDG_STATE_HOME: '/tmp/user-state', HOME: '/home/example' }),
    '/tmp/user-state/pantheon/decision-budget.sqlite',
  )
  assert.equal(
    resolveLocalDecisionBudgetDbPath({ HOME: '/home/example' }),
    '/home/example/.local/state/pantheon/decision-budget.sqlite',
  )
  assert.equal(
    resolveLocalDecisionBudgetDbPath({ XDG_STATE_HOME: 'relative', HOME: '/home/example' }),
    '/home/example/.local/state/pantheon/decision-budget.sqlite',
  )
}

function testMissingConfirmationAndWallClockDivergenceFailClosed(): void {
  withTempDir((directory) => {
    let wallClock = Date.parse('2026-01-31T23:59:59.999Z')
    let monotonicClock = 10
    const ledger = openLocalDecisionBudgetLedger({
      dbPath: join(directory, 'ledger.sqlite'),
      clock: () => wallClock,
      monotonicClock: () => monotonicClock,
    })
    ledger.configureUserCaps({ monthlyCapMicros: 100, perDecisionCapMicros: 20 })
    ledger.configureProviderCaps(openai, { monthlyCapMicros: 100, perDecisionCapMicros: 20 })
    ledger.configureModelCaps(openai, openaiModel, {
      monthlyCapMicros: 100,
      perDecisionCapMicros: 20,
    })
    assert.equal(ledger.reserve(openai, openaiModel).reason, 'period-unconfirmed')
    assert.equal(ledger.confirmBudgetPeriod(null, '2026-01').status, 'confirmed')
    assert.equal(ledger.reserve(openai, openaiModel).period, '2026-01')

    wallClock = Date.parse('2026-02-01T00:00:00.000Z')
    monotonicClock += 1
    assert.equal(ledger.reserve(openai, openaiModel).reason, 'period-mismatch')
    assert.equal(ledger.getActiveBudgetPeriod(), '2026-01')
    const advanced = ledger.confirmBudgetPeriod('2026-01', '2026-02')
    assert.deepEqual(advanced, { status: 'confirmed', activePeriod: '2026-02' })
    assert.equal(ledger.reserve(openai, openaiModel).period, '2026-02')

    wallClock = Date.parse('2026-01-15T12:00:00.000Z')
    monotonicClock += 1
    assert.equal(ledger.reserve(openai, openaiModel).reason, 'clock-untrusted')
    assert.equal(ledger.getActiveBudgetPeriod(), '2026-02')
    ledger.close()
  })
}

function testAdmissionCheckIsReadOnlyAndAppliesAllConfiguredCaps(): void {
  withTempDir((directory) => {
    const ledger = openLocalDecisionBudgetLedger({
      dbPath: join(directory, 'ledger.sqlite'),
      clock: () => Date.parse('2026-10-15T12:00:00.000Z'),
      monotonicClock: () => 1,
    })
    assert.equal(ledger.canReserve(openai, openaiModel).reason, 'no-cap')
    configure(ledger, {
      user: { monthly: 100, decision: 70 },
      providerCaps: { monthly: 100, decision: 70 },
      modelCaps: { monthly: 100, decision: 70 },
      period: '2026-10',
    })
    assert.deepEqual(ledger.canReserve(openai, openaiModel), { status: 'eligible' })
    assert.deepEqual(ledger.canReserve(openai, openaiModel), { status: 'eligible' })
    assert.equal(ledger.reserve(openai, openaiModel).status, 'reserved')
    assert.equal(ledger.canReserve(openai, openaiModel).reason, 'monthly-cap')
    ledger.close()
  })
}

async function testExplicitAdvanceIsOneMonthAndAtomicAcrossProcesses(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'pantheon-budget-'))
  try {
    const dbPath = join(directory, 'ledger.sqlite')
    const ledger = openLocalDecisionBudgetLedger({
      dbPath,
      clock: () => Date.parse('2026-01-15T00:00:00.000Z'),
    })
    configure(ledger, { period: '2026-01' })
    assert.equal(ledger.confirmBudgetPeriod('2026-01', '2026-03').reason, 'not-next-month')
    assert.equal(ledger.confirmBudgetPeriod('2026-01', '2025-12').reason, 'backwards')
    assert.equal(ledger.getActiveBudgetPeriod(), '2026-01')
    ledger.close()

    const results = await Promise.all([
      runConcurrentConfirm(dbPath, '2026-01', '2026-02'),
      runConcurrentConfirm(dbPath, '2026-01', '2026-02'),
    ])
    assert.deepEqual(results.sort(), ['confirmed', 'stale-current'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function testMissingZeroAndMalformedCapsFailClosed(): void {
  withTempDir((directory) => {
    const dbPath = join(directory, 'new.sqlite')
    const ledger = openLocalDecisionBudgetLedger({ dbPath })
    assert.equal(ledger.reserve(openai, openaiModel).reason, 'no-cap')
    ledger.configureUserCaps({ monthlyCapMicros: 100, perDecisionCapMicros: 70 })
    ledger.configureProviderCaps(openai, { monthlyCapMicros: 100, perDecisionCapMicros: 70 })
    assert.equal(ledger.reserve(openai, openaiModel).reason, 'no-cap')
    ledger.configureModelCaps(openai, openaiModel, {
      monthlyCapMicros: 100,
      perDecisionCapMicros: 0,
    })
    assert.equal(ledger.reserve(openai, openaiModel).reason, 'no-cap')
    ledger.configureModelCaps(openai, openaiModel, {
      monthlyCapMicros: 100,
      perDecisionCapMicros: 70,
    })
    ledger.configureProviderCaps(openai, { monthlyCapMicros: 0, perDecisionCapMicros: 70 })
    assert.equal(ledger.reserve(openai, openaiModel).reason, 'no-cap')
    ledger.configureProviderCaps(openai, { monthlyCapMicros: 100, perDecisionCapMicros: 70 })
    ledger.configureUserCaps({ monthlyCapMicros: 0, perDecisionCapMicros: 70 })
    assert.equal(ledger.reserve(openai, openaiModel).reason, 'no-cap')
    ledger.configureUserCaps({ monthlyCapMicros: 100, perDecisionCapMicros: 70 })
    assert.equal(
      ledger.confirmBudgetPeriod(null, new Date().toISOString().slice(0, 7)).status,
      'confirmed',
    )
    assert.throws(() =>
      ledger.configureModelCaps(openai, openaiModel, {
        monthlyCapMicros: Number.NaN,
        perDecisionCapMicros: 70,
      }),
    )
    assert.equal(ledger.reserve(openai, openaiModel).status, 'reserved')

    ledger.configureModelCaps(openai, openaiModel, {
      monthlyCapMicros: 100,
      perDecisionCapMicros: 70,
    })
    const direct = new DatabaseSync(dbPath)
    direct.exec('PRAGMA ignore_check_constraints = ON')
    direct.prepare('UPDATE model_caps SET monthly_cap_micros = -1').run()
    direct.close()
    assert.equal(ledger.reserve(openai, openaiModel).reason, 'no-cap')
    ledger.close()
  })
}

function testReservationUsesDatabasePolicyAndReservesConfiguredMaximum(): void {
  withTempDir((directory) => {
    const ledger = openLocalDecisionBudgetLedger({ dbPath: join(directory, 'ledger.sqlite') })
    configure(ledger, { modelCaps: { monthly: 100, decision: 40 } })
    const reserve = ledger.reserve as (...args: unknown[]) => {
      status: string
      reservedMicros?: number
    }
    const result = reserve(openai, openaiModel, 1)
    assert.equal(result.status, 'reserved')
    assert.equal(result.reservedMicros, 40)
    const second = reserve(openai, openaiModel, 1_000_000)
    assert.equal(second.status, 'reserved')
    assert.equal(second.reservedMicros, 40)
    assert.equal(ledger.reserve(openai, openaiModel).reason, 'monthly-cap')
    ledger.close()
  })
}

function testDecisionCapsAndGlobalUserProviderModelBucketsAreIndependent(): void {
  withTempDir((directory) => {
    const ledger = openLocalDecisionBudgetLedger({ dbPath: join(directory, 'ledger.sqlite') })
    configure(ledger, {
      user: { monthly: 200, decision: 80 },
      providerCaps: { monthly: 200, decision: 80 },
      modelCaps: { monthly: 100, decision: 50 },
    })
    const first = ledger.reserve(openai, openaiModel)
    assert.equal(first.status, 'reserved')
    if (first.status !== 'reserved') throw new Error('expected reservation')
    assert.equal(first.reservedMicros, 50)
    assert.equal(ledger.reserve(openai, openaiModel).status, 'reserved')
    assert.equal(ledger.reserve(openai, openaiModel).reason, 'monthly-cap')
    ledger.close()
  })

  withTempDir((directory) => {
    const ledger = openLocalDecisionBudgetLedger({ dbPath: join(directory, 'ledger.sqlite') })
    configure(ledger, {
      user: { monthly: 100, decision: 70 },
      modelCaps: { monthly: 100, decision: 60 },
    })
    ledger.configureProviderCaps('jev-free', { monthlyCapMicros: 100, perDecisionCapMicros: 70 })
    ledger.configureModelCaps('jev-free', 'jev-free-model', {
      monthlyCapMicros: 100,
      perDecisionCapMicros: 60,
    })
    assert.equal(ledger.reserve(openai, openaiModel).status, 'reserved')
    assert.equal(ledger.reserve('jev-free', 'jev-free-model').reason, 'monthly-cap')
    ledger.close()
  })

  withTempDir((directory) => {
    const ledger = openLocalDecisionBudgetLedger({ dbPath: join(directory, 'ledger.sqlite') })
    configure(ledger, {
      user: { monthly: 100, decision: 30 },
      providerCaps: { monthly: 100, decision: 40 },
      modelCaps: { monthly: 100, decision: 40 },
    })
    assert.equal(ledger.reserve(openai, openaiModel).reason, 'per-decision-cap')
    ledger.close()
  })
}

function testOpenCodeVariantsShareProviderCapAndHaveSeparateModelCaps(): void {
  withTempDir((directory) => {
    const ledger = openLocalDecisionBudgetLedger({ dbPath: join(directory, 'ledger.sqlite') })
    ledger.configureUserCaps({ monthlyCapMicros: 200, perDecisionCapMicros: 60 })
    ledger.configureProviderCaps('opencode-console', {
      monthlyCapMicros: 70,
      perDecisionCapMicros: 60,
    })
    ledger.configureModelCaps('opencode-console', 'variant-a', {
      monthlyCapMicros: 100,
      perDecisionCapMicros: 60,
    })
    ledger.configureModelCaps('opencode-console', 'variant-b', {
      monthlyCapMicros: 100,
      perDecisionCapMicros: 60,
    })
    assert.equal(
      ledger.confirmBudgetPeriod(null, new Date().toISOString().slice(0, 7)).status,
      'confirmed',
    )
    assert.equal(ledger.reserve('opencode-console', 'variant-a').status, 'reserved')
    assert.equal(ledger.reserve('opencode-console', 'variant-b').reason, 'monthly-cap')
    ledger.close()
  })
}

function testDuplicateReservationIdCannotDoubleAdmit(): void {
  withTempDir((directory) => {
    const ledger = openLocalDecisionBudgetLedger({
      dbPath: join(directory, 'ledger.sqlite'),
      reservationIdFactory: () => 'repeat-id',
    })
    configure(ledger, { modelCaps: { monthly: 100, decision: 40 } })
    assert.equal(ledger.reserve(openai, openaiModel).status, 'reserved')
    assert.equal(ledger.reserve(openai, openaiModel).reason, 'duplicate-reservation-id')
    ledger.close()
  })
}

function testPendingReservationSurvivesRestartAndRecovery(): void {
  withTempDir((directory) => {
    const dbPath = join(directory, 'ledger.sqlite')
    const first = openLocalDecisionBudgetLedger({ dbPath })
    configure(first, { provider: jev, model: jevModel, modelCaps: { monthly: 100, decision: 60 } })
    const reservation = first.reserve(jev, jevModel)
    if (reservation.status !== 'reserved') throw new Error('expected reservation')
    first.close()

    const reopened = openLocalDecisionBudgetLedger({ dbPath })
    const unresolved = reopened.listUncertainReservations()
    assert.equal(unresolved.length, 1)
    assert.equal(unresolved[0]?.state, 'pending')
    assert.equal(unresolved[0]?.model, jevModel)
    assert.equal(reopened.recoverPendingReservations(), 1)
    assert.equal(reopened.listUncertainReservations()[0]?.state, 'uncertain')
    assert.equal(reopened.reserve(jev, jevModel).reason, 'monthly-cap')
    const evidence = verifyNativeUsageForReservation(
      {
        reservationId: reservation.reservationId,
        provider: jev,
        model: jevModel,
        period: reservation.period,
      },
      nativeResult({ costUsd: 0.00001 }),
    )
    assert.ok(evidence)
    assert.equal(
      reopened.reconcileVerified(reservation.reservationId, evidence).status,
      'reconciled',
    )
    assert.equal(reopened.reserve(jev, jevModel).status, 'reserved')
    reopened.close()
  })
}

function testOpaqueVerifiedEvidenceRoundsCostsAndRejectsForgeryOrMismatch(): void {
  withTempDir((directory) => {
    const ledger = openLocalDecisionBudgetLedger({ dbPath: join(directory, 'ledger.sqlite') })
    configure(ledger, {
      modelCaps: { monthly: 100, decision: 60 },
      provider: 'typesafe-jev',
      model: 'jev-1.14.0',
    })
    const reservation = ledger.reserve('typesafe-jev', 'jev-1.14.0')
    if (reservation.status !== 'reserved') throw new Error('expected reservation')
    const forged = { reservationId: reservation.reservationId, actualCostMicros: 0 }
    assert.equal(
      ledger.reconcileVerified(reservation.reservationId, forged as never).status,
      'unknown',
    )
    assert.equal(
      ledger.reconcileVerified(reservation.reservationId, {
        reservationId: reservation.reservationId,
        actualCostMicros: -1,
      } as never).status,
      'unknown',
    )
    assert.equal(ledger.listUncertainReservations().length, 1)

    const binding = {
      reservationId: reservation.reservationId,
      provider: 'typesafe-jev',
      model: 'jev-1.14.0',
      period: reservation.period,
    }
    assert.equal(
      verifyNativeUsageForReservation(binding, { answers: [{}], cost: -1 }),
      null,
      'a negative host cost mints nothing',
    )
    assert.equal(
      verifyNativeUsageForReservation(binding, { answers: [{}], cost: '2' }),
      null,
      'a non-numeric host cost mints nothing',
    )
    assert.equal(
      verifyNativeUsageForReservation(binding, { answers: [] }),
      null,
      'a result without answers is not evidence a decision was paid for',
    )

    const wrongPeriod = verifyNativeUsageForReservation(
      { ...binding, period: '0001-01' },
      nativeResult({ costUsd: 0.000001 }),
    )
    assert.ok(wrongPeriod)
    assert.equal(
      ledger.reconcileVerified(reservation.reservationId, wrongPeriod).status,
      'mismatch',
    )

    const wrongReservation = verifyNativeUsageForReservation(
      { ...binding, reservationId: 'different-reservation' },
      nativeResult({ costUsd: 0.000001 }),
    )
    assert.ok(wrongReservation)
    assert.equal(
      ledger.reconcileVerified(reservation.reservationId, wrongReservation).status,
      'mismatch',
    )

    const wrongProvider = verifyNativeUsageForReservation(
      { ...binding, provider: 'jev-free', model: 'jev-1.13-free' },
      nativeResult({ costUsd: 0.000001 }),
    )
    assert.ok(wrongProvider)
    assert.equal(
      ledger.reconcileVerified(reservation.reservationId, wrongProvider).status,
      'mismatch',
    )

    assert.equal(ledger.listUncertainReservations().length, 1)
    assert.equal(ledger.reserve('typesafe-jev', 'jev-1.14.0').reason, 'monthly-cap')

    // Absent host cost is a real zero: reconciling releases the hold instead
    // of burning the period's budget (free Console variants).
    const zeroCost = verifyNativeUsageForReservation(binding, nativeResult())
    assert.ok(zeroCost)
    assert.deepEqual(ledger.reconcileVerified(reservation.reservationId, zeroCost), {
      status: 'reconciled',
      actualCostMicros: 0,
      frozen: false,
    })
    assert.equal(ledger.reserve('typesafe-jev', 'jev-1.14.0').status, 'reserved')
    ledger.close()
  })
}

function testVerifiedUsageMustMatchReservationModel(): void {
  withTempDir((directory) => {
    const ledger = openLocalDecisionBudgetLedger({ dbPath: join(directory, 'ledger.sqlite') })
    configure(ledger, { provider: 'typesafe-jev', model: 'other-model' })
    const reservation = ledger.reserve('typesafe-jev', 'other-model')
    if (reservation.status !== 'reserved') throw new Error('expected reservation')
    const evidence = verifyNativeUsageForReservation(
      {
        reservationId: reservation.reservationId,
        provider: 'typesafe-jev',
        model: 'jev-1.14.0',
        period: reservation.period,
      },
      nativeResult(),
    )
    assert.ok(evidence)
    assert.equal(ledger.reconcileVerified(reservation.reservationId, evidence).status, 'mismatch')
    assert.equal(ledger.listUncertainReservations()[0]?.reservationId, reservation.reservationId)
    ledger.close()
  })
}

function testNativeEvidenceOverrunFreezesScopesAndReconcileIsAtomic(): void {
  withTempDir((directory) => {
    const dbPath = join(directory, 'ledger.sqlite')
    const ledger = openLocalDecisionBudgetLedger({ dbPath })
    configure(ledger, {
      provider: jev,
      model: jevModel,
      modelCaps: { monthly: 100, decision: 20 },
    })
    const reservation = ledger.reserve(jev, jevModel)
    if (reservation.status !== 'reserved') throw new Error('expected reservation')
    const evidence = verifyNativeUsageForReservation(
      {
        reservationId: reservation.reservationId,
        provider: jev,
        model: jevModel,
        period: reservation.period,
      },
      nativeResult({ costUsd: 0.00005 }),
    )
    assert.ok(evidence)
    assert.equal(ledger.listUncertainReservations()[0]?.reservationId, reservation.reservationId)

    const database = new DatabaseSync(dbPath)
    database.exec(`CREATE TRIGGER reject_freezes BEFORE INSERT ON budget_freezes
      BEGIN SELECT RAISE(ABORT, 'forced atomicity failure'); END;`)
    assert.throws(() => ledger.reconcileVerified(reservation.reservationId, evidence))
    const unchanged = database
      .prepare('SELECT state, actual_micros FROM reservations WHERE id = ?')
      .get(reservation.reservationId) as { state: string; actual_micros: number | null }
    assert.equal(unchanged.state, 'pending')
    assert.equal(unchanged.actual_micros, null)
    assert.equal(database.prepare('SELECT count(*) AS n FROM budget_freezes').get()?.n, 0)

    database.exec('DROP TRIGGER reject_freezes')
    const result = ledger.reconcileVerified(reservation.reservationId, evidence)
    assert.deepEqual(result, { status: 'reconciled', actualCostMicros: 50, frozen: true })
    assert.equal(
      ledger.reconcileVerified(reservation.reservationId, evidence).status,
      'already-reconciled',
    )
    assert.equal(database.prepare('SELECT count(*) AS n FROM budget_freezes').get()?.n, 3)
    assert.equal(ledger.reserve(jev, jevModel).reason, 'frozen')
    const stored = database
      .prepare('SELECT actual_micros FROM reservations WHERE id = ?')
      .get(reservation.reservationId) as { actual_micros: number }
    assert.equal(stored.actual_micros, 50)
    database.close()
    ledger.close()
  })
}

async function testSeparateProcessesCannotOverspendConcurrently(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'pantheon-budget-'))
  try {
    const dbPath = join(directory, 'ledger.sqlite')
    const ledger = openLocalDecisionBudgetLedger({ dbPath })
    configure(ledger, {
      user: { monthly: 60, decision: 60 },
      providerCaps: { monthly: 60, decision: 60 },
      modelCaps: { monthly: 60, decision: 60 },
    })
    ledger.close()
    const results = await Promise.all([
      runConcurrentReserve(dbPath, openai, openaiModel),
      runConcurrentReserve(dbPath, openai, openaiModel),
    ])
    assert.deepEqual(results.sort(), ['denied', 'reserved'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function testVersionOneMigrationPreservesCapsReservationsAndUnknownHolds(): void {
  withTempDir((directory) => {
    const dbPath = join(directory, 'legacy.sqlite')
    const old = new DatabaseSync(dbPath)
    old.exec(`
      PRAGMA application_id = 1346522161;
      PRAGMA user_version = 1;
      CREATE TABLE provider_caps (
        provider TEXT PRIMARY KEY NOT NULL,
        monthly_cap_micros INTEGER NOT NULL CHECK (monthly_cap_micros >= 0),
        per_decision_cap_micros INTEGER NOT NULL CHECK (per_decision_cap_micros >= 0),
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE reservations (
        id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL,
        period_utc TEXT NOT NULL CHECK (length(period_utc) = 7),
        reserved_micros INTEGER NOT NULL CHECK (reserved_micros > 0),
        actual_micros INTEGER CHECK (actual_micros IS NULL OR actual_micros >= 0),
        state TEXT NOT NULL CHECK (state IN ('pending', 'uncertain', 'reconciled')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        CHECK ((state = 'reconciled' AND actual_micros IS NOT NULL) OR
               (state IN ('pending', 'uncertain') AND actual_micros IS NULL))
      ) STRICT;
      CREATE INDEX reservations_provider_period_idx ON reservations (provider, period_utc, state);
      CREATE INDEX reservations_period_state_idx ON reservations (period_utc, state);
      CREATE TABLE ledger_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        highest_period_utc TEXT NOT NULL CHECK (length(highest_period_utc) = 7),
        last_seen_ms INTEGER NOT NULL
      ) STRICT;
      INSERT INTO provider_caps VALUES ('jev', 100, 70, 123);
      INSERT INTO reservations VALUES ('pending-old', 'jev', '2026-01', 60, NULL, 'pending', 10, 10);
      INSERT INTO reservations VALUES ('done-old', 'jev', '2026-01', 5, 3, 'reconciled', 11, 12);
      INSERT INTO ledger_state VALUES (1, '2026-01', 12);
    `)
    old.close()

    const ledger = openLocalDecisionBudgetLedger({
      dbPath,
      clock: () => Date.parse('2026-01-20T00:00:00.000Z'),
    })
    assert.equal(ledger.listUncertainReservations().length, 2)
    assert.equal(ledger.listUncertainReservations()[0]?.provider, 'typesafe-jev')
    assert.equal(ledger.listUncertainReservations()[0]?.model, 'jev-1.14.0')
    assert.equal(ledger.getActiveBudgetPeriod(), null)
    assert.equal(ledger.confirmBudgetPeriod(null, '2026-01').status, 'confirmed')
    ledger.configureUserCaps({ monthlyCapMicros: 100, perDecisionCapMicros: 70 })
    assert.equal(ledger.reserve('typesafe-jev', 'jev-1.14.0').reason, 'no-cap')
    ledger.configureModelCaps('typesafe-jev', 'jev-1.14.0', {
      monthlyCapMicros: 100,
      perDecisionCapMicros: 30,
    })
    const result = ledger.reserve('typesafe-jev', 'jev-1.14.0')
    assert.equal(result.status, 'reserved')
    if (result.status === 'reserved') assert.equal(result.reservedMicros, 30)
    assert.equal(ledger.reserve('typesafe-jev', 'jev-1.14.0').reason, 'monthly-cap')
    ledger.close()

    const migrated = new DatabaseSync(dbPath, { readOnly: true })
    assert.equal(migrated.prepare('PRAGMA user_version').get()?.user_version, 3)
    assert.equal(
      migrated
        .prepare("SELECT count(*) AS n FROM reservations WHERE id IN ('pending-old', 'done-old')")
        .get()?.n,
      2,
    )
    assert.equal(
      migrated
        .prepare("SELECT monthly_cap_micros FROM provider_caps WHERE provider = 'typesafe-jev'")
        .get()?.monthly_cap_micros,
      100,
    )
    migrated.close()
  })
}

function testVersionTwoMigrationPreservesFutureDatedHoldsAndRequiresFreshConfirmation(): void {
  withTempDir((directory) => {
    const dbPath = join(directory, 'v2.sqlite')
    const old = new DatabaseSync(dbPath)
    old.exec(`
      PRAGMA application_id = 1346522161;
      PRAGMA user_version = 2;
      CREATE TABLE user_caps (
        id INTEGER PRIMARY KEY CHECK (id = 1), monthly_cap_micros INTEGER NOT NULL,
        per_decision_cap_micros INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE provider_caps (
        provider TEXT PRIMARY KEY NOT NULL, monthly_cap_micros INTEGER NOT NULL,
        per_decision_cap_micros INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE model_caps (
        provider TEXT NOT NULL, model TEXT NOT NULL, monthly_cap_micros INTEGER NOT NULL,
        per_decision_cap_micros INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (provider, model)
      ) STRICT;
      CREATE TABLE reservations (
        id TEXT PRIMARY KEY NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        period_utc TEXT NOT NULL, reserved_micros INTEGER NOT NULL, actual_micros INTEGER,
        state TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX reservations_provider_period_idx ON reservations(provider, period_utc, state);
      CREATE INDEX reservations_model_period_idx ON reservations(provider, model, period_utc, state);
      CREATE INDEX reservations_period_state_idx ON reservations(period_utc, state);
      CREATE INDEX reservations_state_created_idx ON reservations(state, created_at_ms, id);
      CREATE TABLE ledger_state (
        id INTEGER PRIMARY KEY CHECK (id = 1), highest_period_utc TEXT NOT NULL,
        last_seen_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE budget_freezes (
        id INTEGER PRIMARY KEY, scope TEXT NOT NULL, provider TEXT, model TEXT,
        period_utc TEXT NOT NULL, reason TEXT NOT NULL, created_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX budget_freezes_unique_idx
        ON budget_freezes(scope, ifnull(provider, ''), ifnull(model, ''), period_utc);
      CREATE INDEX budget_freezes_period_scope_idx
        ON budget_freezes(period_utc, scope, provider, model);
      INSERT INTO user_caps VALUES (1, 96, 70, 1);
      INSERT INTO provider_caps VALUES ('typesafe-jev', 96, 70, 1);
      INSERT INTO model_caps VALUES ('typesafe-jev', 'jev-1.14.0', 96, 30, 1);
      INSERT INTO reservations VALUES
        ('pending-future', 'typesafe-jev', 'jev-1.14.0', '2026-03', 60, NULL, 'pending', 1, 1);
      INSERT INTO reservations VALUES
        ('done-future', 'typesafe-jev', 'jev-1.14.0', '2026-03', 5, 8, 'reconciled', 1, 1);
      INSERT INTO ledger_state VALUES (1, '2026-03', 1772323200000);
    `)
    old.close()

    const ledger = openLocalDecisionBudgetLedger({
      dbPath,
      clock: () => Date.parse('2026-01-20T00:00:00.000Z'),
    })
    assert.equal(ledger.getActiveBudgetPeriod(), null)
    assert.equal(ledger.reserve('typesafe-jev', 'jev-1.14.0').reason, 'period-unconfirmed')
    assert.deepEqual(
      ledger.listUncertainReservations().map(({ reservationId, state }) => [reservationId, state]),
      [
        ['done-future', 'uncertain'],
        ['pending-future', 'pending'],
      ],
    )
    assert.equal(ledger.confirmBudgetPeriod(null, '2026-01').status, 'confirmed')
    assert.equal(ledger.reserve('typesafe-jev', 'jev-1.14.0').reason, 'monthly-cap')
    ledger.close()

    const migrated = new DatabaseSync(dbPath, { readOnly: true })
    assert.equal(migrated.prepare('PRAGMA user_version').get()?.user_version, 3)
    assert.equal(
      migrated.prepare("SELECT count(*) AS n FROM reservations WHERE period_utc = '2026-03'").get()
        ?.n,
      2,
    )
    assert.equal(
      migrated.prepare('SELECT active_period_utc FROM ledger_state WHERE id = 1').get()
        ?.active_period_utc,
      '2026-01',
    )
    const normalizedHold = migrated
      .prepare(
        "SELECT reserved_micros, actual_micros, state FROM reservations WHERE id = 'done-future'",
      )
      .get() as { reserved_micros: number; actual_micros: number | null; state: string }
    assert.equal(normalizedHold.reserved_micros, 8)
    assert.equal(normalizedHold.actual_micros, null)
    assert.equal(normalizedHold.state, 'uncertain')
    migrated.close()
  })
}

function testFailedVersionTwoMigrationRollsBackHoldNormalization(): void {
  withTempDir((directory) => {
    const dbPath = join(directory, 'v2-conflict.sqlite')
    const old = new DatabaseSync(dbPath)
    old.exec(`
      PRAGMA application_id = 1346522161;
      PRAGMA user_version = 2;
      CREATE TABLE user_caps (id INTEGER, monthly_cap_micros INTEGER,
        per_decision_cap_micros INTEGER, updated_at_ms INTEGER);
      CREATE TABLE provider_caps (provider TEXT, monthly_cap_micros INTEGER,
        per_decision_cap_micros INTEGER, updated_at_ms INTEGER);
      CREATE TABLE model_caps (provider TEXT, model TEXT, monthly_cap_micros INTEGER,
        per_decision_cap_micros INTEGER, updated_at_ms INTEGER);
      CREATE TABLE reservations (id TEXT, provider TEXT, model TEXT, period_utc TEXT,
        reserved_micros INTEGER, actual_micros INTEGER, state TEXT,
        created_at_ms INTEGER, updated_at_ms INTEGER);
      CREATE TABLE ledger_state (id INTEGER, highest_period_utc TEXT, last_seen_ms INTEGER);
      CREATE TABLE budget_freezes (id INTEGER, scope TEXT, provider TEXT, model TEXT,
        period_utc TEXT, reason TEXT, created_at_ms INTEGER);
      CREATE TABLE ledger_state_v2 (marker TEXT);
      INSERT INTO reservations VALUES
        ('already-reconciled', 'openai-decisions', 'gpt-6-luna', '2026-01', 10, 0,
         'reconciled', 1, 1);
      INSERT INTO ledger_state VALUES (1, '2026-03', 1);
      INSERT INTO ledger_state_v2 VALUES ('keep');
    `)
    old.close()

    assert.throws(() => openLocalDecisionBudgetLedger({ dbPath }))
    const afterFailure = new DatabaseSync(dbPath, { readOnly: true })
    assert.equal(afterFailure.prepare('PRAGMA user_version').get()?.user_version, 2)
    const unchangedHold = afterFailure
      .prepare("SELECT state, actual_micros FROM reservations WHERE id = 'already-reconciled'")
      .get() as { state: string; actual_micros: number }
    assert.equal(unchangedHold.state, 'reconciled')
    assert.equal(unchangedHold.actual_micros, 0)
    assert.equal(
      afterFailure.prepare('SELECT highest_period_utc FROM ledger_state WHERE id = 1').get()
        ?.highest_period_utc,
      '2026-03',
    )
    afterFailure.close()
  })
}

function testFailedVersionOneMigrationRollsBackCompletely(): void {
  withTempDir((directory) => {
    const dbPath = join(directory, 'migration-conflict.sqlite')
    const old = new DatabaseSync(dbPath)
    old.exec(`
      PRAGMA application_id = 1346522161;
      PRAGMA user_version = 1;
      CREATE TABLE provider_caps (
        provider TEXT PRIMARY KEY NOT NULL,
        monthly_cap_micros INTEGER NOT NULL,
        per_decision_cap_micros INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE reservations (
        id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL,
        period_utc TEXT NOT NULL,
        reserved_micros INTEGER NOT NULL,
        actual_micros INTEGER,
        state TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE ledger_state (id INTEGER PRIMARY KEY, highest_period_utc TEXT, last_seen_ms INTEGER);
      CREATE TABLE user_caps (legacy_marker TEXT);
      INSERT INTO provider_caps VALUES ('jev', 100, 70, 1);
    `)
    old.close()

    assert.throws(() => openLocalDecisionBudgetLedger({ dbPath }))
    const afterFailure = new DatabaseSync(dbPath, { readOnly: true })
    assert.equal(afterFailure.prepare('PRAGMA user_version').get()?.user_version, 1)
    assert.equal(
      afterFailure.prepare("SELECT provider FROM provider_caps WHERE provider = 'jev'").get()
        ?.provider,
      'jev',
    )
    assert.equal(
      afterFailure
        .prepare("SELECT count(*) AS n FROM pragma_table_info('reservations') WHERE name = 'model'")
        .get()?.n,
      0,
    )
    assert.equal(afterFailure.prepare('SELECT legacy_marker FROM user_caps').all().length, 0)
    afterFailure.close()
  })
}

function testUnversionedNonemptyAndIncompatibleDatabasesAreRejected(): void {
  withTempDir((directory) => {
    const dbPath = join(directory, 'foreign.sqlite')
    const database = new DatabaseSync(dbPath)
    database.exec('CREATE TABLE foreign_data (value TEXT)')
    database.close()
    assert.throws(() => openLocalDecisionBudgetLedger({ dbPath }))
  })
}

function testCorruptLockedUnavailableAndSymlinkPathsFailClosed(): void {
  withTempDir((directory) => {
    const corruptPath = join(directory, 'corrupt.sqlite')
    writeFileSync(corruptPath, 'not a sqlite database')
    assert.throws(() => openLocalDecisionBudgetLedger({ dbPath: corruptPath }))

    const dbPath = join(directory, 'busy.sqlite')
    const ledger = openLocalDecisionBudgetLedger({ dbPath, busyTimeoutMs: 20 })
    configure(ledger)
    const blocker = new DatabaseSync(dbPath)
    blocker.exec('BEGIN EXCLUSIVE')
    assert.throws(() => ledger.reserve(openai, openaiModel))
    blocker.exec('ROLLBACK')
    blocker.close()
    ledger.close()

    const parentFile = join(directory, 'not-a-directory')
    writeFileSync(parentFile, 'x')
    assert.throws(() =>
      openLocalDecisionBudgetLedger({ dbPath: join(parentFile, 'ledger.sqlite') }),
    )

    const realPath = join(directory, 'real.sqlite')
    const linkedPath = join(directory, 'linked.sqlite')
    writeFileSync(realPath, '')
    symlinkSync(realPath, linkedPath)
    assert.throws(() => openLocalDecisionBudgetLedger({ dbPath: linkedPath }))

    const actualAncestor = join(directory, 'actual-ancestor')
    const linkedAncestor = join(directory, 'linked-ancestor')
    mkdirSync(actualAncestor)
    symlinkSync(actualAncestor, linkedAncestor, 'dir')
    assert.throws(() =>
      openLocalDecisionBudgetLedger({ dbPath: join(linkedAncestor, 'ledger.sqlite') }),
    )

    const writableAncestor = join(directory, 'writable-ancestor')
    mkdirSync(writableAncestor)
    chmodSync(writableAncestor, 0o777)
    assert.throws(() =>
      openLocalDecisionBudgetLedger({ dbPath: join(writableAncestor, 'ledger.sqlite') }),
    )
  })
}

function testPrivatePathPermissionsAndPruneResolvedButNotPendingPeriods(): void {
  withTempDir((directory) => {
    let now = Date.parse('2026-01-10T00:00:00.000Z')
    const dbPath = join(directory, 'state', 'ledger.sqlite')
    const ledger = openLocalDecisionBudgetLedger({ dbPath, clock: () => now })
    configure(ledger, { modelCaps: { monthly: 100, decision: 20 }, period: '2026-01' })
    const completed = ledger.reserve(openai, openaiModel)
    const pending = ledger.reserve(openai, openaiModel)
    if (completed.status !== 'reserved' || pending.status !== 'reserved') {
      throw new Error('expected reservations')
    }
    const direct = new DatabaseSync(dbPath)
    direct
      .prepare("UPDATE reservations SET actual_micros = 10, state = 'reconciled' WHERE id = ?")
      .run(completed.reservationId)
    now = Date.parse('2026-02-01T00:00:00.000Z')
    assert.equal(ledger.confirmBudgetPeriod('2026-01', '2026-02').status, 'confirmed')
    assert.equal(ledger.pruneCompletedPeriods(), 0)
    direct
      .prepare("UPDATE reservations SET actual_micros = 10, state = 'reconciled' WHERE id = ?")
      .run(pending.reservationId)
    assert.equal(ledger.pruneCompletedPeriods(), 2)
    direct.close()
    ledger.close()

    const directoryMode = lstatSync(join(directory, 'state')).mode & 0o777
    const fileMode = lstatSync(dbPath).mode & 0o777
    assert.equal(directoryMode, 0o700)
    assert.equal(fileMode, 0o600)
    const database = new DatabaseSync(dbPath, { readOnly: true })
    assert.equal(database.prepare('SELECT count(*) AS n FROM reservations').get()?.n, 0)
    database.close()
  })
}

testDefaultPathUsesUserStateDirectory()
testMissingConfirmationAndWallClockDivergenceFailClosed()
testAdmissionCheckIsReadOnlyAndAppliesAllConfiguredCaps()
await testExplicitAdvanceIsOneMonthAndAtomicAcrossProcesses()
testMissingZeroAndMalformedCapsFailClosed()
testReservationUsesDatabasePolicyAndReservesConfiguredMaximum()
testDecisionCapsAndGlobalUserProviderModelBucketsAreIndependent()
testOpenCodeVariantsShareProviderCapAndHaveSeparateModelCaps()
testDuplicateReservationIdCannotDoubleAdmit()
testPendingReservationSurvivesRestartAndRecovery()
testOpaqueVerifiedEvidenceRoundsCostsAndRejectsForgeryOrMismatch()
testVerifiedUsageMustMatchReservationModel()
testNativeEvidenceOverrunFreezesScopesAndReconcileIsAtomic()
await testSeparateProcessesCannotOverspendConcurrently()
testVersionOneMigrationPreservesCapsReservationsAndUnknownHolds()
testVersionTwoMigrationPreservesFutureDatedHoldsAndRequiresFreshConfirmation()
testFailedVersionTwoMigrationRollsBackHoldNormalization()
testFailedVersionOneMigrationRollsBackCompletely()
testUnversionedNonemptyAndIncompatibleDatabasesAreRejected()
testCorruptLockedUnavailableAndSymlinkPathsFailClosed()
testPrivatePathPermissionsAndPruneResolvedButNotPendingPeriods()

console.log('local decision budget ledger tests passed')
