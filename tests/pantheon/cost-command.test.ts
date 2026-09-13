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
  await testAsync('V1 version selects the V1 database', async () => {
    const dir = freshDir()
    try {
      const v1 = join(dir, 'opencode', 'opencode.db')
      mkdirSync(join(dir, 'opencode'), { recursive: true })
      createDb(v1, true, 'v1-agent')
      await withEnv(
        { XDG_DATA_HOME: dir, PANTHEON_OPENCODE_VERSION: 'v1', PANTHEON_COST_DB: undefined },
        async () => {
          const output = await createCostCommand().pantheon_cost.execute(
            {},
            { sessionID: 'ses_root' },
          )
          assert.ok(output.includes('v1-agent'))
        },
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync('V2 version selects the isolated V2 database', async () => {
    const dir = freshDir()
    try {
      const v2 = join(dir, 'opencode', 'opencode-v2.db')
      mkdirSync(join(dir, 'opencode'), { recursive: true })
      createDb(v2, true, 'v2-agent')
      await withEnv(
        { XDG_DATA_HOME: dir, PANTHEON_OPENCODE_VERSION: 'v2', PANTHEON_COST_DB: undefined },
        async () => {
          const output = await createCostCommand().pantheon_cost.execute(
            {},
            { sessionID: 'ses_root' },
          )
          assert.ok(output.includes('v2-agent'))
        },
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync(
    'explicit dbPath takes precedence over environment override and version',
    async () => {
      const dir = freshDir()
      try {
        const explicit = join(dir, 'explicit.db')
        const envDb = join(dir, 'env.db')
        createDb(explicit, true, 'explicit-agent')
        createDb(envDb, true, 'env-agent')
        await withEnv({ PANTHEON_COST_DB: envDb, PANTHEON_OPENCODE_VERSION: 'v2' }, async () => {
          const output = await createCostCommand({ dbPath: explicit }).pantheon_cost.execute(
            {},
            { sessionID: 'ses_root' },
          )
          assert.ok(output.includes('explicit-agent'))
          assert.ok(!output.includes('env-agent'))
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  await testAsync('missing selected V2 database reports the selected path', async () => {
    const dir = freshDir()
    try {
      await withEnv(
        { XDG_DATA_HOME: dir, PANTHEON_OPENCODE_VERSION: 'v2', PANTHEON_COST_DB: undefined },
        async () => {
          const output = await createCostCommand().pantheon_cost.execute(
            {},
            { sessionID: 'ses_root' },
          )
          assert.ok(output.includes('opencode-v2.db'))
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
      const rows = await queryWithCliFallback('/db/opencode.db', 3, {
        env: { PATH: dir },
        isExecutable: (candidate) => candidate === fakeNode,
        execFile: async (file, args) => {
          calls.push({ file, args: [...args] })
          if (args[0] === '-e') return { stdout: '' }
          return { stdout: JSON.stringify({ ok: true, days: 3, rows: scriptRows }) }
        },
      })
      assert.deepEqual(rows, scriptRows)
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
      const rows = await queryWithCliFallback(dbPath, 7, {
        env: { ...process.env, PANTHEON_NODE: process.execPath },
      })
      const after = readFileSync(dbPath)
      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.agent, 'readonly-agent')
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
