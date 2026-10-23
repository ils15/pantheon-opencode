/**
 * Tests for ambient memory injection on the OpenCode V2 `context` hook.
 *
 * Fixtures build a REAL SQLite database on disk with the same schema the
 * `pantheon-memory` MCP server creates (`memories` + external-content
 * `memories_fts`), then drive the module against it read-only — the same access
 * path the plugin uses in production. A schema difference is therefore caught
 * here rather than on a live host.
 *
 * Run with: npx tsx tests/pantheon/memory-context.test.ts
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import {
  applyMemoryInjection,
  buildFtsQuery,
  buildMemoryInjection,
  classifyMemoryError,
  DEFAULT_MEMORY_INJECTION_CONFIG,
  describeMemoryInjectionConfigIssues,
  errorDetail,
  extractFirstUserText,
  formatMemoryInjectionLogLine,
  hasMemoryContextMarker,
  MEMORY_CONTEXT_MARKER,
  MEMORY_INJECTION_CONFIG_KEYS,
  MEMORY_INJECTION_DEBUG_ENV,
  MEMORY_INJECTION_LOG_MAX_SESSIONS,
  MEMORY_STOPWORDS,
  MemoryInjectionCache,
  MIN_PREFIX_LEN,
  renderMemoryContext,
  resetMemoryInjectionConfigWarned,
  resetMemoryInjectionLogState,
  resolveMemoryDbPath,
  resolveMemoryInjectionConfig,
  TRUNCATION_SUFFIX,
  warnInvalidMemoryInjectionConfig,
} from '../../src/pantheon/memory-context.ts'
import { plugin } from '../../src/plugin-v2.ts'

// ─── Harness ─────────────────────────────────────────────────────────────

const results: { name: string; passed: boolean; error?: string }[] = []

function test(name: string, fn: () => void): void {
  try {
    fn()
    results.push({ name, passed: true })
  } catch (e: unknown) {
    results.push({ name, passed: false, error: e instanceof Error ? e.message : String(e) })
  }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  await Promise.resolve()
    .then(fn)
    .then(
      () => results.push({ name, passed: true }),
      (e: unknown) =>
        results.push({
          name,
          passed: false,
          error: e instanceof Error ? e.message : String(e),
        }),
    )
}

// ─── Database fixture ───────────────────────────────────────────────────

const tempDirs: string[] = []

/** Read a hook log that may not exist yet (no line written == no attempt). */
function readHookLog(dir: string): string {
  try {
    return readFileSync(join(dir, '.pantheon', 'logs', 'hooks.log'), 'utf8')
  } catch {
    return ''
  }
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const SCHEMA = `
CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL DEFAULT 'default',
    key TEXT,
    value TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE VIRTUAL TABLE memories_fts USING fts5(
    namespace, key, value, metadata,
    content='memories', content_rowid='id',
    tokenize='porter unicode61'
);
`

interface FixtureRow {
  namespace: string
  key: string | null
  value: string
  expiresAt?: string | null
}

/**
 * Create the memory store on disk. `withExpiry: false` reproduces a database
 * written before TTL support (no `expires_at` column at all), which is what the
 * live store looks like until the memory server opens it once.
 */
function makeStore(rows: FixtureRow[], options: { withExpiry?: boolean } = {}): string {
  const withExpiry = options.withExpiry ?? true
  const dir = tempDir('pantheon-memory-injection-')
  mkdirSync(join(dir, 'memory'), { recursive: true })
  const dbPath = join(dir, 'memory', 'memory.db')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(SCHEMA)
    if (withExpiry) db.exec('ALTER TABLE memories ADD COLUMN expires_at TEXT')
    const insert = db.prepare(
      `INSERT INTO memories (namespace, key, value, metadata, created_at${withExpiry ? ', expires_at' : ''})
       VALUES (?, ?, ?, '{}', ?${withExpiry ? ', ?' : ''})`,
    )
    for (const row of rows) {
      if (withExpiry) {
        insert.run(row.namespace, row.key, row.value, '2026-01-01T00:00:00Z', row.expiresAt ?? null)
      } else {
        insert.run(row.namespace, row.key, row.value, '2026-01-01T00:00:00Z')
      }
    }
    db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")
  } finally {
    db.close()
  }
  return dbPath
}

const enabled = (overrides: Record<string, unknown> = {}) => ({
  ...DEFAULT_MEMORY_INJECTION_CONFIG,
  enabled: true,
  ...overrides,
})

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0)
const now = () => NOW

function userMessage(text: string): Record<string, unknown> {
  return { id: 'msg_1', role: 'user', content: [{ type: 'text', text }], metadata: {} }
}

function systemTexts(system: unknown): string[] {
  assert.ok(Array.isArray(system), 'system must stay a part array')
  return system.map((part) => {
    assert.equal(typeof (part as { text?: unknown }).text, 'string', 'every part has text')
    assert.equal((part as { type?: unknown }).type, 'text', 'every part is a text part')
    return (part as { text: string }).text
  })
}

// ─── Query builder (mirror of memory_mcp.py:314) ────────────────────────

const MEMORY_MCP_PY = fileURLToPath(new URL('../../src/mcp/memory_mcp.py', import.meta.url))
const PY_SOURCE = readFileSync(MEMORY_MCP_PY, 'utf8')

test('source of truth still exists in memory_mcp.py', () => {
  // The symbol, not the line number, is the contract: the module docstring
  // records `:314` as the line it was ported from, and any edit above it
  // shifts that number without changing the builder.
  assert.match(PY_SOURCE, /^def _build_fts_query\(query: str\) -> str:/m)
})

