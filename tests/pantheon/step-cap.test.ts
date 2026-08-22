/**
 * Tests for R4 — per-agent step caps (max_steps).
 *
 * step-cap.ts provides:
 *   - StepCapTracker: per-agent step counters with a max_steps budget
 *     (from routing.yml agents.<name>.max_steps)
 *   - buildStopInstruction(): the forced summarize-and-stop instruction
 *     injected when an agent reaches its cap
 *   - cappedSummary(): the text returned when a delegation is skipped
 *     because the agent is already at its cap
 *
 * Required behaviors (TDD):
 *   - an agent at max_steps is forced to stop (isCapped → true)
 *   - recordStep returns capped=true exactly when the cap is hit
 *   - buildStopInstruction tells the agent to summarize and stop
 *   - cappedSummary marks the delegation as capped and skips new work
 *
 * Run with: npx tsx tests/pantheon/step-cap.test.ts
 */
import { strict as assert } from 'node:assert'

import {
  buildStopInstruction,
  cappedSummary,
  DEFAULT_MAX_STEPS,
  StepCapTracker,
} from '../../src/pantheon/step-cap.ts'

// ─── Harness ───────────────────────────────────────────────────────────

const results: { name: string; passed: boolean; error?: string }[] = []

async function testAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    results.push({ name, passed: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    results.push({ name, passed: false, error: msg })
  }
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  await testAsync('agent without max_steps config is never capped', async () => {
    const tracker = new StepCapTracker({})
    assert.equal(tracker.maxStepsFor('hermes'), undefined)
    assert.equal(tracker.isCapped('hermes'), false)
    const rec = tracker.recordStep('hermes')
    assert.equal(rec.capped, false)
    assert.equal(rec.maxSteps, undefined)
  })

  await testAsync('agent at max_steps is forced to stop (isCapped → true)', async () => {
    const tracker = new StepCapTracker({ apollo: 3 })
    assert.equal(tracker.isCapped('apollo'), false, 'fresh agent is not capped')

    tracker.recordStep('apollo')
    tracker.recordStep('apollo')
    assert.equal(tracker.isCapped('apollo'), false, '2 < 3 → not capped yet')

    const rec = tracker.recordStep('apollo')
    assert.equal(rec.capped, true, 'step 3 hits the cap')
    assert.equal(rec.steps, 3)
    assert.equal(rec.maxSteps, 3)
    assert.equal(tracker.isCapped('apollo'), true, 'at max_steps → forced to stop')
  })

  await testAsync('recordStep counts per agent independently (case-insensitive)', async () => {
    const tracker = new StepCapTracker({ apollo: 2, themis: 5 })
    tracker.recordStep('apollo')
    tracker.recordStep('Apollo')
    assert.equal(tracker.isCapped('apollo'), true, 'Apollo === apollo')
    assert.equal(tracker.isCapped('themis'), false, 'themis has its own budget')
    assert.equal(tracker.stepCount('themis'), 0)
  })

  await testAsync('buildStopInstruction forces summarize-and-stop', async () => {
    const instruction = buildStopInstruction('apollo', 25)
    assert.match(instruction, /STEP CAP REACHED/, 'marks the cap')
    assert.match(instruction, /apollo/, 'names the agent')
    assert.match(instruction, /25/, 'names the budget')
    assert.match(instruction, /summarize/i, 'tells the agent to summarize')
    assert.match(instruction, /stop/i, 'tells the agent to stop')
    assert.match(instruction, /do not start new work/i, 'forbids new work')
  })

  await testAsync('cappedSummary marks the delegation as capped and skips new work', async () => {
    const summary = cappedSummary('apollo', 25)
    assert.match(summary, /STEP CAP REACHED/, 'marks the delegation as capped')
    assert.match(summary, /apollo/, 'names the agent')
    assert.match(summary, /25/, 'names the budget')
    assert.match(summary, /skipped/i, 'no new work was started')
    assert.match(summary, /summarize/i, 'asks for a summary of prior results')
  })

  await testAsync('reset clears an agent step count', async () => {
    const tracker = new StepCapTracker({ apollo: 1 })
    tracker.recordStep('apollo')
    assert.equal(tracker.isCapped('apollo'), true)
    tracker.reset('apollo')
    assert.equal(tracker.isCapped('apollo'), false)
    assert.equal(tracker.stepCount('apollo'), 0)
  })

  await testAsync('DEFAULT_MAX_STEPS is a sane positive default', async () => {
    assert.equal(typeof DEFAULT_MAX_STEPS, 'number')
    assert.ok(DEFAULT_MAX_STEPS > 0)
  })

  // ═══════════════════════════════════════════════════════════════════════

  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed)

  console.log('')
  for (const r of results) {
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? `: ${r.error}` : ''}`)
  }
  console.log(`\nResults: ${passed} passed, ${failed.length} failed`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main()
