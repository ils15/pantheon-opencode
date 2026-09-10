/**
 * Tests for Native Probe — lazy capability detection for native task() delegation.
 *
 * The probe is invoked on the FIRST native delegation of a session, not at
 * startup. It creates a child session with a minimal "ping" prompt, waits
 * for idle, and classifies the output via classifyNativeResult.
 *
 * Results are cached per session: UNAVAILABLE is TERMINAL (no retry),
 * AVAILABLE is also cached (no re-probe).
 *
 * TDD: these tests MUST fail before implementation.
 *
 * Run with: npx tsx tests/pantheon/native-probe.test.ts
 */
import { strict as assert } from 'node:assert'

import { createNativeProbe } from '../../src/pantheon/native-probe.ts'

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

// ─── Fake Client ───────────────────────────────────────────────────────

interface FakeProbeClient {
  /** Last child session ID created. */
  lastChildID: string | null
  /** Number of times session.create was called. */
  createCount: number
  /** Number of times promptAsync was called. */
  promptCount: number
  /** Controls what session.create returns. */
  createResult: { id: string } | Error
  /** Controls what promptAsync returns. */
  promptResult: unknown
  /** Number of idle events to emit before resolve (default: 1). */
  idleEventsBeforeResolve: number
  /** Collects idle callbacks registered via onIdle. */
  idleCallbacks: Array<() => void>
}

function fakeProbeClient(opts: Partial<FakeProbeClient> = {}): FakeProbeClient {
  return {
    lastChildID: null,
    createCount: 0,
    promptCount: 0,
    createResult: opts.createResult ?? { id: 'child_probe_1' },
    promptResult: opts.promptResult ?? { type: 'accepted' },
    idleEventsBeforeResolve: opts.idleEventsBeforeResolve ?? 1,
    idleCallbacks: [],
  }
}

// ─── Fake Parent Context ───────────────────────────────────────────────

interface FakeParentContext {
  client: {
    session: {
      create: (input: { body: { parentID: string } }) => Promise<{ id: string }>
      promptAsync: (input: { path: { id: string } }) => Promise<unknown>
    }
  }
  parentSessionID: string
}

function fakeParentContext(client: FakeProbeClient): FakeParentContext {
  return {
    client: {
      session: {
        create: async (_input: { body: { parentID: string } }) => {
          client.createCount += 1
          if (client.createResult instanceof Error) throw client.createResult
          client.lastChildID = client.createResult.id
          return client.createResult
        },
        promptAsync: async () => {
          client.promptCount += 1
          return client.promptResult
        },
      },
    },
    parentSessionID: 'ses_parent_probe',
  }
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  // ── AVAILABLE: healthy probe ────────────────────────────────────────

  await testAsync('probe: child returns non-empty content → AVAILABLE', async () => {
    const client = fakeProbeClient({
      promptResult: { output: 'pong — session operational' },
    })
    const ctx = fakeParentContext(client)
    const probe = createNativeProbe()

    const result = await probe(ctx, { timeoutMs: 30_000 })
    assert.equal(result.status, 'AVAILABLE')
    assert.equal(client.createCount, 1, 'session.create called once')
    assert.equal(client.promptCount, 1, 'promptAsync called once')
  })

  // ── UNAVAILABLE: empty output (provider rejection) ──────────────────

  await testAsync('probe: child returns empty output → UNAVAILABLE', async () => {
    const client = fakeProbeClient({
      promptResult: { output: '' },
    })
    const ctx = fakeParentContext(client)
    const probe = createNativeProbe()

    const result = await probe(ctx, { timeoutMs: 30_000 })
    assert.equal(result.status, 'UNAVAILABLE')
  })

  // ── UNSUPPORTED: session.create not available ───────────────────────

  await testAsync('probe: session.create throws "not supported" → UNSUPPORTED', async () => {
    const client = fakeProbeClient({
      createResult: new Error('session.create is not available'),
    })
    const ctx = fakeParentContext(client)
    const probe = createNativeProbe()

    const result = await probe(ctx, { timeoutMs: 30_000 })
    assert.equal(result.status, 'UNSUPPORTED')
    assert.equal(client.promptCount, 0, 'promptAsync not called on UNSUPPORTED')
  })

  // ── TIMEOUT: probe exceeds timeout ──────────────────────────────────

  await testAsync('probe: session.create hangs → UNAVAILABLE after timeout', async () => {
    // session.create never resolves → should timeout
    const client = fakeProbeClient({
      createResult: new Promise<{ id: string }>(() => {
        /* never resolves */
      }),
    })
    const ctx = fakeParentContext(client)
    const probe = createNativeProbe()

    const result = await probe(ctx, { timeoutMs: 50 })
    assert.equal(result.status, 'UNAVAILABLE')
  })

  // ── CACHE: second call returns cached result, no re-probe ──────────

  await testAsync('probe: second call returns cached AVAILABLE, no re-probe', async () => {
    const client = fakeProbeClient({
      promptResult: { output: 'pong' },
    })
    const ctx = fakeParentContext(client)
    const probe = createNativeProbe()

    const result1 = await probe(ctx, { timeoutMs: 30_000 })
    assert.equal(result1.status, 'AVAILABLE')
    assert.equal(client.createCount, 1)

    const result2 = await probe(ctx, { timeoutMs: 30_000 })
    assert.equal(result2.status, 'AVAILABLE')
    assert.equal(client.createCount, 1, 'session.create NOT called again (cached)')
    assert.equal(client.promptCount, 1, 'promptAsync NOT called again (cached)')
  })

  // ── CACHE: UNAVAILABLE is terminal — no retry ──────────────────────

  await testAsync(
    'probe: UNAVAILABLE is cached — second call returns UNAVAILABLE, no retry',
    async () => {
      const client = fakeProbeClient({
        promptResult: { output: '' },
      })
      const ctx = fakeParentContext(client)
      const probe = createNativeProbe()

      const result1 = await probe(ctx, { timeoutMs: 30_000 })
      assert.equal(result1.status, 'UNAVAILABLE')
      assert.equal(client.createCount, 1)

      const result2 = await probe(ctx, { timeoutMs: 30_000 })
      assert.equal(result2.status, 'UNAVAILABLE', 'cached UNAVAILABLE on second call')
      assert.equal(client.createCount, 1, 'no re-probe for UNAVAILABLE')
    },
  )

  // ── Return type check ──────────────────────────────────────────────

  await testAsync('probe: return value is NativeProbeResult', async () => {
    const client = fakeProbeClient({
      promptResult: { output: 'pong' },
    })
    const ctx = fakeParentContext(client)
    const probe = createNativeProbe()

    const result: NativeProbeResult = await probe(ctx, { timeoutMs: 30_000 })
    const validStatuses: NativeProbeResult['status'][] = ['AVAILABLE', 'UNAVAILABLE', 'UNSUPPORTED']
    assert.ok(
      validStatuses.includes(result.status),
      `status "${result.status}" must be one of the 3 probe statuses`,
    )
  })

  // ── REPORT ──────────────────────────────────────────────────────────

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
