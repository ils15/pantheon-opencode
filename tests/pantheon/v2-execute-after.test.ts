/**
 * Tests for the V2 `execute.after` parity adapter.
 *
 * Covers the V1 chain reproduced on the V2 event shape:
 *   task-result-guard → context-sandbox → read-enhancer
 * plus config resolution, no-op shapes, error-status exclusion, metadata merge
 * and fail-safe behaviour.
 *
 * Run with: npx tsx tests/pantheon/v2-execute-after.test.ts
 */
import { strict as assert } from 'node:assert'
import { DEFAULT_CONFIG, resolveSandboxConfig } from '../../src/pantheon/context-sandbox.ts'
import {
  createV2ExecuteAfter,
  resolveV2SandboxConfig,
} from '../../src/pantheon/v2-execute-after.ts'

// ─── Harness ─────────────────────────────────────────────────────────────

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

const HASHLINE_TAG_RE = /(?:^|\n)\s*[0-9]+#[A-Za-z0-9]+\|/

function makeLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `${i + 1}: content line ${i + 1}`).join('\n')
}

/** The real 2.0.x completed-event shape. */
function completedEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tool: 'read',
    sessionID: 'ses_1',
    agent: 'zeus',
    messageID: 'msg_1',
    id: 'call_1',
    input: { filePath: '/tmp/x.ts' },
    status: 'completed',
    result: { output: '1: hello\n2: world' },
    ...over,
  }
}

const handler = createV2ExecuteAfter()

// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  // ── read-enhancer parity ───────────────────────────────────────────────
  await testAsync('read result.output gains hashline tags', async () => {
    const event = completedEvent()
    await handler(event)
    const out = (event.result as { output: string }).output
    assert.match(out, HASHLINE_TAG_RE, `expected hashline tags, got: ${out}`)
    assert.ok(out.includes('hello') && out.includes('world'))
  })

  await testAsync('read result.content string gains hashline tags', async () => {
    const event = completedEvent({ result: { content: '1: a\n2: b' } })
    await handler(event)
    const out = (event.result as { content: string }).content
    assert.match(out, HASHLINE_TAG_RE)
  })

  await testAsync('read result.content text parts gain hashline tags', async () => {
    const event = completedEvent({
      result: { content: [{ type: 'text', text: '1: a\n2: b' }] },
    })
    await handler(event)
    const content = (event.result as { content: Array<{ type: string; text: string }> }).content
    assert.equal(content.length, 1)
    assert.equal(content[0].type, 'text')
    assert.match(content[0].text, HASHLINE_TAG_RE)
  })

  await testAsync('non-read tool output is untouched (no tags)', async () => {
    const event = completedEvent({ tool: 'grep', result: { output: '1: a\n2: b' } })
    await handler(event)
    assert.equal((event.result as { output: string }).output, '1: a\n2: b')
  })

  await testAsync('read enhancement is idempotent', async () => {
    const event = completedEvent()
    await handler(event)
    const once = (event.result as { output: string }).output
    await handler(event)
    assert.equal((event.result as { output: string }).output, once)
  })

  await testAsync('content array with a file part is left untouched', async () => {
    const original = [
      { type: 'text', text: '1: a' },
      { type: 'file', uri: 'file:///x', mime: 'text/plain' },
    ]
    const event = completedEvent({ result: { content: original } })
    await handler(event)
    assert.deepEqual((event.result as { content: unknown }).content, original)
  })

  // ── context-sandbox parity ─────────────────────────────────────────────
  await testAsync('oversized read is truncated AND kept lines stay tagged', async () => {
    const event = completedEvent({ result: { output: makeLines(250) } })
    await handler(event)
    const out = (event.result as { output: string }).output
    assert.ok(out.includes('[TRUNCATED:'), 'expected sandbox truncation marker')
    assert.match(out, HASHLINE_TAG_RE, 'kept lines must keep hashline tags')
    const meta = (event.result as { metadata?: Record<string, unknown> }).metadata
    assert.equal(meta?.truncated, true)
    assert.equal(meta?.sandbox, 'read')
  })

  await testAsync('sandbox disabled config: no truncation, tags still applied', async () => {
    const disabled = createV2ExecuteAfter({
      sandbox: resolveSandboxConfig({ enabled: false }),
    })
    const event = completedEvent({ result: { output: makeLines(250) } })
    await disabled(event)
    const out = (event.result as { output: string }).output
    assert.ok(!out.includes('[TRUNCATED:'), 'sandbox disabled must not truncate')
    assert.match(out, HASHLINE_TAG_RE)
  })

  await testAsync('custom sandbox limits are honoured', async () => {
    const custom = createV2ExecuteAfter({
      sandbox: resolveSandboxConfig({
        limits: { read: { maxLines: 5, keepHead: 2, keepTail: 1 } },
      }),
    })
    const event = completedEvent({ result: { output: makeLines(10) } })
    await custom(event)
    const out = (event.result as { output: string }).output
    assert.ok(out.includes('[TRUNCATED:'))
    assert.ok(out.includes('content line 1') && out.includes('content line 10'))
  })

  await testAsync('existing result metadata is preserved through a truncation', async () => {
    const event = completedEvent({
      result: { output: makeLines(250), metadata: { keep: 'me' } },
    })
    await handler(event)
    const meta = (event.result as { metadata: Record<string, unknown> }).metadata
    assert.equal(meta.keep, 'me')
    assert.equal(meta.truncated, true)
  })

  // ── task-result-guard parity ───────────────────────────────────────────
  await testAsync('empty task result becomes an explicit error', async () => {
    const event = completedEvent({ tool: 'task', result: { output: '   ' } })
    await handler(event)
    const out = (event.result as { output: string }).output
    assert.match(out, /ERROR: task\(\) returned empty output/)
  })

  await testAsync('task result with no output field still becomes an explicit error', async () => {
    const event = completedEvent({ tool: 'task', result: {} })
    await handler(event)
    const out = (event.result as { output: string }).output
    assert.match(out, /ERROR: task\(\) returned empty output/)
  })

  await testAsync('non-empty task result is untouched', async () => {
    const event = completedEvent({ tool: 'task', result: { output: 'real answer' } })
    await handler(event)
    assert.equal((event.result as { output: string }).output, 'real answer')
  })

  // ── no-op / fail-safe shapes ───────────────────────────────────────────
  await testAsync('an error-status event is never modified (no after-on-error claim)', async () => {
    const event = {
      tool: 'read',
      id: 'call_1',
      status: 'error',
      error: { message: 'boom' },
    }
    await handler(event)
    assert.deepEqual(event, {
      tool: 'read',
      id: 'call_1',
      status: 'error',
      error: { message: 'boom' },
    })
  })

  for (const [label, event] of [
    ['null', null],
    ['array', []],
    ['missing result', { tool: 'read', status: 'completed' }],
    ['null result', { tool: 'read', status: 'completed', result: null }],
    ['non-object result', { tool: 'read', status: 'completed', result: 42 }],
    ['no text fields', { tool: 'read', status: 'completed', result: { metadata: {} } }],
  ] as Array<[string, unknown]>) {
    await testAsync(`no-op on malformed event: ${label}`, async () => {
      const before = JSON.stringify(event)
      await handler(event) // must not throw
      assert.equal(JSON.stringify(event) === before || event === null, true)
    })
  }

  // ── config resolution ──────────────────────────────────────────────────
  await testAsync('resolveV2SandboxConfig reads ctx.options.context_sandbox', async () => {
    const resolved = resolveV2SandboxConfig({
      context_sandbox: { enabled: false, limits: { read: { maxLines: 7 } } },
    })
    assert.equal(resolved.enabled, false)
    assert.equal(resolved.limits.read.maxLines, 7)
    assert.equal(resolved.limits.grep.maxResults, DEFAULT_CONFIG.limits.grep.maxResults)
  })

  await testAsync('resolveV2SandboxConfig falls back to defaults for absent/garbage', async () => {
    assert.deepEqual(resolveV2SandboxConfig(undefined), DEFAULT_CONFIG)
    assert.deepEqual(resolveV2SandboxConfig({}), { ...DEFAULT_CONFIG })
    assert.deepEqual(resolveV2SandboxConfig({ context_sandbox: 'nope' }), { ...DEFAULT_CONFIG })
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
