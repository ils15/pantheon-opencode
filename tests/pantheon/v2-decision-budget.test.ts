import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  openLocalDecisionBudgetLedger,
  resolveLocalDecisionBudgetDbPath,
} from '../../src/pantheon/local-decision-budget.ts'
import {
  evaluateCapGate,
  evaluateDecisionBudgetAdmission,
  evaluateLedgerGate,
  evaluatePeriodGate,
  inspectDecisionBudget,
  listDecisionHoldsReadOnly,
  readDecisionBudgetLedgerFacts,
  utcPeriodOf,
} from '../../src/pantheon/v2-decision-budget.ts'

const CAPS = { monthlyCapMicros: 5_000_000, perDecisionCapMicros: 1_000_000 }

interface Sandbox {
  root: string
  env: Record<string, string>
}

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-v2-budget-'))
  return { root, env: { HOME: root, XDG_STATE_HOME: join(root, 'state') } }
}

/** D6: each concern is decided on its own, with its own reason codes. */
test('CAP, PERIOD and LEDGER are three independent gates with distinct reason codes', () => {
  // CAP alone.
  assert.deepEqual(evaluateCapGate({ user: undefined, provider: CAPS, model: CAPS }), {
    concern: 'cap',
    ok: false,
    reason: 'no-cap',
  })
  assert.deepEqual(
    evaluateCapGate({
      user: CAPS,
      provider: { monthlyCapMicros: 10, perDecisionCapMicros: 10 },
      model: CAPS,
    }),
    { concern: 'cap', ok: false, reason: 'per-decision-cap' },
  )
  assert.deepEqual(
    evaluateCapGate({
      user: CAPS,
      provider: CAPS,
      model: { monthlyCapMicros: -1, perDecisionCapMicros: 1 },
    }),
    { concern: 'cap', ok: false, reason: 'invalid-caps' },
  )
  assert.deepEqual(evaluateCapGate({ user: CAPS, provider: CAPS, model: CAPS }), {
    concern: 'cap',
    ok: true,
    reservedMicros: CAPS.perDecisionCapMicros,
  })

  // PERIOD alone: no cap input at all.
  assert.deepEqual(evaluatePeriodGate({ activePeriod: null, wallPeriod: '2026-10' }), {
    concern: 'period',
    ok: false,
    reason: 'period-unconfirmed',
  })
  assert.deepEqual(evaluatePeriodGate({ activePeriod: '2026-09', wallPeriod: '2026-10' }), {
    concern: 'period',
    ok: false,
    reason: 'period-mismatch',
  })
  assert.deepEqual(evaluatePeriodGate({ activePeriod: '2026-10', wallPeriod: null }), {
    concern: 'period',
    ok: false,
    reason: 'invalid-period',
  })
  assert.deepEqual(evaluatePeriodGate({ activePeriod: '2026-10', wallPeriod: '2026-10' }), {
    concern: 'period',
    ok: true,
    period: '2026-10',
  })

  // LEDGER alone: no caps or period input at all.
  const ledgerBase = {
    present: true,
    frozen: false,
    reservedMicros: 1_000_000,
    userCommittedMicros: 0,
    userMonthlyCapMicros: 5_000_000,
    providerCommittedMicros: 0,
    providerMonthlyCapMicros: 5_000_000,
    modelCommittedMicros: 0,
    modelMonthlyCapMicros: 5_000_000,
  }
  assert.deepEqual(evaluateLedgerGate({ ...ledgerBase, present: false }), {
    concern: 'ledger',
    ok: false,
    reason: 'ledger-missing',
  })
  assert.deepEqual(evaluateLedgerGate({ ...ledgerBase, frozen: true }), {
    concern: 'ledger',
    ok: false,
    reason: 'frozen',
  })
  assert.deepEqual(evaluateLedgerGate({ ...ledgerBase, userCommittedMicros: 4_500_000 }), {
    concern: 'ledger',
    ok: false,
    reason: 'monthly-cap',
  })
  assert.deepEqual(evaluateLedgerGate(ledgerBase), { concern: 'ledger', ok: true })
})

