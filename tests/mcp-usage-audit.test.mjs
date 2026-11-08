import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import {
  buildReport,
  callSnippet,
  extractCalledMethods,
  extractMcpRefs,
  hooksLogMcpDurations,
  memoryDbStats,
  pantheonHome,
  persistenceDbStats,
  resolvePersistenceDbPaths,
  resolveTranscriptDbPath,
  scanTranscripts,
  serverForMethod,
} from '../bench/mcp-usage-audit.mjs'

const CODE = `const m = tools["pantheon-memory"].memory_search({ query: "auth" });
await tools["pantheon-memory"].memory_store({ key: "k", value: "v" });
tools['pantheon-vision'].vision_describe({ path: "a.png" });
console.log("unrelated");`

test('extractMcpRefs: servers and method refs parsed from execute code', () => {
  const refs = extractMcpRefs(CODE)
  assert.deepEqual([...refs.servers].sort(), ['pantheon-memory', 'pantheon-vision'])
  assert.ok(refs.methods.has('pantheon-memory.memory_search'))
  assert.ok(refs.methods.has('pantheon-memory.memory_store'))
  assert.equal(extractMcpRefs('const x = 1;').servers.size, 0)
})

test('extractCalledMethods: only actual invocation sites count', () => {
  const called = extractCalledMethods(CODE)
  assert.deepEqual([...called].sort(), ['memory_search', 'memory_store', 'vision_describe'])
})

test('serverForMethod: one owner per method family', () => {
  assert.equal(serverForMethod('memory_store'), 'pantheon-memory')
  assert.equal(serverForMethod('code_query'), 'pantheon-memory')
  assert.equal(serverForMethod('kv_store'), 'pantheon-persistence')
  assert.equal(serverForMethod('context_save'), 'pantheon-persistence')
  assert.equal(serverForMethod('goal_create'), 'pantheon-persistence')
  assert.equal(serverForMethod('vision_describe'), 'pantheon-vision')
  assert.equal(serverForMethod('execute_code_script'), 'pantheon-code-mode')
  assert.equal(serverForMethod('whatever'), 'pantheon-resources')
})

test('callSnippet: bounded, first site, newlines flattened', () => {
  const s = callSnippet(
    `a\nmemory_store({ key: "k", value: "${'x'.repeat(300)}" })`,
    'memory_store',
    40,
  )
  assert.ok(s.length <= 40)
  assert.ok(!s.includes('\n'))
  assert.ok(s.startsWith('memory_store('))
  assert.equal(callSnippet('nothing here', 'memory_store'), '')
})

