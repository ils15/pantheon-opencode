/**
 * P7 — loop decisions on the measured execution channel.
 *
 * Two things are pinned here, both from PROBE-D:
 *
 *   1. **Child/background coverage.** `session.execution.succeeded` is
 *      delivered for child sessions with the child's own `data.sessionID`
 *      (13/13 children), and the event never carries `parentID` (44/44), so
 *      this adapter keys every counter by the delivered session id and never
 *      derives a parent.
 *   2. **Multiplicity is per EXECUTION, not per turn** (PROBE-D §4.3):
 *      44 `started` = 44 `succeeded` for 46 inbox items; manual compaction
 *      adds +1 (C2 = 3), automatic compaction +0 (C1 = 1), a late background
 *      notification adds +1 on the parent (B3/B4/B5 = 2 vs B1/B2 = 1). The
 *      tests below reproduce those numbers.
 *
 * The failure modes that matter are negative: a missing session carrier, a
 * legacy `properties` payload, and a compaction event must produce NO decision
 * and must never count as an execution. The flag is off by default.
 *
 * Run with: npx tsx tests/pantheon/v2-decision-p7.test.ts
 */
import { strict as assert } from 'node:assert'
import type {
  DecisionEventSource,
  HostEventEnvelope,
} from '../../src/pantheon/v2-decision-events.ts'
import {
  createP7LoopPoint,
  P7_LOOP_MAX_EXECUTIONS,
  p7LoopEnabledFromEnv,
} from '../../src/pantheon/v2-decision-points/p7-loop.ts'
import type { ShadowRecord } from '../../src/pantheon/v2-decision-shadow.ts'

let checks = 0
const check = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  checks += 1
  void name
}

const REASON_TOKEN = /^[a-z0-9][a-z0-9.:-]{0,63}$/

/** One delivered execution for a session (measured payload: `data.sessionID`). */
const execution = (sessionID: string) => ({
  type: 'session.execution.succeeded',
  data: { sessionID },
})

/** An inbox item; armed here only to prove it never increments the counter. */
const inbox = (sessionID: string, itemType: 'user' | 'synthetic' | 'compaction') => ({
  type: 'session.inbox.enqueued',
  data: { sessionID, item: { type: itemType } },
})

const compactionEnded = (sessionID: string) => ({
  type: 'session.compaction.ended',
  data: { sessionID, reason: 'manual' },
})

function createPoint(enabled = true) {
  const records: ShadowRecord[] = []
  const point = createP7LoopPoint({ enabled, sink: (record) => records.push(record) })
  return { point, records }
}

async function* iterate(items: readonly unknown[]): AsyncIterable<HostEventEnvelope> {
  for (const item of items) yield item as HostEventEnvelope
}

