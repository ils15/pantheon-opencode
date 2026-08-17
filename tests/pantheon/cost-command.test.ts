/**
 * Tests for the /cost command (Wave 4, PR #46) — `pantheon_cost` structural
 * tool. Reads opencode.db READ-ONLY (node:sqlite on node ≥22.5; falls back
 * to spawning scripts/cost.mjs), aggregates cost + tokens by agent over the
 * last N days and renders a markdown table.
 *
 * Automated coverage (DB-read itself is sandbox-manual — a live opencode.db
 * must not be part of the unit suite):
 *   1. Missing/unreadable database → FRIENDLY error string, never a crash.
 *   2. scripts/cost.mjs exists and fails gracefully on a missing db
 *      (JSON {ok:false} on stdout + non-zero exit).
 *
 * Run with: npx tsx tests/pantheon/cost-command.test.ts
 */
import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { createCostCommand } from '../../src/pantheon/cost-command.ts'

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
      assert.ok(output.includes('not found'), 'error names the missing db')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync('scripts/cost.mjs exists and degrades gracefully on missing db', async () => {
    const dir = freshDir()
    try {
      assert.ok(existsSync(SCRIPT_PATH), 'scripts/cost.mjs ships with the plugin')
      const missing = join(dir, 'nope.db')
      const out = await execFileAsync(process.execPath, [SCRIPT_PATH, missing, '7'])
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

  await testAsync('pantheon_cost exposes zod days arg (default applied by caller)', async () => {
    const command = createCostCommand({ dbPath: '/definitely/missing.db' })
    const args = command.pantheon_cost.args
    assert.ok(args.days, 'days arg schema present')
    assert.equal(
      command.pantheon_cost.description.includes('cost'),
      true,
      'description names the cost report',
    )
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