test('db path resolution: env precedence and existing-only persistence candidates', () => {
  assert.equal(resolveTranscriptDbPath({ PANTHEON_COST_DB: '/a', OPENCODE_DB: '/b' }), '/a')
  assert.equal(resolveTranscriptDbPath({ OPENCODE_DB: '/b' }), '/b')
  assert.equal(pantheonHome({ PANTHEON_HOME: '/p' }), '/p')
  assert.equal(pantheonHome({ XDG_CONFIG_HOME: '/x' }), join('/x', 'opencode'))
  const dir = join(tmpdir(), `mcp-audit-${Date.now()}`)
  try {
    mkdirSync(join(dir, 'persistence'), { recursive: true })
    writeFileSync(join(dir, 'persistence', 'global.db'), '')
    const found = resolvePersistenceDbPaths({ PANTHEON_HOME: dir }, join(dir, 'cwd'))
    assert.deepEqual(found, [join(dir, 'persistence', 'global.db')])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeTranscriptDb(dir) {
  const dbPath = join(dir, 'opencode.db')
  const db = new DatabaseSync(dbPath)
  db.exec(
    'CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)',
  )
  const t0 = Date.parse('2026-10-10T10:00:00Z')
  const ins = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)')
  ins.run(
    'u1',
    's1',
    'user',
    1,
    t0,
    t0,
    JSON.stringify({ time: {}, text: 'investigate the auth bug', files: [], agents: [] }),
  )
  ins.run(
    'a1',
    's1',
    'assistant',
    2,
    t0 + 1000,
    t0 + 1000,
    JSON.stringify({
      time: {},
      agent: 'zeus',
      content: [
        { type: 'text', text: 'thinking' },
        { type: 'tool', name: 'execute', state: { status: 'completed', input: { code: CODE } } },
      ],
    }),
  )
  ins.run(
    'a2',
    's1',
    'assistant',
    3,
    t0 + 2000,
    t0 + 2000,
    JSON.stringify({
      time: {},
      agent: 'zeus',
      content: [
        { type: 'tool', name: 'read', state: { status: 'completed', input: {} } },
        {
          type: 'tool',
          name: 'pantheon-memory_memory_store',
          state: { status: 'completed', input: {} },
        },
      ],
    }),
  )
  ins.run(
    'a3',
    's2',
    'assistant',
    4,
    t0 + 3000,
    t0 + 3000,
    JSON.stringify({
      time: {},
      agent: 'apollo',
      content: [
        {
          type: 'tool',
          name: 'execute',
          state: {
            status: 'failed',
            input: { code: 'tools["pantheon-persistence"].context_save({})' },
          },
        },
      ],
    }),
  )
  db.close()
  return dbPath
}

test('scanTranscripts: counts, direct-vs-execute split, samples, sessions', () => {
  const dir = join(tmpdir(), `mcp-audit-scan-${Date.now()}`)
  try {
    mkdirSync(dir, { recursive: true })
    const scan = scanTranscripts(makeTranscriptDb(dir))
    assert.equal(scan.userTurns, 1)
    assert.equal(scan.assistantMessages, 3)
    assert.equal(scan.directMcpToolCalls, 1, 'direct pantheon-* tool call counted')
    assert.equal(scan.executeCalls, 2)
    assert.equal(scan.executeCompleted, 1)
    assert.equal(scan.executeMentioning, 2)
    assert.equal(scan.executeMentioningCompleted, 1)
    assert.equal(scan.mcpSessions.size, 2)
    assert.equal(scan.perServer['pantheon-memory'].executeBlocks, 1)
    assert.equal(scan.perServer['pantheon-memory'].methods.memory_store, 1)
    assert.equal(scan.perServer['pantheon-memory'].methods.memory_search, 1)
    assert.equal(scan.perServer['pantheon-vision'].methods.vision_describe, 1)
    assert.equal(scan.perServer['pantheon-persistence'].methods.context_save, 1)
    assert.equal(scan.perServer['pantheon-memory'].agents.zeus, 1)
    assert.equal(scan.userTurnsByMonth['2026-10'], 1)
    assert.equal(scan.samples.memory_store.length, 1)
    assert.equal(scan.samples.memory_store[0].user, 'investigate the auth bug')
    assert.equal(scan.samples.context_save.length, 1)
    assert.ok(scan.samples.context_save[0].snippet.startsWith('context_save('))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('memoryDbStats and persistenceDbStats read durable state', () => {
  const dir = join(tmpdir(), `mcp-audit-db-${Date.now()}`)
  try {
    mkdirSync(join(dir, 'memory'), { recursive: true })
    mkdirSync(join(dir, 'persistence'), { recursive: true })
    const mem = new DatabaseSync(join(dir, 'memory', 'memory.db'))
    mem.exec(
      'CREATE TABLE memories (id INTEGER PRIMARY KEY, namespace TEXT, key TEXT, value TEXT, metadata TEXT, created_at TEXT, updated_at TEXT, expires_at TEXT)',
    )
    mem
      .prepare('INSERT INTO memories (namespace, key, value, created_at) VALUES (?,?,?,?)')
      .run('default', 'k1', 'v'.repeat(50), '2026-10-02 10:00:00')
    mem
      .prepare('INSERT INTO memories (namespace, key, value, created_at) VALUES (?,?,?,?)')
      .run('proj', 'k2', 'w', '2026-09-03 10:00:00')
    mem.close()
    const stats = memoryDbStats(join(dir, 'memory', 'memory.db'))
    assert.equal(stats.total, 2)
    assert.equal(stats.byMonth['2026-09'], 1)
    assert.equal(stats.byNamespace.default, 1)
    assert.ok(stats.avgValueBytes > 20)
    assert.equal(stats.recent[0].key, 'k1')

    const per = new DatabaseSync(join(dir, 'persistence', 'global.db'))
    per.exec(
      'CREATE TABLE kv_store (id INTEGER PRIMARY KEY, namespace TEXT, key TEXT, value TEXT, created_at TEXT, updated_at TEXT)',
    )
    const ins = per.prepare(
      'INSERT INTO kv_store (namespace, key, value, created_at) VALUES (?,?,?,?)',
    )
    ins.run('checkpoint:s1:abc:1', 'c', 'x', '2026-10-01 08:00:00')
    ins.run('checkpoint:s2:def:1', 'c', 'x', '2026-10-02 08:00:00')
    ins.run('delegation-telemetry', 'd', 'x', '2026-10-03 08:00:00')
    per.close()
    const pstats = persistenceDbStats([join(dir, 'persistence', 'global.db')])
    assert.equal(pstats.length, 1)
    assert.equal(pstats[0].rows, 3)
    assert.equal(pstats[0].kinds.checkpoint, 2)
    assert.equal(pstats[0].kinds['delegation-telemetry'], 1)
    assert.equal(pstats[0].checkpointNamespaces, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hooksLogMcpDurations: percentile table from bench lines', () => {
  const dir = join(tmpdir(), `mcp-audit-log-${Date.now()}`)
  try {
    mkdirSync(dir, { recursive: true })
    const log = join(dir, 'hooks.log')
    writeFileSync(
      log,
      [
        '[2026-10-10T10:00:00.000Z] [bench] tool.execute.before end tool=pantheon-memory_memory_search callID=c1 started_at=2026-10-10T10:00:00.000Z duration_ms=5',
        '[2026-10-10T10:00:01.000Z] [bench] tool.execute.after end tool=pantheon-memory_memory_search callID=c1 duration_ms=20 since_before_ms=1000',
        '[2026-10-10T10:00:02.000Z] [bench] tool.execute.after end tool=read callID=c2 duration_ms=3 since_before_ms=10',
        'garbage line',
      ].join('\n'),
    )
    const durations = hooksLogMcpDurations(log)
    assert.deepEqual(durations, { 'pantheon-memory_memory_search': { calls: 1, p50: 20, p95: 20 } })
    assert.equal(hooksLogMcpDurations(join(dir, 'missing.log')), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildReport: headline, tables and samples render', () => {
  const dir = join(tmpdir(), `mcp-audit-report-${Date.now()}`)
  try {
    mkdirSync(dir, { recursive: true })
    const scan = scanTranscripts(makeTranscriptDb(dir))
    const report = buildReport(scan, null, [], {
      pantheon_memory_memory_store: { calls: 2, p50: 10, p95: 40 },
    })
    assert.ok(report.includes('# Native MCP usage audit'))
    assert.ok(report.includes('assistant messages scanned: **3**'))
    assert.ok(report.includes('user turns: **1**'))
    assert.ok(report.includes('| pantheon-memory | 1 |'))
    assert.ok(report.includes('no ambient caller'))
    assert.ok(report.includes('### memory_store (1 sampled)'))
    assert.ok(report.includes('investigate the auth bug'))
    assert.ok(report.includes('p50 ms'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
