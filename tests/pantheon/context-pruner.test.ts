/**
 * Tests for DCP dynamic context pruning (OpenCode V2 only).
 *
 * Fixtures use the message shape measured on opencode v2.1.2:
 *   user/assistant text  { id?, role, content: [{ type: 'text', text }], metadata? }
 *   assistant tool call  { id?, role: 'assistant',
 *                          content: [{ type: 'tool-call', id, name, input, providerExecuted }] }
 *   tool result          { role: 'tool',
 *                          content: [{ type: 'tool-result', id, name,
 *                                      result: { type: 'text'|'error', value },
 *                                      providerExecuted }] }
 *
 * Run with: npx tsx tests/pantheon/context-pruner.test.ts
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ContextPrunerConfig,
  DEFAULT_CONTEXT_PRUNER_CONFIG,
  PRUNE_MARKER,
  type PruneStats,
  pruneMessages,
  resolveContextPrunerConfig,
} from '../../src/pantheon/context-pruner.ts'
import { plugin } from '../../src/plugin-v2.ts'

// ─── Harness ─────────────────────────────────────────────────────────────

const results: { name: string; passed: boolean; error?: string }[] = []

function test(name: string, fn: () => void): void {
  try {
    fn()
    results.push({ name, passed: true })
  } catch (e: unknown) {
    results.push({ name, passed: false, error: e instanceof Error ? e.message : String(e) })
  }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    results.push({ name, passed: true })
  } catch (e: unknown) {
    results.push({ name, passed: false, error: e instanceof Error ? e.message : String(e) })
  }
}

// ─── Fixtures (observed V2 shape) ───────────────────────────────────────

type Msg = Record<string, unknown>

function user(text: string, id = 'msg_user'): Msg {
  return { id, role: 'user', content: [{ type: 'text', text }], metadata: {} }
}

function assistantText(text: string, id = 'msg_asst'): Msg {
  return { id, role: 'assistant', content: [{ type: 'text', text }] }
}

function call(id: string, name: string, input: Record<string, unknown>, msgID = `msg_${id}`): Msg {
  return {
    id: msgID,
    role: 'assistant',
    content: [{ type: 'tool-call', id, name, input, providerExecuted: false }],
  }
}

function result(id: string, name: string, value: unknown, kind: 'text' | 'error' = 'text'): Msg {
  return {
    role: 'tool',
    content: [
      { type: 'tool-result', id, name, result: { type: kind, value }, providerExecuted: false },
    ],
  }
}

function errorResult(id: string, name: string, message: string): Msg {
  return result(id, name, { error: { type: 'tool.execution', message }, content: [] }, 'error')
}

function config(overrides: Partial<ContextPrunerConfig> = {}): ContextPrunerConfig {
  return {
    ...DEFAULT_CONTEXT_PRUNER_CONFIG,
    protectedTools: [...DEFAULT_CONTEXT_PRUNER_CONFIG.protectedTools],
    minSavingsTokens: 0,
    ...overrides,
  }
}

function large(label: string, lines = 40): string {
  return Array.from({ length: lines }, (_, i) => `${label} line ${i} ${'x'.repeat(40)}`).join('\n')
}

function clone<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function toolResults(messages: unknown[]): Msg[] {
  return messages.filter((m): m is Msg => (m as Msg).role === 'tool')
}

function firstResultValue(messages: unknown[], callID: string): unknown {
  for (const message of toolResults(messages)) {
    for (const part of message.content as Msg[]) {
      if (part.type === 'tool-result' && part.id === callID) return part.result
    }
  }
  return undefined
}

function callInput(messages: unknown[], callID: string): unknown {
  for (const message of messages as Msg[]) {
    for (const part of (message.content as Msg[]) ?? []) {
      if (part.type === 'tool-call' && part.id === callID) return part.input
    }
  }
  return undefined
}

function assertNoDeletion(before: unknown[], after: unknown[], stats: PruneStats): void {
  assert.equal(after.length, before.length, 'message count must not change')
  const rolesBefore = (before as Msg[]).map((m) => m.role)
  const rolesAfter = (after as Msg[]).map((m) => m.role)
  assert.deepEqual(rolesAfter, rolesBefore, 'roles and ordering must not change')
  assert.ok(stats.messagesTouched <= after.length)
}

// ─── Config resolution ───────────────────────────────────────────────────

test('config: absent/malformed input yields documented defaults', () => {
  for (const raw of [
    undefined,
    null,
    'x',
    42,
    [],
    { context_pruner: 'nope' },
    { context_pruner: [] },
  ]) {
    const resolved = resolveContextPrunerConfig(raw)
    assert.equal(resolved.enabled, false)
    assert.equal(resolved.keepTurns, 4)
    assert.equal(resolved.purgeAfterTurns, 2)
    assert.deepEqual(resolved.protectedTools, ['subagent', 'task', 'skill'])
    assert.equal(resolved.minSavingsTokens, 200)
    assert.equal(resolved.charsPerToken, 4)
  }
})

test('config: overrides are honored, negatives clamped, duplicates removed', () => {
  const resolved = resolveContextPrunerConfig({
    context_pruner: {
      enabled: true,
      keepTurns: 7,
      purgeAfterTurns: -3,
      protectedTools: ['skill', 'skill', ' custom ', ''],
      minSavingsTokens: 12,
      charsPerToken: 0,
    },
  })
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.keepTurns, 7)
  assert.equal(resolved.purgeAfterTurns, 0)
  assert.deepEqual(resolved.protectedTools, ['skill', 'custom'])
  assert.equal(resolved.minSavingsTokens, 12)
  assert.equal(resolved.charsPerToken, 1)
})

// ─── Rule 1: dedup ──────────────────────────────────────────────────────

test('dedup: keeps the most recent result verbatim, replaces earlier bodies', () => {
  const messages: unknown[] = [
    user('go'),
    call('c1', 'read', { path: '/a.ts' }),
    result('c1', 'read', large('FIRST')),
    call('c2', 'read', { path: '/a.ts' }),
    result('c2', 'read', large('SECOND')),
  ]
  const before = clone(messages)
  const stats = pruneMessages(messages, config({ keepTurns: 1 }), 'compaction')

  assert.equal(stats.changed, true)
  assert.equal(stats.partsPruned, 1)
  const early = firstResultValue(messages, 'c1') as Msg
  assert.equal(early.type, 'text')
  assert.ok(String(early.value).startsWith(PRUNE_MARKER), 'earlier result carries the marker')
  assert.deepEqual(
    firstResultValue(messages, 'c2'),
    firstResultValue(before, 'c2'),
    'latest result untouched',
  )
  assertNoDeletion(before, messages, stats)
})

test('dedup: argument key order does not defeat the match', () => {
  const messages: unknown[] = [
    user('go'),
    call('c1', 'read', { path: '/a.ts', limit: 10 }),
    result('c1', 'read', large('ONE')),
    call('c2', 'read', { limit: 10, path: '/a.ts' }),
    result('c2', 'read', large('TWO')),
  ]
  const stats = pruneMessages(messages, config({ keepTurns: 1 }), 'compaction')
  assert.equal(stats.partsPruned, 1)
  assert.ok(String((firstResultValue(messages, 'c1') as Msg).value).startsWith(PRUNE_MARKER))
})

test('dedup: different arguments are distinct invocations', () => {
  const messages: unknown[] = [
    user('go'),
    call('c1', 'read', { path: '/a.ts' }),
    result('c1', 'read', large('ONE')),
    call('c2', 'read', { path: '/b.ts' }),
    result('c2', 'read', large('TWO')),
    call('c3', 'read', { path: '/a.ts' }),
    result('c3', 'read', large('THREE')),
  ]
  const stats = pruneMessages(messages, config({ keepTurns: 0 }), 'compaction')
  assert.equal(stats.changed, true)
  assert.ok(String((firstResultValue(messages, 'c1') as Msg).value).startsWith(PRUNE_MARKER))
  const second = firstResultValue(messages, 'c2') as Msg
  assert.equal(second.type, 'text')
  assert.ok(!String(second.value).startsWith(PRUNE_MARKER), 'a different input is never deduped')
})

test('dedup: latest duplicate without a result prunes nothing (no data loss)', () => {
  // Interrupted/aborted call: c2 exists but its tool-result never arrived.
  const messages: unknown[] = [
    user('go'),
    call('c1', 'read', { path: '/only-output.ts' }),
    result('c1', 'read', large('ONLY-OUTPUT')),
    call('c2', 'read', { path: '/only-output.ts' }),
  ]
  const before = clone(messages)
  const stats = pruneMessages(messages, config({ keepTurns: 0 }), 'compaction')

  assert.equal(stats.changed, false)
  assert.equal(stats.skipReason, 'no-candidates')
  assert.deepEqual(messages, before, 'the only result survives verbatim')
  assert.equal(firstResultValue(messages, 'c1') !== undefined, true)
  assert.ok(!String((firstResultValue(messages, 'c1') as Msg).value).startsWith(PRUNE_MARKER))
})

test('dedup: an error result is never rewritten as superseded', () => {
  // The earlier invocation failed with a 3 KB diagnostic; the later identical
  // call succeeded. The error text must stay visible.
  const messages: unknown[] = [
    user('go'),
    call('bad', 'read', { path: '/guarded.ts' }),
    errorResult('bad', 'read', `EACCES: permission denied ${'e'.repeat(3000)}`),
    assistantText('retry'),
    call('ok', 'read', { path: '/guarded.ts' }),
    result('ok', 'read', large('SUCCESS')),
  ]
  const before = clone(messages)
  // Keep the errored-arguments rule out of the way: this test is about dedup.
  const stats = pruneMessages(messages, config({ keepTurns: 0, purgeAfterTurns: 99 }), 'compaction')

  assert.equal(stats.changed, false)
  assert.deepEqual(firstResultValue(messages, 'bad'), firstResultValue(before, 'bad'))
  assert.equal((firstResultValue(messages, 'bad') as Msg).type, 'error')
  const errorBody = (firstResultValue(messages, 'bad') as Msg).value as Msg
  assert.equal((errorBody.error as Msg).message, `EACCES: permission denied ${'e'.repeat(3000)}`)
})

test('dedup: success then identical failing retry keeps the successful body and the error', () => {
  // Themis ordering: read X succeeds, the identical retry errors. The survivor
  // is an error, so it must NOT authorize pruning the successful body.
  const messages: unknown[] = [
    user('go'),
    call('ok', 'read', { path: '/flaky.ts' }),
    result('ok', 'read', large('SUCCESS BODY')),
    call('retry', 'read', { path: '/flaky.ts' }),
    errorResult('retry', 'read', 'ETIMEDOUT'),
  ]
  const before = clone(messages)
  const stats = pruneMessages(messages, config({ keepTurns: 0, purgeAfterTurns: 99 }), 'compaction')

  assert.equal(stats.changed, false)
  const body = firstResultValue(messages, 'ok') as Msg
  assert.deepEqual(body, firstResultValue(before, 'ok'))
  assert.equal(body.type, 'text')
  assert.ok(!String(body.value).startsWith(PRUNE_MARKER), 'success body must not be destroyed')
  const error = firstResultValue(messages, 'retry') as Msg
  assert.equal(error.type, 'error')
  assert.deepEqual(error.value, {
    error: { type: 'tool.execution', message: 'ETIMEDOUT' },
    content: [],
  })
})

test('dedup: failing first call then identical success keeps the error; args purge is separate', () => {
  // Mirror ordering: dedup must skip the earlier error, while rule 2 may still
  // blank that failed call's arguments. Two independent assertions.
  const messages: unknown[] = [
    user('go'),
    call('bad', 'read', { path: '/flaky.ts', note: 'n'.repeat(200) }),
    errorResult('bad', 'read', 'ETIMEDOUT'),
    assistantText('retry'),
    call('ok', 'read', { path: '/flaky.ts', note: 'n'.repeat(200) }),
    result('ok', 'read', large('SUCCESS')),
    assistantText('done'),
  ]
  const before = clone(messages)
  const stats = pruneMessages(messages, config({ keepTurns: 0, purgeAfterTurns: 2 }), 'compaction')

  // Rule 1: the error body is untouched (no superseded marker).
  assert.deepEqual(firstResultValue(messages, 'bad'), firstResultValue(before, 'bad'))
  assert.equal((firstResultValue(messages, 'bad') as Msg).type, 'error')
  assert.ok(!JSON.stringify(firstResultValue(messages, 'bad')).includes(PRUNE_MARKER))

  // Rule 2: the failed call's arguments are blanked independently.
  assert.equal((callInput(messages, 'bad') as Record<string, unknown>)[PRUNE_MARKER], 'args-purged')
  assert.equal(stats.changed, true)
  assert.equal(stats.partsPruned, 1, 'only the args purge fired; dedup skipped the error')
})

test('dedup control: a successful survivor still prunes the earlier successful body', () => {
  // Guards the new survivor-error check against being over-broad.
  const messages: unknown[] = [
    user('go'),
    call('c1', 'read', { path: '/same.ts' }),
    result('c1', 'read', large('FIRST')),
    call('c2', 'read', { path: '/same.ts' }),
    result('c2', 'read', large('SECOND')),
  ]
  const before = clone(messages)
  const stats = pruneMessages(messages, config({ keepTurns: 0 }), 'compaction')

  assert.equal(stats.changed, true)
  assert.equal(stats.partsPruned, 1)
  assert.ok(String((firstResultValue(messages, 'c1') as Msg).value).startsWith(PRUNE_MARKER))
  assert.deepEqual(firstResultValue(messages, 'c2'), firstResultValue(before, 'c2'))
})

// ─── Rule 2: errored args purge ─────────────────────────────────────────
test('purge: failed call arguments are blanked after N turns, error text stays', () => {
  const messages: unknown[] = [
    user('go'),
    call('bad', 'read', { path: '/missing.txt', note: 'y'.repeat(120) }),
    errorResult('bad', 'read', 'File not found: /missing.txt'),
    assistantText('step 2'),
    assistantText('step 3'),
  ]
  const stats = pruneMessages(messages, config({ keepTurns: 2, purgeAfterTurns: 2 }), 'compaction')

  assert.equal(stats.changed, true)
  const input = callInput(messages, 'bad') as Record<string, unknown>
  assert.equal(input[PRUNE_MARKER], 'args-purged')
  const err = firstResultValue(messages, 'bad') as Msg
  assert.equal(err.type, 'error')
  assert.deepEqual(err.value, {
    error: { type: 'tool.execution', message: 'File not found: /missing.txt' },
    content: [],
  })
})

test('purge: failures inside the last K turns are untouched', () => {
  const messages: unknown[] = [
    user('go'),
    call('bad', 'read', { path: '/missing.txt' }),
    errorResult('bad', 'read', 'File not found'),
    assistantText('step 2'),
  ]
  const before = clone(messages)
  const stats = pruneMessages(messages, config({ keepTurns: 4, purgeAfterTurns: 1 }), 'compaction')
  assert.equal(stats.changed, false)
  assert.deepEqual(messages, before)
})

// ─── Rule 3/4: window and protected tools ───────────────────────────────

test('window: last K turns are never touched', () => {
  const messages: unknown[] = [
    user('go'),
    call('c1', 'read', { path: '/a.ts' }),
    result('c1', 'read', large('ONE')),
    call('c2', 'read', { path: '/a.ts' }),
    result('c2', 'read', large('TWO')),
    call('c3', 'read', { path: '/a.ts' }),
    result('c3', 'read', large('THREE')),
  ]
  const before = clone(messages)
  const stats = pruneMessages(messages, config({ keepTurns: 3 }), 'compaction')
  assert.equal(stats.changed, false, 'all three calls sit in the protected window')
  assert.deepEqual(messages, before)
})

test('protected tools: default list spans delegation and skill loads', () => {
  for (const tool of ['subagent', 'task', 'skill']) {
    const messages: unknown[] = [
      user('go'),
      call('a', tool, { prompt: 'do a thing', detail: 'z'.repeat(120) }),
      result('a', tool, large('A')),
      call('b', tool, { prompt: 'do a thing', detail: 'z'.repeat(120) }),
      result('b', tool, large('B')),
      call('bad', tool, { prompt: 'fail', pad: 'q'.repeat(120) }),
      errorResult('bad', tool, 'boom'),
      assistantText('later 1'),
      assistantText('later 2'),
    ]
    const before = clone(messages)
    const stats = pruneMessages(
      messages,
      config({ keepTurns: 0, purgeAfterTurns: 0 }),
      'compaction',
    )
    assert.equal(stats.changed, false, `${tool} must be protected`)
    assert.deepEqual(messages, before)
  }
})

test('protected tools: custom list replaces the defaults', () => {
  const messages: unknown[] = [
    user('go'),
    call('c1', 'read', { path: '/a.ts' }),
    result('c1', 'read', large('ONE')),
    call('c2', 'read', { path: '/a.ts' }),
    result('c2', 'read', large('TWO')),
  ]
  const stats = pruneMessages(
    messages,
    config({ keepTurns: 0, protectedTools: ['read'] }),
    'compaction',
  )
  assert.equal(stats.changed, false)
})

// ─── Rule 5: idempotency ────────────────────────────────────────────────

test('idempotency: second pass changes nothing and never nests markers', () => {
  const messages: unknown[] = [
    user('go'),
    call('c1', 'read', { path: '/a.ts' }),
    result('c1', 'read', large('ONE')),
    call('c2', 'read', { path: '/a.ts' }),
    result('c2', 'read', large('TWO')),
    call('bad', 'read', { path: '/x', pad: 'p'.repeat(80) }),
    errorResult('bad', 'read', 'nope'),
    assistantText('later 1'),
    assistantText('later 2'),
  ]
  const cfg = config({ keepTurns: 1, purgeAfterTurns: 1 })
  const first = pruneMessages(messages, cfg, 'compaction')
  assert.equal(first.changed, true)
  const snapshot = clone(messages)

  const second = pruneMessages(messages, cfg, 'compaction')
  assert.equal(second.changed, false)
  assert.equal(second.skipReason, 'no-candidates')
  assert.deepEqual(messages, snapshot)

  const serialized = JSON.stringify(messages)
  assert.equal(serialized.match(/\[pantheon-prune:v1/g)?.length, 2, 'one dedup + one args marker')
})

test('idempotency: a marker-bearing array handed in fresh is left alone', () => {
  const messages: unknown[] = [
    user('go'),
    call('c1', 'read', { path: '/a.ts' }),
    result('c1', 'read', `${PRUNE_MARKER} superseded tool=read] already pruned`),
    call('c2', 'read', { path: '/a.ts' }),
    result('c2', 'read', large('KEEP')),
  ]
  const before = clone(messages)
  const stats = pruneMessages(messages, config({ keepTurns: 0 }), 'compaction')
  assert.equal(stats.changed, false)
  assert.deepEqual(messages, before)
})

// ─── Rule 6: threshold ──────────────────────────────────────────────────

test('threshold: below the floor nothing is mutated', () => {
  const messages: unknown[] = [
    user('go'),
    call('c1', 'read', { path: '/a' }),
    result('c1', 'read', 'x'.repeat(300)),
    call('c2', 'read', { path: '/a' }),
    result('c2', 'read', 'x'.repeat(300)),
  ]
  const before = clone(messages)
  const stats = pruneMessages(
    messages,
    config({ keepTurns: 0, minSavingsTokens: DEFAULT_CONTEXT_PRUNER_CONFIG.minSavingsTokens }),
    'compaction',
  )
  assert.equal(stats.changed, false)
  assert.equal(stats.skipReason, 'below-threshold')
  assert.deepEqual(messages, before)
})

test('threshold: a realistic array clears it and reports estimated savings', () => {
  const messages: unknown[] = [user('go')]
  for (let i = 0; i < 12; i++) {
    messages.push(call(`c${i}`, 'read', { path: '/src/app.ts' }))
    messages.push(result(`c${i}`, 'read', large(`COPY-${i}`, 80)))
    messages.push(assistantText(`step ${i}`))
  }
  const stats = pruneMessages(messages, config({ keepTurns: 2 }), 'compaction')
  assert.equal(stats.changed, true)
  assert.ok(stats.estimatedTokensSaved >= 200, `saved ${stats.estimatedTokensSaved} tokens`)
  assert.equal(stats.partsPruned, 11, 'the last copy is kept, the other eleven deduped')
  assert.equal(stats.site, 'compaction')
})

// ─── Fail-open ──────────────────────────────────────────────────────────

test('fail-open: non-array and malformed payloads are returned unchanged', () => {
  const cases: unknown[] = [
    null,
    undefined,
    'messages',
    { messages: [] },
    [null],
    [{}],
    [{ role: 'user', content: 'not-an-array' }],
    [
      { role: 'user', content: [null] },
      { role: 'tool', content: 'nope' },
    ],
  ]
  for (const payload of cases) {
    const before = clone(payload)
    const stats = pruneMessages(payload, config({ keepTurns: 0 }), 'compaction')
    assert.equal(stats.changed, false)
    assert.deepEqual(payload, before)
  }
})

test('fail-open: one malformed message reports malformed, not "no candidates"', () => {
  // Control: the same messages without the trailing malformed entry WOULD be
  // pruned, so the assertion below is not vacuous.
  const prunable: unknown[] = [
    user('go'),
    call('c1', 'read', { path: '/a.ts' }),
    result('c1', 'read', large('ONE')),
    call('c2', 'read', { path: '/a.ts' }),
    result('c2', 'read', large('TWO')),
  ]
  assert.equal(pruneMessages(clone(prunable), config({ keepTurns: 0 }), 'compaction').changed, true)

  const messages: unknown[] = [...clone(prunable), { role: 'user' }]
  const before = clone(messages)
  const stats = pruneMessages(messages, config({ keepTurns: 0 }), 'compaction')
  assert.equal(stats.skipReason, 'malformed')
  assert.equal(stats.changed, false)
  assert.deepEqual(messages, before)
})

test('fail-open: a non-array payload reports not-array', () => {
  const stats = pruneMessages({ messages: [] }, config(), 'compaction')
  assert.equal(stats.skipReason, 'not-array')
  assert.equal(stats.changed, false)
})

test('fail-open: circular tool arguments skip dedup instead of throwing', () => {
  const circular: Record<string, unknown> = { path: '/a' }
  circular.self = circular
  const messages: unknown[] = [
    user('go'),
    call('c1', 'read', circular),
    result('c1', 'read', large('ONE')),
    call('c2', 'read', circular),
    result('c2', 'read', large('TWO')),
  ]
  const stats = pruneMessages(messages, config({ keepTurns: 0 }), 'compaction')
  assert.equal(stats.changed, false)
  assert.equal(messages.length, 5, 'no message removed')
  assert.equal((firstResultValue(messages, 'c1') as Msg).type, 'text')
  assert.ok(!String((firstResultValue(messages, 'c1') as Msg).value).startsWith(PRUNE_MARKER))
})

test('fail-open: frozen parts roll back and leave the array untouched', () => {
  const messages: unknown[] = [
    user('go'),
    call('c1', 'read', { path: '/a.ts' }),
    result('c1', 'read', large('ONE')),
    call('c2', 'read', { path: '/a.ts' }),
    result('c2', 'read', large('TWO')),
  ]
  const frozen = ((messages[2] as Msg).content as Msg[])[0] as Msg
  Object.freeze(frozen)
  const before = clone(messages)
  const stats = pruneMessages(messages, config({ keepTurns: 0 }), 'compaction')
  assert.equal(stats.changed, false)
  assert.deepEqual(messages, before)
})

test('fail-open: text, system and message identity are never rewritten', () => {
  const messages: unknown[] = [
    { role: 'system', content: [{ type: 'text', text: 'SYSTEM' }] },
    user('go', 'msg_keep'),
    call('bad', 'read', { path: '/x', pad: 'p'.repeat(100) }),
    errorResult('bad', 'read', 'nope'),
    assistantText('later 1'),
    assistantText('later 2'),
  ]
  const before = clone(messages)
  const stats = pruneMessages(messages, config({ keepTurns: 1, purgeAfterTurns: 1 }), 'compaction')
  assert.equal(stats.changed, true)
  assert.deepEqual(messages[0], before[0] as Msg)
  assert.deepEqual(messages[1], before[1] as Msg)
  assertNoDeletion(before, messages, stats)
})

test('stats: site is echoed and no-op passes report zeroes', () => {
  const messages: unknown[] = [user('go'), assistantText('hi')]
  const stats = pruneMessages(messages, config(), 'context')
  assert.equal(stats.site, 'context')
  assert.equal(stats.messagesTouched, 0)
  assert.equal(stats.estimatedTokensSaved, 0)
})

// ─── Wiring: the registered compaction handler ──────────────────────────
// These drive `plugin.setup()` and the handler the host actually stores, not
// just `pruneMessages`. No host boot and no network: session.hook captures the
// callback exactly as the host does.

type HookHandler = (event: unknown) => unknown

function pruneContext(
  options: Record<string, unknown>,
  onHook: (name: string, handler: HookHandler) => void,
): Record<string, unknown> {
  const registration = { dispose: async () => {} }
  const transform = async () => registration
  return {
    options,
    agent: { transform },
    catalog: { transform },
    command: { transform },
    reference: { transform },
    skill: { transform },
    session: {
      hook: async (name: string, handler: HookHandler) => {
        onHook(name, handler)
        return registration
      },
    },
  }
}

async function setupCompaction(options: Record<string, unknown>): Promise<HookHandler | undefined> {
  let handler: HookHandler | undefined
  await plugin.setup(
    pruneContext(options, (name, fn) => {
      if (name === 'compaction') handler = fn
    }) as never,
  )
  return handler
}

await testAsync(
  'wiring: malformed config warns once, naming ignored and accepted keys',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantheon-pruner-config-'))
    process.chdir(dir)

    await plugin.setup(
      pruneContext({ context_pruner: { keepTurn: 4, enabled: 'yes' } }, () => {}) as never,
    )
    // A second setup must not repeat the warning (once per process).
    await plugin.setup(pruneContext({ context_pruner: { anotherTypo: 1 } }, () => {}) as never)

    const log = readFileSync(join(dir, '.pantheon', 'logs', 'hooks.log'), 'utf8')
    const lines = log
      .split('\n')
      .filter((line) => line.includes('[context-pruner] ignored invalid context_pruner config'))
    assert.equal(lines.length, 1, 'exactly one config warning per process')
    assert.match(lines[0] ?? '', /unknown key "keepTurn"/)
    assert.match(lines[0] ?? '', /"enabled" must be a boolean/)
    assert.match(
      lines[0] ?? '',
      /accepted keys: enabled, keepTurns, purgeAfterTurns, protectedTools, minSavingsTokens, charsPerToken/,
    )
  },
)

await testAsync('wiring: compaction shape drift logs once per session', async () => {
  const handler = await setupCompaction({})
  assert.equal(typeof handler, 'function')

  const dir = mkdtempSync(join(tmpdir(), 'pantheon-pruner-shape-'))
  process.chdir(dir)

  await handler?.({ sessionID: 'ses_shape_drift_1' }) // messages absent → not-array
  await handler?.({ sessionID: 'ses_shape_drift_1' }) // same session → silent
  await handler?.({ sessionID: 'ses_shape_drift_2', messages: [{ role: 'user' }] }) // malformed

  const log = readFileSync(join(dir, '.pantheon', 'logs', 'hooks.log'), 'utf8')
  const lines = log
    .split('\n')
    .filter((line) => line.includes('[context-pruner] failed open site=compaction'))
  assert.equal(lines.length, 2, 'one line per session, both reasons reported')
  assert.ok(lines.some((line) => line.includes('not-array: payload.messages is not an array')))
  assert.ok(lines.some((line) => line.includes('malformed: unexpected message shape')))
})

await testAsync(
  'wiring: the registered compaction handler returns a host-valid array',
  async () => {
    const handler = await setupCompaction({ context_pruner: { keepTurns: 0 } })
    assert.equal(typeof handler, 'function')

    const messages: unknown[] = [
      user('go'),
      call('c1', 'read', { path: '/src/app.ts' }),
      result('c1', 'read', large('FIRST', 80)),
      call('c2', 'read', { path: '/src/app.ts' }),
      result('c2', 'read', large('SECOND', 80)),
      assistantText('done'),
    ]
    const before = clone(messages)
    const event: Record<string, unknown> = {
      sessionID: 'ses_wiring_prune',
      model: { id: 'fake-1', providerID: 'fakeprov' },
      system: [{ type: 'text', text: 'SYSTEM' }],
      messages,
      options: { maxTokens: 8192 },
      agent: 'build',
      tools: {},
    }

    const returned = await handler?.(event)

    assert.equal(returned, undefined, 'the handler must not return a replacement payload')
    assert.equal('result' in event, false, 'the host must summarize, not receive a canned result')
    assert.equal(messages.length, before.length, 'no message deleted')
    assert.deepEqual(
      (messages as Msg[]).map((message) => message.role),
      (before as Msg[]).map((message) => message.role),
      'roles and ordering preserved',
    )
    for (const message of messages) {
      assert.ok(Array.isArray((message as Msg).content), 'every message keeps a content array')
    }
    assert.deepEqual(event.system, [{ type: 'text', text: 'SYSTEM' }], 'system untouched')
    assert.ok(
      String((firstResultValue(messages, 'c1') as Msg).value).startsWith(PRUNE_MARKER),
      'the earlier duplicate was pruned through the registered handler',
    )
    assert.deepEqual(
      firstResultValue(messages, 'c2'),
      firstResultValue(before, 'c2'),
      'the latest result stays verbatim',
    )
  },
)

// ═══════════════════════════════════════════════════════════════════════════

const passed = results.filter((r) => r.passed).length
const failed = results.filter((r) => !r.passed)

console.log('')
for (const r of results) {
  console.log(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? `: ${r.error}` : ''}`)
}
console.log(`\nResults: ${passed} passed, ${failed.length} failed`)
process.exit(failed.length > 0 ? 1 : 0)
