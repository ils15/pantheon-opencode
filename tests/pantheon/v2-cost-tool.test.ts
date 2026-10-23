/**
 * Focused proof that the V2 `pantheon_cost` wrapper accepts, validates and
 * FORWARDS `session` and `refreshPricing`.
 *
 * The V2 layer is a second entry point: the host validates against the JSON
 * Schema in `COST_INPUT`, then `executeCost` builds the argument object the V1
 * implementation receives. A property advertised in the schema but dropped in
 * that object would be a tool that silently ignores its own arguments, and no
 * schema-only assertion would catch it. So this file drives the real tool
 * definition and asserts an outcome that only the forwarded option can produce:
 *
 *   - `session`: the report names the root and sums exactly the subtree;
 *   - `refreshPricing`: the SAME call is priced, which the cache-read path
 *     cannot produce on a cache-less config dir (it schedules a background
 *     fetch and keeps the current call unpriced).
 *
 * No host is booted and no network is used: the fixture database and price
 * catalog are local, and `fetch` is stubbed for the duration of the test.
 *
 * Run with: npx tsx tests/pantheon/v2-cost-tool.test.ts
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createV2ToolDefinitions, type V2ToolDef } from '../../src/pantheon/v2-tools.ts'

/** Price per 1M tokens, chosen so a 10-token row costs exactly $1.00. */
const PER_MTOK = 100_000

const CATALOG = {
  acme: { models: { alpha: { cost: { input: PER_MTOK, output: PER_MTOK } } } },
}

function costTool(): V2ToolDef {
  const tool = createV2ToolDefinitions().find((def) => def.name === 'pantheon_cost')
  assert.ok(tool, 'pantheon_cost must be registered on the V2 surface')
  return tool
}

function schema(): Record<string, unknown> {
  const properties = costTool().input.properties
  assert.ok(typeof properties === 'object' && properties !== null, 'input.properties is an object')
  return properties as Record<string, unknown>
}

/**
 * A V2-shaped database: `session_v2` for the tree, `session_message` for the
 * ledger. One priced session, one priced descendant, one UNPRICED descendant and
 * one unrelated session whose spend must stay out of a scoped report.
 */
