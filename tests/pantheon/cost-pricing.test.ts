/**
 * Tests for the money + attribution half of `pantheon_cost` and for the
 * offline-safe pricing module it uses.
 *
 * Scope, deliberately narrow so it does not restate `cost-command.test.ts`:
 *   1. cost math, table-driven — input/output/cache rates, a free model priced
 *      at a real zero, and a cache token that has no rate;
 *   2. price resolution — exact provider/model, provider-less fallback,
 *      unknown and ambiguous models;
 *   3. the report path — cost attributed per model and summed onto the agent,
 *      an unpriced model excluded from both dollar totals with a one-line
 *      reconciliation, and `—` for a row with nothing priceable;
 *   4. the session view — a root session plus its descendants, excluding an
 *      unrelated session;
 *   5. offline behaviour — cached prices without a network call, a stale cache
 *      refreshed in the BACKGROUND, an explicit `refreshPricing` refresh, and
 *      every network/parse failure degrading to "pricing unavailable" with the
 *      token report intact.
 *
 * No test reaches the network: every fetch is injected, and every cache path
 * points inside a temp directory.
 *
 * Run with: npx tsx tests/pantheon/cost-pricing.test.ts
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createCostCommand } from '../../src/pantheon/cost-command.ts'
import {
  computeModelCost,
  type FetchLike,
  forceRefreshPricing,
  loadPricing,
  lookupModelPrice,
  type ModelPrice,
  type PricingSnapshot,
  parseCatalogPayload,
} from '../../src/pantheon/model-pricing.ts'

// ─── Harness ───────────────────────────────────────────────────────────

const results: { name: string; passed: boolean; error?: string }[] = []

// Every pricing assertion pins its own cache path and fetch boundary. Ambient
// switches must not decide whether a test reaches the network.
delete process.env.PANTHEON_COST_OFFLINE

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    results.push({ name, passed: true })
  } catch (error: unknown) {
    results.push({
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'pantheon-cost-pricing-'))
}

/** A catalog shaped like models.dev, small enough to read in a diff. */
const CATALOG: Record<string, unknown> = {
  acme: {
    models: {
      alpha: { cost: { input: 1, output: 2, cache_read: 0.5, cache_write: 4 } },
      free: { cost: { input: 0, output: 0 } },
      // Publishes no cache rates at all — cache tokens must NOT be free.
      nocache: { cost: { input: 1, output: 2 } },
      // Same price under two providers ⇒ not ambiguous.
      twin: { cost: { input: 5, output: 5 } },
    },
  },
  second: {
    models: {
      twin: { cost: { input: 5, output: 5 } },
      // Two DIFFERENT prices for one id ⇒ ambiguous, never guessed.
      ambig: { cost: { input: 9, output: 9 } },
    },
  },
  third: { models: { ambig: { cost: { input: 1, output: 1 } } } },
}

function catalogFetch(): FetchLike & { calls: number } {
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    json: async () => CATALOG,
  })) as FetchLike & { calls: number }
  fetchImpl.calls = 0
  const wrapped = (async (url: string, init: { signal?: AbortSignal }) => {
    fetchImpl.calls += 1
    return fetchImpl(url, init)
  }) as FetchLike & { calls: number }
  Object.defineProperty(wrapped, 'calls', { get: () => fetchImpl.calls })
  return wrapped
}

function failingFetch(message = 'network down'): FetchLike & { calls: number } {
  const state = { calls: 0 }
  const wrapped = (async () => {
    state.calls += 1
    throw new Error(message)
  }) as FetchLike & { calls: number }
  Object.defineProperty(wrapped, 'calls', { get: () => state.calls })
  return wrapped
}

/** Write the normalized cache a successful refresh produces. */
function writeCache(path: string, fetchedAt: number): void {
  writeFileSync(
    path,
    JSON.stringify({ version: 1, fetchedAt, providers: parseCatalogPayload(CATALOG) }),
  )
}

const OFFLINE = { offline: true } as const

// ─── 1. Cost math (table-driven) ───────────────────────────────────────

