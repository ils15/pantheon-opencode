/**
 * Tests for Context Window Optimization — Tool Output Sandboxing (v2 P0)
 *
 * Covers:
 *   - sandboxRead / sandboxGrep / sandboxGlob / sandboxWebfetch (dentro/fora/limite exato)
 *   - sandboxOutput dispatch (routing + aliases + pass-through)
 *   - createContextSandbox handler (truncation + metadata + enabled gate + fail-open)
 *   - resolveSandboxConfig (defaults + overrides + fail-open)
 *   - integration: sandbox before hashline readEnhancer (tags remain on kept lines)
 *
 * Run with: npx tsx tests/pantheon/context-sandbox.test.ts
 */
import { strict as assert } from 'node:assert'
import {
  createContextSandbox,
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
  // ── sandboxRead ────────────────────────────────────────────────────────
  await testAsync('sandboxRead: at/below limit untouched, empty untouched', async () => {
    assert.equal(sandboxRead(makeLines(200)), makeLines(200)) // exact limit
    assert.equal(sandboxRead(makeLines(50)), makeLines(50))
    assert.equal(sandboxRead(''), '')
  })

  await testAsync(
    'sandboxRead: over limit truncates head+tail+marker (exact+1, custom, newline)',
    async () => {
      const input = makeLines(250)
      const out = sandboxRead(input)
      assert.ok(out.includes('[TRUNCATED:'), 'must contain TRUNCATED marker')
      assert.ok(out.includes('250 total') && out.includes('50 head') && out.includes('10 tail'))
      assert.ok(out.includes('1: line 1') && out.includes('50: line 50'))
      assert.ok(out.includes('241: line 241') && out.includes('250: line 250'))
      assert.ok(!out.includes('100: line 100'), 'hidden middle must not appear')
      assert.equal(out.split('\n').filter((l) => l !== '').length, 61) // 50 + marker + 10

      assert.ok(sandboxRead(makeLines(201)).includes('[TRUNCATED:'), 'exact+1 must truncate')

      const custom = sandboxRead(makeLines(10), { maxLines: 5, keepHead: 2, keepTail: 1 })
      assert.ok(
        custom.includes('[TRUNCATED:') && custom.includes('2 head') && custom.includes('1 tail'),
      )

      assert.ok(sandboxRead(`${makeLines(250)}\n`).endsWith('\n'), 'trailing newline preserved')
    },
  )

  // ── sandboxGrep ────────────────────────────────────────────────────────
  await testAsync('sandboxGrep: at/below limit untouched', async () => {
    assert.equal(sandboxGrep(makeGrepLines(20)), makeGrepLines(20))
    assert.equal(sandboxGrep(makeGrepLines(5)), makeGrepLines(5))
  })

  await testAsync('sandboxGrep: over limit keeps top-N + marker, newline preserved', async () => {
    const out = sandboxGrep(makeGrepLines(25))
    assert.ok(out.includes('10 of 25 matches'))
    assert.ok(out.includes('file0.ts:0: match 0') && out.includes('file0.ts:9: match 9'))
    assert.ok(!out.includes('file1.ts:15: match 15'), 'hidden must not appear')
    assert.equal(out.split('\n').filter((l) => l !== '').length, 11) // 10 + marker
    assert.ok(sandboxGrep(makeGrepLines(100)).includes('90 more hidden'))
    assert.ok(sandboxGrep(`${makeGrepLines(25)}\n`).endsWith('\n'))
  })

  // ── sandboxGlob ────────────────────────────────────────────────────────
  await testAsync('sandboxGlob: at/below limit untouched', async () => {
    assert.equal(sandboxGlob(makeGlobLines(50)), makeGlobLines(50))
    assert.equal(sandboxGlob(makeGlobLines(10)), makeGlobLines(10))
  })

  await testAsync('sandboxGlob: over limit keeps top-N + marker', async () => {
    const out = sandboxGlob(makeGlobLines(55))
    assert.ok(out.includes('20 of 55 files'))
    assert.ok(out.includes('src/file0.ts') && out.includes('src/file19.ts'))
    assert.ok(!out.includes('src/file30.ts'))
    assert.equal(out.split('\n').filter((l) => l !== '').length, 21) // 20 + marker
    assert.ok(sandboxGlob(makeGlobLines(100)).includes('80 more hidden'))
  })

  // ── sandboxWebfetch ────────────────────────────────────────────────────
  await testAsync('sandboxWebfetch: at/below limit untouched', async () => {
    assert.equal(sandboxWebfetch(makeChars(5000)), makeChars(5000))
    assert.equal(sandboxWebfetch(makeChars(100)), makeChars(100))
  })

  await testAsync(
    'sandboxWebfetch: over limit truncates head + marker (exact+1, custom)',
    async () => {
      const input = makeChars(6000)
      const out = sandboxWebfetch(input)
      assert.ok(out.includes('[TRUNCATED: Content truncated'))
      assert.ok(out.includes('first 2000 of 6000 chars') && out.includes('4000 chars hidden'))
      assert.equal(out.slice(0, 2000), 'x'.repeat(2000))
      assert.ok(out.length < input.length)

      assert.ok(sandboxWebfetch(makeChars(5001)).includes('[TRUNCATED:'), 'exact+1 must truncate')

      const custom = sandboxWebfetch(makeChars(100), { maxChars: 10, keepHead: 5 })
      assert.ok(custom.includes('first 5 of 100 chars'))
      assert.equal(custom.slice(0, 5), 'xxxxx')
    },
  )

  // ── sandboxOutput dispatch ─────────────────────────────────────────────
  await testAsync(
    'sandboxOutput: routes each tool (over limit, aliases, case-insensitive)',
    async () => {
      assert.ok(sandboxOutput('read', makeLines(250)).includes('[TRUNCATED:'))
      assert.ok(sandboxOutput('grep', makeGrepLines(25)).includes('matches'))
      assert.ok(sandboxOutput('glob', makeGlobLines(55)).includes('files'))
      assert.ok(sandboxOutput('webfetch', makeChars(6000)).includes('Content truncated'))
      assert.ok(sandboxOutput('fetch', makeChars(6000)).includes('[TRUNCATED:'))
      assert.ok(sandboxOutput('web_fetch', makeChars(6000)).includes('[TRUNCATED:'))
      assert.ok(sandboxOutput('READ', makeLines(250)).includes('[TRUNCATED:'))
      assert.ok(sandboxOutput('Grep', makeGrepLines(25)).includes('[TRUNCATED:'))
    },
  )

  await testAsync(
    'sandboxOutput: pass-through — unknown, empty, within limits, custom limits',
    async () => {
      const input = makeLines(1000)
      assert.equal(sandboxOutput('bash', input), input)
      assert.equal(sandboxOutput('edit', input), input)
      assert.equal(sandboxOutput('unknown', input), input)
      assert.equal(sandboxOutput('read', ''), '')
      assert.equal(sandboxOutput('grep', ''), '')
      assert.equal(sandboxOutput('read', makeLines(10)), makeLines(10))
      assert.equal(sandboxOutput('grep', makeGrepLines(10)), makeGrepLines(10))
      assert.equal(sandboxOutput('glob', makeGlobLines(10)), makeGlobLines(10))
      assert.equal(sandboxOutput('webfetch', makeChars(100)), makeChars(100))

      const limits = { ...DEFAULT_LIMITS, read: { maxLines: 5, keepHead: 2, keepTail: 1 } }
      assert.ok(sandboxOutput('read', makeLines(10), limits).includes('[TRUNCATED:'))
    },
  )

  // ── resolveSandboxConfig ───────────────────────────────────────────────
  await testAsync(
    'resolveSandboxConfig: undefined/null/empty/non-object/invalid → defaults (fail-open)',
    async () => {
      const def = resolveSandboxConfig(undefined)
      assert.equal(def.enabled, true)
      assert.deepEqual(def.limits, DEFAULT_LIMITS)
      assert.equal(resolveSandboxConfig(null).enabled, true)
      assert.deepEqual(resolveSandboxConfig({}).limits.read, DEFAULT_LIMITS.read)
      assert.deepEqual(resolveSandboxConfig('bad'), def)
      assert.deepEqual(resolveSandboxConfig(42), def)

      const invalid = resolveSandboxConfig({
        limits: { read: { maxLines: 'bad' } },
      } as unknown as Record<string, unknown>)
      assert.equal(invalid.limits.read.maxLines, DEFAULT_LIMITS.read.maxLines)
    },
  )

  await testAsync(
    'resolveSandboxConfig: disabled flag + partial override keeps other defaults',
    async () => {
      assert.equal(resolveSandboxConfig({ enabled: false }).enabled, false)

      const cfg = resolveSandboxConfig({
        limits: { read: { maxLines: 10, keepHead: 3, keepTail: 1 } },
      })
      assert.equal(cfg.limits.read.maxLines, 10)
      assert.equal(cfg.limits.read.keepHead, 3)
      assert.deepEqual(cfg.limits.grep, DEFAULT_LIMITS.grep)
      assert.deepEqual(cfg.limits.glob, DEFAULT_LIMITS.glob)
    },
  )

  // ── createContextSandbox handler ───────────────────────────────────────
  await testAsync('handler: over limit truncates each tool + sets metadata.truncated', async () => {
    const cases = [
      ['read', makeLines(250), '[TRUNCATED:'],
      ['grep', makeGrepLines(30), 'matches'],
      ['glob', makeGlobLines(60), 'files'],
      ['webfetch', makeChars(6000), 'Content truncated'],
    ] as const
    for (const [tool, raw, marker] of cases) {
      const handler = createContextSandbox()
      const output = { title: tool, output: raw, metadata: {} as Record<string, unknown> }
      await handler({ tool, sessionID: 'ses1', callID: 'c1' }, output)
      assert.ok(output.output.includes(marker), `${tool} must truncate`)
      assert.equal(output.metadata.truncated, true)
      assert.equal(output.metadata.sandbox, tool)
    }
  })

  await testAsync(
    'handler: within limit untouched, existing metadata preserved + merged',
    async () => {
      const handler = createContextSandbox()
      const original = makeLines(10)
      const within = {
        title: 'read',
        output: original,
        metadata: { foo: 'bar' } as Record<string, unknown>,
      }
      await handler({ tool: 'read', sessionID: 'ses1', callID: 'c1' }, within)
      assert.equal(within.output, original)
      assert.deepEqual(within.metadata, { foo: 'bar' })

      const over = {
        title: 'read',
        output: makeLines(250),
        metadata: { foo: 'bar' } as Record<string, unknown>,
      }
      await handler({ tool: 'read', sessionID: 'ses1', callID: 'c1' }, over)
      assert.equal(over.metadata.foo, 'bar')
      assert.equal(over.metadata.truncated, true)
    },
  )

  await testAsync(
    'handler guards: disabled gate, live config, unknown tool, non-string, never throws',
    async () => {
      const original = makeLines(250)
      const input = { tool: 'read', sessionID: 'ses1', callID: 'c1' }

      const disabled = createContextSandbox({ enabled: false, limits: DEFAULT_LIMITS })
      const disabledOut = {
        title: 'read',
        output: original,
        metadata: {} as Record<string, unknown>,
      }
      await disabled(input, disabledOut)
      assert.equal(disabledOut.output, original)
      assert.equal(disabledOut.metadata.truncated, undefined)

      const live = { enabled: true, limits: DEFAULT_LIMITS }
      const liveHandler = createContextSandbox(live)
      live.enabled = false
      const liveOut = { title: 'read', output: original, metadata: {} as Record<string, unknown> }
      await liveHandler(input, liveOut)
      assert.equal(liveOut.output, original, 'live config update must be respected')

      const passthrough = createContextSandbox()
      const bash = makeLines(1000)
      const bashOut = { title: 'bash', output: bash, metadata: {} as Record<string, unknown> }
      await passthrough({ tool: 'bash', sessionID: 'ses1', callID: 'c1' }, bashOut)
      assert.equal(bashOut.output, bash)
      assert.equal(bashOut.metadata.truncated, undefined)

      const nullOut = {
        title: 'read',
        output: null as unknown as string,
        metadata: {} as Record<string, unknown>,
      }
      await passthrough(input, nullOut as unknown as { output: string })
      assert.equal(nullOut.output, null)

      // @ts-expect-error intentional malformed input
      await passthrough(null, null)
      // @ts-expect-error intentional malformed input
      await passthrough({ tool: 'read' }, { output: 123 })
    },
  )

  // ── integration: sandbox before hashline enhancer ──────────────────────
  await testAsync('integration: sandbox then readEnhancer — tags on kept lines only', async () => {
    const sandbox = createContextSandbox()
    const enhancer = createReadEnhancer()
    const input = { tool: 'read', sessionID: 'ses1', callID: 'c1' }
    const output: { title: string; output: string; metadata?: Record<string, unknown> } = {
      title: 'read',
      output: makeLines(250),
      metadata: {},
    }
    await sandbox(input, output)
    assert.ok(output.output.includes('[TRUNCATED:'), 'sandbox must truncate first')
    assert.equal(output.output.split('\n').filter((l) => l !== '').length, 61)

    await enhancer(input, output)
    assert.ok(output.output.includes('[TRUNCATED:'), 'marker must survive enhancer')
    assert.ok(output.output.includes('1#'), 'kept head lines must be tagged')
    assert.ok(output.output.includes('250#'), 'kept tail lines must be tagged')
    assert.ok(!output.output.includes('100#'), 'hidden lines must not be tagged')
  })

  await testAsync('integration: enhancer is a no-op for non-read (grep)', async () => {
    const sandbox = createContextSandbox()
    const enhancer = createReadEnhancer()
    const input = { tool: 'grep', sessionID: 'ses1', callID: 'c1' }
    const output = { title: 'grep', output: makeGrepLines(30), metadata: {} }
    await sandbox(input, output)
    await enhancer(input, output)
    assert.ok(output.output.includes('[TRUNCATED:'))
    assert.ok(!output.output.includes('#'), 'grep output should not be hashline-tagged')
  })

  // ── performance ────────────────────────────────────────────────────────
  await testAsync('performance: sandbox 10k lines < 50ms', async () => {
    const start = Date.now()
    const out = sandboxRead(makeLines(10_000))
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
