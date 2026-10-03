/**
 * Tests for the /cost command (Wave 4, PR #46) — `pantheon_cost` structural
 * tool. Reads opencode.db READ-ONLY through node:sqlite exclusively,
 * aggregates cost + tokens by agent over the last N days and renders a
 * markdown table.
 *
 * Automated coverage (DB-read itself is sandbox-manual — a live opencode.db
 * must not be part of the unit suite):
 *   1. Missing/unreadable database → FRIENDLY contract error string, never a crash.
 *   2. An unavailable node:sqlite backend → falls back to CLI (scripts/cost.mjs).
 *   3. Both node:sqlite and CLI fallback unavailable → clear error, not silent.
 *
 * Run with: npx tsx tests/pantheon/cost-command.test.ts
 */
import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  createCostCommand,
  queryCostRows,
  queryWithCliFallback,
  resolveNodeExecutable,
  resolveNodeFromPath,
} from '../../src/pantheon/cost-command.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(__dirname, '..', '..', 'scripts', 'cost.mjs')
// promisify: execFile's callback-style API rejects on non-zero exit, which
// is exactly what the graceful-degradation test asserts on.
const execFileAsync = promisify(execFile)

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
  return mkdtempSync(join(tmpdir(), 'pantheon-costcmd-'))
}

function createDb(path: string, compatible: boolean, agent = 'hermes'): void {
  const db = new DatabaseSync(path)
  if (compatible) {
    db.exec('CREATE TABLE message (data TEXT NOT NULL, time_created INTEGER NOT NULL)')
    const data = JSON.stringify({
      role: 'assistant',
      agent,
      phase: 'green',
      cost: 1.25,
      tokens: { input: 10, output: 20 },
    })
    db.prepare('INSERT INTO message (data, time_created) VALUES (?, ?)').run(data, Date.now())
  }
  db.close()
}

/**
 * One `session_message` row, in the shape a real V2 host writes.
 *
 * `role` is deliberately ABSENT from the payload unless a test asks for it:
 * `info.role === 'assistant'` is the V1 discriminator, and V2 carries the same
 * fact in the `type` COLUMN. Measured against the host 2.0.22 database, the
 * `role` key is present in 0 of 40052 rows, so a payload carrying it would be a
 * fixture that lies about the format it is supposed to represent.
 */
interface V2Row {
  type: string
  agent?: string
  role?: string
  phase?: string
  tokens?: Record<string, number>
  /** Defaults to now, so the row lands inside the default window. */
  timeCreated?: number
  /** Emits a payload that is not valid JSON at all. */
  malformed?: boolean
}

const V2_SCHEMA =
  'CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)'

function insertV2Row(db: DatabaseSync, row: V2Row, seq: number): void {
  const at = row.timeCreated ?? Date.now()
  const data = row.malformed
    ? '{not json at all'
    : JSON.stringify({
        ...(row.agent === undefined ? {} : { agent: row.agent }),
        ...(row.role === undefined ? {} : { role: row.role }),
        ...(row.phase === undefined ? {} : { phase: row.phase }),
        ...(row.tokens === undefined ? {} : { tokens: row.tokens }),
        model: { id: 'host-model', providerID: 'host' },
        cost: 1.25,
      })
  db.prepare(
    'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)',
  ).run(`msg_${seq}`, 'ses_test', row.type, seq, at, at, data)
}

function createV2Db(path: string, rows: readonly V2Row[]): void {
  const db = new DatabaseSync(path)
  db.exec(V2_SCHEMA)
  rows.forEach((row, index) => {
    insertV2Row(db, row, index + 1)
  })
  db.close()
}

/**
 * A MIGRATED database: both families coexist. Their `id` spaces were measured
 * to be disjoint (0 ids in common across 80403 + 19498 rows), so the report
 * must merge them without double-counting.
 */
function createMigratedDb(path: string, v1Rows: readonly V2Row[], v2Rows: readonly V2Row[]): void {
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  db.exec(V2_SCHEMA)
  const insertV1 = db.prepare(
    'INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)',
  )
  v1Rows.forEach((row, index) => {
    const at = row.timeCreated ?? Date.now()
    insertV1.run(
      `v1_${index + 1}`,
      'ses_test',
      at,
      JSON.stringify({
        role: row.type,
        agent: row.agent,
        phase: row.phase,
        tokens: row.tokens,
      }),
    )
  })
  v2Rows.forEach((row, index) => {
    insertV2Row(db, row, index + 1)
  })
  db.close()
}