await testAsync('computeModelCost prices input, output and cache tokens', async () => {
  const price: ModelPrice = {
    inputPerMTok: 1,
    outputPerMTok: 2,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 4,
  }
  const cases: Array<{
    name: string
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
    usd: number
  }> = [
    {
      name: 'input + output only',
      tokens: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
      usd: 3,
    },
    {
      name: 'cache read is billed at its own rate, not the input rate',
      tokens: { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 },
      usd: 0.5,
    },
    {
      name: 'cache write is billed at its own rate',
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 },
      usd: 4,
    },
    {
      name: 'every component together',
      tokens: { input: 2_000_000, output: 500_000, cacheRead: 1_000_000, cacheWrite: 250_000 },
      usd: 2 + 1 + 0.5 + 1,
    },
  ]
  for (const testCase of cases) {
    const result = computeModelCost(price, testCase.tokens)
    assert.ok(result.ok, `${testCase.name}: expected a price`)
    assert.equal(result.usd, testCase.usd, testCase.name)
  }
})

await testAsync('a free model is priced at a real zero, not marked unpriced', async () => {
  const result = computeModelCost(
    { inputPerMTok: 0, outputPerMTok: 0 },
    { input: 5_000_000, output: 5_000_000, cacheRead: 0, cacheWrite: 0 },
  )
  assert.deepEqual(result, { ok: true, usd: 0 })
})

await testAsync('cache tokens without a cache rate stay unpriced', async () => {
  const price: ModelPrice = { inputPerMTok: 1, outputPerMTok: 2 }
  assert.deepEqual(
    computeModelCost(price, { input: 10, output: 10, cacheRead: 1_000_000, cacheWrite: 0 }),
    { ok: false, reason: 'missing-cache-price' },
  )
  assert.deepEqual(
    computeModelCost(price, { input: 10, output: 10, cacheRead: 0, cacheWrite: 1_000_000 }),
    { ok: false, reason: 'missing-cache-price' },
  )
})

// ─── 2. Price resolution ───────────────────────────────────────────────

