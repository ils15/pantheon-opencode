/**
 * Tests for Native Probe — lazy capability detection (src/pantheon/native-probe.ts).
 *
 * Covers the essential behavior: capability detect (content → AVAILABLE),
 * memoization (a second call reuses the cached result with no re-probe), and
 * fail-safe classification on host errors.
 *
 * Run with: npx tsx tests/pantheon/native-probe.test.ts
 */
import { strict as assert } from 'node:assert'

import { createNativeProbe } from '../../src/pantheon/native-probe.ts'

interface FakeOptions {
  create?: () => Promise<{ id: string }>
  prompt?: () => Promise<unknown>
}

function fakeHost(opts: FakeOptions = {}) {
  const calls = { create: 0, prompt: 0 }
  const client = {
    session: {
      create: async (_input: { body: { parentID: string } }) => {
        calls.create += 1
        return opts.create ? opts.create() : { id: 'child_probe_1' }
      },
      promptAsync: async (_input: {
        path: { id: string }
        body: { agent: string; parts: Array<{ type: 'text'; text: string }> }
      }) => {
        calls.prompt += 1
        return opts.prompt ? opts.prompt() : { output: 'PONG' }
      },
    },
  }
  return { calls, ctx: { client, parentSessionID: 'ses_parent' } }
}

async function main(): Promise<void> {
  // Capability detected — non-empty output → AVAILABLE.
  const healthy = fakeHost()
  const probe = createNativeProbe()
  assert.equal((await probe(healthy.ctx, { timeoutMs: 1000 })).status, 'AVAILABLE')

  // Memoized — the second call reuses the cache, no re-probe.
  assert.equal((await probe(healthy.ctx, { timeoutMs: 1000 })).status, 'AVAILABLE')
  assert.equal(healthy.calls.create, 1)
  assert.equal(healthy.calls.prompt, 1)

  // Empty output → UNAVAILABLE (provider rejected the probe).
  const empty = fakeHost({ prompt: async () => ({ output: '' }) })
  assert.equal((await createNativeProbe()(empty.ctx, { timeoutMs: 1000 })).status, 'UNAVAILABLE')

  // Unsupported session API → UNSUPPORTED, fail-safe (no prompt sent).
  const unsupported = fakeHost({
    create: async () => {
      throw new Error('session.create is not available')
    },
  })
  assert.equal(
    (await createNativeProbe()(unsupported.ctx, { timeoutMs: 1000 })).status,
    'UNSUPPORTED',
  )
  assert.equal(unsupported.calls.prompt, 0)

  // Generic host failure → UNAVAILABLE, never thrown to the caller.
  const failing = fakeHost({
    create: async () => {
      throw new Error('transport reset')
    },
  })
  assert.equal((await createNativeProbe()(failing.ctx, { timeoutMs: 1000 })).status, 'UNAVAILABLE')
}

await main()
