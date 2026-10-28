import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  type ActiveContextCostInput,
  estimateActiveContextCost,
  queryUsageHistory,
  type UsageHistoryPeriod,
} from '../../src/pantheon/cost-command.ts'
import type { ModelPrice, PricingSnapshot } from '../../src/pantheon/model-pricing.ts'

const NOW = Date.parse('2026-10-28T12:00:00.000Z')
const DAY = 86_400_000
const results: { name: string; error?: string }[] = []

async function test(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
    results.push({ name })
  } catch (error) {
    results.push({ name, error: error instanceof Error ? error.message : String(error) })
  }
}

type Row = {
  source: 'message' | 'session_message'
  at: number
  role?: string
  agent?: string
  provider?: string
  model?: string
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  malformed?: boolean
}

function fixture(path: string, family: 'v1' | 'v2' | 'migrated', rows: readonly Row[]): void {
  const db = new DatabaseSync(path)
  if (family !== 'v2') {
    db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  }
  if (family !== 'v1') {
    db.exec(
      'CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)',
    )
  }
  let seq = 0
  for (const row of rows) {
    seq += 1
    const data = row.malformed
      ? '{not valid json'
      : JSON.stringify({
          ...(row.agent === undefined ? {} : { agent: row.agent }),
          model: { providerID: row.provider, id: row.model },
          tokens: {
            input: row.tokens?.input ?? 0,
            output: row.tokens?.output ?? 0,
            cache: {
              read: row.tokens?.cacheRead ?? 0,
              write: row.tokens?.cacheWrite ?? 0,
            },
          },
        })
    if (row.source === 'message') {
      db.prepare(
        'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
      ).run(
        `v1_${seq}`,
        'ses_test',
        row.at,
        row.malformed
          ? data
          : JSON.stringify({ role: row.role ?? 'assistant', ...JSON.parse(data) }),
      )
    } else {
      db.prepare(
        'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(`v2_${seq}`, 'ses_test', row.role ?? 'assistant', seq, row.at, row.at, data)
    }
  }
  db.close()
}

function createPricing(entries: Record<string, ModelPrice>): PricingSnapshot {
  const index = new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]))
  const modelIndex = new Map<string, ModelPrice[]>()
  for (const [key, value] of index) {
    const model = key.slice(key.indexOf('/') + 1)
    modelIndex.set(model, [...(modelIndex.get(model) ?? []), value])
  }
  return { index, modelIndex, stale: false, refreshing: false, fetchedAt: NOW }
}

function tempDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-usage-history-'))
  return { dir, path: join(dir, 'opencode.db') }
}

const prices = createPricing({
  'acme/alpha': {
    inputPerMTok: 1,
    outputPerMTok: 2,
    cacheReadPerMTok: 0.25,
    cacheWritePerMTok: 0.5,
  },
  'other/beta': {
    inputPerMTok: 3,
    outputPerMTok: 4,
    cacheReadPerMTok: 1,
    cacheWritePerMTok: 2,
  },
})

