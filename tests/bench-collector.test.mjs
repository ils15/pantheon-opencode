/**
 * bench-collector.test.mjs — TDD contract tests for bench/lib/collector.mjs
 * (beta-10 latency slice, Phase 0 baseline harness).
 *
 * Locked contracts:
 *   - the collector opens opencode.db STRICTLY read-only: a missing db is an
 *     explicit error and NO file is created; an existing file is byte-identical
 *     after collection
 *   - node:sqlite unavailable → explicit error, no fallback
 *   - schema detection mirrors cost-command.ts (V1 `message` vs V2
 *     `session_message`); an unrecognised ledger is reported, never guessed
 *   - tokens root + children aggregated without double counting; cache tokens
 *     surfaced when the schema carries them
 *   - tool calls per name extracted from assistant content parts
 *   - a metric the schema cannot provide comes back as
 *     {status:'unavailable', reason} — never as zero
 *
 * Run: node --test tests/bench-collector.test.mjs
 */
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const { collectInstructionState, collectRunMetrics, detectSchema, openReadOnly } = await import(
  '../bench/lib/collector.mjs'
)
const { DatabaseSync } = await import('node:sqlite')

// ─── fixture builder ─────────────────────────────────────────────────────

/**
 * Minimal V2-shaped fixture database. Column names match the real host schema
 * (verified read-only on the live opencode.db): session_v2 + session_message.
 */
function buildV2Fixture(dbPath) {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT,
      agent TEXT, model TEXT, idle_outcome TEXT,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, data TEXT
    );
    CREATE INDEX msg_session ON session_message(session_id, seq);
  `)
  const insSession = db.prepare(
    'INSERT INTO session_v2 (id, parent_id, directory, title, agent, model, idle_outcome, time_created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  insSession.run(
    'ses_root',
    null,
    '/sandbox',
    'root',
    'zeus',
    '{"id":"m1","providerID":"p"}',
    'succeeded',
    1000,
  )
  insSession.run(
    'ses_child',
    'ses_root',
    '/sandbox',
    'child',
    'hermes',
    '{"id":"m1","providerID":"p"}',
    'succeeded',
    1100,
  )
  insSession.run('ses_other', null, '/elsewhere', 'other', 'zeus', '{}', 'succeeded', 1200)
  const insMsg = db.prepare(
    'INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const assistant = (input, output, cacheRead) =>
    JSON.stringify({
      agent: 'zeus',
      tokens: { input, output, reasoning: 0, cache: { read: cacheRead, write: 0 } },
      content: [{ type: 'text', text: 'ok' }],
    })
  insMsg.run('m1', 'ses_root', 'assistant', 1, 1010, assistant(100, 10, 55))
  insMsg.run(
    'm2',
    'ses_root',
    'assistant',
    2,
    1020,
    JSON.stringify({
      agent: 'zeus',
      tokens: { input: 30, output: 3, reasoning: 0, cache: { read: 5, write: 0 } },
      content: [
        { type: 'tool', id: 'call_1', name: 'shell', state: { status: 'completed' } },
        { type: 'tool', id: 'call_2', name: 'read', state: { status: 'completed' } },
      ],
    }),
  )
  insMsg.run('m3', 'ses_child', 'assistant', 1, 1110, assistant(50, 5, 11))
  insMsg.run(
    'm4',
    'ses_child',
    'assistant',
    2,
    1120,
    JSON.stringify({
      agent: 'hermes',
      tokens: { input: 20, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      content: [{ type: 'tool', id: 'call_3', name: 'shell', state: { status: 'completed' } }],
    }),
  )
  // a user message: must be ignored by the token ledger (assistant-only, as in
  // cost-command.ts)
  insMsg.run(
    'm5',
    'ses_root',
    'user',
    0,
    1005,
    JSON.stringify({ tokens: { input: 9999, output: 9999 } }),
  )
  db.close()
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function withFixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-collector-'))
  const dbPath = join(dir, 'opencode.db')
  try {
    buildV2Fixture(dbPath)
    run(dbPath, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ─── read-only discipline ────────────────────────────────────────────────

test('openReadOnly on a missing db throws an explicit error and creates no file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-collector-missing-'))
  try {
    const missing = join(dir, 'nope.db')
    assert.throws(() => openReadOnly(missing), /not found/i)
    assert.equal(existsSync(missing), false, 'collector must never create the db')
    assert.equal(existsSync(`${missing}-wal`), false)
    assert.equal(existsSync(`${missing}-shm`), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('collection leaves the database byte-identical (no writes, no WAL growth)', () => {
  withFixture((dbPath) => {
    const before = sha256(dbPath)
    const db = openReadOnly(dbPath)
    collectRunMetrics(db, 'ses_root')
    db.close()
    assert.equal(sha256(dbPath), before, 'collector must not write to the db')
    assert.equal(existsSync(`${dbPath}-wal`), false, 'no WAL side files may appear')
    assert.equal(existsSync(`${dbPath}-shm`), false, 'no SHM side files may appear')
  })
})

// ─── schema detection ────────────────────────────────────────────────────

test('detectSchema classifies the V2 ledger (session_message, no role discriminator)', () => {
  withFixture((dbPath) => {
    const db = openReadOnly(dbPath)
    try {
      const schema = detectSchema(db)
      assert.equal(schema.generation, 'v2')
      assert.ok(schema.tables.includes('session_message'))
    } finally {
      db.close()
    }
  })
})

test('detectSchema classifies a V1 ledger as v1 and the collector reports tokens unavailable for it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-collector-v1-'))
  try {
    const dbPath = join(dir, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER)')
    db.close()
    const handle = openReadOnly(dbPath)
    try {
      assert.equal(detectSchema(handle).generation, 'v1')
      const metrics = collectRunMetrics(handle, 'ses_x')
      assert.equal(metrics.tokens.status, 'unavailable')
      assert.match(metrics.tokens.reason, /v1/i)
    } finally {
      handle.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('detectSchema reports unsupported (not v1/v2) when no ledger table exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-collector-empty-'))
  try {
    const dbPath = join(dir, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE kv (k TEXT, v TEXT)')
    db.close()
    const handle = openReadOnly(dbPath)
    try {
      assert.equal(detectSchema(handle).generation, 'unsupported')
    } finally {
      handle.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── metric collection ───────────────────────────────────────────────────

test('collectRunMetrics sums tokens over root + children exactly once (assistant rows only)', () => {
  withFixture((dbPath) => {
    const db = openReadOnly(dbPath)
    try {
      const metrics = collectRunMetrics(db, 'ses_root')
      assert.equal(metrics.childrenCount, 1)
      assert.equal(metrics.tokens.status, 'ok')
      // 100 + 30 (root assistant rows) + 50 + 20 (child) — the 9999 user row excluded
      assert.equal(metrics.tokens.input, 200)
      assert.equal(metrics.tokens.output, 20)
      assert.equal(metrics.tokens.cacheRead, 71)
    } finally {
      db.close()
    }
  })
})

test('collectRunMetrics extracts tool calls per name across the whole tree', () => {
  withFixture((dbPath) => {
    const db = openReadOnly(dbPath)
    try {
      const metrics = collectRunMetrics(db, 'ses_root')
      assert.equal(metrics.toolCalls.status, 'ok')
      assert.deepEqual(metrics.toolCalls.calls, [
        { name: 'shell', count: 2 },
        { name: 'read', count: 1 },
      ])
    } finally {
      db.close()
    }
  })
})

test('collectRunMetrics carries the root session outcome and model', () => {
  withFixture((dbPath) => {
    const db = openReadOnly(dbPath)
    try {
      const metrics = collectRunMetrics(db, 'ses_root')
      assert.equal(metrics.root.idle_outcome, 'succeeded')
      assert.ok(typeof metrics.root.model === 'string' && metrics.root.model.includes('m1'))
    } finally {
      db.close()
    }
  })
})

test('a root id absent from the db yields unavailable metrics with a reason', () => {
  withFixture((dbPath) => {
    const db = openReadOnly(dbPath)
    try {
      const metrics = collectRunMetrics(db, 'ses_nope')
      assert.equal(metrics.root.status, 'unavailable')
      assert.equal(metrics.tokens.status, 'unavailable')
      assert.equal(metrics.toolCalls.status, 'unavailable')
    } finally {
      db.close()
    }
  })
})

// ─── instruction provenance (D4 fidelity proof) ──────────────────────────

/** Fixture with the real instruction_state/instruction_blob shape. */
function buildInstructionFixture(dbPath) {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE instruction_state (
      session_id TEXT, epoch_start INTEGER, through_seq INTEGER,
      initial_values TEXT, current_values TEXT
    );
    CREATE TABLE instruction_blob (hash TEXT, value TEXT);
  `)
  const global = '# global rules\n'.repeat(3)
  const project = '# project rules\n'
  const blob = JSON.stringify([
    { path: '/host/.config/opencode/AGENTS.md', content: global },
    { path: '/repo/AGENTS.md', content: project },
  ])
  const hash = createHash('sha256').update(blob).digest('hex')
  db.prepare('INSERT INTO instruction_blob (hash, value) VALUES (?, ?)').run(hash, blob)
  db.prepare(
    'INSERT INTO instruction_state (session_id, epoch_start, through_seq, initial_values, current_values) VALUES (?, ?, ?, ?, ?)',
  ).run(
    'ses_root',
    3,
    3,
    JSON.stringify({ 'core/instructions': hash }),
    JSON.stringify({ 'core/instructions': hash }),
  )
  db.close()
}