const run = async (): Promise<void> => {
  await check('the flag is off unless explicitly enabled', () => {
    assert.equal(p7LoopEnabledFromEnv({}), false)
    assert.equal(p7LoopEnabledFromEnv({ PANTHEON_V2_P7_LOOP: 'off' }), false)
    assert.equal(p7LoopEnabledFromEnv({ PANTHEON_V2_P7_LOOP: '' }), false)
    assert.equal(p7LoopEnabledFromEnv({ PANTHEON_V2_P7_LOOP: 'on' }), true)
    assert.equal(p7LoopEnabledFromEnv({ PANTHEON_V2_P7_LOOP: '1' }), true)

    const { point, records } = createPoint(false)
    const result = point.observe(execution('ses_a'))
    assert.equal(result.enabled, false)
    assert.equal(result.record, null)
    assert.equal(result.loopDecision, null)
    assert.equal(result.reason, 'p7.disabled')
    assert.equal(point.executionCount('ses_a'), 0)
    assert.deepEqual(records, [])
  })

  await check('one execution per prompt, not one per turn (T1-T4, M1)', () => {
    const plain = createPoint().point
    plain.observe(execution('ses_t1'))
    assert.equal(plain.executionCount('ses_t1'), 1)

    const multi = createPoint().point
    for (let turn = 0; turn < 3; turn += 1) {
      multi.observe(inbox('ses_m1', 'user'))
      multi.observe(execution('ses_m1'))
    }
    assert.equal(multi.executionCount('ses_m1'), 3, 'M1: 3 prompts = 3 executions')
  })

  await check('manual compaction adds an execution (+1) and automatic adds none (+0)', () => {
    // C2: 2 user prompts + 1 manual compaction job = 3 executions.
    const manual = createPoint().point
    for (const item of ['user', 'user', 'compaction'] as const) {
      manual.observe(inbox('ses_c2', item))
      manual.observe(execution('ses_c2'))
    }
    assert.equal(manual.executionCount('ses_c2'), 3)

    // C1: 1 prompt with auto-compaction inside the drain = 1 execution.
    const automatic = createPoint().point
    automatic.observe(inbox('ses_c1', 'user'))
    automatic.observe(compactionEnded('ses_c1'))
    automatic.observe(execution('ses_c1'))
    assert.equal(automatic.executionCount('ses_c1'), 1)
  })

  await check('a compaction-driven execution is counted once, never twice', () => {
    const { point, records } = createPoint()
    point.observe(compactionEnded('ses_x1'))
    assert.equal(point.executionCount('ses_x1'), 0, 'compaction.ended is not an execution')
    point.observe(execution('ses_x1'))
    point.observe(compactionEnded('ses_x1'))
    assert.equal(point.executionCount('ses_x1'), 1)
    assert.equal(records.length, 1, 'only the execution event records a decision')
    assert.equal(records[0]?.decision, 'loop.continue')
  })

  await check('folded inbox items share one execution (46 items -> 44 executions)', () => {
    // B1/B2: user item and a synthetic notification folded into one drain.
    const folded = createPoint().point
    folded.observe(inbox('ses_b1', 'user'))
    folded.observe(inbox('ses_b1', 'synthetic'))
    folded.observe(execution('ses_b1'))
    assert.equal(folded.executionCount('ses_b1'), 1)

    // Aggregate of the 21 measured runs: 29 top-level + 15 child executions
    // delivered for 46 inbox items.
    const aggregate = createPoint().point
    for (let index = 0; index < 29; index += 1) aggregate.observe(execution('ses_top'))
    for (let index = 0; index < 15; index += 1) aggregate.observe(execution('ses_child'))
    for (let index = 0; index < 31; index += 1) aggregate.observe(inbox('ses_top', 'user'))
    for (let index = 0; index < 15; index += 1) aggregate.observe(inbox('ses_child', 'user'))
    const executions = aggregate.executionCount('ses_top') + aggregate.executionCount('ses_child')
    assert.equal(executions, 44, '44 started = 44 succeeded')
    assert.equal(aggregate.executionCount('ses_top'), 29)
    assert.equal(aggregate.executionCount('ses_child'), 15)
  })

  await check('a child session is counted on its own id, never on the parent', () => {
    // X1: the child runs a turn and then a compaction job (2 executions); the
    // parent runs 1. `parentID` is absent from the event, so it is never read.
    const { point } = createPoint()
    point.observe(execution('ses_parent'))
    point.observe(execution('ses_child'))
    point.observe(compactionEnded('ses_child'))
    point.observe(execution('ses_child'))
    assert.equal(point.executionCount('ses_parent'), 1)
    assert.equal(point.executionCount('ses_child'), 2)

    // B3/B5: the late synthetic notification opens a second parent execution.
    const background = createPoint().point
    background.observe(execution('ses_bg_parent'))
    background.observe(execution('ses_bg_child'))
    background.observe(inbox('ses_bg_parent', 'synthetic'))
    background.observe(execution('ses_bg_parent'))
    assert.equal(background.executionCount('ses_bg_parent'), 2)
    assert.equal(background.executionCount('ses_bg_child'), 1)
  })

  await check('a missing sessionID fails closed with no decision', () => {
    const { point, records } = createPoint()
    for (const payload of [
      { type: 'session.execution.succeeded', data: {} },
      { type: 'session.execution.succeeded', data: { sessionID: '' } },
      { type: 'session.execution.succeeded', data: { sessionID: '   ' } },
      { type: 'session.execution.succeeded', data: { sessionID: 42 } },
      { type: 'session.execution.succeeded', sessionID: 'ses_top_level_decoy' },
    ]) {
      const result = point.observe(payload)
      assert.equal(result.record, null)
      assert.equal(result.loopDecision, null)
      assert.equal(result.sessionID, null)
      assert.equal(result.reason, 'p7.session.absent')
      assert.equal(point.executionCount('ses_top_level_decoy'), 0)
    }
    assert.deepEqual(records, [])
  })

  await check('a properties-only payload yields no decision and is never read', () => {
    const { point, records } = createPoint()
    const forbidden = Object.defineProperty(
      { type: 'session.execution.succeeded', data: {} },
      'properties',
      {
        enumerable: false,
        get() {
          throw new Error('legacy envelope field was read')
        },
      },
    )
    const result = point.observe(forbidden)
    assert.equal(result.record, null)
    assert.equal(result.reason, 'p7.session.absent')
    assert.deepEqual(records, [])
  })

  await check('unknown or unrelated payloads produce a reason, never a throw', () => {
    const { point } = createPoint()
    for (const payload of [null, undefined, 'event', 42, [], {}]) {
      const result = point.observe(payload)
      assert.equal(result.record, null)
      assert.equal(result.loopDecision, null)
      assert.equal(result.reason, 'p7.event.absent')
      assert.match(result.reason, REASON_TOKEN)
    }
    const unrelated = point.observe({ type: 'session.idle', data: { sessionID: 'ses_idle' } })
    assert.equal(unrelated.record, null)
    assert.equal(unrelated.reason, 'p7.event.unrelated')
    assert.equal(point.executionCount('ses_idle'), 0)
  })

  await check('noul and score track the execution counter and stop at the cap', () => {
    const { point, records } = createPoint()
    const observed: Array<{ count: number; level: number; continueLoop: number }> = []
    for (let index = 1; index <= P7_LOOP_MAX_EXECUTIONS + 1; index += 1) {
      const result = point.observe(execution('ses_loop'))
      assert.ok(result.loopDecision)
      observed.push({
        count: result.executionCount,
        level: result.loopDecision.level,
        continueLoop: result.loopDecision.continueLoop,
      })
    }
    assert.deepEqual(observed[0], { count: 1, level: 1, continueLoop: 1 })
    assert.deepEqual(observed[1], { count: 2, level: 2, continueLoop: 1 })
    assert.deepEqual(observed[3], { count: 4, level: 3, continueLoop: 1 })
    assert.equal(observed.at(-1)?.continueLoop, 0, 'past the cap the answer is stop')
    assert.equal(records.at(-1)?.decision, 'loop.stop')
    assert.equal(records.at(-1)?.reason, 'p7.execution.exhausted')

    // A reset is caller-supplied (no user-input signal is wired in Phase 4a).
    point.reset('ses_loop')
    assert.equal(point.executionCount('ses_loop'), 0)
    const after = point.observe(execution('ses_loop'))
    assert.deepEqual(after.loopDecision, { continueLoop: 1, level: 1 })
  })

  await check('counters are isolated per session', () => {
    const { point } = createPoint()
    point.observe(execution('ses_a'))
    point.observe(execution('ses_a'))
    point.observe(execution('ses_b'))
    assert.equal(point.executionCount('ses_a'), 2)
    assert.equal(point.executionCount('ses_b'), 1)
  })

  await check('subscribe consumes the 0b contract and filters client-side', async () => {
    const calls: number[] = []
    const source: DecisionEventSource = {
      subscribe(...args: Parameters<DecisionEventSource['subscribe']>) {
        calls.push(args.length)
        return iterate([
          { type: 'session.idle', data: { sessionID: 'ses_idle' } },
          execution('ses_a'),
          { type: 'session.execution.succeeded', data: {} },
          execution('ses_b'),
        ])
      },
    }
    const { point, records } = createPoint()
    const summary = await point.subscribe(source, {
      signal: new AbortController().signal,
    })
    assert.deepEqual(calls, [1], 'subscribe takes exactly one argument')
    assert.equal(summary.matched, 2)
    assert.equal(summary.skippedType, 1)
    assert.equal(summary.skippedMissingSession, 1)
    assert.equal(point.executionCount('ses_a'), 1)
    assert.equal(point.executionCount('ses_b'), 1)
    assert.equal(point.executionCount('ses_idle'), 0)
    assert.equal(records.length, 2)

    const disabled = createPoint(false).point
    const disabledSummary = await disabled.subscribe(source, {
      signal: new AbortController().signal,
    })
    assert.equal(disabledSummary.matched, 2)
    assert.equal(disabled.executionCount('ses_a'), 0, 'a disabled adapter records no execution')
  })

  console.log(`P7 loop decisions: ${checks} groups passed`)
}

await run()
