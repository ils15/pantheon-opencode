/**
 * Tests for WS3 Token-Opt (PR #94) — C9 Mode-1, 4 meta-tools ceiling,
 * response filtering/truncation, schema compression, tokens-only metering.
 *
 * TDD RED: `src/pantheon/token-opt.ts` does not exist yet, so every test
 * here FAILS before the implementation and PASSES after.
 *
 * Constraints (PLAN GATE 1): tokens-only accounting (NO monetary layer),
 * deterministic metering (NO LLM calls), pre-retrieval overhead is debited,
 * a lever with net delta <= 0 is DISABLED by flag (never removed).
 *
 * Run with: npx tsx tests/pantheon/token-opt.test.ts
 */
import { strict as assert } from 'node:assert'

import {
  ALWAYS_ON_TOOLS,
  applyGate,
  buildC9Context,
  C9_DEFAULT_CUTOFF,
  C9_DEFAULT_TOP_K,
  type C9CandidateBatch,
  type C9Chunk,
  c9Filter,
  classifyTool,
  DEFAULT_FLAGS,
  describeTool,
  discoveryOverheadChars,
  EMPTY_OVERHEAD,
  estimateTokens,
  filterFields,
  fullDetailChars,
  isKnownTool,
  isTokenOptEnabled,
  type LeverMeasurement,
  type LeverName,
  lazyRoute,
  measureLever,
  measureLeverFull,
  prepareC9Context,
  TokenMeter,
  totalOverheadChars,
  truncateTurn,
} from '../../src/pantheon/token-opt.ts'
import { toonEncode } from '../../src/pantheon/toon-codec.ts'

// ─── Harness ─────────────────────────────────────────────────────────────

const results: { name: string; passed: boolean; error?: string }[] = []