async function main(): Promise<void> {
  await test('reads V1, V2, and migrated ledgers and includes valid agent-less assistant rows', async () => {
    for (const family of ['v1', 'v2', 'migrated'] as const) {
      const { dir, path } = tempDb()
      try {
        const rows: Row[] = [
          {
            source: 'message',
            role: 'assistant',
            at: NOW,
            provider: 'acme',
            model: 'alpha',
            tokens: { input: 10, output: 2, cacheRead: 4, cacheWrite: 1 },
          },
          {
            source: 'session_message',
            role: 'assistant',
            at: NOW,
            agent: 'worker',
            provider: 'other',
            model: 'beta',
            tokens: { input: 5, output: 3 },
          },
        ].filter(
          (row) =>
            family === 'migrated' ||
            row.source === (family === 'v1' ? 'message' : 'session_message'),
        )
        fixture(path, family, rows)
        const result = await queryUsageHistory(path, 'total', { now: NOW, pricing: prices })
        assert.equal(result.rows, family === 'migrated' ? 2 : 1)
        assert.equal(result.models.length, family === 'migrated' ? 2 : 1)
        assert.equal(result.partial, false)
        assert.equal(result.pricing.status, 'complete')
        if (family === 'v1') {
          assert.equal(result.models[0]?.agentlessRows, 1)
          assert.equal(result.models[0]?.providerID, 'acme')
          assert.equal(result.models[0]?.modelID, 'alpha')
          assert.deepEqual(result.totals, {
            input: 10,
            output: 2,
            cacheRead: 4,
            cacheWrite: 1,
            total: 12,
          })
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  await test('usage periods exclude future rows while rolling windows preserve exact cutoff semantics', async () => {
    const { dir, path } = tempDb()
    try {
      fixture(path, 'migrated', [
        {
          source: 'message',
          at: NOW - 30 * DAY - 1,
          provider: 'acme',
          model: 'alpha',
          tokens: { input: 99 },
        },
        {
          source: 'message',
          at: NOW - 30 * DAY,
          provider: 'acme',
          model: 'alpha',
          tokens: { input: 4 },
        },
        {
          source: 'message',
          at: NOW - 15 * DAY,
          provider: 'acme',
          model: 'alpha',
          tokens: { input: 3 },
        },
        {
          source: 'message',
          at: NOW - 7 * DAY - 1,
          provider: 'acme',
          model: 'alpha',
          tokens: { input: 2 },
        },
        {
          source: 'message',
          at: NOW - 7 * DAY,
          provider: 'acme',
          model: 'alpha',
          tokens: { input: 1 },
        },
        {
          source: 'message',
          at: NOW + DAY,
          provider: 'acme',
          model: 'alpha',
          tokens: { input: 1_000 },
        },
        {
          source: 'session_message',
          at: NOW + DAY,
          provider: 'acme',
          model: 'alpha',
          tokens: { input: 2_000 },
        },
      ])
      const expected: Record<UsageHistoryPeriod, number> = {
        '7d': 1,
        '15d': 6,
        '30d': 10,
        total: 109,
      }
      const expectedRows: Record<UsageHistoryPeriod, number> = {
        '7d': 1,
        '15d': 3,
        '30d': 4,
        total: 5,
      }
      for (const period of ['7d', '15d', '30d', 'total'] as const) {
        const result = await queryUsageHistory(path, period, { now: NOW, pricing: prices })
        assert.equal(result.totals.input, expected[period], period)
        assert.equal(result.rows, expectedRows[period], period)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('future-only ledgers have no usage coverage or rolling partial warning', async () => {
    const { dir, path } = tempDb()
    try {
      fixture(path, 'migrated', [
        {
          source: 'message',
          at: NOW + DAY,
          provider: 'acme',
          model: 'alpha',
          tokens: { input: 1_000 },
        },
        {
          source: 'session_message',
          at: NOW + DAY,
          provider: 'other',
          model: 'beta',
          tokens: { input: 2_000 },
        },
      ])
      const result = await queryUsageHistory(path, '7d', { now: NOW, pricing: prices })
      assert.equal(result.rows, 0)
      assert.equal(result.coverageStartAt, null)
      assert.equal(result.coverageStart, null)
      assert.equal(result.partial, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('Total has no hidden history cap and reports actual coverage start', async () => {
    const { dir, path } = tempDb()
    try {
      const oldest = NOW - 500 * DAY
      fixture(path, 'v2', [
        {
          source: 'session_message',
          at: oldest,
          provider: 'acme',
          model: 'alpha',
          tokens: { input: 7 },
        },
        {
          source: 'session_message',
          at: NOW,
          provider: 'acme',
          model: 'alpha',
          tokens: { input: 2 },
        },
      ])
      const result = await queryUsageHistory(path, 'total', { now: NOW, pricing: prices })
      assert.equal(result.totals.input, 9)
      assert.equal(result.coverageStartAt, oldest)
      assert.equal(result.coverageStart, new Date(oldest).toISOString().slice(0, 10))
      assert.equal(result.partial, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('a covered window with no assistant usage is empty, not unpriced', async () => {
    const { dir, path } = tempDb()
    try {
      fixture(path, 'v1', [
        {
          source: 'message',
          at: NOW - 9 * DAY,
          provider: 'acme',
          model: 'alpha',
          tokens: { input: 5 },
        },
      ])
      const result = await queryUsageHistory(path, '7d', { now: NOW, pricing: prices })
      assert.equal(result.rows, 0)
      assert.deepEqual(result.buckets, [])
      assert.equal(result.pricing.status, 'empty')
      assert.equal(result.partial, false)
      assert.notEqual(result.coverageStart, null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('reports incomplete rolling coverage and UTC daily/model buckets', async () => {
    const { dir, path } = tempDb()
    try {
      fixture(path, 'migrated', [
        {
          source: 'message',
          at: NOW - 9 * DAY,
          provider: 'acme',
          model: 'alpha',
          tokens: { input: 6 },
        },
        {
          source: 'session_message',
          at: NOW,
          provider: 'other',
          model: 'beta',
          tokens: { output: 3 },
        },
      ])
      const short = await queryUsageHistory(path, '7d', { now: NOW, pricing: prices })
      const longer = await queryUsageHistory(path, '15d', { now: NOW, pricing: prices })
      assert.equal(short.partial, false)
      assert.equal(longer.partial, true)
      assert.equal(longer.coverageStart, new Date(NOW - 9 * DAY).toISOString().slice(0, 10))
      assert.equal(longer.buckets.at(-1)?.date, '2026-10-28')
      assert.deepEqual(
        longer.models.map(({ providerID, modelID }) => [providerID, modelID]),
        [
          ['acme', 'alpha'],
          ['other', 'beta'],
        ],
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('excludes malformed and non-assistant rows, but retains valid rows without model metadata', async () => {
    const { dir, path } = tempDb()
    try {
      fixture(path, 'v2', [
        { source: 'session_message', role: 'assistant', at: NOW, tokens: { input: 5 } },
        {
          source: 'session_message',
          role: 'assistant',
          at: NOW,
          provider: 'acme',
          model: 'alpha',
          tokens: { input: 1 },
        },
        {
          source: 'session_message',
          role: 'user',
          at: NOW - 2 * DAY,
          provider: 'acme',
          model: 'alpha',
          tokens: { input: 90 },
        },
        { source: 'session_message', role: 'assistant', at: NOW - 3 * DAY, malformed: true },
      ])
      const result = await queryUsageHistory(path, 'total', { now: NOW, pricing: prices })
      assert.equal(result.rows, 2)
      assert.equal(result.totals.input, 6)
      assert.equal(result.coverageStartAt, NOW)
      assert.ok(
        result.models.some(
          (model) => model.providerID === 'unknown' && model.modelID === 'unknown',
        ),
      )
      assert.equal(result.pricing.status, 'partial')
      assert.equal(result.pricing.complete, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('empty and unpriced ledgers expose honest pricing states', async () => {
    const emptyDb = tempDb()
    const unknownDb = tempDb()
    try {
      fixture(emptyDb.path, 'v1', [])
      fixture(unknownDb.path, 'v1', [
        { source: 'message', at: NOW, provider: 'missing', model: 'model', tokens: { input: 5 } },
      ])
      const empty = await queryUsageHistory(emptyDb.path, 'total', { now: NOW, pricing: prices })
      const unknown = await queryUsageHistory(unknownDb.path, 'total', {
        now: NOW,
        pricing: prices,
      })
      assert.equal(empty.pricing.status, 'empty')
      assert.equal(empty.pricing.estimatedUsd, undefined)
      assert.equal(empty.coverageStart, null)
      assert.equal(unknown.pricing.status, 'unavailable')
      assert.equal(unknown.pricing.estimatedUsd, undefined)
      assert.equal(unknown.models[0]?.estimatedUsd, undefined)
    } finally {
      rmSync(emptyDb.dir, { recursive: true, force: true })
      rmSync(unknownDb.dir, { recursive: true, force: true })
    }
  })

  await test('uses offline cached pricing only and leaves the SQLite database unchanged', async () => {
    const { dir, path } = tempDb()
    try {
      fixture(path, 'v1', [
        { source: 'message', at: NOW, provider: 'acme', model: 'alpha', tokens: { input: 5 } },
      ])
      const before = readFileSync(path)
      let fetchCalls = 0
      const result = await queryUsageHistory(path, 'total', {
        now: NOW,
        pricingOptions: {
          cachePath: join(dir, 'absent-pricing-cache.json'),
          fetchImpl: async () => {
            fetchCalls += 1
            throw new Error('network must not be touched')
          },
        },
      })
      assert.equal(fetchCalls, 0)
      assert.equal(result.pricing.status, 'unavailable')
      assert.deepEqual(readFileSync(path), before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('active-context estimate is explicitly pre-cache input-price and never billed', async () => {
    const input: ActiveContextCostInput = {
      providerID: 'acme',
      modelID: 'alpha',
      contextTokens: 12_000,
    }
    const result = estimateActiveContextCost({ ...input, cost: 999 } as ActiveContextCostInput, {
      pricing: prices,
    })
    assert.equal(result.status, 'estimated')
    assert.equal(result.estimatedUsd, 0.012)
    assert.equal(result.billed, false)
    assert.equal(result.basis, 'pre-cache-context-tokens-times-input-price')
    assert.equal(result.cacheDiscountApplied, false)
    assert.notEqual(result.estimatedUsd, 999)
    assert.equal('actualCostUsd' in result, false)
  })

  await test('active-context estimate ignores any displayed cache percentage', async () => {
    const input: ActiveContextCostInput = {
      providerID: 'acme',
      modelID: 'alpha',
      contextTokens: 12_000,
    }
    const baseline = estimateActiveContextCost(input, { pricing: prices })
    const withCacheMetric = estimateActiveContextCost(
      { ...input, cachePercent: 97 } as ActiveContextCostInput,
      { pricing: prices },
    )
    assert.deepEqual(withCacheMetric, baseline)
    assert.equal(withCacheMetric.estimatedUsd, 0.012)
  })

  await test('active-context estimate is unavailable for missing identity, unknown price, or invalid tokens', async () => {
    const missingModel = estimateActiveContextCost(
      { providerID: 'acme', modelID: null, contextTokens: 12_000 },
      { pricing: prices },
    )
    const unknownPrice = estimateActiveContextCost(
      { providerID: 'acme', modelID: 'missing', contextTokens: 12_000 },
      { pricing: prices },
    )
    const invalidTokens = [null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((contextTokens) =>
      estimateActiveContextCost(
        { providerID: 'acme', modelID: 'alpha', contextTokens } as ActiveContextCostInput,
        { pricing: prices },
      ),
    )
    assert.equal(missingModel.status, 'unavailable')
    assert.equal(missingModel.reason, 'missing-model-identity')
    assert.equal(unknownPrice.status, 'unavailable')
    assert.equal(unknownPrice.reason, 'unknown-model')
    for (const result of invalidTokens) {
      assert.equal(result.status, 'unavailable')
      assert.equal(result.reason, 'invalid-context-token-count')
      assert.equal(result.estimatedUsd, undefined)
    }
  })

  await test('active-context estimate never fetches missing cached pricing', async () => {
    const { dir } = tempDb()
    let fetchCalls = 0
    try {
      const result = estimateActiveContextCost(
        { providerID: 'acme', modelID: 'alpha', contextTokens: 12_000 },
        {
          pricingOptions: {
            cachePath: join(dir, 'missing-model-price-cache.json'),
            fetchImpl: async () => {
              fetchCalls += 1
              throw new Error('active-context estimates must not fetch pricing')
            },
          },
        },
      )
      assert.equal(result.status, 'unavailable')
      assert.equal(result.reason, 'no-pricing')
      assert.equal(fetchCalls, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const failed = results.filter((result) => result.error)
  for (const result of results) {
    console.log(
      `${result.error ? '❌' : '✅'} ${result.name}${result.error ? `: ${result.error}` : ''}`,
    )
  }
  if (failed.length > 0) process.exitCode = 1
}

void main()