await testAsync('model price lookup', async () => {
  const dir = freshDir()
  try {
    const cachePath = join(dir, 'prices.json')
    writeCache(cachePath, Date.now())
    // The snapshot comes from the production cache/index path, so the lookup is
    // exercised against the same index the tool builds.
    const { snapshot } = loadPricing({ cachePath, ...OFFLINE })
    assert.ok(snapshot.index.size > 0, 'the fixture cache must load')

    const cases: Array<{
      name: string
      provider: string | undefined
      model: string | undefined
      expected: 'ok' | 'unknown-model' | 'ambiguous-model'
    }> = [
      { name: 'exact provider/model', provider: 'acme', model: 'alpha', expected: 'ok' },
      {
        name: 'unknown provider id falls back to a uniquely priced model',
        provider: 'opencode-go',
        model: 'free',
        expected: 'ok',
      },
      { name: 'model id is case-insensitive', provider: 'ACME', model: 'ALPHA', expected: 'ok' },
      { name: 'unknown model', provider: 'acme', model: 'mystery', expected: 'unknown-model' },
      { name: 'missing model id', provider: 'acme', model: undefined, expected: 'unknown-model' },
      {
        name: 'two different prices',
        provider: 'nope',
        model: 'ambig',
        expected: 'ambiguous-model',
      },
      { name: 'one price under two providers', provider: 'nope', model: 'twin', expected: 'ok' },
    ]
    for (const testCase of cases) {
      const result = lookupModelPrice(snapshot, testCase.provider, testCase.model)
      assert.equal(result.ok ? 'ok' : result.reason, testCase.expected, testCase.name)
    }

    const empty: PricingSnapshot = {
      index: new Map(),
      modelIndex: new Map(),
      stale: false,
      refreshing: false,
    }
    assert.deepEqual(lookupModelPrice(empty, 'acme', 'alpha'), {
      ok: false,
      reason: 'no-pricing',
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── Fixtures ──────────────────────────────────────────────────────────

interface FixtureRow {
  sessionId: string
  agent: string
  provider?: string
  model?: string
  tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } }
}

interface FixtureSession {
  id: string
  parentId?: string
  title?: string
}

/**
 * A V2-shaped database: `session_v2` (ids/parents) plus `session_message`.
 *
 * `ledgerSessionColumn: false` models a ledger table without `session_id`, the
 * case that must degrade to "no session view" instead of failing the report.
 */
function buildDb(
  path: string,
  sessions: readonly FixtureSession[],
  rows: readonly FixtureRow[],
  options?: { ledgerSessionColumn?: boolean },
): void {
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT)')
  const insertSession = db.prepare(
    'INSERT INTO session_v2 (id, parent_id, title, agent) VALUES (?, ?, ?, ?)',
  )
  for (const session of sessions) {
    insertSession.run(session.id, session.parentId ?? null, session.title ?? null, null)
  }
  const sessionColumn = options?.ledgerSessionColumn !== false
  db.exec(
    `CREATE TABLE session_message (id TEXT, ${sessionColumn ? 'session_id TEXT, ' : ''}type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)`,
  )
  const insert = db.prepare(
    sessionColumn
      ? 'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)'
      : 'INSERT INTO session_message (id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const at = Date.now()
  rows.forEach((row, index) => {
    const data = JSON.stringify({
      agent: row.agent,
      ...(row.model === undefined
        ? {}
        : { model: { id: row.model, providerID: row.provider ?? 'unknown-provider' } }),
      tokens: row.tokens ?? { input: 0, output: 0 },
    })
    if (sessionColumn) {
      insert.run(`msg_${index}`, row.sessionId, 'assistant', index, at, at, data)
    } else {
      insert.run(`msg_${index}`, 'assistant', index, at, at, data)
    }
  })
  db.close()
}

function commandFor(dbPath: string, cachePath: string) {
  return createCostCommand({ dbPath, pricing: { cachePath, ...OFFLINE } })
}

const ctx = { sessionID: 'ses_test' }

// ─── 3. Report path: pricing, `—`, partial totals ──────────────────────

await testAsync('an unpaid model reads — and is excluded from a partial total', async () => {
  const dir = freshDir()
  try {
    const dbPath = join(dir, 'opencode.db')
    const cachePath = join(dir, 'prices.json')
    writeCache(cachePath, Date.now())
    buildDb(
      dbPath,
      [{ id: 'ses_a', title: 'priced work' }],
      [
        {
          sessionId: 'ses_a',
          agent: 'zeus',
          provider: 'acme',
          model: 'alpha',
          tokens: { input: 1_000_000, output: 1_000_000 },
        },
        {
          sessionId: 'ses_a',
          agent: 'ghost',
          provider: 'ghost-provider',
          model: 'mystery-model',
          tokens: { input: 99_000_000, output: 99_000_000 },
        },
      ],
    )

    const output = await commandFor(dbPath, cachePath).pantheon_cost.execute({ days: 7 }, ctx)

    assert.match(output, /status: OK/)
    // Priced row: 1M input ($1) + 1M output ($2).
    assert.match(output, /\| zeus \| unknown \| 1000000 \| 1000000 \| 2000000 \| \$3\.00 \|/)
    // Unpriced row: the model is in no catalog, so no number is invented.
    assert.match(output, /\| ghost \| unknown \| 99000000 \| 99000000 \| 198000000 \| — \|/)
    // 99M tokens × 2 must not appear anywhere as money.
    assert.ok(!output.includes('$396'), 'an unknown model was priced at its token count')
    assert.match(output, /never priced at zero/i)
    assert.match(output, /\(partial\)/, 'the total must say it is partial')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('cache tokens are billed from the catalog, not at the input rate', async () => {
  const dir = freshDir()
  try {
    const dbPath = join(dir, 'opencode.db')
    const cachePath = join(dir, 'prices.json')
    writeCache(cachePath, Date.now())
    buildDb(
      dbPath,
      [{ id: 'ses_a' }],
      [
        {
          sessionId: 'ses_a',
          agent: 'hermes',
          provider: 'acme',
          model: 'alpha',
          tokens: {
            input: 0,
            output: 0,
            cache: { read: 1_000_000, write: 1_000_000 },
          },
        },
      ],
    )

    const output = await commandFor(dbPath, cachePath).pantheon_cost.execute({ days: 7 }, ctx)
    // 1M cache-read × $0.5 + 1M cache-write × $4 = $4.50
    assert.match(output, /\| acme \| alpha \| 0 \| 0 \| 1000000 \| 1000000 \| \$4\.50 \|/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync(
  'a free model is reported as $0.00 and does not make the total partial',
  async () => {
    const dir = freshDir()
    try {
      const dbPath = join(dir, 'opencode.db')
      const cachePath = join(dir, 'prices.json')
      writeCache(cachePath, Date.now())
      buildDb(
        dbPath,
        [{ id: 'ses_a' }],
        [
          {
            sessionId: 'ses_a',
            agent: 'zeus',
            provider: 'acme',
            model: 'free',
            tokens: { input: 3_000_000, output: 3_000_000 },
          },
        ],
      )

      const output = await commandFor(dbPath, cachePath).pantheon_cost.execute({ days: 7 }, ctx)
      assert.match(output, /\| acme \| free \| 3000000 \| 3000000 \| 0 \| 0 \| \$0\.00 \|/)
      assert.ok(!output.includes('(partial)'), 'a priced-at-zero model is a measurement, not a gap')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

// ─── Multi-model attribution ───────────────────────────────────────────

/**
 * One agent can run on several models, and only some of them may be priced.
 * The row must be the SUM of its priced models (not `—`), the two totals must
 * agree whenever everything is priced, and `(partial)` must mean exactly one
 * thing: a contributing model had no catalog price.
 */
await testAsync('an agent spanning several models is priced per model and summed', async () => {
  const pricedRows: FixtureRow[] = [
    // alpha is $1/Mtok in + $2/Mtok out ⇒ 1M input = $1.00.
    {
      sessionId: 'ses_a',
      agent: 'zeus',
      provider: 'acme',
      model: 'alpha',
      tokens: { input: 1_000_000, output: 0 },
    },
    // twin is $5/Mtok in + $5/Mtok out ⇒ 1M output = $5.00.
    {
      sessionId: 'ses_a',
      agent: 'zeus',
      provider: 'acme',
      model: 'twin',
      tokens: { input: 0, output: 1_000_000 },
    },
  ]
  const cases: Array<{
    name: string
    rows: FixtureRow[]
    partial: boolean
    input: number
    output: number
  }> = [
    {
      name: 'two priced models',
      rows: pricedRows,
      partial: false,
      input: 1_000_000,
      output: 1_000_000,
    },
    {
      name: 'two priced models plus an unpriced model',
      rows: [
        ...pricedRows,
        // In no catalog: 20M tokens that must never be priced at zero.
        {
          sessionId: 'ses_a',
          agent: 'zeus',
          provider: 'ghost-provider',
          model: 'mystery-model',
          tokens: { input: 10_000_000, output: 10_000_000 },
        },
      ],
      partial: true,
      input: 11_000_000,
      output: 11_000_000,
    },
  ]

  for (const testCase of cases) {
    const dir = freshDir()
    try {
      const dbPath = join(dir, 'opencode.db')
      const cachePath = join(dir, 'prices.json')
      writeCache(cachePath, Date.now())
      buildDb(dbPath, [{ id: 'ses_a' }], testCase.rows)

      const output = await commandFor(dbPath, cachePath).pantheon_cost.execute({ days: 7 }, ctx)
      const total = testCase.input + testCase.output
      const suffix = testCase.partial ? ' (partial)' : ''

      // Criterion 1: numeric agent cost = the sum of its priced models ($1 + $5).
      assert.ok(
        output.includes(
          `| zeus | unknown | ${testCase.input} | ${testCase.output} | ${total} | $6.00${suffix} |`,
        ),
        `${testCase.name}: by-agent row must show the summed cost, got:\n${output}`,
      )

      // Criterion 2: both totals are the same money for the same tokens.
      assert.ok(
        output.includes(
          `| **Total** | — | **${testCase.input}** | **${testCase.output}** | **${total}** | **$6.00**${suffix} |`,
        ),
        `${testCase.name}: by-agent total disagrees with the model sum`,
      )
      assert.ok(
        output.includes(
          `| **Total** | — | **${testCase.input}** | **${testCase.output}** | **0** | **0** | **$6.00**${suffix} |`,
        ),
        `${testCase.name}: by-model total disagrees with the agent sum`,
      )

      if (testCase.partial) {
        // The marker now means "a contributing model had no catalog price", and
        // the excluded tokens are stated once instead of left for the reader.
        assert.ok(output.includes('Cost reconciliation:'), `${testCase.name}: no reconciliation`)
        assert.ok(
          output.includes('20000000 token(s) from 1 unpriced model row(s)'),
          `${testCase.name}: the excluded tokens must be named`,
        )
        assert.ok(
          output.includes('excluded from both dollar totals'),
          `${testCase.name}: the exclusion must apply to both totals`,
        )
        assert.ok(
          output.includes('| ghost-provider | mystery-model | 10000000 | 10000000 | 0 | 0 | — |'),
          `${testCase.name}: the unpriced model must read —`,
        )
        // Criterion 4: never priced at 0 — or at the input rate, or at all.
        assert.ok(!output.includes('$0.00'), `${testCase.name}: an unpriced model read as free`)
        assert.ok(!output.includes('$20.00'), `${testCase.name}: unpriced tokens were priced`)
      } else {
        assert.ok(!output.includes('(partial)'), `${testCase.name}: fully priced report is partial`)
        assert.ok(
          !output.includes('Cost reconciliation:'),
          `${testCase.name}: nothing to reconcile, yet a note was printed`,
        )
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

// ─── 4. Session view ───────────────────────────────────────────────────

function treeFixture(dir: string): { dbPath: string; cachePath: string } {
  const dbPath = join(dir, 'opencode.db')
  const cachePath = join(dir, 'prices.json')
  writeCache(cachePath, Date.now())
  buildDb(
    dbPath,
    [
      { id: 'ses_root', title: 'root work' },
      { id: 'ses_child', parentId: 'ses_root', title: 'child work' },
      { id: 'ses_grand', parentId: 'ses_child', title: 'grandchild work' },
      { id: 'ses_other', title: 'unrelated work' },
    ],
    [
      {
        sessionId: 'ses_root',
        agent: 'zeus',
        provider: 'acme',
        model: 'alpha',
        tokens: { input: 1_000_000, output: 0 },
      },
      {
        sessionId: 'ses_child',
        agent: 'hermes',
        provider: 'acme',
        model: 'alpha',
        tokens: { input: 0, output: 1_000_000 },
      },
      {
        sessionId: 'ses_grand',
        agent: 'themis',
        provider: 'acme',
        model: 'alpha',
        tokens: { input: 1_000_000, output: 1_000_000 },
      },
      {
        sessionId: 'ses_other',
        agent: 'apollo',
        provider: 'acme',
        model: 'alpha',
        tokens: { input: 10_000_000, output: 10_000_000 },
      },
    ],
  )
  return { dbPath, cachePath }
}

await testAsync('session:<id> aggregates the root plus its descendants only', async () => {
  const dir = freshDir()
  try {
    const { dbPath, cachePath } = treeFixture(dir)
    const scoped = await commandFor(dbPath, cachePath).pantheon_cost.execute(
      { session: 'ses_root' },
      ctx,
    )

    assert.match(scoped, /root ses_root/)
    assert.match(scoped, /Scope: the root session plus 2 descendant session\(s\)/)
    assert.match(scoped, /ses_child/)
    assert.match(scoped, /ses_grand/)
    assert.ok(!scoped.includes('ses_other'), 'an unrelated session was attributed to the tree')
    assert.ok(!scoped.includes('apollo'), 'an unrelated session reached the by-agent table')
    // root $1 + child $2 + grandchild $3 = $6, excluding the $30 unrelated tree.
    assert.match(scoped, /Root \+ descendants.*\*\*\$6\.00\*\*/)
    assert.ok(!scoped.includes('$36.00'), 'the unrelated session leaked into the tree total')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('the default report is unchanged in shape and lists every session', async () => {
  const dir = freshDir()
  try {
    const { dbPath, cachePath } = treeFixture(dir)
    const output = await commandFor(dbPath, cachePath).pantheon_cost.execute({}, ctx)

    // Historical by-agent table still present, same columns, same token maths.
    assert.match(
      output,
      /\| Agent \| Phase \| Tokens In \| Tokens Out \| Tokens Total \| Cost \(USD\) \|/,
    )
    assert.match(output, /\| apollo \| unknown \| 10000000 \| 10000000 \| 20000000 \| \$30\.00 \|/)
    assert.match(
      output,
      /\| \*\*Total\*\* \| — \| \*\*12000000\*\* \| \*\*12000000\*\* \| \*\*24000000\*\*/,
    )
    // …and the additive views, with no scope applied.
    assert.match(output, /## Cost by model/)
    assert.match(output, /## Cost by session/)
    assert.match(output, /ses_other/)
    assert.ok(!output.includes('Scope:'), 'a default report must not be scoped')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('a ledger without session_id degrades instead of failing', async () => {
  const dir = freshDir()
  try {
    const dbPath = join(dir, 'opencode.db')
    const cachePath = join(dir, 'prices.json')
    writeCache(cachePath, Date.now())
    buildDb(
      dbPath,
      [],
      [
        {
          sessionId: 'ignored',
          agent: 'zeus',
          provider: 'acme',
          model: 'alpha',
          tokens: { input: 1_000_000, output: 0 },
        },
      ],
      { ledgerSessionColumn: false },
    )

    const output = await commandFor(dbPath, cachePath).pantheon_cost.execute({ days: 7 }, ctx)
    assert.match(output, /status: OK/)
    assert.match(output, /\| zeus \| unknown \| 1000000 \| 0 \| 1000000 \| \$1\.00 \|/)
    assert.match(output, /No session rows in this window\./)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('a V1 ledger is priced and scoped through the V1 session table', async () => {
  const dir = freshDir()
  try {
    const dbPath = join(dir, 'opencode.db')
    const cachePath = join(dir, 'prices.json')
    writeCache(cachePath, Date.now())
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT)')
    db.exec(
      'CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)',
    )
    db.prepare('INSERT INTO session (id, parent_id, title) VALUES (?, ?, ?)').run(
      'ses_v1_root',
      null,
      'v1 root',
    )
    db.prepare('INSERT INTO session (id, parent_id, title) VALUES (?, ?, ?)').run(
      'ses_v1_child',
      'ses_v1_root',
      'v1 child',
    )
    const insert = db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
    )
    const at = Date.now()
    const payload = (agent: string, input: number) =>
      JSON.stringify({
        role: 'assistant',
        agent,
        phase: 'green',
        // The V1 model fields are TOP-LEVEL, unlike V2's `model` object.
        modelID: 'alpha',
        providerID: 'acme',
        tokens: { input, output: 0, cache: { read: 0, write: 0 } },
      })
    insert.run('m1', 'ses_v1_root', at, at, payload('zeus', 1_000_000))
    insert.run('m2', 'ses_v1_child', at, at, payload('hermes', 1_000_000))
    insert.run('m3', 'ses_v1_other', at, at, payload('apollo', 1_000_000))
    db.close()

    const output = await commandFor(dbPath, cachePath).pantheon_cost.execute(
      { session: 'ses_v1_root' },
      ctx,
    )
    // V1 phases are real, not the V2 `unknown` literal.
    assert.match(output, /\| zeus \| green \| 1000000 \| 0 \| 1000000 \| \$1\.00 \|/)
    assert.match(output, /\| hermes \| green \| 1000000 \| 0 \| 1000000 \| \$1\.00 \|/)
    assert.match(output, /Scope: the root session plus 1 descendant session\(s\)/)
    assert.match(output, /Root \+ descendants.*\*\*\$2\.00\*\*/)
    assert.ok(!output.includes('apollo'), 'a V1 session outside the subtree was counted')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── 5. Offline behaviour ──────────────────────────────────────────────

await testAsync('a cached catalog is used without any network call', async () => {
  const dir = freshDir()
  try {
    const { dbPath, cachePath } = treeFixture(dir)
    const fetchImpl = failingFetch('the cache must make this unreachable')
    const output = await createCostCommand({
      dbPath,
      pricing: { cachePath, fetchImpl, now: () => Date.now() },
    }).pantheon_cost.execute({ days: 7 }, ctx)

    assert.match(output, /Pricing: models\.dev catalog/)
    assert.equal(fetchImpl.calls, 0, 'a fresh cache must not trigger a fetch')
    assert.match(output, /\$30\.00/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('a stale cache is served immediately and refreshed in the background', async () => {
  const dir = freshDir()
  try {
    const { dbPath, cachePath } = treeFixture(dir)
    // Written 30 days ago, so it is stale under the default 24h TTL.
    writeCache(cachePath, Date.now() - 30 * 86_400_000)
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      await gate
      return { ok: true, status: 200, json: async () => CATALOG }
    }

    const output = await createCostCommand({
      dbPath,
      pricing: { cachePath, fetchImpl, now: () => Date.now() },
    }).pantheon_cost.execute({ days: 7 }, ctx)

    // The report came back while the refresh is still blocked: never awaited.
    assert.match(output, /stale, refreshing in the background/)
    assert.match(output, /\$30\.00/, 'stale prices are still better than none')
    assert.equal(calls, 1, 'a stale cache triggers exactly one opportunistic refresh')
    release?.()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('refreshPricing awaits one refresh and prices from its result', async () => {
  const dir = freshDir()
  try {
    const { dbPath, cachePath } = treeFixture(dir)
    rmSync(cachePath, { force: true })
    const fetchImpl = catalogFetch()

    const output = await createCostCommand({
      dbPath,
      pricing: { cachePath, fetchImpl, now: () => Date.now() },
    }).pantheon_cost.execute({ refreshPricing: true, days: 7 }, ctx)

    assert.equal(fetchImpl.calls, 1)
    assert.match(output, /\$30\.00/)
    assert.ok(!output.includes('Pricing: unavailable'))
    // The refresh is persisted, so the next call needs no network at all.
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as { providers: unknown }
    assert.ok(cached.providers, 'the refreshed catalog must be cached on disk')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('network failure and a malformed payload degrade to unavailable', async () => {
  const dir = freshDir()
  try {
    const { dbPath } = treeFixture(dir)
    const cases: Array<{ name: string; fetchImpl: FetchLike }> = [
      { name: 'fetch rejects', fetchImpl: failingFetch() },
      {
        name: 'payload has no models',
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) }),
      },
      {
        name: 'HTTP error',
        fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      },
    ]
    for (const testCase of cases) {
      const cachePath = join(dir, `empty-${testCase.name.replaceAll(' ', '-')}.json`)
      const output = await createCostCommand({
        dbPath,
        pricing: { cachePath, fetchImpl: testCase.fetchImpl, now: () => Date.now() },
      }).pantheon_cost.execute({ refreshPricing: true, days: 7 }, ctx)

      assert.match(output, /status: OK/, `${testCase.name}: the token report must survive`)
      assert.match(output, /Pricing: unavailable/, testCase.name)
      assert.ok(
        /— \*\*\(nothing priceable\)\*\*|\| — \|/.test(output),
        `${testCase.name}: costs must read —, not $0.00`,
      )
      assert.match(output, /1000000 \| 1000000 \| 2000000 \|/, testCase.name)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync(
  'loadPricing with no cache and no network returns an unavailable snapshot',
  async () => {
    const dir = freshDir()
    try {
      const cachePath = join(dir, 'missing.json')
      const lookup = loadPricing({ cachePath, ...OFFLINE })
      assert.equal(lookup.snapshot.index.size, 0)
      assert.match(String(lookup.snapshot.unavailableReason), /no price cache/)
      assert.equal(lookup.pending, undefined, 'offline mode must not schedule a refresh')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

await testAsync('a failed forced refresh keeps the cached prices', async () => {
  const dir = freshDir()
  try {
    const cachePath = join(dir, 'prices.json')
    writeCache(cachePath, Date.now() - 5 * 86_400_000)
    const snapshot = await forceRefreshPricing({
      cachePath,
      fetchImpl: failingFetch('offline'),
      now: () => Date.now(),
    })
    assert.equal(snapshot.index.size > 0, true)
    assert.equal(snapshot.stale, true)
    assert.match(String(snapshot.unavailableReason), /refresh failed|offline/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── Negative controls ─────────────────────────────────────────────────

await testAsync('PANTHEON_COST_OFFLINE=1 refuses refreshPricing without a socket', async () => {
  const dir = freshDir()
  const previous = process.env.PANTHEON_COST_OFFLINE
  try {
    const { dbPath, cachePath } = treeFixture(dir)
    const fetchImpl = failingFetch('offline must not reach the network')
    // The env var, not the option: the documented guarantee is the variable.
    process.env.PANTHEON_COST_OFFLINE = '1'
    const output = await createCostCommand({
      dbPath,
      pricing: { cachePath, fetchImpl, now: () => Date.now() },
    }).pantheon_cost.execute({ refreshPricing: true }, ctx)

    assert.equal(fetchImpl.calls, 0, 'offline opened a socket for a forced refresh')
    assert.match(output, /Pricing: REFUSED/)
    // The notice must name BOTH switches: the argument and the env var.
    assert.match(output, /refreshPricing cannot run/)
    assert.match(output, /PANTHEON_COST_OFFLINE/)
    // The refusal is not a no-op: the report still answers from the cache.
    assert.match(output, /status: OK/)
    assert.match(output, /\$30\.00/)
  } finally {
    if (previous === undefined) delete process.env.PANTHEON_COST_OFFLINE
    else process.env.PANTHEON_COST_OFFLINE = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('an empty scoped subtree is a report, not a data fault', async () => {
  const dir = freshDir()
  try {
    const dbPath = join(dir, 'opencode.db')
    const cachePath = join(dir, 'prices.json')
    writeCache(cachePath, Date.now())
    // The root and its child exist, but every token row belongs to another
    // session: the scope, not the ledger layout, removes all rows.
    buildDb(
      dbPath,
      [
        { id: 'ses_root', title: 'root work' },
        { id: 'ses_child', parentId: 'ses_root', title: 'child work' },
        { id: 'ses_other', title: 'unrelated work' },
      ],
      [
        {
          sessionId: 'ses_other',
          agent: 'apollo',
          provider: 'acme',
          model: 'alpha',
          tokens: { input: 1_000_000, output: 0 },
        },
      ],
    )

    const output = await commandFor(dbPath, cachePath).pantheon_cost.execute(
      { session: 'ses_root' },
      ctx,
    )
    assert.match(output, /status: OK/)
    assert.ok(!output.includes('UNSUPPORTED'), 'an empty subtree was reported as a fault')
    assert.ok(!output.includes('no readable token source'), 'the ledger was blamed for the filter')
    assert.match(output, /Scope: the root session plus 1 descendant session\(s\)/)
    assert.match(
      output,
      /No token records in the last 7 days for ses_root or its descendant sessions\./,
    )
    assert.ok(!output.includes('apollo'), 'rows from outside the scope were counted')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('a priced sub-cent cost is never rendered as a zero', async () => {
  const dir = freshDir()
  try {
    const dbPath = join(dir, 'opencode.db')
    const cachePath = join(dir, 'prices.json')
    writeCache(cachePath, Date.now())
    buildDb(
      dbPath,
      [{ id: 'ses_a' }],
      [
        {
          sessionId: 'ses_a',
          agent: 'talos',
          provider: 'acme',
          model: 'alpha',
          // 40 input tokens at $1/Mtok = $0.00004, below 4-decimal resolution.
          tokens: { input: 40, output: 0 },
        },
      ],
    )

    const output = await commandFor(dbPath, cachePath).pantheon_cost.execute({ days: 7 }, ctx)
    assert.match(output, /\| talos \| unknown \| 40 \| 0 \| 40 \| < \$0\.0001 \|/)
    assert.match(output, /\*\*< \$0\.0001\*\*/, 'the total must not round the spend to zero')
    assert.ok(!output.includes('$0.0000'), 'a non-zero cost was displayed as zero')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── Report ────────────────────────────────────────────────────────────

const failed = results.filter((result) => !result.passed)
for (const result of results) {
  const mark = result.passed ? 'PASS' : 'FAIL'
  process.stdout.write(
    `  ${mark} ${result.name}${result.error === undefined ? '' : `: ${result.error}`}\n`,
  )
}
process.stdout.write(
  `\nResults: ${results.length - failed.length} passed, ${failed.length} failed\n`,
)
if (failed.length > 0) process.exitCode = 1