async function testAsync(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    results.push({ name, passed: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    results.push({ name, passed: false, error: msg })
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────

function chunk(id: string, category: string, score: number): C9Chunk {
  return { id, category, score, text: `chunk-text-${id}` }
}

// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  // ── Deterministic metering ────────────────────────────────────────────
  await testAsync(
    'estimateTokens is deterministic (no LLM, same input → same output)',
    async () => {
      assert.equal(estimateTokens(''), 0)
      assert.equal(estimateTokens('abcd'), 1)
      assert.equal(estimateTokens('abcdefgh'), 2)
      const sample = 'Background Delegations (running): [apo-1] task — COMPLETED'
      assert.equal(estimateTokens(sample), estimateTokens(sample))
      assert.ok(estimateTokens(sample) > 0)
    },
  )

  // ── C9 pre-retrieval Mode-1 ───────────────────────────────────────────
  await testAsync('C9 defaults are top-k 3 and cutoff 0.3', async () => {
    assert.equal(C9_DEFAULT_TOP_K, 3)
    assert.equal(C9_DEFAULT_CUTOFF, 0.3)
  })

  await testAsync('c9Filter drops chunks below the relevance cutoff', async () => {
    const chunks = [
      chunk('a', 'memory', 0.9),
      chunk('b', 'memory', 0.29),
      chunk('c', 'memory', 0.1),
    ]
    const out = c9Filter(chunks)
    assert.deepEqual(
      out.selected.map((c) => c.id),
      ['a'],
    )
    assert.deepEqual(
      out.dropped.map((c) => c.id),
      ['b', 'c'],
    )
  })

  await testAsync('c9Filter keeps top-k per category sorted by score desc', async () => {
    const chunks = [
      chunk('m1', 'memory', 0.5),
      chunk('m2', 'memory', 0.9),
      chunk('m3', 'memory', 0.7),
      chunk('m4', 'memory', 0.8),
      chunk('m5', 'memory', 0.6),
    ]
    const out = c9Filter(chunks)
    assert.deepEqual(
      out.selected.map((c) => c.id),
      ['m2', 'm4', 'm3'],
    )
    assert.deepEqual(
      out.dropped.map((c) => c.id),
      ['m5', 'm1'],
    )
  })

  await testAsync('c9Filter applies top-k and cutoff independently per category', async () => {
    const chunks = [
      chunk('m1', 'memory', 0.9),
      chunk('m2', 'memory', 0.8),
      chunk('k1', 'kv', 0.95),
      chunk('k2', 'kv', 0.2),
      chunk('c1', 'codemap', 0.4),
    ]
    const out = c9Filter(chunks)
    assert.deepEqual(
      out.selected.map((c) => c.id),
      ['m1', 'm2', 'k1', 'c1'],
    )
    assert.deepEqual(
      out.dropped.map((c) => c.id),
      ['k2'],
    )
  })

  await testAsync('c9Filter honors per-category top-k and cutoff overrides', async () => {
    const chunks = [
      chunk('m1', 'memory', 0.9),
      chunk('m2', 'memory', 0.8),
      chunk('m3', 'memory', 0.7),
    ]
    const out = c9Filter(chunks, { memory: { topK: 1, cutoff: 0.85 } })
    assert.deepEqual(
      out.selected.map((c) => c.id),
      ['m1'],
    )
    assert.deepEqual(
      out.dropped.map((c) => c.id),
      ['m2', 'm3'],
    )
  })

  await testAsync('c9Filter on empty input selects nothing with zero injection', async () => {
    const out = c9Filter([])
    assert.deepEqual(out.selected, [])
    assert.deepEqual(out.dropped, [])
    assert.equal(out.injectedTokens, 0)
  })

  await testAsync('c9Filter debits injection overhead in tokens (auditable)', async () => {
    const chunks = [chunk('a', 'memory', 0.9)]
    const out = c9Filter(chunks)
    assert.ok(out.injectedTokens > 0, 'retrieval cost must be debited')
    assert.equal(out.injectedTokens, estimateTokens(buildC9Context(out.selected)))
  })

  await testAsync('buildC9Context injects only auditable chunks (id + score + text)', async () => {
    const selected = [chunk('a', 'memory', 0.9)]
    const ctx = buildC9Context(selected)
    assert.match(ctx, /a/, 'chunk id is auditable')
    assert.match(ctx, /0\.9/, 'chunk score is auditable')
    assert.match(ctx, /chunk-text-a/, 'chunk text is injected')
  })

  // ── WS3 completion: C9 quality-floor signals (never silent on empty) ──
  await testAsync('c9Filter signals ok with null notice on selection', async () => {
    const out = c9Filter([chunk('a', 'memory', 0.9)])
    assert.equal(out.signal, 'ok')
    assert.equal(out.notice, null)
    assert.equal(out.recall, 1)
  })

  await testAsync('c9Filter signals empty-input with fallback notice', async () => {
    const out = c9Filter([])
    assert.equal(out.signal, 'empty-input')
    assert.match(out.notice ?? '', /empty input/)
    assert.equal(out.recall, 1)
  })

  await testAsync('c9Filter signals all-dropped with fallback notice', async () => {
    const out = c9Filter([chunk('a', 'memory', 0.1), chunk('b', 'memory', 0.2)])
    assert.equal(out.signal, 'all-dropped')
    assert.match(out.notice ?? '', /all chunks dropped/)
    assert.deepEqual(out.selected, [])
  })

  await testAsync(
    'c9Filter uses an auditable lexical/relative fallback for relevant low scores',
    async () => {
      const chunks = [
        {
          ...chunk('relevant', 'memory', 0.016),
          text: 'token optimization keeps context relevant',
        },
        { ...chunk('other', 'memory', 0.015), text: 'unrelated deployment notes' },
      ]
      const out = c9Filter(chunks, { query: 'token optimization' })
      assert.deepEqual(
        out.selected.map((item) => item.id),
        ['relevant'],
      )
      assert.ok(out.selected.every((item) => item.score < C9_DEFAULT_CUTOFF))
      assert.equal(out.signal, 'fallback-relative')
      assert.match(out.notice ?? '', /lexical\/relative fallback/)
      assert.match(out.notice ?? '', /remain below cutoff/)
      assert.ok(out.injectedTokens > 0)
    },
  )

  await testAsync(
    'c9Filter rejects a nonsense query instead of injecting low-score junk',
    async () => {
      const out = c9Filter(
        [
          {
            ...chunk('relevant', 'memory', 0.016),
            text: 'token optimization keeps context relevant',
          },
        ],
        undefined,
        'qzxv nonsense query',
      )
      assert.deepEqual(out.selected, [])
      assert.equal(out.injectedTokens, 0)
      assert.equal(out.signal, 'nonsense')
      assert.match(out.notice ?? '', /no lexical overlap/)
      assert.match(out.notice ?? '', /no context was injected/)
    },
  )

  await testAsync('c9Filter recall debits top-k overflow honestly', async () => {
    const chunks = [
      chunk('m1', 'memory', 0.9),
      chunk('m2', 'memory', 0.8),
      chunk('m3', 'memory', 0.7),
      chunk('m4', 'memory', 0.6),
      chunk('m5', 'memory', 0.5),
    ]
    const out = c9Filter(chunks)
    assert.equal(out.selected.length, 3)
    assert.ok(Math.abs(out.recall - 0.6) < 1e-9, `recall 3/5 eligible, got ${out.recall}`)
  })

  // ── C9 contract/preparation boundary ──────────────────────────────────
  await testAsync(
    'prepareC9Context returns a discriminated disabled result for the kill-switch',
    async () => {
      const batch: C9CandidateBatch = {
        query: 'token optimization',
        candidates: [chunk('secret', 'memory', 0.99)],
      }
      const out = prepareC9Context(batch, { env: { PANTHEON_TOKEN_OPT: 'off' } })
      assert.equal(out.enabled, false)
      assert.equal(out.context, '')
      assert.equal(out.telemetry.signal, 'disabled')
      assert.equal(out.telemetry.injectedChars, 0)
      assert.equal(out.telemetry.injectedTokens, 0)
    },
  )

  await testAsync(
    'prepareC9Context applies the normal cutoff and reports auditable counts',
    async () => {
      const out = prepareC9Context({
        query: 'token optimization',
        candidates: [
          { ...chunk('kept', 'memory', 0.9), text: 'token optimization' },
          { ...chunk('dropped', 'memory', 0.29), text: 'old notes' },
        ],
      })
      assert.equal(out.enabled, true)
      assert.match(out.context, /\[memory:kept\|0\.9\]/)
      assert.deepEqual(out.telemetry.counts, { candidates: 2, selected: 1, dropped: 1 })
      assert.equal(out.telemetry.signal, 'ok')
    },
  )

  await testAsync(
    'prepareC9Context allows a relevant low-score fallback and preserves its score',
    async () => {
      const out = prepareC9Context({
        query: 'token optimization',
        candidates: [
          {
            ...chunk('relevant', 'memory', 0.016),
            text: 'token optimization keeps context relevant',
          },
          { ...chunk('other', 'memory', 0.015), text: 'unrelated deployment notes' },
        ],
      })
      assert.equal(out.enabled, true)
      assert.equal(out.telemetry.signal, 'fallback-relative')
      assert.match(out.context, /\[memory:relevant\|0\.016\]/)
      assert.ok(!out.context.includes('0.3'), 'fallback must not rewrite the original score')
      assert.deepEqual(out.telemetry.counts, { candidates: 2, selected: 1, dropped: 1 })
    },
  )

  await testAsync('prepareC9Context does not inject for a nonsense query', async () => {
    const out = prepareC9Context({
      query: 'qzxv nonsense query',
      candidates: [{ ...chunk('junk', 'memory', 0.9), text: 'token optimization context' }],
    })
    assert.equal(out.enabled, true)
    assert.equal(out.context, '')
    assert.equal(out.telemetry.signal, 'nonsense')
    assert.equal(out.telemetry.injectedChars, 0)
    assert.equal(out.telemetry.injectedTokens, 0)
  })

  await testAsync('prepareC9Context does not inject for an empty query', async () => {
    const out = prepareC9Context({ query: '', candidates: [chunk('candidate', 'memory', 0.9)] })
    assert.equal(out.enabled, true)
    assert.equal(out.context, '')
    assert.equal(out.telemetry.signal, 'empty-query')
    assert.deepEqual(out.telemetry.counts, { candidates: 1, selected: 0, dropped: 1 })
    assert.equal(out.telemetry.injectedTokens, 0)
  })

  await testAsync('prepareC9Context does not inject an empty candidate batch', async () => {
    const out = prepareC9Context({ query: 'token optimization', candidates: [] })
    assert.equal(out.enabled, true)
    assert.equal(out.context, '')
    assert.equal(out.telemetry.signal, 'empty-input')
    assert.deepEqual(out.telemetry.counts, { candidates: 0, selected: 0, dropped: 0 })
    assert.equal(out.telemetry.injectedChars, 0)
  })

  await testAsync('prepareC9Context keeps top-k independently for each category', async () => {
    const out = prepareC9Context(
      {
        query: 'memory kv',
        candidates: [
          { ...chunk('m1', 'memory', 0.9), text: 'memory result' },
          { ...chunk('m2', 'memory', 0.8), text: 'memory result' },
          { ...chunk('k1', 'kv', 0.95), text: 'kv result' },
          { ...chunk('k2', 'kv', 0.94), text: 'kv result' },
        ],
      },
      { perCategory: { memory: { topK: 1 }, kv: { topK: 1 } } },
    )
    assert.deepEqual(
      out.context.split('\n').map((line) => line.slice(line.indexOf(':') + 1, line.indexOf('|'))),
      ['m1', 'k1'],
    )
    assert.deepEqual(out.telemetry.counts, { candidates: 4, selected: 2, dropped: 2 })
  })

  await testAsync('prepareC9Context does not mutate the readonly candidate batch', async () => {
    const batch: C9CandidateBatch = {
      query: 'immutable context',
      candidates: Object.freeze([
        Object.freeze({ ...chunk('candidate', 'memory', 0.9), text: 'immutable context' }),
      ]),
    }
    const before = JSON.stringify(batch)
    prepareC9Context(batch)
    assert.equal(JSON.stringify(batch), before)
  })

  await testAsync('C9 telemetry contains metrics only and never injected text', async () => {
    const out = prepareC9Context({
      query: 'private phrase',
      candidates: [{ ...chunk('audited', 'memory', 0.9), text: 'private phrase' }],
    })
    assert.deepEqual(Object.keys(out.telemetry).sort(), [
      'counts',
      'injectedChars',
      'injectedTokens',
      'recall',
      'signal',
    ])
    assert.ok(!JSON.stringify(out.telemetry).includes('private phrase'))
    assert.ok(!('context' in out.telemetry))
    assert.ok(!('text' in out.telemetry))
  })

  // ── 4 meta-tools ceiling + lazy ───────────────────────────────────────
  await testAsync('ALWAYS_ON_TOOLS is exactly the 4 meta-tools (real repo names)', async () => {
    assert.deepEqual([...ALWAYS_ON_TOOLS].sort(), [
      'code_query',
      'kv_search',
      'memory_search',
      'pantheon://resources',
    ])
  })

  await testAsync('classifyTool marks always-on vs lazy (search-first discovery)', async () => {
    assert.equal(classifyTool('memory_search'), 'always-on')
    assert.equal(classifyTool('kv_search'), 'always-on')
    assert.equal(classifyTool('code_query'), 'always-on')
    assert.equal(classifyTool('pantheon://resources'), 'always-on')
    assert.equal(classifyTool('kv_get'), 'lazy')
    assert.equal(classifyTool('memory_recall'), 'lazy')
    assert.equal(classifyTool('context_save'), 'lazy')
    assert.equal(classifyTool('code_neighbors'), 'lazy')
    assert.equal(classifyTool('something-unknown'), 'lazy')
  })

  await testAsync('lazyRoute resolves non-ceiling tools via pantheon-code-mode', async () => {
    const route = lazyRoute('kv_get')
    assert.equal(route.via, 'execute_code_script')
    assert.equal(route.tool, 'kv_get')
  })

  await testAsync('lazyRoute throws on unknown tools (never silently misrouted)', async () => {
    assert.throws(() => lazyRoute('something-unknown'), /unknown tool/)
    assert.ok(isKnownTool('kv_get'), 'kv_get is known via descriptions')
    assert.ok(!isKnownTool('something-unknown'), 'unknown tool is not known')
  })

  // ── Response filtering + truncation ───────────────────────────────────
  await testAsync('filterFields keeps only used MCP fields', async () => {
    const raw = { id: 1, key: 'k', value: 'v', embedding: [0.1, 0.2], rank: 0.9 }
    const out = filterFields(raw, ['id', 'key', 'value'])
    assert.deepEqual(out, { id: 1, key: 'k', value: 'v' })
  })

  await testAsync('filterFields throws on missing required fields (quality floor)', async () => {
    const raw = { id: 1, key: 'k' }
    assert.throws(() => filterFields(raw, ['id', 'key'], ['value']), /missing required fields/)
    const out = filterFields(raw, ['id', 'key'], ['id'])
    assert.deepEqual(out, { id: 1, key: 'k' })
  })

  await testAsync(
    'truncateTurn preserves summary (first) + tail (last) under a strict cap=40',
    async () => {
      const blocks = ['SUMMARY-abc', 'middle-1', 'middle-2', 'middle-3', 'TAIL-xyz']
      const out = truncateTurn(blocks, 40)
      const joined = out.blocks.join('\n')
      assert.ok(out.truncated, 'must report truncation')
      assert.match(joined, /SUMMARY-abc/, 'summary preserved')
      assert.match(joined, /TAIL-xyz/, 'tail preserved')
      assert.ok(joined.length <= 40, `hard cap margin 0, got len=${joined.length}`)
      assert.ok(out.markerChars > 0, 'marker cost must be reported for debiting')
    },
  )

  await testAsync('truncateTurn hard cap=30 is strict even when the tail is sliced', async () => {
    const blocks = ['SUMMARY-abc', 'middle-1', 'middle-2', 'middle-3', 'TAIL-xyz']
    const out = truncateTurn(blocks, 30)
    const joined = out.blocks.join('\n')
    assert.ok(out.truncated, 'must report truncation')
    assert.match(joined, /SUMMARY-abc/, 'summary preserved')
    assert.ok(joined.length <= 30, `hard cap margin 0, got len=${joined.length}`)
    assert.ok(out.markerChars > 0, 'marker cost must be reported for debiting')
  })

  await testAsync('truncateTurn reports markerChars 0 when untruncated', async () => {
    const blocks = ['a', 'b']
    const out = truncateTurn(blocks, 100)
    assert.equal(out.truncated, false)
    assert.deepEqual(out.blocks, blocks)
    assert.equal(out.markerChars, 0)
  })

  // ── Schema compression ────────────────────────────────────────────────
  await testAsync('describeTool returns a slim schema for familiar tools', async () => {
    const slim = describeTool('memory_search')
    const full = describeTool('memory_search', true)
    assert.ok(slim.length < full.length, 'slim must be shorter than full')
    assert.ok(slim.length <= full.length * 0.6, 'slim saves >= 40% of description chars')
    assert.match(slim, /memory_search/, 'slim still names the tool')
  })

  await testAsync('describeTool detail-on-demand restores the full description', async () => {
    const full = describeTool('kv_search', true)
    assert.match(full, /kv_search/, 'full names the tool')
    assert.match(full, /FTS5/, 'full keeps the detail')
    assert.ok(!describeTool('kv_search').includes('FTS5'), 'slim drops the detail')
  })

  // ── WS3 completion: TOTAL overhead (no silently omitted component) ────
  await testAsync(
    'totalOverheadChars sums every component (retrieval+discovery+detail+markers)',
    async () => {
      const total = totalOverheadChars({
        retrievalChars: 10,
        discoveryChars: 20,
        detailChars: 30,
        markerChars: 16,
      })
      assert.equal(total, 76)
      assert.equal(totalOverheadChars(EMPTY_OVERHEAD), 0)
      assert.ok(discoveryOverheadChars('kv_get') > 0, 'lazy discovery is debited')
      assert.ok(fullDetailChars('kv_search') > 0, 'detail-on-demand is debited')
      assert.equal(fullDetailChars('something-unknown'), 0)
    },
  )

  await testAsync('measureLeverFull debits TOTAL overhead; net<=0 disables', async () => {
    const m = measureLeverFull('filter-truncate', 1000, 600, {
      ...EMPTY_OVERHEAD,
      markerChars: 16,
    })
    assert.equal(m.overhead, estimateTokens('x'.repeat(16)))
    assert.equal(m.gross, m.before - m.after)
    assert.equal(m.net, m.gross - m.overhead)
    assert.equal(m.enabled, m.net > 0)
    const losing = measureLeverFull('schema', 100, 95, {
      ...EMPTY_OVERHEAD,
      detailChars: 1000,
    })
    assert.ok(losing.net <= 0, 'overhead above gross must lose')
    assert.equal(losing.enabled, false)
  })

  // ── Tokens-only metering (WS0 extension, no monetary layer) ──────────
  await testAsync('TokenMeter aggregates tokens per phase with NO monetary field', async () => {
    const meter = new TokenMeter()
    meter.record('dispatch', 'hermes', 400, 200)
    meter.record('dispatch', 'apollo', 100, 100)
    const totals = meter.phaseTotals('dispatch')
    assert.equal(totals.input, estimateTokens('x'.repeat(500)))
    assert.equal(totals.output, estimateTokens('x'.repeat(300)))
    assert.ok(!('costUsd' in totals), 'tokens-only: no monetary layer')
    assert.ok(!('usd' in totals), 'tokens-only: no monetary layer')
  })

  await testAsync('measureLever computes gross and NET delta (overhead debited)', async () => {
    const m: LeverMeasurement = measureLever('c9', 1000, 600, 50)
    assert.equal(m.before, estimateTokens('x'.repeat(1000)))
    assert.equal(m.gross, m.before - m.after)
    assert.equal(m.net, m.before - m.after - m.overhead)
    assert.equal(m.enabled, m.net > 0)
  })

  await testAsync(
    'DEFAULT_FLAGS enables every lever; applyGate disables net<=0 WITHOUT removing',
    async () => {
      const allOn = Object.values(DEFAULT_FLAGS)
      assert.ok(allOn.length > 0 && allOn.every((v) => v === true))
      const measurements: LeverMeasurement[] = [
        { name: 'c9', before: 10, after: 5, overhead: 1, gross: 5, net: 4, enabled: true },
        { name: 'toon', before: 10, after: 9, overhead: 5, gross: 1, net: -4, enabled: false },
      ]
      const gated = applyGate(DEFAULT_FLAGS, measurements)
      assert.equal(gated.c9, true)
      assert.equal(gated.toon, false, 'negative net → disabled by flag')
      assert.ok('toon' in gated, 'disabled lever is kept (flag), never removed')
    },
  )

  await testAsync('applyGate contract preserves measured lever flags', async () => {
    const c9 = measureLever('c9', 1000, 600, 50)
    const toon = measureLeverFull('toon', 500, 300, { ...EMPTY_OVERHEAD })
    const losing = measureLeverFull('schema', 100, 95, {
      ...EMPTY_OVERHEAD,
      detailChars: 1000,
    })
    const gated = applyGate(DEFAULT_FLAGS, [c9, toon, losing])
    assert.equal(gated.c9, c9.net > 0)
    assert.equal(gated.toon, toon.net > 0)
    assert.equal(gated.schema, false)
    assert.ok('schema' in gated, 'disabled lever is kept (flag), never removed')
  })

  await testAsync(
    'TOON board-flat payload contract gates toon lever (no overhead enables, overhead>gross disables)',
    async () => {
      const board = {
        taskID: 'ses_child_1',
        alias: 'apo-1',
        agent: 'hermes',
        state: 'completed',
        summary: 'Done: auth router implemented, 12 tests green',
        timestamp: 1787955800816,
      }
      const jsonChars = JSON.stringify(board).length
      const toonChars = toonEncode(board).length
      assert.ok(
        toonChars < jsonChars,
        `TOON must save chars on board-flat, got json=${jsonChars} toon=${toonChars}`,
      )
      const enabled = measureLeverFull('toon', jsonChars, toonChars, { ...EMPTY_OVERHEAD })
      assert.ok(enabled.gross > 0, 'board-flat gross must be positive')
      assert.equal(enabled.enabled, true, 'sem overhead → habilita')
      const gatedOn = applyGate(DEFAULT_FLAGS, [enabled])
      assert.equal(gatedOn.toon, true)
      const losing = measureLeverFull('toon', jsonChars, toonChars, {
        ...EMPTY_OVERHEAD,
        detailChars: 1000,
      })
      assert.ok(losing.net <= 0, `overhead>gross must lose, got net=${losing.net}`)
      assert.equal(losing.enabled, false, 'overhead>gross → desabilita')
      const gatedOff = applyGate(DEFAULT_FLAGS, [losing])
      assert.equal(gatedOff.toon, false)
      assert.ok('toon' in gatedOff, 'disabled lever is kept (flag), never removed')
    },
  )

  // ── Kill-switch ───────────────────────────────────────────────────────
  await testAsync('isTokenOptEnabled honors PANTHEON_TOKEN_OPT=off', async () => {
    assert.equal(isTokenOptEnabled({ PANTHEON_TOKEN_OPT: 'off' }), false)
    assert.equal(isTokenOptEnabled({}), true)
    assert.equal(isTokenOptEnabled(), true)
  })

  await testAsync('LeverName covers all five WS3 levers', async () => {
    const names: LeverName[] = ['c9', 'tools-ceiling', 'filter-truncate', 'toon', 'schema']
    assert.equal(names.length, 5)
    for (const n of names) assert.equal(typeof DEFAULT_FLAGS[n], 'boolean')
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

void main()