function buildFixture(path: string): void {
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT)')
  db.exec(
    'CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)',
  )
  const insertSession = db.prepare(
    'INSERT INTO session_v2 (id, parent_id, title, agent) VALUES (?, ?, ?, ?)',
  )
  insertSession.run('ses_root', null, 'root work', 'zeus')
  insertSession.run('ses_child', 'ses_root', 'child work', 'hermes')
  insertSession.run('ses_grand', 'ses_child', 'grandchild work', 'themis')
  insertSession.run('ses_other', null, 'unrelated work', 'apollo')

  const insert = db.prepare(
    'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  const at = Date.now()
  const payload = (agent: string, model: string | undefined, tokens: Record<string, number>) =>
    JSON.stringify({
      agent,
      ...(model === undefined ? {} : { model: { id: model, providerID: 'acme' } }),
      tokens,
    })
  const rows: Array<[string, string, string, string | undefined, Record<string, number>]> = [
    ['m1', 'ses_root', 'zeus', 'alpha', { input: 10, output: 0 }],
    ['m2', 'ses_child', 'hermes', 'alpha', { input: 0, output: 10 }],
    // In no catalog ⇒ the row must read —, never $0.00.
    ['m3', 'ses_grand', 'themis', 'mystery-model', { input: 10, output: 0 }],
    ['m4', 'ses_other', 'apollo', 'alpha', { input: 10_000, output: 0 }],
  ]
  rows.forEach(([id, sessionId, agent, model, tokens], index) => {
    insert.run(id, sessionId, 'assistant', index, at, at, payload(agent, model, tokens))
  })
  db.close()
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-v2-cost-tool-'))
  const previousEnv = {
    PANTHEON_HOME: process.env.PANTHEON_HOME,
    PANTHEON_COST_DB: process.env.PANTHEON_COST_DB,
    PANTHEON_COST_OFFLINE: process.env.PANTHEON_COST_OFFLINE,
    PANTHEON_OPENCODE_VERSION: process.env.PANTHEON_OPENCODE_VERSION,
  }
  const previousFetch = globalThis.fetch
  try {
    // ── Schema ─────────────────────────────────────────────────────────
    const properties = schema()
    assert.deepEqual(Object.keys(properties).sort(), ['days', 'refreshPricing', 'session'])
    assert.equal(costTool().input.additionalProperties, false)
    assert.deepEqual(properties.session, {
      type: 'string',
      minLength: 1,
      description:
        'Root session id. The report is scoped to that session plus every descendant session in its subtree.',
    })
    assert.equal((properties.refreshPricing as { type?: unknown }).type, 'boolean')
    // `days` keeps its original bounds and description.
    const days = properties.days as { type?: unknown; minimum?: unknown; maximum?: unknown }
    assert.equal(days.type, 'integer')
    assert.equal(days.minimum, 1)
    assert.equal(days.maximum, 365)
    const description = costTool().description
    assert.ok(
      !description.includes('no monetary values'),
      'the V2 description must not claim the report is money-free',
    )
    assert.match(description, /models\.dev/)
    assert.match(description, /session=/)

    // ── Boundary validation (no database or network is reached) ────────
    const tool = costTool()
    const boundary: Array<{ name: string; input: Record<string, unknown>; message: RegExp }> = [
      {
        name: 'days below the floor',
        input: { days: 0 },
        message: /"days" must be an integer between 1 and 365/,
      },
      {
        name: 'days above the ceiling',
        input: { days: 366 },
        message: /"days" must be an integer between 1 and 365/,
      },
      {
        name: 'non-integer days',
        input: { days: 7.5 },
        message: /"days" must be an integer between 1 and 365/,
      },
      {
        name: 'empty session',
        input: { session: '' },
        message: /"session" must be a non-empty string/,
      },
      {
        name: 'non-string session',
        input: { session: 42 },
        message: /"session" must be a non-empty string/,
      },
      {
        name: 'non-boolean refreshPricing',
        input: { refreshPricing: 'yes' },
        message: /"refreshPricing" must be a boolean/,
      },
    ]
    for (const testCase of boundary) {
      const result = await tool.execute(testCase.input, { sessionID: 'ses_v2' })
      assert.match(result.output, testCase.message, testCase.name)
      assert.ok(
        !result.output.includes('status:'),
        `${testCase.name}: a rejected argument must not reach the report`,
      )
    }

    // ── Forwarding, end to end through the V2 wrapper ──────────────────
    const dbPath = join(root, 'opencode.db')
    const configHome = join(root, 'config')
    mkdirSync(configHome, { recursive: true })
    buildFixture(dbPath)
    process.env.PANTHEON_HOME = configHome
    process.env.PANTHEON_COST_DB = dbPath
    // Neither the real cache nor the real network may decide this test.
    delete process.env.PANTHEON_COST_OFFLINE
    delete process.env.PANTHEON_OPENCODE_VERSION
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls += 1
      return { ok: true, status: 200, json: async () => CATALOG } as Response
    }) as typeof fetch
    const cachePath = join(configHome, 'cache', 'models-dev.json')

    const priced = await tool.execute(
      { days: 7, session: 'ses_root', refreshPricing: true },
      { sessionID: 'ses_v2' },
    )
    assert.match(priced.output, /status: OK/)
    // `session` reached the implementation: the report is scoped and sums 2 of
    // the 3 descendants, excluding `ses_other`.
    assert.match(priced.output, /root ses_root/)
    assert.match(priced.output, /Scope: the root session plus 2 descendant session\(s\)/)
    assert.ok(!priced.output.includes('ses_other'), 'session: was not applied')
    assert.ok(!priced.output.includes('apollo'), 'an unrelated session reached the by-agent table')
    // `refreshPricing` was awaited: this call is already priced, which the
    // cache-read path cannot be on a cache-less config dir.
    assert.equal(fetchCalls, 1, 'refreshPricing must trigger exactly one refresh')
    assert.ok(existsSync(cachePath), 'the refresh must be persisted for later calls')
    assert.match(priced.output, /\| zeus \| unknown \| 10 \| 0 \| 10 \| \$1\.00 \|/)
    assert.match(priced.output, /\| hermes \| unknown \| 0 \| 10 \| 10 \| \$1\.00 \|/)
    assert.match(priced.output, /\| themis \| unknown \| 10 \| 0 \| 10 \| — \|/)
    assert.match(
      priced.output,
      /\*\*\$2\.00\*\* \(partial\)/,
      'the unpriced row must flag the total',
    )

    // The cache written by the forced refresh is reused without a new call…
    const reused = await tool.execute({ days: 7 }, { sessionID: 'ses_v2' })
    assert.equal(fetchCalls, 1, 'a fresh cache must not trigger another refresh')
    // …and the no-scope default keeps every session, including the unrelated one.
    assert.match(reused.output, /ses_other/)
    assert.ok(!reused.output.includes('Scope:'), 'a default V2 report must not be scoped')
    assert.match(reused.output, /Pricing: models\.dev catalog/)
  } finally {
    globalThis.fetch = previousFetch
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
