/**
 * Tests for the Cost Tracker (Wave 4, PR #46) — JSONL cost ledger for
 * background delegations.
 *
 * record() appends one JSON line to `.pantheon/costs/delegations.jsonl`
 * (appendFile; the parent directory is created on first write). list()
 * returns parsed records, optionally filtered by sessionID. summary()
 * aggregates totals across ALL records in the ledger. A missing file is
 * an empty ledger — list() → [], summary() → zeros, never a crash.
 *
 * Run with: npx tsx tests/pantheon/cost-tracker.test.ts
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type CostRecord, createCostTracker } from '../../src/pantheon/cost-tracker.ts'

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

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'pantheon-costs-'))
}

function entry(overrides: Partial<CostRecord>): CostRecord {
  return {
    taskId: 'ses_child_1',
    agent: 'hermes',
    model: 'opencode/deepseek-v4-flash',
    tokensInput: 1000,
    tokensOutput: 500,
    costUsd: 0.001,
    timestamp: '2026-08-11T10:00:00.000Z',
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  await testAsync(
    'record appends one JSON line per call; file created on first write',
    async () => {
      const dir = freshDir()
      try {
        const filePath = join(dir, 'costs', 'delegations.jsonl')
        const tracker = createCostTracker({ filePath })
        await tracker.record(entry({ taskId: 'a' }))
        await tracker.record(entry({ taskId: 'b' }))

        assert.ok(existsSync(filePath), 'ledger file exists after records')
        const lines = readFileSync(filePath, 'utf8').trim().split('\n')
        assert.equal(lines.length, 2, 'one JSON line per record')
        const parsed = JSON.parse(lines[0] ?? '') as CostRecord
        assert.equal(parsed.taskId, 'a')
        assert.equal(parsed.agent, 'hermes')
        assert.equal(parsed.costUsd, 0.001)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'list(sessionID?) filters the ledger by session; no arg returns all',
    async () => {
      const dir = freshDir()
      try {
        const tracker = createCostTracker({ filePath: join(dir, 'delegations.jsonl') })
        await tracker.record(entry({ sessionID: 'ses_root', taskId: '1' }))
        await tracker.record(entry({ sessionID: 'ses_root', taskId: '2' }))
        await tracker.record(entry({ sessionID: 'ses_other', taskId: '3' }))

        const all = await tracker.list()
        assert.equal(all.length, 3, 'list() returns every record')
        const root = await tracker.list('ses_root')
        assert.equal(root.length, 2, 'list(sessionID) filters by session')
        assert.ok(root.every((r) => r.sessionID === 'ses_root'))
        const none = await tracker.list('ses_missing')
        assert.equal(none.length, 0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  await testAsync('summary aggregates count, cost and token totals', async () => {
    const dir = freshDir()
    try {
      const tracker = createCostTracker({ filePath: join(dir, 'delegations.jsonl') })
      await tracker.record(entry({ tokensInput: 100, tokensOutput: 50, costUsd: 0.001 }))
      await tracker.record(entry({ tokensInput: 200, tokensOutput: 100, costUsd: 0.002 }))
      await tracker.record(entry({ tokensInput: 300, tokensOutput: 150, costUsd: 0.003 }))

      const s = await tracker.summary()
      assert.equal(s.count, 3)
      assert.ok(Math.abs(s.totalCostUsd - 0.006) < 1e-9, 'cost totals sum')
      assert.equal(s.totalTokensInput, 600)
      assert.equal(s.totalTokensOutput, 300)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync('missing ledger file → empty list and zero summary, no crash', async () => {
    const dir = freshDir()
    try {
      const tracker = createCostTracker({
        filePath: join(dir, 'does-not-exist', 'delegations.jsonl'),
      })
      const all = await tracker.list()
      assert.equal(all.length, 0, 'missing file → empty list')
      const s = await tracker.summary()
      assert.equal(s.count, 0)
      assert.equal(s.totalCostUsd, 0)
      assert.equal(s.totalTokensInput, 0)
      assert.equal(s.totalTokensOutput, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