test('collectInstructionState reports the identity of every loaded instruction file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-instr-'))
  const dbPath = join(dir, 'opencode.db')
  try {
    buildInstructionFixture(dbPath)
    const db = openReadOnly(dbPath)
    try {
      const provenance = collectInstructionState(db, 'ses_root')
      assert.equal(provenance.status, 'ok')
      assert.equal(provenance.entryCount, 2)
      assert.equal(provenance.totalBytes, 3 * 15 + 16)
      assert.deepEqual(
        provenance.entries.map((e) => e.path),
        ['/host/.config/opencode/AGENTS.md', '/repo/AGENTS.md'],
      )
      for (const entry of provenance.entries) {
        assert.match(entry.sha256, /^[0-9a-f]{64}$/)
        assert.ok(entry.bytes > 0)
      }
      // content must never ride along in the report
      assert.equal(JSON.stringify(provenance).includes('global rules'), false)
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('collectInstructionState degrades to unavailable when the tables are absent', () => {
  withFixture((dbPath) => {
    const db = openReadOnly(dbPath)
    try {
      const provenance = collectInstructionState(db, 'ses_root')
      assert.equal(provenance.status, 'unavailable')
      assert.match(provenance.reason, /instruction_state/)
    } finally {
      db.close()
    }
  })
})

test('collectInstructionState degrades to unavailable when the session has no state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-instr-'))
  const dbPath = join(dir, 'opencode.db')
  try {
    buildInstructionFixture(dbPath)
    const db = openReadOnly(dbPath)
    try {
      const provenance = collectInstructionState(db, 'ses_missing')
      assert.equal(provenance.status, 'unavailable')
      assert.match(provenance.reason, /no instruction_state row/)
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
