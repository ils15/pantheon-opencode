#!/usr/bin/env node
/**
 * Offline/ambiental probe for pantheon_cost.
 *
 * The probe never reads or writes a user's real database. Without --fixture it
 * reports AMBIENTAL because a real dependency/database is intentionally not
 * exercised. With --fixture it imports the installed command and creates a
 * temporary synthetic opencode database. A missing fixture runtime is also
 * AMBIENTAL rather than a false PASS.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const requestedVersion = valueFor('--version')
const jsonOutput = process.argv.includes('--json')
const fixtureMode = process.argv.includes('--fixture')

function valueFor(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function emit(status, detail, checks = []) {
  const result = { status, version: requestedVersion, detail, checks }
  if (jsonOutput) process.stdout.write(JSON.stringify(result))
  else process.stdout.write(`${status}: ${detail}\n`)
  if (status === 'FAIL') process.exitCode = 1
}

function diagnostic(error) {
  const message = error instanceof Error ? error.message : String(error)
  const stderr =
    error && typeof error === 'object' && typeof error.stderr === 'string'
      ? error.stderr.trim()
      : ''
  return stderr === '' ? message : `${message}; stderr: ${stderr}`
}

function ambiental(detail) {
  emit('AMBIENTAL', detail)
}

function setEnvironment(values) {
  const previous = new Map()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function createSyntheticDb(DatabaseSync, path, rows) {
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE message (data TEXT NOT NULL, time_created INTEGER NOT NULL)')
  const insert = db.prepare('INSERT INTO message (data, time_created) VALUES (?, ?)')
  for (const data of rows) insert.run(JSON.stringify(data), Date.now())
  db.close()
}

function createIncompatibleDb(DatabaseSync, path) {
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE not_message (value TEXT NOT NULL)')
  db.close()
}

function requireOutput(output, fragment, label) {
  if (!output.includes(fragment)) throw new Error(`${label}: missing ${fragment}`)
}

function assertTokensOnly(output, expectedRows, total) {
  requireOutput(output, 'Tokens In | Tokens Out | Tokens Total', 'tokens-only header')
  for (const row of expectedRows) {
    requireOutput(
      output,
      `| ${row.agent} | ${row.phase} | ${row.input} | ${row.output} | ${row.total} |`,
      'token row',
    )
  }
  requireOutput(
    output,
    `| **Total** | — | **${total.input}** | **${total.output}** | **${total.total}** |`,
    'token total',
  )
  if (/Cost \(USD\)|costUsd|\$\d|\bUSD\b/i.test(output)) {
    throw new Error('tokens-only output contains a monetary value')
  }
}

async function main() {
  if (requestedVersion !== 'v1' && requestedVersion !== 'v2') {
    emit('FAIL', 'usage: --version v1|v2 [--fixture] [--json]')
    return
  }

  if (!fixtureMode) {
    ambiental(
      'real pantheon_cost dependency/database not exercised; use --fixture for synthetic checks',
    )
    return
  }

  const source = new URL('../src/pantheon/cost-command.ts', import.meta.url)
  if (!existsSync(source)) {
    ambiental(
      'pantheon_cost dependency is unavailable: installed package lacks src/pantheon/cost-command.ts',
    )
    return
  }

  let DatabaseSync
  let createCostCommand
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
    ;({ createCostCommand } = await import(source.href))
  } catch (error) {
    ambiental(
      `pantheon_cost fixture runtime unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }

  const root = mkdtempSync(join(tmpdir(), 'pantheon-cost-probe-'))
  const dataHome = join(root, 'data')
  const opencodeDir = join(dataHome, 'opencode')
  const selectedDb = join(opencodeDir, requestedVersion === 'v2' ? 'opencode-v2.db' : 'opencode.db')
  const otherDb = join(root, 'other.db')
  const envDb = join(root, 'env.db')
  const explicitDb = join(root, 'explicit.db')
  const incompatibleDb = join(root, 'incompatible.db')
  const checks = []

  try {
    mkdirSync(opencodeDir, { recursive: true })
    // These rows intentionally include a monetary-looking field to prove it is
    // ignored; only input/output/total tokens may appear in the report.
    const selectedRows =
      requestedVersion === 'v2'
        ? [
            {
              role: 'assistant',
              agent: 'aphrodite',
              phase: 'plan',
              cost: 999.99,
              tokens: { input: 7, output: 8 },
            },
            {
              role: 'assistant',
              agent: 'aphrodite',
              phase: 'plan',
              cost: 999.99,
              tokens: { input: 1, output: 2 },
            },
            {
              role: 'assistant',
              agent: 'zeus',
              phase: 'audit',
              cost: 999.99,
              tokens: { input: 4, output: 6 },
            },
          ]
        : [
            {
              role: 'assistant',
              agent: 'hermes',
              phase: 'plan',
              cost: 999.99,
              tokens: { input: 10, output: 20 },
            },
            {
              role: 'assistant',
              agent: 'hermes',
              phase: 'plan',
              cost: 999.99,
              tokens: { input: 3, output: 4 },
            },
            {
              role: 'assistant',
              agent: 'athena',
              phase: 'review',
              cost: 999.99,
              tokens: { input: 2, output: 5 },
            },
          ]
    createSyntheticDb(DatabaseSync, selectedDb, selectedRows)
    createSyntheticDb(DatabaseSync, otherDb, [
      {
        role: 'assistant',
        agent: 'wrong-version',
        phase: 'other',
        tokens: { input: 90, output: 90 },
      },
    ])
    createSyntheticDb(DatabaseSync, envDb, [
      { role: 'assistant', agent: 'env-agent', phase: 'override', tokens: { input: 1, output: 2 } },
    ])
    createSyntheticDb(DatabaseSync, explicitDb, [
      {
        role: 'assistant',
        agent: 'explicit-agent',
        phase: 'explicit',
        tokens: { input: 9, output: 1 },
      },
    ])
    createIncompatibleDb(DatabaseSync, incompatibleDb)

    const restore = setEnvironment({
      XDG_DATA_HOME: dataHome,
      PANTHEON_OPENCODE_VERSION: requestedVersion,
      PANTHEON_COST_DB: undefined,
    })
    try {
      const selectedOutput = await createCostCommand().pantheon_cost.execute(
        {},
        { sessionID: 'cost-probe' },
      )
      assertTokensOnly(
        selectedOutput,
        requestedVersion === 'v2'
          ? [
              { agent: 'aphrodite', phase: 'plan', input: 8, output: 10, total: 18 },
              { agent: 'zeus', phase: 'audit', input: 4, output: 6, total: 10 },
            ]
          : [
              { agent: 'hermes', phase: 'plan', input: 13, output: 24, total: 37 },
              { agent: 'athena', phase: 'review', input: 2, output: 5, total: 7 },
            ],
        requestedVersion === 'v2'
          ? { input: 12, output: 16, total: 28 }
          : { input: 15, output: 29, total: 44 },
      )
      checks.push('version-selected DB: PASS')
    } finally {
      restore()
    }

    const envRestore = setEnvironment({
      XDG_DATA_HOME: dataHome,
      PANTHEON_OPENCODE_VERSION: requestedVersion,
      PANTHEON_COST_DB: envDb,
    })
    try {
      const output = await createCostCommand().pantheon_cost.execute(
        {},
        { sessionID: 'cost-probe' },
      )
      requireOutput(output, '| env-agent | override | 1 | 2 | 3 |', 'PANTHEON_COST_DB')
      if (output.includes('wrong-version') || output.includes('env-agent') === false) {
        throw new Error('PANTHEON_COST_DB did not override the version-selected database')
      }
      checks.push('PANTHEON_COST_DB override: PASS')
    } finally {
      envRestore()
    }

    const explicitRestore = setEnvironment({
      XDG_DATA_HOME: dataHome,
      PANTHEON_OPENCODE_VERSION: requestedVersion,
      PANTHEON_COST_DB: envDb,
    })
    try {
      const output = await createCostCommand({ dbPath: explicitDb }).pantheon_cost.execute(
        {},
        { sessionID: 'cost-probe' },
      )
      requireOutput(output, '| explicit-agent | explicit | 9 | 1 | 10 |', 'explicit dbPath')
      if (output.includes('env-agent')) throw new Error('explicit dbPath did not take precedence')
      checks.push('explicit dbPath precedence: PASS')
    } finally {
      explicitRestore()
    }

    const missingRestore = setEnvironment({
      XDG_DATA_HOME: join(root, 'missing-data'),
      PANTHEON_OPENCODE_VERSION: requestedVersion,
      PANTHEON_COST_DB: undefined,
    })
    try {
      const output = await createCostCommand().pantheon_cost.execute(
        {},
        { sessionID: 'cost-probe' },
      )
      requireOutput(output, 'not found', 'missing DB')
      requireOutput(
        output,
        requestedVersion === 'v2' ? 'opencode-v2.db' : 'opencode.db',
        'selected missing DB path',
      )
      checks.push('missing DB: PASS')
    } finally {
      missingRestore()
    }

    const incompatibleOutput = await createCostCommand({
      dbPath: incompatibleDb,
    }).pantheon_cost.execute({}, { sessionID: 'cost-probe' })
    requireOutput(incompatibleOutput, 'incompatible opencode.db schema', 'incompatible schema')
    checks.push('incompatible schema: PASS')
    emit('PASS', 'offline synthetic DB checks passed; no real DB was read', checks)
  } catch (error) {
    emit('FAIL', diagnostic(error), checks)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

await main()