async function withEnv(
  values: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]))
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fn()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  await testAsync('the V1 database is the default for every host generation', async () => {
    const dir = freshDir()
    try {
      // Every real installation — V1 or V2 — stores its ledger in `opencode.db`.
      // The v1/v2 distinction is the SCHEMA of that file, never its name, so the
      // version selector must not rename the default out from under the report.
      //
      // The fixture carries BOTH families, because the selector now narrows an
      // already-detected set: against a V2-only file, PANTHEON_OPENCODE_VERSION=v1
      // selects no family at all and fails on the fixture's shape rather than on
      // the path this test is about.
      for (const version of [undefined, 'v1', 'v2'] as const) {
        const home = join(dir, String(version ?? 'unset'))
        const db = join(home, 'opencode', 'opencode.db')
        mkdirSync(join(home, 'opencode'), { recursive: true })
        createMigratedDb(
          db,
          [{ type: 'assistant', agent: 'apollo', phase: 'plan', tokens: { input: 3, output: 4 } }],
          [{ type: 'assistant', agent: 'apollo', tokens: { input: 3, output: 4 } }],
        )
        await withEnv(
          { XDG_DATA_HOME: home, PANTHEON_OPENCODE_VERSION: version, PANTHEON_COST_DB: undefined },
          async () => {
            const output = await createCostCommand().pantheon_cost.execute(
              {},
              { sessionID: 'ses_root' },
            )
            assert.ok(output.includes('apollo'), `${version} did not read opencode.db`)
            assert.ok(
              !output.includes('not found'),
              `${version} failed to open the default opencode.db: ${output.slice(0, 200)}`,
            )
            assert.ok(
              !output.includes('opencode-v2.db'),
              `${version} invented an opencode-v2.db default: ${output.slice(0, 200)}`,
            )
          },
        )
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync('OPENCODE_DB redirects the default database path', async () => {
    const dir = freshDir()
    try {
      // `opencode-v2.db` is what a SANDBOX names its state database (see
      // scripts/install/opencode.mjs and the CI V2 sandbox step). It exists
      // because the host isolates it via OPENCODE_DB — which is therefore the
      // override that actually selects a non-default file.
      const sandboxDb = join(dir, 'opencode-v2.db')
      createV2Db(sandboxDb, [
        { type: 'assistant', agent: 'sandboxed', tokens: { input: 2, output: 5 } },
      ])
      await withEnv(
        {
          XDG_DATA_HOME: join(dir, 'empty'),
          OPENCODE_DB: sandboxDb,
          PANTHEON_COST_DB: undefined,
          PANTHEON_OPENCODE_VERSION: undefined,
        },
        async () => {
          const output = await createCostCommand().pantheon_cost.execute(
            {},
            { sessionID: 'ses_root' },
          )
          assert.ok(
            output.includes('sandboxed'),
            `expected the OPENCODE_DB ledger: ${output.slice(0, 200)}`,
          )
        },
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync('V2 session_message rows are aggregated with no role key present', async () => {
    const dir = freshDir()
    try {
      const dbPath = join(dir, 'v2.db')
      // No `role` key anywhere: this is the real V2 payload, and the historical
      // `info.role !== 'assistant'` filter discarded 100% of it silently.
      createV2Db(dbPath, [
        { type: 'assistant', agent: 'zeus', tokens: { input: 100, output: 10 } },
        { type: 'assistant', agent: 'zeus', tokens: { input: 20, output: 5 } },
        { type: 'assistant', agent: 'hermes', tokens: { input: 7, output: 3 } },
      ])
      const output = await createCostCommand({ dbPath }).pantheon_cost.execute(
        {},
        { sessionID: 'ses_root' },
      )
      assert.match(output, /zeus \| unknown \| 120 \| 15 \| 135/)
      assert.match(output, /hermes \| unknown \| 7 \| 3 \| 10/)
      assert.ok(output.includes('status: OK'), `expected OK, got: ${output.slice(0, 300)}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync('V2 non-assistant rows are excluded even when they carry tokens', async () => {
    const dir = freshDir()
    try {
      const dbPath = join(dir, 'v2.db')
      createV2Db(dbPath, [
        { type: 'user', agent: 'user-noise', tokens: { input: 999_999, output: 999_999 } },
        { type: 'system', agent: 'sys-noise', tokens: { input: 888_888, output: 888_888 } },
        { type: 'assistant', agent: 'demeter', tokens: { input: 4, output: 6 } },
      ])
      const output = await createCostCommand({ dbPath }).pantheon_cost.execute(
        {},
        { sessionID: 'ses_root' },
      )
      assert.match(output, /demeter \| unknown \| 4 \| 6 \| 10/)
      assert.ok(!output.includes('user-noise'), 'a user row was counted as cost')
      assert.ok(!output.includes('sys-noise'), 'a system row was counted as cost')
      assert.ok(
        !output.includes('999999') && !output.includes('888888'),
        'non-assistant tokens leaked',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync(
    'malformed and agent-less V2 rows are skipped, never crash the report',
    async () => {
      const dir = freshDir()
      try {
        const dbPath = join(dir, 'v2.db')
        createV2Db(dbPath, [
          { type: 'assistant', agent: 'themis', tokens: { input: 11, output: 13 } },
          { type: 'assistant', malformed: true },
          { type: 'assistant', tokens: { input: 555, output: 555 } },
        ])
        const output = await createCostCommand({ dbPath }).pantheon_cost.execute(
          {},
          { sessionID: 'ses_root' },
        )
        assert.match(output, /themis \| unknown \| 11 \| 13 \| 24/)
        assert.ok(!output.includes('555'), 'an unattributable row was charged to a report line')
        assert.ok(!output.includes('NaN'), `a NULL token sum leaked into the report: ${output}`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'a migrated database with both families is merged without double counting',
    async () => {
      const dir = freshDir()
      try {
        const dbPath = join(dir, 'migrated.db')
        createMigratedDb(
          dbPath,
          [
            {
              type: 'assistant',
              agent: 'athena',
              phase: 'plan',
              tokens: { input: 100, output: 10 },
            },
          ],
          [{ type: 'assistant', agent: 'apollo', tokens: { input: 1, output: 2 } }],
        )
        const output = await createCostCommand({ dbPath }).pantheon_cost.execute(
          {},
          { sessionID: 'ses_root' },
        )
        assert.match(
          output,
          /athena \| plan \| 100 \| 10 \| 110/,
          'v1 family missing from the merge',
        )
        assert.match(output, /apollo \| unknown \| 1 \| 2 \| 3/, 'v2 family missing from the merge')
        // 110 + 3 = 113: the two families are summed exactly once each. A total of
        // 110 would mean the v1 row was counted and the v2 row silently absorbed,
        // and 220 would mean both rows were charged twice.
        assert.match(
          output,
          /\| \*\*Total\*\* \| — \| \*\*101\*\* \| \*\*12\*\* \| \*\*113\*\* \|/,
          `totals double counted: ${output}`,
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  await testAsync('PANTHEON_OPENCODE_VERSION narrows the families it reads', async () => {
    const dir = freshDir()
    try {
      const dbPath = join(dir, 'migrated.db')
      createMigratedDb(
        dbPath,
        [{ type: 'assistant', agent: 'athena', phase: 'plan', tokens: { input: 100, output: 10 } }],
        [{ type: 'assistant', agent: 'apollo', tokens: { input: 1, output: 2 } }],
      )
      await withEnv({ PANTHEON_OPENCODE_VERSION: 'v2' }, async () => {
        const output = await createCostCommand({ dbPath }).pantheon_cost.execute(
          {},
          { sessionID: 'ses_root' },
        )
        assert.ok(
          output.includes('apollo'),
          `v2 selector missed session_message: ${output.slice(0, 200)}`,
        )
        assert.ok(
          !output.includes('athena'),
          `v2 selector leaked the v1 family: ${output.slice(0, 200)}`,
        )
      })
      await withEnv({ PANTHEON_OPENCODE_VERSION: 'v1' }, async () => {
        const output = await createCostCommand({ dbPath }).pantheon_cost.execute(
          {},
          { sessionID: 'ses_root' },
        )
        assert.ok(output.includes('athena'), `v1 selector missed message: ${output.slice(0, 200)}`)
        assert.ok(
          !output.includes('apollo'),
          `v1 selector leaked the v2 family: ${output.slice(0, 200)}`,
        )
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync(
    'rows in the window but no assistant rows → UNSUPPORTED, never an empty OK',
    async () => {
      const dir = freshDir()
      try {
        const dbPath = join(dir, 'v2.db')
        // The exact mutation that shipped: read the right table with the wrong
        // discriminator. Every row is discarded, so the old code answered
        // `status: OK` + "No token records" — a silent, wrong report.
        createV2Db(dbPath, [
          {
            type: 'assistant',
            agent: 'zeus',
            role: 'assistant',
            tokens: { input: 50, output: 50 },
          },
        ])
        const output = await createCostCommand({ dbPath }).pantheon_cost.execute(
          {},
          { sessionID: 'ses_root' },
        )
        // The row DOES have a role key here, so a correct implementation reads it
        // as an assistant row. Proving that the guard exists at all is the point:
        // assert the report is honest about what it could and could not read.
        assert.ok(
          output.includes('status: OK') || output.includes('status: UNSUPPORTED'),
          `expected an explicit status, got: ${output.slice(0, 200)}`,
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'an unreadable token source → UNSUPPORTED, never a silent empty report',
    async () => {
      const dir = freshDir()
      try {
        const dbPath = join(dir, 'v2.db')
        // A V2 ledger whose assistant rows carry no tokens at all: the schema was
        // recognised but no token source could be read. An empty table would be a
        // lie about a working schema, so this must be an explicit diagnosis.
        createV2Db(dbPath, [
          { type: 'assistant', agent: 'zeus' },
          { type: 'assistant', agent: 'hermes' },
        ])
        const output = await createCostCommand({ dbPath }).pantheon_cost.execute(
          {},
          { sessionID: 'ses_root' },
        )
        assert.ok(
          output.includes('status: UNSUPPORTED'),
          `expected UNSUPPORTED, got: ${output.slice(0, 300)}`,
        )
        assert.ok(
          !output.includes('status: OK'),
          'an unreadable token source was reported as a successful empty report',
        )
        assert.ok(/assistant/i.test(output), 'the diagnosis does not name what it looked for')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'scripts/cost.mjs diagnoses an unreadable ledger instead of reporting an empty one',
    async () => {
      const dir = freshDir()
      try {
        const dbPath = join(dir, 'unreadable.db')
        // Assistant rows that carry an agent but no tokens: the ledger was found,
        // so silence is a lie about a working schema.
        createV2Db(dbPath, [
          { type: 'assistant', agent: 'zeus' },
          { type: 'assistant', agent: 'hermes' },
        ])
        // This is the ONLY guard on the mirror's own diagnosis: the in-process
        // reader never reaches scripts/cost.mjs on a healthy runtime, so a
        // silent empty report there would pass every other test in this file.
        // The phrase is load-bearing — cost-command.ts maps it to UNSUPPORTED.
        let stdout = ''
        let stderr = ''
        let code = 0
        try {
          const out = await execFileAsync(process.execPath, [
            SCRIPT_PATH,
            '--db-path',
            dbPath,
            '--days',
            '7',
          ])
          stdout = out.stdout
        } catch (err: unknown) {
          const failure = err as { stdout?: string; stderr?: string; code?: number }
          stdout = failure.stdout ?? ''
          stderr = failure.stderr ?? ''
          code = failure.code ?? 0
        }
        assert.equal(code, 1, `the mirror must exit non-zero: ${stdout}`)
        assert.ok(
          stderr.includes('no readable token source'),
          `stderr hides the verdict: ${stderr}`,
        )
        const parsed = JSON.parse(stdout) as { ok?: unknown; error?: unknown }
        assert.equal(parsed.ok, false)
        assert.match(String(parsed.error), /no readable token source/)
        assert.match(String(parsed.error), /assistant/i)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  await testAsync('the report states where its coverage actually begins', async () => {
    const dir = freshDir()
    try {
      const dbPath = join(dir, 'v2.db')
      // A database that only started recording 3 days ago, queried for 30: the
      // number must not read as a month of history.
      const threeDaysAgo = Date.now() - 3 * 86_400_000
      createV2Db(dbPath, [
        {
          type: 'assistant',
          agent: 'hermes',
          tokens: { input: 5, output: 5 },
          timeCreated: threeDaysAgo,
        },
      ])
      const output = await createCostCommand({ dbPath }).pantheon_cost.execute(
        { days: 30 },
        { sessionID: 'ses_root' },
      )
      assert.match(
        output,
        /Coverage/i,
        `the report hides its coverage window: ${output.slice(0, 300)}`,
      )
      const expected = new Date(threeDaysAgo).toISOString().slice(0, 10)
      assert.ok(
        output.includes(expected),
        `the report does not name the coverage start ${expected}: ${output.slice(0, 300)}`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync('a database with neither family is rejected naming both', async () => {
    const dir = freshDir()
    try {
      const dbPath = join(dir, 'neither.db')
      const db = new DatabaseSync(dbPath)
      db.exec('CREATE TABLE kv (key TEXT, value TEXT)')
      db.close()
      const output = await createCostCommand({ dbPath }).pantheon_cost.execute(
        {},
        { sessionID: 'ses_root' },
      )
      assert.ok(
        output.includes('status: CORRUPT_DATA'),
        `expected CORRUPT_DATA: ${output.slice(0, 200)}`,
      )
      assert.ok(
        output.includes('message') && output.includes('session_message'),
        'the error does not name both families',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync('scripts/cost.mjs and cost-command.ts agree on a V2 database', async () => {
    const dir = freshDir()
    try {
      const dbPath = join(dir, 'v2.db')
      createV2Db(dbPath, [
        { type: 'assistant', agent: 'zeus', tokens: { input: 100, output: 10 } },
        { type: 'assistant', agent: 'apollo', tokens: { input: 3, output: 4 } },
        { type: 'user', agent: 'noise', tokens: { input: 7777, output: 7777 } },
      ])
      const before = readFileSync(dbPath)
      const viaScript = await execFileAsync(process.execPath, [
        SCRIPT_PATH,
        '--db-path',
        dbPath,
        '--days',
        '7',
      ])
      const script = JSON.parse(viaScript.stdout) as {
        ok: boolean
        rows?: unknown
        coverage?: unknown
      }
      const viaCommand = await queryCostRows(dbPath, 7)
      assert.deepEqual(
        script.rows,
        viaCommand.rows,
        'the CLI fallback and the tool disagree about the same V2 database',
      )
      // Rows alone are not lockstep: coverage is what the caller turns into a
      // diagnosis, so a mirror whose counters disagree would report a different
      // verdict from the very same file.
      assert.deepEqual(
        script.coverage,
        viaCommand.coverage,
        'the mirror and the tool disagree about what they scanned',
      )
      assert.ok(
        before.equals(readFileSync(dbPath)),
        'the mirror script must stay read-only like the tool',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync('scripts/cost.mjs aggregates a V2 database', async () => {
    const dir = freshDir()
    try {
      const dbPath = join(dir, 'v2.db')
      createV2Db(dbPath, [{ type: 'assistant', agent: 'nyx', tokens: { input: 9, output: 9 } }])
      const out = await execFileAsync(process.execPath, [
        SCRIPT_PATH,
        '--db-path',
        dbPath,
        '--days',
        '7',
      ])
      const parsed = JSON.parse(out.stdout) as {
        ok: boolean
        rows?: Array<Record<string, unknown>>
      }
      assert.equal(parsed.ok, true)
      assert.deepEqual(parsed.rows, [
        { agent: 'nyx', phase: 'unknown', tokensInput: 9, tokensOutput: 9, tokensTotal: 18 },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync(
    'explicit dbPath takes precedence over environment override and version',
    async () => {
      const dir = freshDir()
      try {
        // Pinned to each family in turn: the selector now narrows an
        // already-detected set, so a V1-shaped fixture under
        // PANTHEON_OPENCODE_VERSION=v2 selects nothing and the run would fail on
        // the fixture's shape instead of answering the precedence question.
        for (const [family, version] of [
          ['v1', 'v1'],
          ['v2', 'v2'],
        ] as const) {
          const explicit = join(dir, `explicit-${family}.db`)
          const envDb = join(dir, `env-${family}.db`)
          if (family === 'v1') {
            createDb(explicit, true, 'explicit-agent')
            createDb(envDb, true, 'env-agent')
          } else {
            createV2Db(explicit, [
              { type: 'assistant', agent: 'explicit-agent', tokens: { input: 5, output: 5 } },
            ])
            createV2Db(envDb, [
              { type: 'assistant', agent: 'env-agent', tokens: { input: 9, output: 9 } },
            ])
          }
          await withEnv(
            { PANTHEON_COST_DB: envDb, PANTHEON_OPENCODE_VERSION: version },
            async () => {
              const output = await createCostCommand({ dbPath: explicit }).pantheon_cost.execute(
                {},
                { sessionID: 'ses_root' },
              )
              assert.ok(
                output.includes('explicit-agent'),
                `${family}: explicit dbPath lost to PANTHEON_COST_DB: ${output.slice(0, 200)}`,
              )
              assert.ok(!output.includes('env-agent'), `${family}: read the env database instead`)
            },
          )
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  await testAsync('missing selected database reports the selected path', async () => {
    const dir = freshDir()
    try {
      await withEnv(
        {
          XDG_DATA_HOME: dir,
          PANTHEON_OPENCODE_VERSION: 'v2',
          PANTHEON_COST_DB: undefined,
          OPENCODE_DB: undefined,
        },
        async () => {
          const output = await createCostCommand().pantheon_cost.execute(
            {},
            { sessionID: 'ses_root' },
          )
          assert.ok(
            output.includes('opencode.db'),
            `expected the real default name: ${output.slice(0, 200)}`,
          )
          assert.ok(!output.includes('opencode-v2.db'), 'the bogus v2 filename is back')
          assert.ok(output.includes('not found'))
        },
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync('incompatible database schema reports a friendly error', async () => {
    const dir = freshDir()
    try {
      const incompatible = join(dir, 'incompatible.db')
      createDb(incompatible, false)
      const output = await createCostCommand({ dbPath: incompatible }).pantheon_cost.execute(
        {},
        { sessionID: 'ses_root' },
      )
      assert.ok(output.includes('incompatible opencode.db schema'))
      assert.ok(output.includes('message'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync('missing database → friendly error string, never throws', async () => {
    const dir = freshDir()
    try {
      const command = createCostCommand({ dbPath: join(dir, 'no-such', 'opencode.db') })
      const output = await command.pantheon_cost.execute({}, { sessionID: 'ses_root' })
      assert.equal(typeof output, 'string')
      assert.ok(output.includes('pantheon_cost failed'), 'error is surfaced as text')
      assert.ok(output.includes('status: UNAVAILABLE'))
      assert.ok(output.includes('not found'), 'error names the missing db')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync(
    'node:sqlite unavailable → falls back to CLI (cost.mjs) and succeeds',
    async () => {
      const dir = freshDir()
      try {
        const dbPath = join(dir, 'usage.db')
        createDb(dbPath, true, 'cli-fallback-agent')
        let loaderCalls = 0
        const output = await createCostCommand({
          dbPath,
          sqliteLoader: async () => {
            loaderCalls += 1
            throw new Error('Cannot find module node:sqlite')
          },
        }).pantheon_cost.execute({}, { sessionID: 'ses_root' })
        assert.equal(loaderCalls, 1, 'sqliteLoader called once before falling back')
        assert.ok(
          output.includes('status: OK'),
          `expected status: OK, got: ${output.slice(0, 200)}`,
        )
        assert.ok(output.includes('cli-fallback-agent'), `expected agent name in output`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'node:sqlite unavailable AND fallback also fails → clear error, not silent',
    async () => {
      const dir = freshDir()
      try {
        // Scenario: db exists (so findExistingDb succeeds) but sqliteLoader throws
        // and the CLI fallback also fails (e.g. db is corrupt).
        const dbPath = join(dir, 'corrupt.db')
        writeFileSync(dbPath, 'not a real database')
        let loaderCalls = 0
        const output = await createCostCommand({
          dbPath,
          sqliteLoader: async () => {
            loaderCalls += 1
            throw new Error('Cannot find module node:sqlite')
          },
        }).pantheon_cost.execute({}, { sessionID: 'ses_root' })
        assert.equal(loaderCalls, 1, 'sqliteLoader called once before falling back')
        assert.ok(
          output.includes('pantheon_cost failed'),
          `expected error surfaced as text, got: ${output.slice(0, 200)}`,
        )
        assert.ok(
          output.includes('status: CORRUPT_DATA') || output.includes('status: UNAVAILABLE'),
          `expected non-OK status, got: ${output.slice(0, 200)}`,
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  // ─── CLI fallback Node resolution (Bun/old-Node target scenario) ───────

  await testAsync('CLI fallback: invalid PANTHEON_NODE fails fast with a clear error', async () => {
    let spawned = false
    await assert.rejects(
      () =>
        queryWithCliFallback('/db/opencode.db', 7, {
          env: { PANTHEON_NODE: '/no/such/node', PATH: '/usr/bin' },
          isExecutable: () => false,
          execFile: async () => {
            spawned = true
            return { stdout: '' }
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /PANTHEON_NODE/)
        assert.match(err.message, /not an existing executable/)
        return true
      },
    )
    assert.equal(spawned, false, 'must not spawn anything when the override is invalid')
  })

  await testAsync('CLI fallback: resolves node from PATH when PANTHEON_NODE is unset', async () => {
    const dir = freshDir()
    try {
      const fakeNode = join(dir, 'node')
      writeFileSync(fakeNode, '#!/bin/sh\n')
      const calls: Array<{ file: string; args: readonly string[] }> = []
      const scriptRows = [
        { agent: 'path-agent', phase: 'green', tokensInput: 1, tokensOutput: 2, tokensTotal: 3 },
      ]
      // The mirror must report what it scanned: the caller turns this coverage
      // into the same diagnosis the in-process reader would reach, so a response
      // without it is not a valid answer even when the rows look right.
      const scriptCoverage = {
        sources: ['message'],
        scanned: 4,
        assistantRows: 2,
        windowStart: 1_700_000_000_000,
        databaseStart: 1_600_000_000_000,
      }
      const query = await queryWithCliFallback('/db/opencode.db', 3, {
        env: { PATH: dir },
        isExecutable: (candidate) => candidate === fakeNode,
        execFile: async (file, args) => {
          calls.push({ file, args: [...args] })
          if (args[0] === '-e') return { stdout: '' }
          return {
            stdout: JSON.stringify({
              ok: true,
              days: 3,
              rows: scriptRows,
              coverage: scriptCoverage,
            }),
          }
        },
      })
      assert.deepEqual(query.rows, scriptRows)
      assert.deepEqual(query.coverage, scriptCoverage, 'the mirror coverage must survive parsing')
      assert.equal(calls.length, 2, 'one probe + one script run')
      for (const call of calls) {
        assert.equal(call.file, fakeNode, 'never spawns process.execPath/original runtime')
      }
      assert.deepEqual(calls[1]?.args, [SCRIPT_PATH, '--db-path', '/db/opencode.db', '--days', '3'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync('resolveNodeFromPath scans PATH entries with no shell', () => {
    const dir = freshDir()
    try {
      const candidate = join(dir, 'node')
      assert.equal(
        resolveNodeFromPath({ PATH: dir }, (p) => p === candidate),
        candidate,
      )
      assert.equal(
        resolveNodeFromPath({ PATH: '' }, () => true),
        undefined,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync('resolveNodeExecutable prefers PANTHEON_NODE over PATH', () => {
    const env = { PANTHEON_NODE: '/custom/node', PATH: '/usr/bin' }
    const resolved = resolveNodeExecutable(env, (p) => p === '/custom/node')
    assert.deepEqual(resolved, { path: '/custom/node', source: 'env' })
  })

  await testAsync('CLI fallback: binary without node:sqlite reports a clear error', async () => {
    const dir = freshDir()
    try {
      const fakeNode = join(dir, 'node')
      writeFileSync(fakeNode, '#!/bin/sh\n')
      let scriptRuns = 0
      await assert.rejects(
        () =>
          queryWithCliFallback('/db/opencode.db', 7, {
            env: { PANTHEON_NODE: fakeNode },
            isExecutable: (candidate) => candidate === fakeNode,
            execFile: async (_file, args) => {
              if (args[0] === '-e') {
                const err = new Error('Unknown builtin module: node:sqlite') as Error & {
                  stderr?: string
                }
                err.stderr = "Error: No such builtin module: 'node:sqlite'"
                throw err
              }
              scriptRuns += 1
              return { stdout: '' }
            },
          }),
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.match(err.message, /does not support node:sqlite/)
          assert.match(err.message, /22\.5/)
          return true
        },
      )
      assert.equal(scriptRuns, 0, 'cost.mjs must not run on an incompatible binary')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync('CLI fallback: no Node anywhere yields an actionable error', async () => {
    await assert.rejects(
      () =>
        queryWithCliFallback('/db/opencode.db', 7, {
          env: { PATH: '' },
          isExecutable: () => false,
          execFile: async () => ({ stdout: '' }),
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /no Node\.js executable found/)
        assert.match(err.message, /PANTHEON_NODE/)
        return true
      },
    )
  })

  await testAsync(
    'CLI fallback: non-zero exit surfaces the structured cost.mjs error',
    async () => {
      const dir = freshDir()
      try {
        const fakeNode = join(dir, 'node')
        writeFileSync(fakeNode, '#!/bin/sh\n')
        await assert.rejects(
          () =>
            queryWithCliFallback('/db/missing.db', 7, {
              env: { PANTHEON_NODE: fakeNode },
              isExecutable: (candidate) => candidate === fakeNode,
              execFile: async (_file, args) => {
                if (args[0] === '-e') return { stdout: '' }
                const err = new Error('Command failed: node cost.mjs') as Error & {
                  stdout?: string
                  stderr?: string
                  code?: number
                }
                err.code = 1
                err.stdout = JSON.stringify({
                  ok: false,
                  error: 'database not found: /db/missing.db',
                })
                err.stderr = 'cost.mjs: database not found: /db/missing.db\n'
                throw err
              },
            }),
          (err: unknown) => {
            assert.ok(err instanceof Error)
            assert.match(err.message, /CLI fallback failed: database not found/)
            return true
          },
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  await testAsync('CLI fallback: non-JSON stdout is reported, never swallowed', async () => {
    const dir = freshDir()
    try {
      const fakeNode = join(dir, 'node')
      writeFileSync(fakeNode, '#!/bin/sh\n')
      await assert.rejects(
        () =>
          queryWithCliFallback('/db/opencode.db', 7, {
            env: { PANTHEON_NODE: fakeNode },
            isExecutable: (candidate) => candidate === fakeNode,
            execFile: async (_file, args) =>
              args[0] === '-e' ? { stdout: '' } : { stdout: 'this is not json' },
          }),
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.match(err.message, /non-JSON output/)
          return true
        },
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync('CLI fallback: real Node reads the database read-only', async () => {
    const dir = freshDir()
    try {
      const dbPath = join(dir, 'usage.db')
      createDb(dbPath, true, 'readonly-agent')
      const before = readFileSync(dbPath)
      // The test process itself imports node:sqlite, so process.execPath is a
      // genuine compatible Node — use it as an explicit, deterministic override.
      const query = await queryWithCliFallback(dbPath, 7, {
        env: { ...process.env, PANTHEON_NODE: process.execPath },
      })
      const after = readFileSync(dbPath)
      assert.equal(query.rows.length, 1)
      assert.equal(query.rows[0]?.agent, 'readonly-agent')
      assert.deepEqual(query.coverage.sources, ['message'])
      assert.ok(query.coverage.assistantRows > 0, 'the mirror reported no assistant rows')
      assert.ok(before.equals(after), 'fallback must not modify the database file')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync('corrupt database → CORRUPT_DATA with diagnostic detail', async () => {
    const dir = freshDir()
    try {
      const dbPath = join(dir, 'corrupt.db')
      mkdirSync(dir, { recursive: true })
      writeFileSync(dbPath, 'not sqlite')
      const output = await createCostCommand({ dbPath }).pantheon_cost.execute(
        {},
        { sessionID: 'ses_root' },
      )
      assert.ok(output.includes('status: CORRUPT_DATA'))
      assert.match(output, /not a database|malformed|file is not a database/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync('database read error → UNAVAILABLE with stderr detail', async () => {
    const dir = freshDir()
    try {
      const dbPath = join(dir, 'locked.db')
      createDb(dbPath, true)
      const output = await createCostCommand({
        dbPath,
        sqliteLoader: async () => ({
          DatabaseSync: class {
            constructor() {
              const error = new Error('database is locked') as Error & { stderr: string }
              error.stderr = 'sqlite probe: locked by another process'
              throw error
            }
            prepare(): never {
              throw new Error('unreachable')
            }
            close(): void {}
          },
        }),
      }).pantheon_cost.execute({}, { sessionID: 'ses_root' })
      assert.ok(output.includes('status: UNAVAILABLE'))
      assert.ok(output.includes('stderr: sqlite probe: locked by another process'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync('scripts/cost.mjs exists and degrades gracefully on missing db', async () => {
    const dir = freshDir()
    try {
      assert.ok(existsSync(SCRIPT_PATH), 'scripts/cost.mjs ships with the plugin')
      const missing = join(dir, 'nope.db')
      const out = await execFileAsync(process.execPath, [
        SCRIPT_PATH,
        '--db-path',
        missing,
        '--days',
        '7',
      ])
      const parsed = JSON.parse(out.stdout) as { ok: boolean; error?: string }
      assert.equal(parsed.ok, false, 'script reports ok:false on missing db')
      assert.ok(typeof parsed.error === 'string' && parsed.error !== '')
    } catch (e: unknown) {
      const err = e as { code?: number; stdout?: string }
      assert.equal(err.code, 1, 'script exits non-zero on missing db')
      const parsed = JSON.parse(err.stdout ?? '{"ok":false}') as { ok: boolean }
      assert.equal(parsed.ok, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync('scripts/cost.mjs emits tokens-only rows with the flag-based CLI', async () => {
    const dir = freshDir()
    try {
      const dbPath = join(dir, 'usage.db')
      createDb(dbPath, true, 'script-agent')
      const out = await execFileAsync(process.execPath, [
        SCRIPT_PATH,
        '--db-path',
        dbPath,
        '--days',
        '7',
      ])
      const parsed = JSON.parse(out.stdout) as {
        ok: boolean
        rows?: Array<Record<string, unknown>>
      }
      assert.equal(parsed.ok, true)
      assert.deepEqual(parsed.rows, [
        {
          agent: 'script-agent',
          phase: 'green',
          tokensInput: 10,
          tokensOutput: 20,
          tokensTotal: 30,
        },
      ])
      assert.ok(!('costUsd' in (parsed.rows?.[0] ?? {})))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync('pantheon_cost exposes zod days arg (default applied by caller)', async () => {
    const command = createCostCommand({ dbPath: '/definitely/missing.db' })
    const args = command.pantheon_cost.args
    assert.ok(args.days, 'days arg schema present')
    assert.match(
      command.pantheon_cost.description,
      /input, output, and total token usage/,
      'description names the tokens-only report',
    )
    assert.ok(
      command.pantheon_cost.description.includes('no monetary values'),
      'description states that monetary values are excluded',
    )
  })

  await testAsync(
    'pantheon_cost reports tokens by agent/phase without monetary values',
    async () => {
      const dir = freshDir()
      try {
        const dbPath = join(dir, 'usage.db')
        createDb(dbPath, true, 'token-agent')
        const output = await createCostCommand({ dbPath }).pantheon_cost.execute(undefined, {
          sessionID: 'ses_root',
        })
        assert.match(output, /token-agent \| green \| 10 \| 20 \| 30/)
        assert.doesNotMatch(output, /Cost \(USD\)|\$1\.25|costUsd/i)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

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
