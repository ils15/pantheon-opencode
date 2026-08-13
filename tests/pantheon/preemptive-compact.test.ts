/**
 * Tests for Preemptive Compaction Check (release-134 Phase 5) — preemptive-compact.ts.
 *
 * The SDK 1.18.x exposes no runtime context-usage source, so this module is a
 * dormant, ready-to-wire decision core: pure threshold + re-warn-step logic
 * with an injected enqueue. No chat-reminders import, no timers, no wiring.
 *
 * Spec:
 *   (a) usage below threshold (0.70) → NO enqueue, returns undefined
 *   (b) 0.78 (fresh) and 0.90 (jump from 0.78) → each enqueues 1×, returns the pct
 *   (c) 0.82 after 0.80 → NO re-warn (below step); 0.87 → enqueue
 *   (d) enqueue throws → fail-open: no throw, previous state preserved
 *   (e) lastWarnedPct undefined at threshold (0.78) → enqueue
 *
 * Run with: npx tsx tests/pantheon/preemptive-compact.test.ts
 */
import { strict as assert } from 'node:assert'

import {
  PREEMPTIVE_COMPACTION_THRESHOLD,
  PREEMPTIVE_REWARN_STEP,
  preemptiveCompactCheck,
  shouldWarn,
} from '../../src/pantheon/preemptive-compact.ts'

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

const SESSION = 'ses_root'

/** Collect enqueued messages into the given array. */
function makeEnqueue(messages: string[]): (text: string) => void {
  return (text: string) => {
    messages.push(text)
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────

async function main() {
  await testAsync('(a) usage 0.70 (below threshold) → no enqueue, returns undefined', async () => {
    const messages: string[] = []
    const result = preemptiveCompactCheck({
      sessionID: SESSION,
      usagePct: 0.7,
      lastWarnedPct: undefined,
      enqueue: makeEnqueue(messages),
    })
    assert.equal(messages.length, 0, 'below threshold must not enqueue')
    assert.equal(result, undefined, 'no warning fired → undefined')
  })

  await testAsync('(b) 0.78 (fresh) and 0.90 (jump) → each enqueues 1×, returns pct', async () => {
    // 0.78 with no prior warning → threshold hit, exactly one enqueue
    const fresh: string[] = []
    const first = preemptiveCompactCheck({
      sessionID: SESSION,
      usagePct: 0.78,
      lastWarnedPct: undefined,
      enqueue: makeEnqueue(fresh),
    })
    assert.equal(fresh.length, 1, 'threshold hit → exactly one enqueue')
    assert.equal(first, 0.78, 'returns the usage pct that triggered the warning')
    assert.match(fresh[0]!, /78%/, 'message carries the rounded percentage')
    assert.match(fresh[0]!, /compacting/, 'message carries the guidance text')

    // 0.90 after 0.78 → jumped the re-warn step, exactly one more enqueue
    const jump: string[] = []
    const second = preemptiveCompactCheck({
      sessionID: SESSION,
      usagePct: 0.9,
      lastWarnedPct: first,
      enqueue: makeEnqueue(jump),
    })
    assert.equal(jump.length, 1, 'jump above re-warn step → exactly one enqueue')
    assert.equal(second, 0.9, 'returns the new usage pct')
    assert.match(jump[0]!, /90%/, 'message carries the new rounded percentage')
  })

  await testAsync('(c) 0.82 after 0.80 → no enqueue; 0.87 → enqueue', async () => {
    const messages: string[] = []
    const enqueue = makeEnqueue(messages)

    // 0.82 is above threshold but below lastWarnedPct + step (0.85) → silence
    const noWarn = preemptiveCompactCheck({
      sessionID: SESSION,
      usagePct: 0.82,
      lastWarnedPct: 0.8,
      enqueue,
    })
    assert.equal(messages.length, 0, 'below re-warn step → no enqueue')
    assert.equal(noWarn, 0.8, 'lastWarnedPct preserved when no warning fires')

    // 0.87 ≥ 0.80 + 0.05 → re-warn
    const reWarn = preemptiveCompactCheck({
      sessionID: SESSION,
      usagePct: 0.87,
      lastWarnedPct: noWarn,
      enqueue,
    })
    assert.equal(messages.length, 1, 'crossed re-warn step → enqueue')
    assert.equal(reWarn, 0.87, 'returns the new usage pct')
  })

  await testAsync('(d) enqueue throws → fail-open, previous state preserved', async () => {
    const before = 0.8
    let result: number | undefined
    let threw = false
    try {
      result = preemptiveCompactCheck({
        sessionID: SESSION,
        usagePct: 0.9,
        lastWarnedPct: before,
        enqueue: () => {
          throw new Error('enqueue exploded')
        },
      })
    } catch {
      threw = true
    }
    assert.equal(threw, false, 'preemptiveCompactCheck must never throw')
    assert.equal(result, before, 'state preserved on enqueue failure')
  })

  await testAsync('(e) lastWarnedPct undefined at threshold → enqueue', async () => {
    const messages: string[] = []
    const result = preemptiveCompactCheck({
      sessionID: SESSION,
      usagePct: 0.78,
      lastWarnedPct: undefined,
      enqueue: makeEnqueue(messages),
    })
    assert.equal(messages.length, 1, 'first threshold hit → enqueue')
    assert.equal(result, 0.78, 'returns the usage pct')
  })

  await testAsync('shouldWarn pure predicate (exported) matches spec', async () => {
    assert.equal(PREEMPTIVE_COMPACTION_THRESHOLD, 0.78, 'threshold constant')
    assert.equal(PREEMPTIVE_REWARN_STEP, 0.05, 're-warn step constant')
    assert.equal(shouldWarn(0.7, undefined), false, 'below threshold → false')
    assert.equal(shouldWarn(0.78, undefined), true, 'at threshold, never warned → true')
    assert.equal(shouldWarn(0.9, 0.78), true, 'jumped the re-warn step → true')
    assert.equal(shouldWarn(0.82, 0.8), false, 'below re-warn step → false')
    assert.equal(shouldWarn(0.78, 0.78), false, 'same level as last warning → false')
  })

  // ═══════════════════════════════════════════════════════════════════════

  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed)

  console.log('')
  for (const r of results) {
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? ': ' + r.error : ''}`)
  }
  console.log(`\nResults: ${passed} passed, ${failed.length} failed`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main()
