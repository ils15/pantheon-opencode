/**
 * Tests for Context Window Optimization — Tool Output Sandboxing (v2 P0)
 *
 * Covers:
 *   - sandboxRead / sandboxGrep / sandboxGlob / sandboxWebfetch pure functions (dentro/fora limite)
 *   - sandboxOutput dispatch (4 tools x 2 sizes + unknown + edge)
 *   - createContextSandbox handler (truncation + metadata + enabled gate + fail-open)
 *   - resolveSandboxConfig (defaults + overrides + fail-open)
 *   - integration: sandbox before hashline readEnhancer (tags remain on kept lines)
 *   - session memory auto-save already covered by delegation-compaction tests (P1 conectado)
 *
 * Run with: npx tsx tests/pantheon/context-sandbox.test.ts
 */
import { strict as assert } from 'node:assert'
import {
  createContextSandbox,
  DEFAULT_CONFIG,
  DEFAULT_LIMITS,
  resolveSandboxConfig,
  sandboxGlob,
  sandboxGrep,
  sandboxOutput,
  sandboxRead,
  sandboxWebfetch,
} from '../../src/pantheon/context-sandbox.ts'
import { createReadEnhancer } from '../../src/pantheon/hashline/read-enhancer.ts'

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

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeLines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, i) => `${i + 1}: ${prefix} ${i + 1}`).join('\n')
}

function makeGrepLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `file${i % 3}.ts:${i}: match ${i}`).join('\n')
}

function makeGlobLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `src/file${i}.ts`).join('\n')
}

function makeChars(n: number): string {
  return 'x'.repeat(n)
}

// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  // ── sandboxRead: dentro do limite ──────────────────────────────────────
  await testAsync('sandboxRead: within limit (200) — unchanged', async () => {
    const input = makeLines(200)
    assert.equal(sandboxRead(input), input)
  })

  await testAsync('sandboxRead: under limit (50) — unchanged', async () => {
    const input = makeLines(50)
    assert.equal(sandboxRead(input), input)
  })

  await testAsync('sandboxRead: empty — unchanged', async () => {
    assert.equal(sandboxRead(''), '')
  })

  // ── sandboxRead: fora do limite ────────────────────────────────────────
  await testAsync('sandboxRead: over limit (250) — truncated head+tail+marker', async () => {
    const input = makeLines(250)
    const out = sandboxRead(input)
    assert.ok(out.includes('[TRUNCATED:'), 'must contain TRUNCATED marker')
    assert.ok(out.includes('250 total'), 'must mention total')
    assert.ok(out.includes('50 head'), 'must mention head count')
    assert.ok(out.includes('10 tail'), 'must mention tail count')
    // head: first 50 lines present
    assert.ok(out.includes('1: line 1'))
    assert.ok(out.includes('50: line 50'))
    // tail: last 10 present
    assert.ok(out.includes('241: line 241'))
    assert.ok(out.includes('250: line 250'))
    // hidden region not present
    assert.ok(!out.includes('100: line 100'), 'hidden middle must not appear')
    const lines = out.split('\n').filter((l) => l !== '')
    // 50 head + 1 marker + 10 tail = 61 lines
    assert.equal(lines.length, 61)
  })

  await testAsync('sandboxRead: exactly 201 lines — truncated', async () => {
    const input = makeLines(201)
    const out = sandboxRead(input)
    assert.ok(out.includes('[TRUNCATED:'))
    assert.ok(!out.includes('100: line 100'))
  })

  await testAsync('sandboxRead: trailing newline preserved', async () => {
    const input = makeLines(250) + '\n'
    const out = sandboxRead(input)
    assert.ok(out.endsWith('\n'), 'trailing newline must be preserved')
    assert.ok(out.includes('[TRUNCATED:'))
  })

  await testAsync('sandboxRead: custom limits', async () => {
    const input = makeLines(10)
    const out = sandboxRead(input, { maxLines: 5, keepHead: 2, keepTail: 1 })
    assert.ok(out.includes('[TRUNCATED:'))
    assert.ok(out.includes('2 head'))
    assert.ok(out.includes('1 tail'))
    assert.ok(out.includes('1: line 1'))
    assert.ok(out.includes('10: line 10'))
  })

  // ── sandboxGrep: dentro ────────────────────────────────────────────────
  await testAsync('sandboxGrep: within limit (20) — unchanged', async () => {
    const input = makeGrepLines(20)
    assert.equal(sandboxGrep(input), input)
  })

  await testAsync('sandboxGrep: under limit (5) — unchanged', async () => {
    const input = makeGrepLines(5)
    assert.equal(sandboxGrep(input), input)
  })

  // ── sandboxGrep: fora ──────────────────────────────────────────────────
  await testAsync('sandboxGrep: over limit (25) — truncated top 10 + marker', async () => {
    const input = makeGrepLines(25)
    const out = sandboxGrep(input)
    assert.ok(out.includes('[TRUNCATED:'))
    assert.ok(out.includes('10 of 25 matches'))
    assert.ok(out.includes('file0.ts:0: match 0'))
    assert.ok(out.includes('file0.ts:9: match 9'))
    assert.ok(!out.includes('file1.ts:15: match 15'), 'hidden must not appear')
    const lines = out.split('\n').filter((l) => l !== '')
    assert.equal(lines.length, 11) // 10 + marker
  })

  await testAsync('sandboxGrep: huge (100) — marker correct', async () => {
    const input = makeGrepLines(100)
    const out = sandboxGrep(input)
    assert.ok(out.includes('10 of 100 matches'))
    assert.ok(out.includes('90 more hidden'))
  })

  await testAsync('sandboxGrep: trailing newline preserved', async () => {
    const input = makeGrepLines(25) + '\n'
    const out = sandboxGrep(input)
    assert.ok(out.endsWith('\n'))
  })

  // ── sandboxGlob: dentro ────────────────────────────────────────────────
  await testAsync('sandboxGlob: within limit (50) — unchanged', async () => {
    const input = makeGlobLines(50)
    assert.equal(sandboxGlob(input), input)
  })

  await testAsync('sandboxGlob: under limit (10) — unchanged', async () => {
    const input = makeGlobLines(10)
    assert.equal(sandboxGlob(input), input)
  })

  // ── sandboxGlob: fora ──────────────────────────────────────────────────
  await testAsync('sandboxGlob: over limit (55) — truncated top 20 + marker', async () => {
    const input = makeGlobLines(55)
    const out = sandboxGlob(input)
    assert.ok(out.includes('[TRUNCATED:'))
    assert.ok(out.includes('20 of 55 files'))
    assert.ok(out.includes('src/file0.ts'))
    assert.ok(out.includes('src/file19.ts'))
    assert.ok(!out.includes('src/file30.ts'))
    const lines = out.split('\n').filter((l) => l !== '')
    assert.equal(lines.length, 21) // 20 + marker
  })

  await testAsync('sandboxGlob: 100 files — marker correct', async () => {
    const input = makeGlobLines(100)
    const out = sandboxGlob(input)
    assert.ok(out.includes('20 of 100 files'))
    assert.ok(out.includes('80 more hidden'))
  })

  // ── sandboxWebfetch: dentro ────────────────────────────────────────────
  await testAsync('sandboxWebfetch: within limit (5000) — unchanged', async () => {
    const input = makeChars(5000)
    assert.equal(sandboxWebfetch(input), input)
  })

  await testAsync('sandboxWebfetch: under limit (100) — unchanged', async () => {
    const input = makeChars(100)
    assert.equal(sandboxWebfetch(input), input)
  })

  // ── sandboxWebfetch: fora ───────────────────────────────────────────────
  await testAsync('sandboxWebfetch: over limit (6000) — truncated head 2000 + marker', async () => {
    const input = makeChars(6000)
    const out = sandboxWebfetch(input)
    assert.ok(out.includes('[TRUNCATED: Content truncated'))
    assert.ok(out.includes('first 2000 of 6000 chars'))
    assert.ok(out.includes('4000 chars hidden'))
    assert.equal(out.slice(0, 2000), 'x'.repeat(2000))
    assert.ok(
      out.length < input.length,
      'output must be shorter than input? actually head+marker vs 6000: 2000+~80 <6000 true',
    )
  })

  await testAsync('sandboxWebfetch: exactly 5001 — truncated', async () => {
    const input = makeChars(5001)
    const out = sandboxWebfetch(input)
    assert.ok(out.includes('[TRUNCATED:'))
  })

  await testAsync('sandboxWebfetch: custom limits', async () => {
    const input = makeChars(100)
    const out = sandboxWebfetch(input, { maxChars: 10, keepHead: 5 })
    assert.ok(out.includes('first 5 of 100 chars'))
    assert.equal(out.slice(0, 5), 'xxxxx')
  })

  // ── sandboxOutput dispatch ─────────────────────────────────────────────
  await testAsync('sandboxOutput: dispatch read → truncated', async () => {
    const input = makeLines(250)
    const out = sandboxOutput('read', input)
    assert.ok(out.includes('[TRUNCATED:'))
  })

  await testAsync('sandboxOutput: dispatch grep → truncated', async () => {
    const input = makeGrepLines(25)
    const out = sandboxOutput('grep', input)
    assert.ok(out.includes('matches'))
  })

  await testAsync('sandboxOutput: dispatch glob → truncated', async () => {
    const input = makeGlobLines(55)
    const out = sandboxOutput('glob', input)
    assert.ok(out.includes('files'))
  })

  await testAsync('sandboxOutput: dispatch webfetch → truncated', async () => {
    const input = makeChars(6000)
    const out = sandboxOutput('webfetch', input)
    assert.ok(out.includes('Content truncated'))
  })

  await testAsync('sandboxOutput: alias fetch/web_fetch also truncated', async () => {
    assert.ok(sandboxOutput('fetch', makeChars(6000)).includes('[TRUNCATED:'))
    assert.ok(sandboxOutput('web_fetch', makeChars(6000)).includes('[TRUNCATED:'))
  })

  await testAsync('sandboxOutput: unknown tool — unchanged', async () => {
    const input = makeLines(1000)
    assert.equal(sandboxOutput('bash', input), input)
    assert.equal(sandboxOutput('edit', input), input)
    assert.equal(sandboxOutput('unknown', input), input)
  })

  await testAsync('sandboxOutput: case insensitive', async () => {
    const input = makeLines(250)
    assert.ok(sandboxOutput('READ', input).includes('[TRUNCATED:'))
    assert.ok(sandboxOutput('Grep', makeGrepLines(25)).includes('[TRUNCATED:'))
  })

  await testAsync('sandboxOutput: empty string — unchanged', async () => {
    assert.equal(sandboxOutput('read', ''), '')
    assert.equal(sandboxOutput('grep', ''), '')
  })

  await testAsync('sandboxOutput: within limits — unchanged for all tools', async () => {
    assert.equal(sandboxOutput('read', makeLines(10)), makeLines(10))
    assert.equal(sandboxOutput('grep', makeGrepLines(10)), makeGrepLines(10))
    assert.equal(sandboxOutput('glob', makeGlobLines(10)), makeGlobLines(10))
    assert.equal(sandboxOutput('webfetch', makeChars(100)), makeChars(100))
  })

  await testAsync('sandboxOutput: custom limits override', async () => {
    const input = makeLines(10)
    const limits = { ...DEFAULT_LIMITS, read: { maxLines: 5, keepHead: 2, keepTail: 1 } }
    const out = sandboxOutput('read', input, limits)
    assert.ok(out.includes('[TRUNCATED:'))
  })

  // ── resolveSandboxConfig ───────────────────────────────────────────────
  await testAsync('resolveSandboxConfig: undefined → defaults', async () => {
    const cfg = resolveSandboxConfig(undefined)
    assert.equal(cfg.enabled, true)
    assert.deepEqual(cfg.limits, DEFAULT_LIMITS)
  })

  await testAsync('resolveSandboxConfig: null → defaults', async () => {
    const cfg = resolveSandboxConfig(null)
    assert.equal(cfg.enabled, true)
  })

  await testAsync('resolveSandboxConfig: empty object → defaults', async () => {
    const cfg = resolveSandboxConfig({})
    assert.equal(cfg.enabled, true)
    assert.deepEqual(cfg.limits.read, DEFAULT_LIMITS.read)
  })

  await testAsync('resolveSandboxConfig: disabled flag', async () => {
    const cfg = resolveSandboxConfig({ enabled: false })
    assert.equal(cfg.enabled, false)
  })

  await testAsync('resolveSandboxConfig: partial limits override', async () => {
    const cfg = resolveSandboxConfig({
      limits: { read: { maxLines: 10, keepHead: 3, keepTail: 1 } },
    })
    assert.equal(cfg.limits.read.maxLines, 10)
    assert.equal(cfg.limits.read.keepHead, 3)
    // other tools keep defaults
    assert.deepEqual(cfg.limits.grep, DEFAULT_LIMITS.grep)
    assert.deepEqual(cfg.limits.glob, DEFAULT_LIMITS.glob)
  })

  await testAsync('resolveSandboxConfig: invalid limits → fall back', async () => {
    const cfg = resolveSandboxConfig({ limits: { read: { maxLines: 'bad' } } } as unknown as Record<
      string,
      unknown
    >)
    assert.equal(cfg.limits.read.maxLines, DEFAULT_LIMITS.read.maxLines)
  })

  await testAsync('resolveSandboxConfig: non-object → defaults', async () => {
    assert.deepEqual(resolveSandboxConfig('bad'), resolveSandboxConfig(undefined))
    assert.deepEqual(resolveSandboxConfig(42), resolveSandboxConfig(undefined))
  })

  // ── createContextSandbox handler ───────────────────────────────────────
  await testAsync('handler: read over limit → truncates + metadata.truncated', async () => {
    const handler = createContextSandbox()
    const input = { tool: 'read', sessionID: 'ses1', callID: 'c1' }
    const output = { title: 'read', output: makeLines(250), metadata: {} }
    await handler(input, output)
    assert.ok(output.output.includes('[TRUNCATED:'))
    assert.equal((output.metadata as Record<string, unknown>).truncated, true)
    assert.equal((output.metadata as Record<string, unknown>).sandbox, 'read')
  })

  await testAsync('handler: read within limit — no mutation, no metadata', async () => {
    const handler = createContextSandbox()
    const input = { tool: 'read', sessionID: 'ses1', callID: 'c1' }
    const original = makeLines(10)
    const output = { title: 'read', output: original, metadata: { foo: 'bar' } }
    await handler(input, output)
    assert.equal(output.output, original)
    assert.deepEqual(output.metadata, { foo: 'bar' })
  })

  await testAsync('handler: grep over limit → truncates', async () => {
    const handler = createContextSandbox()
    const input = { tool: 'grep', sessionID: 'ses1', callID: 'c1' }
    const output = { title: 'grep', output: makeGrepLines(30), metadata: {} }
    await handler(input, output)
    assert.ok(output.output.includes('matches'))
    assert.equal((output.metadata as Record<string, unknown>).truncated, true)
  })

  await testAsync('handler: glob over limit → truncates', async () => {
    const handler = createContextSandbox()
    const input = { tool: 'glob', sessionID: 'ses1', callID: 'c1' }
    const output = { title: 'glob', output: makeGlobLines(60), metadata: {} }
    await handler(input, output)
    assert.ok(output.output.includes('files'))
  })

  await testAsync('handler: webfetch over limit → truncates', async () => {
    const handler = createContextSandbox()
    const input = { tool: 'webfetch', sessionID: 'ses1', callID: 'c1' }
    const output = { title: 'webfetch', output: makeChars(6000), metadata: {} }
    await handler(input, output)
    assert.ok(output.output.includes('Content truncated'))
  })

  await testAsync('handler: unknown tool — passes through', async () => {
    const handler = createContextSandbox()
    const input = { tool: 'bash', sessionID: 'ses1', callID: 'c1' }
    const original = makeLines(1000)
    const output = { title: 'bash', output: original, metadata: {} }
    await handler(input, output)
    assert.equal(output.output, original)
    assert.equal((output.metadata as Record<string, unknown>).truncated, undefined)
  })

  await testAsync('handler: disabled → no truncation', async () => {
    const handler = createContextSandbox({ enabled: false, limits: DEFAULT_LIMITS })
    const input = { tool: 'read', sessionID: 'ses1', callID: 'c1' }
    const original = makeLines(250)
    const output = { title: 'read', output: original, metadata: {} }
    await handler(input, output)
    assert.equal(output.output, original)
    assert.equal((output.metadata as Record<string, unknown>).truncated, undefined)
  })

  await testAsync('handler: mutable config ref — live update', async () => {
    const cfg = { enabled: true, limits: DEFAULT_LIMITS }
    const handler = createContextSandbox(cfg)
    // disable live
    cfg.enabled = false
    const input = { tool: 'read', sessionID: 'ses1', callID: 'c1' }
    const original = makeLines(250)
    const output = { title: 'read', output: original, metadata: {} }
    await handler(input, output)
    assert.equal(output.output, original, 'live config update must be respected')
  })

  await testAsync('handler: non-string output — no throw, pass through', async () => {
    const handler = createContextSandbox()
    const input = { tool: 'read', sessionID: 'ses1', callID: 'c1' }
    const output = { title: 'read', output: null as unknown as string, metadata: {} }
    await handler(input, output as unknown as { output: string })
    assert.equal(output.output, null)
  })

  await testAsync('handler: existing metadata preserved + truncated merged', async () => {
    const handler = createContextSandbox()
    const input = { tool: 'read', sessionID: 'ses1', callID: 'c1' }
    const output = { title: 'read', output: makeLines(250), metadata: { foo: 'bar' } }
    await handler(input, output)
    assert.equal((output.metadata as Record<string, unknown>).foo, 'bar')
    assert.equal((output.metadata as Record<string, unknown>).truncated, true)
  })

  await testAsync('handler: never throws on malformed input', async () => {
    const handler = createContextSandbox()
    // @ts-expect-error intentional malformed
    await handler(null, null)
    // @ts-expect-error
    await handler({ tool: 'read' }, { output: 123 })
  })

  // ── integration: sandbox before hashline enhancer ──────────────────────
  await testAsync('integration: sandbox then readEnhancer — tags on kept lines only', async () => {
    const sandbox = createContextSandbox()
    const enhancer = createReadEnhancer()
    const input = { tool: 'read', sessionID: 'ses1', callID: 'c1' }
    // Simulate read output with line numbers: "1: a\n2: b\n..."
    const raw = makeLines(250)
    const output: { title: string; output: string; metadata?: Record<string, unknown> } = {
      title: 'read',
      output: raw,
      metadata: {},
    }
    await sandbox(input, output)
    assert.ok(output.output.includes('[TRUNCATED:'), 'sandbox must truncate first')
    const afterSandboxLineCount = output.output.split('\n').filter((l) => l !== '').length
    assert.equal(afterSandboxLineCount, 61, 'after sandbox: 50 head + marker + 10 tail')

    await enhancer(input, output)
    // Enhancer tags lines matching "N: content" → "N#TAG|content"
    // Marker line "[TRUNCATED: ..." does not match prefix, so left untouched
    assert.ok(output.output.includes('[TRUNCATED:'), 'marker must survive enhancer')
    // Kept lines must be tagged: e.g. "1#??|line 1"
    assert.ok(output.output.includes('1#'), 'kept head lines must be tagged')
    assert.ok(output.output.includes('250#'), 'kept tail lines must be tagged')
    // Hidden lines not present, hence not tagged
    assert.ok(!output.output.includes('100#'), 'hidden lines must not be tagged')
  })

  await testAsync('integration: sandbox + enhancer order independence for non-read', async () => {
    const sandbox = createContextSandbox()
    const enhancer = createReadEnhancer()
    const input = { tool: 'grep', sessionID: 'ses1', callID: 'c1' }
    const raw = makeGrepLines(30)
    const output = { title: 'grep', output: raw, metadata: {} }
    await sandbox(input, output)
    await enhancer(input, output)
    // enhancer is no-op for grep
    assert.ok(output.output.includes('[TRUNCATED:'))
    assert.ok(!output.output.includes('#'), 'grep output should not be hashline-tagged')
  })

  // ── performance: large input <5ms overhead ─────────────────────────────
  await testAsync('performance: sandbox 10k lines < 50ms', async () => {
    const input = makeLines(10_000)
    const start = Date.now()
    const out = sandboxRead(input)
    const elapsed = Date.now() - start
    assert.ok(out.includes('[TRUNCATED:'))
    assert.ok(elapsed < 50, `sandbox 10k lines took ${elapsed}ms, expected <50ms`)
  })

  // ═══════════════════════════════════════════════════════════════════════════

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
