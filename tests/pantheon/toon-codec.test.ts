/**
 * Tests for the WS3 TOON codec (PR #94) — TypeScript mirror.
 *
 * TDD RED: `src/pantheon/toon-codec.ts` does not exist yet, so every test
 * here FAILS before the implementation and PASSES after.
 *
 * TOON (Token-Oriented Object Notation): a minimal deterministic encoding
 * for board signals, checkpoints and KV payloads. Semantics identical to
 * JSON; per-class savings ~11% board-signal up to ~49% large-tabular
 * (28% checkpoint, 33% kv-list — see docs/ws3-token-opt-measurements.md);
 * JSON fallback when the parser is absent/fails.
 *
 * Run with: npx tsx tests/pantheon/toon-codec.test.ts
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  TOON_MAX_CHARS,
  TOON_MAX_DEPTH,
  type ToonValue,
  toonDecode,
  toonDecodeAuto,
  toonEncode,
  toonSizeReport,
} from '../../src/pantheon/toon-codec.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PARITY_FIXTURE = join(__dirname, '..', 'fixtures', 'toon-parity.json')

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

// ─── Fixtures (shaped like the real payloads) ────────────────────────────

function boardSignal() {
  return {
    taskID: 'ses_child_1',
    alias: 'apo-1',
    agent: 'hermes',
    state: 'completed',
    summary: 'Done: auth router implemented, 12 tests green',
    timestamp: 1787955800816,
  }
}

function checkpoint() {
  // Realistic full checkpoint (WS2 shape): phase + tail + in-flight jobs
  // + pending todos + heartbeat nesting. Tabular sections encode as tables.
  return {
    phase: 3,
    agent: 'hermes',
    summary: 'Delegate relaunch e2e green, monitor apo-2 and apo-3',
    remaining: ['monitor', 'reconcile', 'verify'],
    tail: 'last action: reconcile apo-1 completed after 12 tests green, heartbeat refreshed',
    jobs: [
      { taskID: 'ses_child_1', agent: 'hermes', state: 'completed' },
      { taskID: 'ses_child_2', agent: 'apollo', state: 'running' },
      { taskID: 'ses_child_3', agent: 'themis', state: 'running' },
      { taskID: 'ses_child_4', agent: 'demeter', state: 'running' },
      { taskID: 'ses_child_5', agent: 'aphrodite', state: 'error' },
    ],
    todos: [
      { id: 't1', desc: 'dispatch hermes', status: 'done' },
      { id: 't2', desc: 'monitor board', status: 'active' },
      { id: 't3', desc: 'reconcile signals', status: 'pending' },
      { id: 't4', desc: 'verify e2e', status: 'pending' },
    ],
    nested: { retries: 1, capped: false },
  }
}

function kvList() {
  return [
    { namespace: 'checkpoint:auth:abc123', key: 'phase:3', value: 'relaunch green' },
    { namespace: 'checkpoint:auth:abc123', key: 'latest', value: 'relaunch green' },
    { namespace: 'checkpoint:auth:abc123', key: 'heartbeat', value: 'alive' },
  ]
}

// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  await testAsync('round-trip preserves identical semantics (nested dict)', async () => {
    const value = checkpoint()
    assert.deepEqual(toonDecode(toonEncode(value)), value)
  })

  await testAsync('round-trip preserves a list of dicts (KV payload)', async () => {
    assert.deepEqual(toonDecode(toonEncode(kvList())), kvList())
  })

  await testAsync('round-trip preserves scalar types (string "123" stays a string)', async () => {
    const value = { count: 123, flag: true, missing: null, code: '123', name: 'apo-1' }
    assert.deepEqual(toonDecode(toonEncode(value)), value)
  })

  await testAsync('board signal encodes smaller than JSON (flat minimal record)', async () => {
    // Flat minimal records (PLAN: id, agente, estado, 1 linha) are
    // content-dominated: TOON wins on structure only (~11% board-signal).
    // The lever is still net-positive here (replaces JSON, zero overhead) —
    // structural payloads below save 28% checkpoint / 33% kv-list / ~49% large-tabular.
    const report = toonSizeReport(boardSignal())
    assert.ok(
      report.toonChars < report.jsonChars,
      `expected strictly smaller, got json=${report.jsonChars} toon=${report.toonChars}`,
    )
  })

  await testAsync('checkpoint encodes ~28% smaller than JSON (structural payload)', async () => {
    const report = toonSizeReport(checkpoint())
    assert.ok(
      report.toonChars <= report.jsonChars * 0.75,
      `expected >=25% smaller, got json=${report.jsonChars} toon=${report.toonChars}`,
    )
  })

  await testAsync('KV list encodes ~33% smaller than JSON (uniform table)', async () => {
    const report = toonSizeReport(kvList())
    assert.ok(
      report.toonChars <= report.jsonChars * 0.75,
      `expected >=25% smaller, got json=${report.jsonChars} toon=${report.toonChars}`,
    )
  })

  await testAsync('toonDecodeAuto falls back to JSON when the parser input is JSON', async () => {
    const value = boardSignal()
    const json = JSON.stringify(value)
    assert.deepEqual(toonDecodeAuto(json), value)
    assert.deepEqual(toonDecodeAuto(toonEncode(value)), value)
  })

  await testAsync('toonDecodeAuto throws on garbage (neither TOON nor JSON)', async () => {
    assert.throws(() => toonDecodeAuto(':::not-valid:::\n  \x00'), /neither TOON nor JSON/)
  })

  // ── WS3 completion: pipe-quoting (raw `|` must not split cells) ──────
  await testAsync('pipe values in a table are quoted and round-trip', async () => {
    const value = [{ a: 'x|y', b: '1' }]
    assert.equal(toonEncode(value), '@table a|b\n"x|y"|"1"')
    assert.deepEqual(toonDecode('@table a|b\n"x|y"|"1"'), value)
  })

  await testAsync('pipe + quote values in a table round-trip', async () => {
    const value = [{ a: 'x|"y"', b: 'p|q|r' }]
    assert.deepEqual(toonDecode(toonEncode(value)), value)
  })

  // ── WS3 completion: quoted colon key (raw_decode fix) ────────────────
  await testAsync('quoted colon key {"a:b": 2} splits after the closing quote', async () => {
    assert.equal(toonEncode({ 'a:b': 2 }), '"a:b": 2')
    assert.deepEqual(toonDecode('"a:b": 2'), { 'a:b': 2 })
  })

  // ── WS3 completion: cross-parity goldens (py ↔ ts byte-compatible) ───
  await testAsync('golden fixtures tests/fixtures/toon-parity.json hold in TS', async () => {
    const payload = JSON.parse(readFileSync(PARITY_FIXTURE, 'utf-8')) as {
      fixtures: { name: string; value: ToonValue; toon: string }[]
    }
    assert.ok(payload.fixtures.length > 0, 'parity fixture must not be empty')
    for (const entry of payload.fixtures) {
      assert.equal(toonEncode(entry.value), entry.toon, `golden ${entry.name}`)
      assert.deepEqual(toonDecode(entry.toon), entry.value, `golden ${entry.name}`)
    }
  })

  // ── WS3 completion: robustness (empty, colon, keylike, multiline) ────
  await testAsync('robustness: empty containers, colons, keylike items, multiline', async () => {
    assert.deepEqual(toonDecode(toonEncode({ a: {}, b: [] })), { a: {}, b: [] })
    assert.deepEqual(toonDecode(toonEncode({ summary: 'a: b: c' })), { summary: 'a: b: c' })
    assert.deepEqual(toonDecode(toonEncode(['a: b', 'plain'])), ['a: b', 'plain'])
    assert.deepEqual(toonDecode(toonEncode({ note: 'line1\nline2' })), {
      note: 'line1\nline2',
    })
  })

  // ── WS3 completion: DoS guards (maxDepth / maxChars fail closed) ─────
  await testAsync('toonDecode enforces maxDepth with a controlled Error', async () => {
    let nested: ToonValue = { leaf: 1 }
    for (let i = 0; i < TOON_MAX_DEPTH + 2; i += 1) nested = { nest: nested }
    assert.throws(() => toonDecode(toonEncode(nested)), /maxDepth/)
    assert.throws(() => toonDecode(toonEncode({ a: { b: 1 } }), 0), /maxDepth/)
  })

  await testAsync('toonDecode enforces maxChars with a controlled Error', async () => {
    assert.throws(() => toonDecode('a: 1', TOON_MAX_DEPTH, 2), /too large/)
    assert.throws(() => toonDecode('x'.repeat(TOON_MAX_CHARS + 1)), /too large/)
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
