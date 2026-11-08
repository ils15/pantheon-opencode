/**
 * J2 skill-selection scorecard harness — offline, rerunnable.
 *
 * Measures the skill-selection surface on BOTH paths: the local deterministic
 * prefilter (`selectPantheonSkills`) and the full `mode: "skills"` preset of
 * `pantheon_jev_decide` (real gate chain — config, consent, budget ledger,
 * permission kill-switch — with EVERY Jev reply faked from the fixture table
 * in `j2-fixtures.ts`). No network: `globalThis.fetch` is a throwing spy for
 * the whole run.
 *
 * The canned replies measure the PLUMBING (preparation, gating, consumption,
 * telemetry), NOT model quality; a live-model scorecard is a future, consented
 * run. This phase MEASURES; it activates nothing.
 *
 * Run with: npx tsx tests/pantheon/j2-skill-selection-scorecard.test.ts
 */
import { strict as assert } from 'node:assert'
import { PANTHEON_SKILL_IDS } from '../../src/pantheon/pantheon-decision-catalog.ts'
import {
  sanitizeTelemetry,
  type TelemetryPointId,
} from '../../src/pantheon/decision-telemetry.ts'
import {
  encodeJ2ScorecardReason,
  fakeJevReplyForState,
  J2_HOST_SKILLS,
  J2_SCENARIOS,
  J2_SCORECARD_POINT,
  j2TelemetryDecision,
  renderJ2ScorecardMarkdown,
  runJ2Scorecard,
} from './j2-fixtures.ts'

let checks = 0
function check(name: string, fn: () => void): void {
  fn()
  checks += 1
  void name
}

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  await fn()
  checks += 1
  void name
}

/** The telemetry token charset (mirrors decision-telemetry). */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

// ─── Scenario catalog ───────────────────────────────────────────────────

function testScenarioCatalog(): void {
  assert.ok(J2_SCENARIOS.length >= 24, `scenario floor: ${J2_SCENARIOS.length}`)
  const adversarial = J2_SCENARIOS.filter((scenario) => scenario.category === 'adversarial')
  const refusals = J2_SCENARIOS.filter((scenario) => scenario.category === 'refusal')
  assert.ok(adversarial.length >= 5, `adversarial floor: ${adversarial.length}`)
  assert.ok(refusals.length >= 5, `refusal floor: ${refusals.length}`)
  for (const category of [
    'clear-match',
    'ambiguous',
    'low-confidence',
    'timeout',
    'malformed',
  ] as const) {
    assert.ok(
      J2_SCENARIOS.some((scenario) => scenario.category === category),
      `category present: ${category}`,
    )
  }
  // Unique ids and unique state texts: the fake table is keyed by state.
  const ids = new Set(J2_SCENARIOS.map((scenario) => scenario.id))
  assert.equal(ids.size, J2_SCENARIOS.length)
  const states = new Set(J2_SCENARIOS.map((scenario) => scenario.state))
  assert.equal(states.size, J2_SCENARIOS.length)
  // Every state resolves in the canned-reply table.
  for (const scenario of J2_SCENARIOS) {
    assert.ok(fakeJevReplyForState(scenario.state) !== undefined, scenario.id)
  }
  // Expected is `none`, a catalog skill, or a host-installed skill.
  const hostIds = new Set(J2_HOST_SKILLS.map((skill) => skill.id))
  for (const scenario of J2_SCENARIOS) {
    assert.ok(
      scenario.expected === 'none' ||
        PANTHEON_SKILL_IDS.has(scenario.expected) ||
        hostIds.has(scenario.expected),
      `${scenario.id}: expected ${scenario.expected}`,
    )
    assert.ok(
      scenario.prefilterExpectation === 'shortlist-includes' ||
        scenario.prefilterExpectation === 'no-match',
      scenario.id,
    )
  }
  // Synthetic by construction: no real paths, no credential shapes, and every
  // adversarial marker is actually present in its own state text.
  for (const scenario of J2_SCENARIOS) {
    assert.equal(/\/home\/|\/Users\/|\/root\/|[A-Za-z]:\\/.test(scenario.state), false, scenario.id)
    assert.equal(/sk-[A-Za-z0-9]|api[_-]?key\s*=|Bearer\s/.test(scenario.state), false, scenario.id)
    for (const marker of scenario.leakMarkers ?? []) {
      assert.ok(scenario.state.includes(marker), `${scenario.id}: marker ${marker}`)
    }
  }
}

// ─── Telemetry: J2 admitted, P-series pinned ────────────────────────────

