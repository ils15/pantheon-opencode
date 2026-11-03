/**
 * Tests for the TUI cost summary — `queryCostSummary` and its bounded RPC
 * projection. This is the `/quota` panel's read-only view of the same
 * `opencode.db` ledger `pantheon_cost` reports on, so it must hold the SAME
 * semantics: V1/V2 table families merge, an unknown model is never priced at
 * zero, a mixed agent shows its priced part, and a ledger that exists but
 * yields no attributable tokens is diagnosed, never rendered as empty.
 *
 * Scope, deliberately narrow so it does not restate cost-command.test.ts:
 *   1. totals + per-agent rows over the last-N-days, priced from an injected
 *      catalog snapshot (no network, no disk cache);
 *   2. V1, V2 and migrated ledgers read and merged without double counting;
 *   3. partial pricing (unknown model, missing cache rate) and the projection's
 *      `partial` status;
 *   4. rolling-window bounds, `total`, future-row exclusion, coverage/partial;
 *   5. the unreadable-ledger diagnosis (the UNSUPPORTED analogue) at projection;
 *   6. projection hygiene: sanitised agent labels, agent cap, sorted rows.
 *
 * Run with: npx tsx tests/pantheon/cost-summary.test.ts
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { queryCostSummary } from '../../src/plugins/tui/src/cost-data.ts'
import {
  MAX_COST_AGENTS,
  projectCostSummaryResult,
} from '../../src/plugins/tui/src/cost-summary-contract.ts'
import type { ModelPrice, PricingSnapshot } from '../../src/plugins/tui/src/model-pricing.ts'

const NOW = Date.parse('2026-10-28T12:00:00.000Z')
const DAY = 86_400_000
const HOUR = 3_600_000
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
  source?: 'message' | 'session_message'
  at?: number
  type?: string
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
    const at = row.at ?? NOW
    const source = row.source ?? (family === 'v2' ? 'session_message' : 'message')
    const payload = row.malformed
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
    if (source === 'message') {
      // A V1 assistant row carries the role in the payload; a malformed payload
      // is stored as-is, exactly like a broken write in a real database.
      const data = row.malformed
        ? payload
        : JSON.stringify({ role: row.type ?? 'assistant', ...JSON.parse(payload) })
      db.prepare(
        'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
      ).run(`v1_${seq}`, 'ses_private', at, data)
    } else {
      db.prepare(
        'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(`v2_${seq}`, 'ses_private', row.type ?? 'assistant', seq, at, at, payload)
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
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-cost-summary-'))
  return { dir, path: join(dir, 'opencode.db') }
}

type AgentRow = {
  agent: string
  tokensInput: number
  tokensOutput: number
  tokensCacheRead: number
  tokensCacheWrite: number
  tokensTotal: number
  estimatedUsd?: number
  pricingComplete: boolean
  unpricedReason?: string
}

function agent(result: { agents: readonly AgentRow[] }, name: string): AgentRow {
  const row = result.agents.find((entry) => entry.agent === name)
  assert.ok(row, `agent row ${name} missing from ${JSON.stringify(result.agents)}`)
  return row
}

const prices = createPricing({
  'acme/alpha': {
    inputPerMTok: 1,
    outputPerMTok: 2,
    cacheReadPerMTok: 0.25,
    cacheWritePerMTok: 0.5,
  },
  'other/beta': { inputPerMTok: 3, outputPerMTok: 4, cacheReadPerMTok: 1, cacheWritePerMTok: 2 },
})

async function main(): Promise<void> {
  await test('prices v1, v2 and migrated ledgers per agent from the injected catalog', async () => {
    for (const family of ['v1', 'v2', 'migrated'] as const) {
      const { dir, path } = tempDb()
      try {
        const rows: Row[] = [
          {
            source: 'message',
            agent: 'zeus',
            provider: 'acme',
            model: 'alpha',
            tokens: { input: 1000, output: 2000, cacheRead: 100, cacheWrite: 50 },
          },
          {
            source: 'session_message',
            agent: 'hermes',
            provider: 'other',
            model: 'beta',
            tokens: { input: 500, output: 1500 },
          },
        ]
        fixture(
          path,
          family,
          family === 'migrated' ? rows : rows.map((row) => ({ ...row, source: undefined })),
        )
        const result = await queryCostSummary(path, 'total', { now: NOW, pricing: prices })
        assert.equal(result.rows, 2, family)
        assert.equal(result.agents.length, 2, family)
        assert.equal(result.partial, false, family)
        assert.equal(result.pricing.status, 'complete', family)
        // (1000×1 + 2000×2 + 100×0.25 + 50×0.5) / 1e6
        assert.ok(Math.abs((agent(result, 'zeus').estimatedUsd ?? 0) - 0.00505) < 1e-12, family)
        assert.equal(agent(result, 'zeus').pricingComplete, true, family)
        // (500×3 + 1500×4) / 1e6
        assert.ok(Math.abs((agent(result, 'hermes').estimatedUsd ?? 0) - 0.0075) < 1e-12, family)
        assert.equal(agent(result, 'zeus').tokensTotal, 3000, family)
        assert.deepEqual(result.totals, {
          input: 1500,
          output: 3500,
          cacheRead: 100,
          cacheWrite: 50,
          total: 5000,
        })
        const projected = projectCostSummaryResult(result)
        assert.equal(projected.status, 'available', family)
        if (projected.status === 'unavailable') return
        assert.equal(projected.pricing.billed, false, family)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  await test('an unknown model is never priced at zero and a mixed agent keeps its priced part', async () => {
    const { dir, path } = tempDb()
    try {
      fixture(path, 'v1', [
        {
          agent: 'zeus',
          provider: 'acme',
          model: 'alpha',
          tokens: { input: 1000, output: 1000 },
        },
        {
          agent: 'zeus',
          provider: 'acme',
          model: 'unheard-of',
          tokens: { input: 7000, output: 0 },
        },
        {
          agent: 'hermes',
          provider: 'acme',
          model: 'unheard-of',
          tokens: { input: 100, output: 100 },
        },
      ])
      const result = await queryCostSummary(path, 'total', { now: NOW, pricing: prices })
      // The mixed agent shows only the money its priced model accounts for, and
      // the unpriced model's tokens stay measured in the token columns.
      const zeus = agent(result, 'zeus')
      // (1000×1 + 1000×2)/1e6 — the priced part only.
      assert.ok(Math.abs((zeus.estimatedUsd ?? 0) - 0.003) < 1e-12)
      assert.equal(zeus.pricingComplete, false)
      assert.equal(zeus.tokensTotal, 9000)
      assert.equal(agent(result, 'hermes').estimatedUsd, undefined)
      assert.equal(agent(result, 'hermes').unpricedReason, 'unknown-model')
      assert.equal(result.pricing.status, 'partial')
      assert.equal(result.pricing.unpricedModels, 2)
      assert.ok(Math.abs((result.pricing.estimatedUsd ?? 0) - 0.003) < 1e-12)
      const projected = projectCostSummaryResult(result)
      assert.equal(projected.status, 'partial')
      if (projected.status === 'unavailable') return
      assert.equal(projected.pricing.status, 'partial')
      assert.equal(projected.pricing.unpricedModels, 2)
      assert.equal(projected.pricing.billed, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('cache tokens with no catalog rate leave the row unpriced, not free', async () => {
    const { dir, path } = tempDb()
    try {
      fixture(path, 'v1', [
        {
          agent: 'zeus',
          provider: 'no-cache-rate',
          model: 'alpha',
          tokens: { input: 100, output: 100, cacheRead: 5000 },
        },
      ])
      const limited = createPricing({
        'no-cache-rate/alpha': { inputPerMTok: 1, outputPerMTok: 1 },
      })
      const result = await queryCostSummary(path, 'total', { now: NOW, pricing: limited })
      const zeus = agent(result, 'zeus')
      assert.equal(zeus.estimatedUsd, undefined)
      assert.equal(zeus.unpricedReason, 'missing-cache-price')
      assert.equal(zeus.tokensCacheRead, 5000)
      assert.equal(result.pricing.status, 'unavailable')
      assert.equal(result.pricing.estimatedUsd, undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('rolling windows bound both sides and total has no lower age cap', async () => {
    const { dir, path } = tempDb()
    try {
      fixture(path, 'v1', [
        {
          agent: 'zeus',
          provider: 'acme',
          model: 'alpha',
          at: NOW - 8 * DAY,
          tokens: { input: 10, output: 0 },
        },
        {
          agent: 'zeus',
          provider: 'acme',
          model: 'alpha',
          at: NOW - 1 * DAY,
          tokens: { input: 20, output: 0 },
        },
        {
          agent: 'hermes',
          provider: 'acme',
          model: 'alpha',
          at: NOW + DAY,
          tokens: { input: 40, output: 0 },
        },
      ])
      const week = await queryCostSummary(path, '7d', { now: NOW, pricing: prices })
      assert.deepEqual(week.totals, {
        input: 20,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 20,
      })
      assert.equal(week.rows, 1)
      const total = await queryCostSummary(path, 'total', { now: NOW, pricing: prices })
      // Future-dated rows are excluded from every period, including `total`.
      assert.equal(total.totals.input, 30)
      assert.equal(total.rows, 2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('coverage start reflects the ledger and a short database marks the window partial', async () => {
    const { dir, path } = tempDb()
    try {
      const oldest = NOW - 3 * DAY
      fixture(path, 'v1', [
        {
          agent: 'zeus',
          provider: 'acme',
          model: 'alpha',
          at: oldest,
          tokens: { input: 5, output: 0 },
        },
        {
          agent: 'zeus',
          provider: 'acme',
          model: 'alpha',
          at: NOW - HOUR,
          tokens: { input: 5, output: 0 },
        },
      ])
      const week = await queryCostSummary(path, '7d', { now: NOW, pricing: prices })
      assert.equal(week.partial, true)
      assert.equal(week.coverageStart, new Date(oldest).toISOString().slice(0, 10))
      assert.equal(week.coverageStartAt, oldest)
      assert.equal(projectCostSummaryResult(week).status, 'partial')
      const total = await queryCostSummary(path, 'total', { now: NOW, pricing: prices })
      assert.equal(total.partial, false)
      assert.equal(projectCostSummaryResult(total).status, 'available')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('agentless assistant rows are excluded from attribution but counted as scanned', async () => {
    const { dir, path } = tempDb()
    try {
      fixture(path, 'v1', [
        {
          agent: 'zeus',
          provider: 'acme',
          model: 'alpha',
          tokens: { input: 30, output: 0 },
        },
        {
          agent: undefined,
          provider: 'acme',
          model: 'alpha',
          tokens: { input: 90, output: 0 },
        },
      ])
      const result = await queryCostSummary(path, 'total', { now: NOW, pricing: prices })
      assert.equal(result.rows, 1)
      assert.equal(result.agents.length, 1)
      assert.equal(result.totals.input, 30)
      assert.equal(result.assistantRows, 2)
      assert.equal(result.scanned, 2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('an empty window is a successful empty report, not a diagnosis', async () => {
    const { dir, path } = tempDb()
    try {
      fixture(path, 'v1', [
        {
          agent: 'zeus',
          provider: 'acme',
          model: 'alpha',
          at: NOW - 40 * DAY,
          tokens: { input: 10, output: 0 },
        },
      ])
      const result = await queryCostSummary(path, '7d', { now: NOW, pricing: prices })
      assert.equal(result.rows, 0)
      assert.equal(result.agents.length, 0)
      assert.equal(result.scanned, 0)
      assert.equal(result.pricing.status, 'empty')
      const projected = projectCostSummaryResult(result)
      assert.equal(projected.status, 'available')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('a scanned ledger with no assistant row projects to an unsupported diagnosis', async () => {
    const { dir, path } = tempDb()
    try {
      fixture(path, 'v1', [
        { type: 'user', agent: 'zeus', provider: 'acme', model: 'alpha', tokens: { input: 10 } },
      ])
      const result = await queryCostSummary(path, 'total', { now: NOW, pricing: prices })
      assert.equal(result.scanned, 1)
      assert.equal(result.assistantRows, 0)
      assert.deepEqual(projectCostSummaryResult(result), {
        status: 'unavailable',
        reason: 'ledger_unsupported',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('assistant rows with an agent but no token payload diagnose unsupported', async () => {
    const { dir, path } = tempDb()
    try {
      fixture(path, 'v1', [
        { agent: 'zeus', provider: 'acme', model: 'alpha', tokens: { input: 0, output: 0 } },
      ])
      const result = await queryCostSummary(path, 'total', { now: NOW, pricing: prices })
      assert.equal(result.assistantRows, 1)
      assert.equal(result.rows, 1)
      assert.equal(result.totals.total, 0)
      assert.deepEqual(projectCostSummaryResult(result), {
        status: 'unavailable',
        reason: 'ledger_unsupported',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('cache-only usage is still usage and must not diagnose unsupported', async () => {
    const { dir, path } = tempDb()
    try {
      fixture(path, 'v1', [
        {
          agent: 'zeus',
          provider: 'acme',
          model: 'alpha',
          tokens: { input: 0, output: 0, cacheRead: 4000 },
        },
      ])
      const result = await queryCostSummary(path, 'total', { now: NOW, pricing: prices })
      assert.equal(result.totals.cacheRead, 4000)
      assert.notEqual(projectCostSummaryResult(result).status, 'unavailable')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('a missing database and a foreign schema reject instead of rendering', async () => {
    const missing = await queryCostSummary(
      join(tmpdir(), 'pantheon-cost-summary-missing', 'opencode.db'),
      '7d',
      { now: NOW, pricing: prices },
    ).then(
      () => false,
      (error: unknown) => error instanceof Error,
    )
    assert.equal(missing, true, 'missing db must reject')

    const { dir, path } = tempDb()
    try {
      const db = new DatabaseSync(path)
      db.exec('CREATE TABLE unrelated (id INTEGER)')
      db.close()
      await assert.rejects(
        () => queryCostSummary(path, '7d', { now: NOW, pricing: prices }),
        /incompatible opencode\.db schema/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('the projection caps agents, sorts by tokens and sanitises labels', async () => {
    const { dir, path } = tempDb()
    try {
      const rows: Row[] = []
      for (let index = 0; index < MAX_COST_AGENTS + 4; index += 1) {
        rows.push({
          agent: `agent-${String(index).padStart(2, '0')}`,
          provider: 'acme',
          model: 'alpha',
          tokens: { input: MAX_COST_AGENTS + 4 - index, output: 0 },
        })
      }
      // The unsanitary label sorts first, so the cap keeps it and the test can
      // assert both the sanitisation and the truncation in one ledger.
      rows.push({
        agent: 'bad agent with spaces',
        provider: 'acme',
        model: 'alpha',
        tokens: { input: 9999, output: 0 },
      })
      fixture(path, 'v1', rows)
      const result = await queryCostSummary(path, 'total', { now: NOW, pricing: prices })
      assert.equal(result.agents.length, MAX_COST_AGENTS + 5)
      const projected = projectCostSummaryResult(result)
      assert.equal(projected.status, 'partial')
      if (projected.status === 'unavailable') return
      assert.equal(projected.truncated, true)
      assert.equal(projected.agents.length, MAX_COST_AGENTS)
      assert.equal(projected.agents[0]?.agent, 'unknown')
      assert.equal(projected.agents[0]?.total, 9999)
      assert.ok(
        projected.agents.every(
          (row, index) => index === 0 || (projected.agents[index - 1]?.total ?? 0) >= row.total,
        ),
      )
      assert.ok(projected.agents.some((row) => row.agent === 'agent-00'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('malformed payloads degrade instead of raising', async () => {
    const { dir, path } = tempDb()
    try {
      fixture(path, 'v1', [
        {
          agent: 'zeus',
          provider: 'acme',
          model: 'alpha',
          tokens: { input: 12, output: 0 },
        },
        { malformed: true },
      ])
      const result = await queryCostSummary(path, 'total', { now: NOW, pricing: prices })
      assert.equal(result.rows, 1)
      assert.equal(result.totals.input, 12)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

main()
  .then(() => {
    const failures = results.filter((result) => result.error !== undefined)
    for (const result of results) {
      if (result.error === undefined) {
        process.stdout.write(`ok - ${result.name}\n`)
        continue
      }
      process.stdout.write(`fail - ${result.name}\n      ${result.error}\n`)
    }
    process.stdout.write(
      `cost-summary: ${results.length - failures.length}/${results.length} passed\n`,
    )
    if (failures.length > 0) process.exit(1)
  })
  .catch((error: unknown) => {
    process.stdout.write(`cost-summary harness failed: ${String(error)}\n`)
    process.exit(1)
  })