test('stopwords and the prefix threshold match memory_mcp.py (drift guard)', () => {
  const block = /_STOPWORDS = frozenset\(\s*\[([\s\S]*?)\]\s*\)/.exec(PY_SOURCE)
  assert.ok(block, '_STOPWORDS block found in memory_mcp.py')
  const pythonWords = [...String(block[1]).matchAll(/"([^"]*)"/g)].map((m) => m[1])
  assert.ok(pythonWords.length > 50, 'the python stopword list was parsed')
  assert.deepEqual([...MEMORY_STOPWORDS], pythonWords, 'stopword list is identical (and in order)')
  const minPrefix = /_MIN_PREFIX_LEN = (\d+)/.exec(PY_SOURCE)
  assert.ok(minPrefix, '_MIN_PREFIX_LEN found in memory_mcp.py')
  assert.equal(Number(String(minPrefix[1])), MIN_PREFIX_LEN)
})

test('query shape is pinned: OR-joined, double-quoted terms, prefix star', () => {
  // The constants test above pins the stopwords and the threshold; this pins
  // the SHAPE, so flipping OR to AND or dropping the quoting in the Python
  // builder turns this red instead of silently diverging. It parses literals
  // only (no python3 execution) and is deliberately structural: the f-string
  // variable name may change, the quotes/operator/star may not.
  const start = PY_SOURCE.indexOf('def _build_fts_query(')
  assert.ok(start >= 0, 'the python builder is still named _build_fts_query')
  const rest = PY_SOURCE.slice(start)
  const nextTopLevel = rest.slice(1).search(/\n(?=\S)/)
  const body = nextTopLevel === -1 ? rest : rest.slice(0, nextTopLevel + 1)

  const join = /(['"])([^'"]+)\1\.join\(/.exec(body)
  assert.ok(join, 'the python builder still joins terms with a literal separator')
  assert.equal(String(join[2]).trim(), 'OR', 'terms stay OR-joined (AND would narrow recall)')

  const forms = [...body.matchAll(/f(['"])"\{([A-Za-z_][A-Za-z0-9_]*)\}"(\*?)\1/g)].map((m) =>
    m[3] === '*' ? 'prefix' : 'exact',
  )
  assert.deepEqual(
    [...new Set(forms)].sort(),
    ['exact', 'prefix'],
    'both the quoted-exact and the quoted-prefix template are present',
  )
  // Literal double quotes inside the term, i.e. `f'"..."*'` and not `f'{...}*'`.
  assert.equal(body.includes('"{word}"*') || /f(['"])"\{/.test(body), true)
})

test('query builder extracts terms, drops stopwords, prefix-matches 4+ chars', () => {
  assert.equal(buildFtsQuery('the quick brown fox'), '"quick"* OR "brown"* OR "fox"')
  assert.equal(buildFtsQuery('a of the'), '', 'stopword-only input has no expression')
  assert.equal(buildFtsQuery('   '), '')
  assert.equal(buildFtsQuery('abc abcd'), '"abc" OR "abcd"*')
  assert.equal(buildFtsQuery('Read THE changelog'), '"Read"* OR "changelog"*')
})

test('query builder escapes quotes and never emits FTS5 syntax from user text', () => {
  // A double quote inside a term is doubled, so the term stays one string.
  assert.equal(buildFtsQuery('foo"bar'), '"foo""bar"*')
  const hostile = buildFtsQuery('x" OR value:secret OR namespace:"')
  // Every emitted token is a quoted string; no bare boolean operator escapes.
  const tokens = hostile.split(' OR ')
  for (const token of tokens) {
    assert.match(token, /^"[^"]*(""[^"]*)*"\*?$/, `token stays quoted: ${token}`)
  }
  assert.equal(hostile.includes(' OR value'), false)
})

test('hostile term cannot read another namespace through the real query', () => {
  const dbPath = makeStore([
    { namespace: 'private', key: 'secret', value: 'nothing to see' },
    { namespace: 'default', key: 'public', value: 'shared note' },
  ])
  const result = buildMemoryInjection(
    [userMessage('" OR namespace:private OR value:secret OR "')],
    enabled(),
    { dbPath, now },
  )
  // Nothing leaks: the quoted terms match no row, and no row is returned.
  assert.equal(result.text, null)
  assert.notEqual(result.skip, null)
})

test('the builder produces an executable expression against an in-memory store', () => {
  // An in-memory fixture: same schema, no files. This is what makes builder
  // drift catchable — a changed stopword/prefix rule shows up as a different
  // result set, not just a different string.
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(SCHEMA)
    const insert = db.prepare(
      "INSERT INTO memories (namespace, key, value, metadata, created_at) VALUES (?, ?, ?, '{}', ?)",
    )
    insert.run('default', 'a', 'changelog drift guard', '2026-01-01T00:00:00Z')
    insert.run('default', 'b', 'unrelated css work', '2026-01-01T00:00:00Z')
    insert.run('default', 'c', 'the a of to', '2026-01-01T00:00:00Z')
    db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")

    const query = buildFtsQuery('the changelog drift')
    assert.equal(query, '"changelog"* OR "drift"*')
    const rows = db
      .prepare(
        `SELECT memories.key AS key FROM memories_fts
         JOIN memories ON memories.id = memories_fts.rowid
         WHERE memories_fts MATCH ? ORDER BY rank`,
      )
      .all(query) as { key: string }[]
    assert.deepEqual(
      rows.map((row) => row.key),
      ['a'],
    )

    // Every token a stopword: no expression, so no query is attempted.
    assert.equal(buildFtsQuery('the a of to'), '')
    // Porter stemming plus the prefix rule reaches an inflected form: the
    // plural query term finds the singular stored word.
    const stemmed = db
      .prepare(
        'SELECT memories.key AS key FROM memories_fts JOIN memories ON memories.id = memories_fts.rowid WHERE memories_fts MATCH ?',
      )
      .all(buildFtsQuery('changelogs')) as { key: string }[]
    assert.deepEqual(
      stemmed.map((row) => row.key),
      ['a'],
    )
  } finally {
    db.close()
  }
})

test('term count is capped so a huge prompt cannot build a huge expression', () => {
  const words = Array.from({ length: 80 }, (_, i) => `term${i}zz`)
  const expression = buildFtsQuery(words.join(' '))
  assert.equal(expression.split(' OR ').length, 32)
})

// ─── Message extraction ────────────────────────────────────────────────

test('first user message is used, not later turns', () => {
  const messages = [
    { role: 'system', content: 'ignored' },
    userMessage('first question about memory'),
    { role: 'assistant', content: [{ type: 'text', text: 'an answer' }] },
    userMessage('second question'),
  ]
  assert.equal(extractFirstUserText(messages), 'first question about memory')
  assert.equal(extractFirstUserText([]), null)
  assert.equal(extractFirstUserText('not-an-array'), null)
  assert.equal(extractFirstUserText([{ role: 'assistant', content: 'x' }]), null)
  assert.equal(
    extractFirstUserText([{ role: 'user', content: [{ type: 'image', text: '' }] }]),
    null,
  )
})

// ─── Query behaviour against the real schema ───────────────────────────

test('injects the top-K entries for the first user message', () => {
  const dbPath = makeStore([
    { namespace: 'default', key: 'release', value: 'changelog must be updated before a release' },
    { namespace: 'default', key: 'tests', value: 'run the changelog drift test after edits' },
    { namespace: 'default', key: 'other', value: 'unrelated content about css' },
  ])
  const result = buildMemoryInjection([userMessage('update the changelog')], enabled(), {
    dbPath,
    now,
  })
  assert.equal(result.skip, null)
  assert.ok(result.text)
  assert.ok(result.text.startsWith(MEMORY_CONTEXT_MARKER))
  assert.equal(result.entries, 2)
  assert.match(result.text, /default\/release/)
  assert.match(result.text, /default\/tests/)
  assert.doesNotMatch(result.text, /default\/other/)
  assert.equal(result.chars, result.text.length)
})

test('K cap limits how many entries are injected', () => {
  const dbPath = makeStore([
    { namespace: 'default', key: 'a', value: 'changelog alpha' },
    { namespace: 'default', key: 'b', value: 'changelog beta' },
    { namespace: 'default', key: 'c', value: 'changelog gamma' },
  ])
  const result = buildMemoryInjection([userMessage('changelog')], enabled({ maxEntries: 1 }), {
    dbPath,
    now,
  })
  assert.equal(result.entries, 1)
  assert.equal(result.text?.match(/^- /gm)?.length, 1)
})

test('expired entries are excluded, future and NULL expiry survive', () => {
  const dbPath = makeStore([
    {
      namespace: 'default',
      key: 'past',
      value: 'stale note one',
      expiresAt: '2026-01-02T00:00:00Z',
    },
    {
      namespace: 'default',
      key: 'future',
      value: 'stale note two',
      expiresAt: '2027-01-01T00:00:00Z',
    },
    { namespace: 'default', key: 'never', value: 'stale note three', expiresAt: null },
  ])
  const result = buildMemoryInjection([userMessage('stale note')], enabled(), { dbPath, now })
  assert.equal(result.skip, null)
  assert.doesNotMatch(result.text ?? '', /default\/past/)
  assert.match(result.text ?? '', /default\/future/)
  assert.match(result.text ?? '', /default\/never/)
})

test('a store without expires_at (pre-TTL schema) still injects', () => {
  const dbPath = makeStore(
    [{ namespace: 'default', key: 'legacy', value: 'legacy entry about deployments' }],
    { withExpiry: false },
  )
  const result = buildMemoryInjection([userMessage('deployment notes')], enabled(), {
    dbPath,
    now,
  })
  assert.equal(result.skip, null, result.detail)
  assert.match(result.text ?? '', /default\/legacy/)
})

test('namespace defaults to no filter and can be narrowed', () => {
  const dbPath = makeStore([
    { namespace: 'default', key: 'k1', value: 'deployment checklist default' },
    { namespace: 'project-x', key: 'k2', value: 'deployment checklist project' },
  ])
  const all = buildMemoryInjection([userMessage('deployment checklist')], enabled(), {
    dbPath,
    now,
  })
  assert.match(all.text ?? '', /default\/k1/)
  assert.match(all.text ?? '', /project-x\/k2/)

  const narrowed = buildMemoryInjection(
    [userMessage('deployment checklist')],
    enabled({ namespace: 'project-x' }),
    { dbPath, now },
  )
  assert.match(narrowed.text ?? '', /project-x\/k2/)
  assert.doesNotMatch(narrowed.text ?? '', /default\/k1/)
  assert.equal(narrowed.entries, 1)
})

// ─── Budget ────────────────────────────────────────────────────────────

test('total characters never exceed the budget and long entries are truncated', () => {
  const dbPath = makeStore([
    { namespace: 'default', key: 'long', value: 'truncate '.repeat(400) },
    { namespace: 'default', key: 'short', value: 'truncate too' },
  ])
  for (const maxChars of [1400, 900, 400, 240, 160]) {
    const result = buildMemoryInjection([userMessage('truncate')], enabled({ maxChars }), {
      dbPath,
      now,
    })
    assert.ok(result.text, `payload exists at ${maxChars}`)
    assert.ok(result.text.length <= maxChars, `${result.text.length} <= ${maxChars}`)
    assert.ok(
      result.text.includes(TRUNCATION_SUFFIX),
      `a 3600-char entry is truncated at ${maxChars}`,
    )
  }
  // Both matching entries get a slice of the budget, not just the longest one.
  const split = buildMemoryInjection([userMessage('truncate')], enabled({ maxChars: 480 }), {
    dbPath,
    now,
  })
  assert.equal(split.entries, 2)
  assert.match(split.text ?? '', /default\/short/)
  const tiny = buildMemoryInjection([userMessage('truncate')], enabled({ maxChars: 100 }), {
    dbPath,
    now,
  })
  assert.equal(tiny.text, null, 'a budget below the header injects nothing')
  assert.equal(tiny.skip, 'empty')
})

test('renderMemoryContext is the single budget authority', () => {
  const rows = [
    { namespace: 'default', key: 'a', value: 'x'.repeat(500), created_at: '' },
    { namespace: 'default', key: 'b', value: 'y'.repeat(500), created_at: '' },
  ]
  for (const budget of [1200, 600, 300, 160]) {
    const rendered = renderMemoryContext(rows, budget, 2)
    assert.ok(rendered)
    assert.ok(rendered.text.length <= budget)
    assert.deepEqual(systemTexts([{ type: 'text', text: rendered.text }]).length, 1)
  }
  assert.equal(renderMemoryContext([], 1200), null)
})

// ─── Fail-open paths ───────────────────────────────────────────────────

test('missing database is a silent no-op', () => {
  const dir = tempDir('pantheon-memory-missing-')
  const result = buildMemoryInjection([userMessage('anything at all')], enabled(), {
    dbPath: join(dir, 'memory', 'memory.db'),
    now,
  })
  assert.equal(result.text, null)
  assert.equal(result.skip, 'no-db')
})

test('a database without the memory schema is a silent no-op', () => {
  const dir = tempDir('pantheon-memory-schema-')
  const dbPath = join(dir, 'memory.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)')
  db.close()
  const result = buildMemoryInjection([userMessage('anything at all')], enabled(), {
    dbPath,
    now,
  })
  assert.equal(result.text, null)
  assert.equal(result.skip, 'schema')
  assert.match(result.detail ?? '', /memories/)
})

test('a runtime without node:sqlite is a silent no-op', () => {
  const dir = tempDir('pantheon-memory-nosqlite-')
  const result = buildMemoryInjection([userMessage('anything at all')], enabled(), {
    dbPath: join(dir, 'memory.db'),
    sqliteLoader: () => null,
    now,
  })
  assert.equal(result.text, null)
  assert.equal(result.skip, 'no-sqlite')
})

test('disabled config never opens the database', () => {
  const result = buildMemoryInjection(
    [userMessage('anything at all')],
    DEFAULT_MEMORY_INJECTION_CONFIG,
    {
      sqliteLoader: () => {
        throw new Error('the store must not be touched while disabled')
      },
    },
  )
  assert.equal(result.text, null)
  assert.equal(result.skip, 'disabled')
})

test('config defaults are opt-in and defensive', () => {
  assert.deepEqual(resolveMemoryInjectionConfig(undefined), DEFAULT_MEMORY_INJECTION_CONFIG)
  assert.deepEqual(resolveMemoryInjectionConfig({ memory_injection: 'nope' }), {
    ...DEFAULT_MEMORY_INJECTION_CONFIG,
  })
  assert.deepEqual(
    resolveMemoryInjectionConfig({
      memory_injection: { enabled: true, maxEntries: 999, maxChars: 10, namespace: '  ' },
    }),
    { enabled: true, maxEntries: 10, maxChars: 100, namespace: null },
  )
  assert.deepEqual(
    resolveMemoryInjectionConfig({
      memory_injection: { enabled: false, maxEntries: 2, maxChars: 500, namespace: ' proj ' },
    }),
    { enabled: false, maxEntries: 2, maxChars: 500, namespace: 'proj' },
  )
  assert.deepEqual(describeMemoryInjectionConfigIssues({ memory_injection: { enabled: 'yes' } }), [
    '"enabled" must be a boolean',
  ])
  assert.deepEqual(describeMemoryInjectionConfigIssues({ memory_injection: { maxEntry: 2 } }), [
    'unknown key "maxEntry"',
  ])
  assert.deepEqual(describeMemoryInjectionConfigIssues({}), [])
  assert.deepEqual(describeMemoryInjectionConfigIssues({ memory_injection: { namespace: 5 } }), [
    '"namespace" must be a string or null',
  ])
  assert.deepEqual(
    [...MEMORY_INJECTION_CONFIG_KEYS],
    ['enabled', 'maxEntries', 'maxChars', 'namespace'],
  )
})

test('db path mirrors _pantheon_paths.py', () => {
  assert.equal(resolveMemoryDbPath({ PANTHEON_HOME: '/tmp/home' }), '/tmp/home/memory/memory.db')
  assert.equal(
    resolveMemoryDbPath({ PANTHEON_HOME: '', XDG_CONFIG_HOME: '/tmp/xdg' }),
    '/tmp/xdg/opencode/memory/memory.db',
  )
})

// ─── Session cache ─────────────────────────────────────────────────────

test('the payload is computed once per session and stays bounded', () => {
  const cache = new MemoryInjectionCache()
  let calls = 0
  const compute = () => {
    calls++
    return { text: 'payload', entries: 1, chars: 7, skip: null }
  }
  const first = cache.resolve('ses_a', compute)
  const second = cache.resolve('ses_a', compute)
  assert.equal(first, second, 'the same payload object is replayed')
  assert.equal(calls, 1, 'one query for the session')
  cache.resolve('ses_b', compute)
  assert.equal(calls, 2)

  for (let i = 0; i < 200; i++) cache.resolve(`ses_${i}`, compute)
  assert.ok(cache.size <= 64, `cache stays bounded (size=${cache.size})`)
  cache.delete('ses_b')
  cache.clear()
  assert.equal(cache.size, 0)
  // A missing session id cannot be keyed, so it is never cached.
  assert.equal(cache.resolve(undefined, compute).text, 'payload')
  assert.equal(cache.size, 0)
})

test('a failed lookup is cached too, so a broken store is probed once', () => {
  const cache = new MemoryInjectionCache()
  let calls = 0
  const compute = () => {
    calls++
    return { text: null, entries: 0, chars: 0, skip: 'no-db' as const }
  }
  cache.resolve('ses_x', compute)
  cache.resolve('ses_x', compute)
  assert.equal(calls, 1)
})

test('marker detection accepts the measured part shape and bare strings', () => {
  assert.equal(hasMemoryContextMarker([{ type: 'text', text: MEMORY_CONTEXT_MARKER }]), true)
  assert.equal(hasMemoryContextMarker([MEMORY_CONTEXT_MARKER]), true)
  assert.equal(hasMemoryContextMarker([{ type: 'text', text: 'policy' }]), false)
  assert.equal(hasMemoryContextMarker([null, 7, {}]), false)
  assert.equal(hasMemoryContextMarker('not-an-array'), false)
  assert.equal(hasMemoryContextMarker(undefined), false)
})

test('the log line is written once per session and stays silent on ordinary misses', () => {
  resetMemoryInjectionLogState()
  const seen = new Set<string>()
  const ok = { text: 'payload', entries: 2, chars: 7, skip: null }
  assert.equal(
    formatMemoryInjectionLogLine('ses_log', ok, seen),
    '[memory-context] injected entries=2 chars=7 session=ses_log',
  )
  assert.equal(formatMemoryInjectionLogLine('ses_log', ok, seen), null, 'second request is silent')
  assert.equal(
    formatMemoryInjectionLogLine(
      'ses_other',
      { text: null, entries: 0, chars: 0, skip: 'empty' },
      seen,
    ),
    null,
  )
  assert.equal(
    formatMemoryInjectionLogLine(
      'ses_other',
      { text: null, entries: 0, chars: 0, skip: 'no-terms' },
      seen,
    ),
    null,
  )
  assert.equal(
    formatMemoryInjectionLogLine(
      'ses_broken',
      { text: null, entries: 0, chars: 0, skip: 'no-db' },
      seen,
    ),
    '[memory-context] no injection session=ses_broken skip=no-db',
  )
  assert.equal(
    formatMemoryInjectionLogLine(
      'ses_schema',
      { text: null, entries: 0, chars: 0, skip: 'schema', detail: 'missing table(s) memories' },
      seen,
    ),
    '[memory-context] no injection session=ses_schema skip=schema: missing table(s) memories',
  )
  for (let i = 0; i < MEMORY_INJECTION_LOG_MAX_SESSIONS + 5; i++) {
    formatMemoryInjectionLogLine(`ses_${i}`, ok, seen)
  }
  assert.ok(seen.size <= MEMORY_INJECTION_LOG_MAX_SESSIONS)
})

test('an invalid config is reported once and resolution keeps the defaults', () => {
  resetMemoryInjectionConfigWarned()
  const lines: string[] = []
  warnInvalidMemoryInjectionConfig({ memory_injection: { maxEntry: 5, enabled: 'yes' } }, (line) =>
    lines.push(line),
  )
  warnInvalidMemoryInjectionConfig({ memory_injection: { maxEntry: 5, enabled: 'yes' } }, (line) =>
    lines.push(line),
  )
  assert.equal(lines.length, 1, 'one line per process')
  assert.match(lines[0], /\[memory-context\] ignored invalid memory_injection config/)
  assert.match(lines[0], /"enabled" must be a boolean/)
  assert.match(lines[0], /unknown key "maxEntry"/)
  assert.match(lines[0], /accepted keys: enabled, maxEntries, maxChars, namespace/)
  assert.deepEqual(resolveMemoryInjectionConfig({ memory_injection: { enabled: 'yes' } }), {
    ...DEFAULT_MEMORY_INJECTION_CONFIG,
  })
  const silent: string[] = []
  resetMemoryInjectionConfigWarned()
  warnInvalidMemoryInjectionConfig({}, (line) => silent.push(line))
  warnInvalidMemoryInjectionConfig(undefined, (line) => silent.push(line))
  assert.deepEqual(silent, [])
})

test('applyMemoryInjection appends one valid part and never duplicates it', () => {
  const dbPath = makeStore([
    { namespace: 'default', key: 'k', value: 'apply memory injection works' },
  ])
  const previousHome = process.env.PANTHEON_HOME
  // The module resolves the store from the environment; point it at the fixture.
  process.env.PANTHEON_HOME = dirname(dirname(dbPath))
  try {
    const cache = new MemoryInjectionCache()
    const lines: string[] = []
    const log = (line: string) => lines.push(line)
    const config = enabled()
    const system: unknown[] = [{ type: 'text', text: 'HOST' }]

    applyMemoryInjection(system, [userMessage('apply injection')], 'ses_apply', config, cache, log)
    assert.equal(system.length, 2)
    const part = system[1] as { type: string; text: string }
    assert.equal(part.type, 'text', 'only a { type, text } part is pushed')
    assert.ok(part.text.startsWith(MEMORY_CONTEXT_MARKER))

    applyMemoryInjection(system, [userMessage('apply injection')], 'ses_apply', config, cache, log)
    assert.equal(system.length, 2, 'a marked system is left alone')
    assert.equal(lines.filter((line) => line.includes('injected')).length, 1, 'logged once')

    // Disabled: nothing is pushed and no store is opened.
    const untouched: unknown[] = [{ type: 'text', text: 'HOST' }]
    applyMemoryInjection(
      untouched,
      [userMessage('apply injection')],
      'ses_off',
      {
        ...DEFAULT_MEMORY_INJECTION_CONFIG,
      },
      cache,
      log,
    )
    assert.equal(untouched.length, 1)

    // A non-array system is left alone rather than coerced.
    applyMemoryInjection('nope', [userMessage('x')], 'ses_bad', config, cache, log)
  } finally {
    if (previousHome === undefined) delete process.env.PANTHEON_HOME
    else process.env.PANTHEON_HOME = previousHome
  }
})

// ─── Wiring through the real registered context handler ────────────────

type Hook = (event: unknown) => unknown

interface CapturedHooks {
  context?: Hook
}

async function setupPlugin(
  options: Record<string, unknown>,
  captured: CapturedHooks,
): Promise<void> {
  await plugin.setup({
    options,
    agent: { transform: async () => ({ dispose: async () => {} }) },
    catalog: { transform: async () => ({ dispose: async () => {} }) },
    command: { transform: async () => ({ dispose: async () => {} }) },
    reference: { transform: async () => ({ dispose: async () => {} }) },
    skill: { transform: async () => ({ dispose: async () => {} }) },
    session: {
      hook: async (name: string, handler: Hook) => {
        if (name === 'context') captured.context = handler
        return { dispose: async () => {} }
      },
    },
  } as never)
  assert.equal(typeof captured.context, 'function', 'the context hook was registered')
}

function contextEvent(
  sessionID: string,
  text: string,
  system?: unknown[],
): Record<string, unknown> {
  return {
    sessionID,
    model: { id: 'fake-1', providerID: 'fakeprov' },
    system: system ?? [{ type: 'text', text: 'HOST SYSTEM' }],
    messages: [userMessage(text)],
    options: { maxTokens: 8192 },
    agent: 'zeus',
    tools: {},
  }
}

await testAsync('disabled by default: system is byte-identical to no config', async () => {
  const withoutConfig: CapturedHooks = {}
  await setupPlugin({}, withoutConfig)
  const noConfig = contextEvent('ses_contract_disabled_a', 'changelog deployment notes')
  withoutConfig.context?.(noConfig)

  const explicitlyOff: CapturedHooks = {}
  await setupPlugin({ memory_injection: { enabled: false } }, explicitlyOff)
  const offEvent = contextEvent('ses_contract_disabled_b', 'changelog deployment notes')
  explicitlyOff.context?.(offEvent)

  assert.equal(JSON.stringify(offEvent.system), JSON.stringify(noConfig.system))
  const texts = systemTexts(noConfig.system)
  assert.equal(texts.length, 2, 'only the host part and the policy part')
  assert.match(texts[1], /Pantheon routing policy/)
  for (const text of texts) assert.equal(text.includes(MEMORY_CONTEXT_MARKER), false)
})

await testAsync(
  'enabled: the payload is injected once and replayed without duplication',
  async () => {
    const store = makeStore([
      { namespace: 'default', key: 'release', value: 'changelog must be updated before a release' },
      { namespace: 'default', key: 'drift', value: 'changelog drift test pins the python builder' },
    ])
    const previousHome = process.env.PANTHEON_HOME
    // `makeStore` writes `<home>/memory/memory.db`; the plugin resolves the same
    // path from the environment, so point it at that home for this test only.
    process.env.PANTHEON_HOME = dirname(dirname(store))
    try {
      const captured: CapturedHooks = {}
      await setupPlugin({ memory_injection: { enabled: true } }, captured)

      const first = contextEvent('ses_contract_memory_1', 'update the changelog')
      captured.context?.(first)
      const firstTexts = systemTexts(first.system)
      const injected = firstTexts.filter((text) => text.includes(MEMORY_CONTEXT_MARKER))
      assert.equal(injected.length, 1, 'exactly one injected part on the first request')
      assert.match(injected[0], /default\/release/)
      assert.match(injected[0], /default\/drift/)
      assert.equal(firstTexts[0], 'HOST SYSTEM')
      assert.match(firstTexts[1], /Pantheon routing policy/)

      // A second request of the same session re-adds the same text, once.
      const second = contextEvent('ses_contract_memory_1', 'update the changelog')
      captured.context?.(second)
      const secondTexts = systemTexts(second.system)
      assert.equal(
        secondTexts.filter((text) => text.includes(MEMORY_CONTEXT_MARKER)).length,
        1,
        'the marker prevents a duplicate',
      )
      assert.equal(secondTexts[2], injected[0], 'the cached payload is replayed verbatim')

      // A third request with the marker already present adds nothing.
      const third = contextEvent('ses_contract_memory_1', 'update the changelog', [
        { type: 'text', text: 'HOST SYSTEM' },
        { type: 'text', text: injected[0] },
      ])
      captured.context?.(third)
      assert.equal(
        systemTexts(third.system).filter((text) => text.includes(MEMORY_CONTEXT_MARKER)).length,
        1,
      )
    } finally {
      if (previousHome === undefined) delete process.env.PANTHEON_HOME
      else process.env.PANTHEON_HOME = previousHome
    }
  },
)

await testAsync('a missing store logs one line per session and injects nothing', async () => {
  const previousCwd = process.cwd()
  const previousHome = process.env.PANTHEON_HOME
  const emptyHome = tempDir('pantheon-memory-empty-home-')
  const logCwd = tempDir('pantheon-memory-log-')
  process.env.PANTHEON_HOME = emptyHome
  try {
    const captured: CapturedHooks = {}
    await setupPlugin({ memory_injection: { enabled: true } }, captured)
    process.chdir(logCwd)

    const event = contextEvent('ses_contract_memory_missing', 'anything about memory')
    captured.context?.(event)
    assert.equal(systemTexts(event.system).length, 2, 'policy only, no injected part')

    captured.context?.(event)
    const log = readFileSync(join(logCwd, '.pantheon', 'logs', 'hooks.log'), 'utf8')
    const lines = log
      .split('\n')
      .filter((line) => line.includes('[memory-context]') && line.includes('skip=no-db'))
    assert.equal(lines.length, 1, `exactly one diagnostic line, got:\n${log}`)
  } finally {
    process.chdir(previousCwd)
    if (previousHome === undefined) delete process.env.PANTHEON_HOME
    else process.env.PANTHEON_HOME = previousHome
  }
})

await testAsync(
  'an invalid config block is reported once and does not disable defaults',
  async () => {
    const previousCwd = process.cwd()
    const logCwd = tempDir('pantheon-memory-config-log-')
    try {
      process.chdir(logCwd)
      const captured: CapturedHooks = {}
      await setupPlugin({ memory_injection: { enable: true, maxEntry: 3 } }, captured)
      const log = readFileSync(join(logCwd, '.pantheon', 'logs', 'hooks.log'), 'utf8')
      assert.match(log, /\[memory-context\] ignored invalid memory_injection config/)
      assert.match(log, /unknown key "enable"/)
      assert.match(log, /unknown key "maxEntry"/)
      assert.match(log, /accepted keys: enabled, maxEntries, maxChars, namespace/)
      // A typo leaves injection disabled rather than half-configured.
      const event = contextEvent('ses_contract_memory_typo', 'anything about memory')
      captured.context?.(event)
      assert.equal(systemTexts(event.system).length, 2)
    } finally {
      process.chdir(previousCwd)
    }
  },
)

test('an unexpected query failure logs a stable code, never the match text', () => {
  // A `memories_fts` PLAIN TABLE repros the real hazard: the failing statement
  // carries the MATCH expression, which is built from the user's first message.
  const dir = tempDir('pantheon-memory-broken-fts-')
  const dbPath = join(dir, 'memory.db')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(
      'CREATE TABLE memories (id INTEGER PRIMARY KEY, namespace TEXT, key TEXT, value TEXT, created_at TEXT)',
    )
    db.exec(
      'CREATE TABLE memories_fts (id INTEGER, namespace TEXT, key TEXT, value TEXT, created_at TEXT)',
    )
    db.exec(
      "INSERT INTO memories VALUES (1, 'default', 'k', 'changelog drift', '2026-01-01T00:00:00Z')",
    )
  } finally {
    db.close()
  }

  const previous = process.env[MEMORY_INJECTION_DEBUG_ENV]
  delete process.env[MEMORY_INJECTION_DEBUG_ENV]
  try {
    const secretPrompt = 'super-secret-prompt-term about the changelog'
    const result = buildMemoryInjection([userMessage(secretPrompt)], enabled(), { dbPath, now })
    assert.equal(result.text, null)
    assert.equal(result.skip, 'error')
    assert.equal(result.detail, 'code=ERR_SQLITE_ERROR')
    assert.doesNotMatch(result.detail ?? '', /super-secret-prompt-term/)
    assert.doesNotMatch(result.detail ?? '', /changelog/i, 'no prompt fragment survives')
    assert.doesNotMatch(result.detail ?? '', /MATCH|SELECT/i, 'no SQL text survives')

    process.env[MEMORY_INJECTION_DEBUG_ENV] = '1'
    const verbose = buildMemoryInjection([userMessage(secretPrompt)], enabled(), { dbPath, now })
    assert.equal(verbose.skip, 'error')
    assert.match(verbose.detail ?? '', /^code=ERR_SQLITE_ERROR message=/)
  } finally {
    if (previous === undefined) delete process.env[MEMORY_INJECTION_DEBUG_ENV]
    else process.env[MEMORY_INJECTION_DEBUG_ENV] = previous
  }
})

test('the error classification is an enum, never a message body', () => {
  assert.equal(classifyMemoryError({ code: 'ERR_SQLITE_ERROR' }), 'ERR_SQLITE_ERROR')
  assert.equal(classifyMemoryError(new TypeError('boom')), 'TypeError')
  assert.equal(classifyMemoryError(new Error('boom')), 'unknown')
  assert.equal(classifyMemoryError({ code: 'not a code' }), 'unknown')
  assert.equal(classifyMemoryError(null), 'unknown')
  assert.equal(classifyMemoryError('plain string'), 'unknown')
  const previous = process.env[MEMORY_INJECTION_DEBUG_ENV]
  try {
    delete process.env[MEMORY_INJECTION_DEBUG_ENV]
    const error = Object.assign(new Error('SELECT * FROM memories WHERE value = "user text"'), {
      code: 'ERR_SQLITE_ERROR',
    })
    assert.equal(errorDetail(error), 'code=ERR_SQLITE_ERROR')
    assert.doesNotMatch(errorDetail(error), /user text/)
    process.env[MEMORY_INJECTION_DEBUG_ENV] = '1'
    assert.match(errorDetail(error), /^code=ERR_SQLITE_ERROR message=SELECT \* FROM memories/)
  } finally {
    if (previous === undefined) delete process.env[MEMORY_INJECTION_DEBUG_ENV]
    else process.env[MEMORY_INJECTION_DEBUG_ENV] = previous
  }
})

await testAsync(
  'enabled with no system reports skip=no-system instead of going inert',
  async () => {
    const previousCwd = process.cwd()
    const previousHome = process.env.PANTHEON_HOME
    const logCwd = tempDir('pantheon-memory-nosystem-log-')
    const store = makeStore([{ namespace: 'default', key: 'k', value: 'changelog release notes' }])
    process.env.PANTHEON_HOME = dirname(dirname(store))
    try {
      const captured: CapturedHooks = {}
      await setupPlugin({ memory_injection: { enabled: true } }, captured)
      process.chdir(logCwd)

      // No `system` at all: the host shape on which the old code was silent.
      const event: Record<string, unknown> = {
        sessionID: 'ses_contract_memory_nosystem',
        model: { id: 'fake-1', providerID: 'fakeprov' },
        messages: [userMessage('update the changelog')],
        options: { maxTokens: 8192 },
        agent: 'zeus',
        tools: {},
      }
      captured.context?.(event)
      assert.equal('system' in event, false, 'no system key is created where the host sent none')
      assert.equal(event.system, undefined, 'nothing is pushed when there is no system array')

      // A retry must not add a second line.
      captured.context?.(event)
      const log = readFileSync(join(logCwd, '.pantheon', 'logs', 'hooks.log'), 'utf8')
      const lines = log
        .split('\n')
        .filter((line) => line.includes('[memory-context]') && line.includes('skip=no-system'))
      assert.equal(lines.length, 1, `exactly one diagnostic line, got:\n${log}`)
      assert.match(lines[0], /session=ses_contract_memory_nosystem/)
      assert.match(lines[0], /system absent/)

      // A non-array system (malformed host) is reported too, never coerced.
      const malformed: Record<string, unknown> = {
        sessionID: 'ses_contract_memory_badsystem',
        system: { oops: true },
        messages: [userMessage('update the changelog')],
      }
      captured.context?.(malformed)
      assert.deepEqual(malformed.system, { oops: true }, 'the host value is left untouched')
      const log2 = readFileSync(join(logCwd, '.pantheon', 'logs', 'hooks.log'), 'utf8')
      assert.match(log2, /skip=no-system: system is not an array/)
    } finally {
      process.chdir(previousCwd)
      if (previousHome === undefined) delete process.env.PANTHEON_HOME
      else process.env.PANTHEON_HOME = previousHome
    }
  },
)

await testAsync('disabled: system bytes are unchanged and the store is never opened', async () => {
  const previousCwd = process.cwd()
  const previousHome = process.env.PANTHEON_HOME
  const logCwd = tempDir('pantheon-memory-disabled-log-')
  const home = tempDir('pantheon-memory-disabled-home-')
  // A DIRECTORY where memory/memory.db would be: any read attempt must fail and
  // log `skip=no-db`, which is what makes "no line at all" a proof of no touch.
  mkdirSync(join(home, 'memory', 'memory.db'), { recursive: true })
  process.env.PANTHEON_HOME = home
  try {
    // The no-config baseline first: the hook itself adds the routing policy, so
    // "unchanged" means "identical to what the hook did before this feature",
    // byte for byte.
    const baseline: CapturedHooks = {}
    await setupPlugin({}, baseline)
    const baseEvent = contextEvent('ses_contract_memory_base', 'update the changelog')
    baseline.context?.(baseEvent)

    const off: CapturedHooks = {}
    await setupPlugin({ memory_injection: { enabled: false } }, off)
    const offEvent = contextEvent('ses_contract_memory_off', 'update the changelog')
    off.context?.(offEvent)
    assert.equal(
      JSON.stringify(offEvent.system),
      JSON.stringify(baseEvent.system),
      'disabled is byte-identical to no config at all',
    )

    process.chdir(logCwd)
    off.context?.(contextEvent('ses_contract_memory_off_2', 'update the changelog'))
    const after = readHookLog(logCwd)
    assert.doesNotMatch(after, /\[memory-context\]/, 'disabled touches neither store nor log')

    // Control: the same store WITH the feature enabled does log an attempt, so
    // the silence above really means "never opened".
    const on: CapturedHooks = {}
    await setupPlugin({ memory_injection: { enabled: true } }, on)
    on.context?.(contextEvent('ses_contract_memory_on_control', 'update the changelog'))
    const control = readHookLog(logCwd)
    assert.match(control, /\[memory-context\] no injection .* skip=no-db/)
  } finally {
    process.chdir(previousCwd)
    if (previousHome === undefined) delete process.env.PANTHEON_HOME
    else process.env.PANTHEON_HOME = previousHome
  }
})

// ─── Report ────────────────────────────────────────────────────────────

for (const dir of tempDirs) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup.
  }
}

const passed = results.filter((r) => r.passed).length
const failed = results.filter((r) => !r.passed)

console.log('')
for (const r of results) {
  console.log(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? `: ${r.error}` : ''}`)
}
console.log(`\nResults: ${passed} passed, ${failed.length} failed`)
process.exit(failed.length > 0 ? 1 : 0)