/** D6: the composition names the concern that refused, in a fixed order. */
test('composed admission attributes every denial to exactly one concern', () => {
  const ledger = {
    frozen: false,
    userCommittedMicros: 0,
    userMonthlyCapMicros: 5_000_000,
    providerCommittedMicros: 0,
    providerMonthlyCapMicros: 5_000_000,
    modelCommittedMicros: 0,
    modelMonthlyCapMicros: 5_000_000,
  }
  assert.deepEqual(
    evaluateDecisionBudgetAdmission({
      caps: { user: CAPS, provider: CAPS, model: undefined },
      period: { activePeriod: null, wallPeriod: '2026-10' },
      ledger,
    }),
    { admitted: false, concern: 'cap', reason: 'no-cap' },
  )
  assert.deepEqual(
    evaluateDecisionBudgetAdmission({
      caps: { user: CAPS, provider: CAPS, model: CAPS },
      period: { activePeriod: null, wallPeriod: '2026-10' },
      ledger,
    }),
    { admitted: false, concern: 'period', reason: 'period-unconfirmed' },
  )
  assert.deepEqual(
    evaluateDecisionBudgetAdmission({
      caps: { user: CAPS, provider: CAPS, model: CAPS },
      period: { activePeriod: '2026-10', wallPeriod: '2026-10' },
      ledger: { ...ledger, frozen: true },
    }),
    { admitted: false, concern: 'ledger', reason: 'frozen' },
  )
  assert.deepEqual(
    evaluateDecisionBudgetAdmission({
      caps: { user: CAPS, provider: CAPS, model: CAPS },
      period: { activePeriod: '2026-10', wallPeriod: '2026-10' },
      ledger,
    }),
    { admitted: true, period: '2026-10', reservedMicros: CAPS.perDecisionCapMicros },
  )
})

test('utcPeriodOf is UTC-only and rejects unusable instants', () => {
  assert.equal(utcPeriodOf(Date.parse('2026-01-01T00:00:00.000Z')), '2026-01')
  assert.equal(utcPeriodOf(Date.parse('2026-01-01T02:59:59.000Z')), '2026-01')
  assert.equal(utcPeriodOf(-1), null)
  assert.equal(utcPeriodOf(Number.NaN), null)
})

/** D8 at the read surface: inspection never creates or migrates the ledger. */
test('read-only inspection reports an absent ledger without creating it', () => {
  const { root, env } = sandbox()
  try {
    const dbPath = resolveLocalDecisionBudgetDbPath(env)
    const facts = readDecisionBudgetLedgerFacts(dbPath)
    assert.deepEqual(facts, { present: false })
    assert.equal(listDecisionHoldsReadOnly(dbPath), null)
    const inspection = inspectDecisionBudget(dbPath)
    assert.deepEqual(inspection, {
      ledger: { present: false },
      caps: null,
      period: { activePeriod: null },
    })
    assert.equal(
      readDecisionBudgetLedgerFacts(dbPath).present,
      false,
      'a read must not create the SQLite file',
    )
    assert.equal(
      existsSync(join(root, 'state')),
      false,
      'a read must not create the ledger directory',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('inspection reads the three concerns without mutating the ledger', () => {
  const { root, env } = sandbox()
  try {
    const dbPath = resolveLocalDecisionBudgetDbPath(env)
    const seeded = openLocalDecisionBudgetLedger({
      dbPath,
      clock: () => Date.parse('2026-10-10T00:00:00.000Z'),
    })
    let reservationId: string | undefined
    try {
      seeded.configureUserCaps(CAPS)
      seeded.configureProviderCaps('typesafe-jev', CAPS)
      seeded.configureModelCaps('typesafe-jev', 'jev-1.14.0', CAPS)
      assert.equal(seeded.confirmBudgetPeriod(null, '2026-10').status, 'confirmed')
      const reservation = seeded.reserve('typesafe-jev', 'jev-1.14.0')
      assert.equal(reservation.status, 'reserved')
      if (reservation.status === 'reserved') reservationId = reservation.reservationId
    } finally {
      seeded.close()
    }

    const inspection = inspectDecisionBudget(dbPath)
    assert.equal(inspection.ledger.present, true)
    assert.equal(inspection.ledger.readable, true)
    if (inspection.ledger.present && inspection.ledger.readable) {
      assert.equal(inspection.ledger.schemaVersion, 3)
      assert.equal(inspection.ledger.activePeriod, '2026-10')
      assert.equal(inspection.ledger.holds, 1)
      assert.equal(inspection.ledger.reservations, 1)
    }
    assert.deepEqual(inspection.period, { activePeriod: '2026-10' })
    assert.deepEqual(inspection.caps?.user, CAPS)
    assert.deepEqual(inspection.caps?.providers['typesafe-jev'], CAPS)
    assert.deepEqual(inspection.caps?.models['typesafe-jev/jev-1.14.0'], CAPS)

    const holds = listDecisionHoldsReadOnly(dbPath)
    assert.equal(holds?.length, 1)
    assert.equal(holds?.[0]?.reservationId, reservationId)
    assert.equal(holds?.[0]?.state, 'pending')

    // Re-reading must not move the ledger: still one pending hold, same period.
    const after = listDecisionHoldsReadOnly(dbPath)
    assert.equal(after?.length, 1)
    assert.equal(inspectDecisionBudget(dbPath).period.activePeriod, '2026-10')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