function testTelemetryAdmitsJ2(): void {
  // Compile-time admission: the J-series literal list type-checks.
  const jSeries: TelemetryPointId[] = ['J1', 'J2']
  assert.equal(jSeries.length, 2)
  const result = sanitizeTelemetry({
    point: J2_SCORECARD_POINT,
    decision: 'match',
    effect: 'none',
    reason: 'choice-tdd-with-agents',
    mode: 'shadow',
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.event.point, 'J2')
  // The measured P-series rules are pinned unchanged.
  assert.equal(
    sanitizeTelemetry({ point: 'P1', decision: 'x', reason: 'y', effect: 'none' }).ok,
    true,
  )
  assert.equal(
    sanitizeTelemetry({ point: 'P11', decision: 'x', reason: 'y', effect: 'none' }).ok,
    true,
  )
  assert.equal(sanitizeTelemetry({ point: 'P99', decision: 'x', reason: 'y' }).ok, false)
  // J1 remains admitted alongside J2.
  assert.equal(
    sanitizeTelemetry({
      point: 'J1',
      decision: 'observe',
      reason: 'risk-3-intent-yes',
      effect: 'none',
      mode: 'shadow',
    }).ok,
    true,
  )
}

// ─── Canned reply table ─────────────────────────────────────────────────

function testFakeReplyShapes(): void {
  for (const scenario of J2_SCENARIOS) {
    const reply = fakeJevReplyForState(scenario.state)
    assert.ok(reply !== undefined, scenario.id)
    if (reply === undefined) continue
    if (reply.kind === 'answer') {
      assert.ok(reply.choice.length > 0 && reply.choice.length <= 64, scenario.id)
      if (reply.confidence !== undefined) {
        assert.ok(
          Number.isFinite(reply.confidence) && reply.confidence >= 0 && reply.confidence <= 1,
          `${scenario.id}: confidence`,
        )
      }
    } else if (reply.kind === 'refusal') {
      const response = reply.response as { answers?: unknown }
      assert.ok(response !== null && typeof response === 'object', scenario.id)
    }
  }
}

// ─── Reason encoding ────────────────────────────────────────────────────

function testReasonEncoding(): void {
  const expected = 'tdd-with-agents'
  const outcomes = [
    {
      kind: 'answer' as const,
      choice: 'tdd-with-agents',
      confidence: 0.8,
      lowConfidence: false,
      effect: 'none' as const,
    },
    { kind: 'refusal' as const, detail: 'missing-stack-answer' },
    { kind: 'refusal' as const, detail: 'model_declined' },
    { kind: 'gate-refusal' as const, reasonCode: 'USAGE_UNRECONCILED' },
    { kind: 'timeout' as const },
    { kind: 'harness-error' as const, detail: 'RangeError' },
  ]
  for (const outcome of outcomes) {
    const reason = encodeJ2ScorecardReason(outcome)
    assert.match(reason, TOKEN, JSON.stringify(outcome))
    assert.ok(reason.length <= 64)
  }
  assert.equal(encodeJ2ScorecardReason(outcomes[0]), 'choice-tdd-with-agents')
  assert.equal(encodeJ2ScorecardReason(outcomes[2]), 'refused-model_declined')
  assert.equal(encodeJ2ScorecardReason(outcomes[3]), 'gate-refused-usage_unreconciled')
  assert.equal(encodeJ2ScorecardReason(outcomes[4]), 'skip-timeout')
  assert.equal(j2TelemetryDecision(outcomes[0], expected), 'match')
  assert.equal(j2TelemetryDecision(outcomes[0], 'codemap'), 'mismatch')
  assert.equal(j2TelemetryDecision(outcomes[4], expected), 'unavailable')
}

// ─── The scorecard run ──────────────────────────────────────────────────

let lastRun: Awaited<ReturnType<typeof runJ2Scorecard>> | undefined

async function testScorecardRun(): Promise<void> {
  const run = await runJ2Scorecard()
  lastRun = run
  const rows = run.rows
  assert.equal(rows.length, J2_SCENARIOS.length)
  assert.equal(run.metrics.fetchCallCount, 0, 'the native route must never fetch')
  assert.equal(
    run.metrics.adversarialLeakCount,
    0,
    'adversarial prose must never escape the state slot',
  )
  for (const row of rows) {
    assert.notEqual(row.jev.kind, 'harness-error', `${row.scenario.id}: harness fault`)
    assert.equal(row.leaks.length, 0, `${row.scenario.id}: ${row.leaks.join(' | ')}`)
    assert.match(row.telemetryReason, TOKEN, row.scenario.id)
    assert.equal(row.decideCallCount, 1, `${row.scenario.id}: exactly one decide call`)
  }
  // Reply-kind ↔ outcome-kind consistency: answers answer, refusals are
  // handled (consumer-level or fail-closed settlement), timeouts time out.
  for (const row of rows) {
    const kind = row.scenario.reply.kind
    if (kind === 'answer') assert.equal(row.jev.kind, 'answer', row.scenario.id)
    if (kind === 'refusal') {
      assert.ok(
        row.jev.kind === 'refusal' || row.jev.kind === 'gate-refusal',
        `${row.scenario.id}: ${row.jev.kind}`,
      )
    }
    if (kind === 'timeout') assert.equal(row.jev.kind, 'timeout', row.scenario.id)
  }
  // Every refusal-shaped scenario is handled without throwing into the host.
  const refusalRows = rows.filter((row) => row.scenario.category === 'refusal')
  assert.ok(refusalRows.length >= 5)
  for (const row of refusalRows) {
    assert.ok(row.jev.kind === 'refusal' || row.jev.kind === 'gate-refusal', row.scenario.id)
    assert.equal(row.verdict === 'refused' || row.verdict === 'gate-refused', true, row.scenario.id)
  }
  // Consumed advice is always advisory: effect stays 'none'.
  for (const row of rows) {
    if (row.jev.kind === 'answer') assert.equal(row.jev.effect, 'none', row.scenario.id)
  }
  // Low-confidence bookkeeping: below-threshold answers are flagged.
  const lowConfidenceRows = rows.filter((row) => row.scenario.category === 'low-confidence')
  assert.equal(lowConfidenceRows.length, 2)
  const flagged = lowConfidenceRows.filter(
    (row) => row.jev.kind === 'answer' && row.jev.lowConfidence,
  ).length
  assert.ok(flagged >= 1 && flagged <= 2, `flagged: ${flagged}`)
  // Adversarial rows: outcome recorded, zero leaks, prose never escaped.
  for (const row of rows.filter((row) => row.scenario.category === 'adversarial')) {
    assert.equal(row.leaks.length, 0, `${row.scenario.id}: ${row.leaks.join(' | ')}`)
    assert.equal(row.decideCallCount, 1, row.scenario.id)
  }
  // Telemetry: exactly one bounded J2 shadow record per scenario.
  assert.equal(run.telemetry.length, J2_SCENARIOS.length)
  for (const record of run.telemetry) {
    assert.equal(record.point, J2_SCORECARD_POINT)
    assert.equal(record.effect, 'none')
    assert.match(record.decision, TOKEN)
    assert.match(record.reason, TOKEN)
  }
  // Metrics bookkeeping is internally consistent.
  const metrics = run.metrics
  assert.equal(metrics.total, J2_SCENARIOS.length)
  assert.equal(metrics.prefilterPass + metrics.prefilterFail, metrics.total)
  assert.ok(metrics.jevCorrectCount <= metrics.jevAnswerCount)
  assert.ok(
    metrics.jevAnswerCount +
      metrics.refusalCount +
      metrics.gateRefusalCount +
      metrics.timeoutCount ===
      metrics.total,
    'outcome kinds partition the scenarios',
  )
  assert.ok(metrics.agreementAgreeCount <= metrics.agreementEvaluable)
}

// ─── The dated scorecard document ───────────────────────────────────────

function testScorecardRenderer(): void {
  const run = lastRun
  assert.ok(run !== undefined, 'the renderer check runs after the scorecard run')
  if (run === undefined) return
  const markdown = renderJ2ScorecardMarkdown(run, { date: '2026-11-03', commit: 'test-tip' })
  assert.ok(markdown.includes('2026-11-03'), 'the scorecard is dated')
  assert.ok(markdown.includes('faked'), 'the fake-reply caveat is present')
  assert.ok(markdown.includes('NOT model quality'), 'the plumbing-vs-quality caveat is present')
  assert.ok(markdown.includes('proves nothing'), 'the hermes gate statement is present')
  assert.ok(markdown.includes('2 consecutive'), 'the activation gate is present')
  assert.ok(
    markdown.toLowerCase().includes('adversarial leak count: 0'),
    'the leak gate line is present',
  )
  assert.ok(markdown.toLowerCase().includes('honest-negative'), 'findings section is present')
  for (const row of run.rows) {
    assert.ok(markdown.includes(`| ${row.scenario.id} |`), `table row: ${row.scenario.id}`)
  }
}

// ─── Runner ─────────────────────────────────────────────────────────────

check('scenario catalog: floors, uniqueness, synthetic-by-construction', testScenarioCatalog)
check('telemetry: J2 admitted, J1 kept, P-series pinned', testTelemetryAdmitsJ2)
check('canned reply table: host-shaped and bounded', testFakeReplyShapes)
check('reason encoding: one bounded token per outcome', testReasonEncoding)
await checkAsync(
  'scorecard run: zero leaks, refusals handled, no host throw, fetch spy silent',
  testScorecardRun,
)
check('scorecard renderer: dated document carries caveats and gate', testScorecardRenderer)

console.log(`J2 skill-selection scorecard: ${checks} checks passed`)
