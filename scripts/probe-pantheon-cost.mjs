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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * Write the rows in the family the requested host generation actually uses.
 *
 * Call sites describe an assistant turn the way they always have
 * (`role: 'assistant'`, plus a `phase`). This function translates that
 * descriptor into what is on disk: for V2, `role` becomes the `type` COLUMN and
 * `phase` is dropped, because a real V2 payload carries neither — measured, the
 * `role` key is absent from 40052 of 40052 rows on a host 2.0.22 database.
 *
 * Keeping that translation in ONE place is the point: a fixture that wrote
 * `role` into a session_message row asserts the V1 format under a V2 name, which
 * is exactly how the stale V1 predicate in the CLI mirror stayed green — the
 * synthetic database agreed with the bug instead of contradicting it.
 */
/** USD per 1M tokens, chosen so a 10-token row costs exactly $1.00. */
const PRICE_PER_MTOK = 100_000

/** Priced by the synthetic catalog below. */
const PRICED_MODEL = { id: 'probe-model', providerID: 'probe' }

/** In no catalog at all, so its row must read — and never $0.00. */
const UNPRICED_MODEL = { id: 'ghost-model', providerID: 'ghost' }

/**
 * Translate a fixture descriptor into the payload the selected family stores.
 *
 * V1 keeps the model at the TOP LEVEL (`modelID`/`providerID`) and marks the
 * assistant turn inside `data.role`; V2 nests the model in `model` and marks the
 * turn with the `type` COLUMN. Writing one family's shape under the other
 * family's name is how a fixture starts agreeing with the reader instead of with
 * the host, so the translation lives in one place.
 */
function toLedgerPayload(row, version) {
  const payload = { ...row }
  const model = payload.model
  delete payload.model
  if (model !== undefined) {
    if (version === 'v2') {
      payload.model = model
    } else {
      payload.modelID = model.id
      payload.providerID = model.providerID
    }
  }
  if (version === 'v2') {
    delete payload.role
    delete payload.phase
  }
  return payload
}

function createSyntheticDb(DatabaseSync, path, rows) {
  const db = new DatabaseSync(path)
  if (requestedVersion === 'v2') {
    db.exec(
      'CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)',
    )
    const insert = db.prepare(
      'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)',
    )
    rows.forEach((row, index) => {
      insert.run(
        `msg_${index + 1}`,
        'ses_probe',
        row.role,
        index + 1,
        Date.now(),
        Date.now(),
        JSON.stringify(toLedgerPayload(row, 'v2')),
      )
    })
  } else {
    db.exec('CREATE TABLE message (data TEXT NOT NULL, time_created INTEGER NOT NULL)')
    const insert = db.prepare('INSERT INTO message (data, time_created) VALUES (?, ?)')
    for (const row of rows) insert.run(JSON.stringify(toLedgerPayload(row, 'v1')), Date.now())
  }
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

/**
 * The money side of the report, asserted rather than trusted.
 *
 * Every assertion here is a way the cost feature can silently disappear: the
 * column is dropped from the header, a row loses its cost cell, the two
 * additive sections go away, the unpriced row is priced at zero, or the total
 * stops saying it is partial. The unit suites cover the arithmetic; this probe
 * covers the SHIPPED output shape of the installed package.
 */
function assertCostReport(output, expectedRows, total, expectedTotalCell) {
  requireOutput(
    output,
    'Tokens In | Tokens Out | Tokens Total | Cost (USD) |',
    'cost column in the by-agent header',
  )
  for (const row of expectedRows) {
    requireOutput(
      output,
      `| ${row.agent} | ${row.phase} | ${row.input} | ${row.output} | ${row.total} | ${row.cost} |`,
      'row with its cost cell',
    )
  }
  requireOutput(
    output,
    `| **Total** | — | **${total.input}** | **${total.output}** | **${total.total}** | ${expectedTotalCell} |`,
    'total with its cost cell',
  )
  requireOutput(output, '## Cost by model', 'by-model section')
  requireOutput(output, '## Cost by session', 'by-session section')
  requireOutput(output, 'Pricing:', 'pricing provenance')
  if (output.includes('999.99')) {
    throw new Error('the payload `cost` field was published as if it were a price')
  }
  if (output.includes('$0.00') && expectedRows.some((row) => row.cost === '—')) {
    throw new Error('an unpriced row was reported as free')
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
  // Every real installation writes `opencode.db`; the v1/v2 distinction is the
  // SCHEMA of that file, never its name. Deriving `opencode-v2.db` here made the
  // probe assert a path that exists on no real machine.
  const selectedDb = join(opencodeDir, 'opencode.db')
  const otherDb = join(root, 'other.db')
  const envDb = join(root, 'env.db')
  const explicitDb = join(root, 'explicit.db')
  const incompatibleDb = join(root, 'incompatible.db')
  const checks = []
  // Pricing is pinned into the temp root: the probe asserts the report's money
  // semantics, not whether models.dev is reachable today or what the developer's
  // real cache happens to contain.
  const configHome = join(root, 'config')
  const priceCache = join(configHome, 'cache', 'models-dev.json')
  // A synthetic cache plus an offline host is the only combination that keeps
  // this probe deterministic: it must never reach the network, and it must not
  // inherit whatever prices the running machine has cached. Set OUTSIDE the try
  // so the finally block can always restore it.
  const previousPricingEnv = {
    PANTHEON_HOME: process.env.PANTHEON_HOME,
    PANTHEON_COST_OFFLINE: process.env.PANTHEON_COST_OFFLINE,
  }
  process.env.PANTHEON_HOME = configHome
  process.env.PANTHEON_COST_OFFLINE = '1'

  try {
    mkdirSync(opencodeDir, { recursive: true })
    mkdirSync(join(configHome, 'cache'), { recursive: true })
    writeFileSync(
      priceCache,
      JSON.stringify({
        version: 1,
        fetchedAt: Date.now(),
        providers: {
          probe: { 'probe-model': { inputPerMTok: PRICE_PER_MTOK, outputPerMTok: PRICE_PER_MTOK } },
        },
      }),
    )
    // These rows intentionally include a monetary-looking field to prove it is
    // ignored; only input/output/total tokens may appear in the report. Every
    // V2 phase reads back as `unknown` because the V2 reader emits that literal:
    // a V2 payload carries no phase field for a reader to recover.
    const selectedRows =
      requestedVersion === 'v2'
        ? [
            {
              role: 'assistant',
              agent: 'aphrodite',
              phase: 'plan',
              model: PRICED_MODEL,
              cost: 999.99,
              tokens: { input: 7, output: 8 },
            },
            {
              role: 'assistant',
              agent: 'aphrodite',
              phase: 'plan',
              model: PRICED_MODEL,
              cost: 999.99,
              tokens: { input: 1, output: 2 },
            },
            {
              role: 'assistant',
              agent: 'zeus',
              phase: 'audit',
              model: UNPRICED_MODEL,
              cost: 999.99,
              tokens: { input: 4, output: 6 },
            },
          ]
        : [
            {
              role: 'assistant',
              agent: 'hermes',
              phase: 'plan',
              model: PRICED_MODEL,
              cost: 999.99,
              tokens: { input: 10, output: 20 },
            },
            {
              role: 'assistant',
              agent: 'hermes',
              phase: 'plan',
              model: PRICED_MODEL,
              cost: 999.99,
              tokens: { input: 3, output: 4 },
            },
            {
              role: 'assistant',
              agent: 'athena',
              phase: 'review',
              model: UNPRICED_MODEL,
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
      assertCostReport(
        selectedOutput,
        requestedVersion === 'v2'
          ? [
              // 18 tokens × $0.10/token: priced from the synthetic catalog.
              {
                agent: 'aphrodite',
                phase: 'unknown',
                input: 8,
                output: 10,
                total: 18,
                cost: '$1.80',
              },
              // In no catalog: — and excluded from the total, never $0.00.
              { agent: 'zeus', phase: 'unknown', input: 4, output: 6, total: 10, cost: '—' },
            ]
          : [
              { agent: 'hermes', phase: 'plan', input: 13, output: 24, total: 37, cost: '$3.70' },
              { agent: 'athena', phase: 'review', input: 2, output: 5, total: 7, cost: '—' },
            ],
        requestedVersion === 'v2'
          ? { input: 12, output: 16, total: 28 }
          : { input: 15, output: 29, total: 44 },
        requestedVersion === 'v2' ? '**$1.80** (partial)' : '**$3.70** (partial)',
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
      // V2 has no phase to report, so the same row reads back as 'unknown'.
      requireOutput(
        output,
        `| env-agent | ${requestedVersion === 'v2' ? 'unknown' : 'override'} | 1 | 2 | 3 |`,
        'PANTHEON_COST_DB',
      )
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
      requireOutput(
        output,
        `| explicit-agent | ${requestedVersion === 'v2' ? 'unknown' : 'explicit'} | 9 | 1 | 10 |`,
        'explicit dbPath',
      )
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
      requireOutput(output, 'opencode.db', 'selected missing DB path')
      checks.push('missing DB: PASS')
    } finally {
      missingRestore()
    }

    const incompatibleOutput = await createCostCommand({
      dbPath: incompatibleDb,
    }).pantheon_cost.execute({}, { sessionID: 'cost-probe' })
    requireOutput(incompatibleOutput, 'incompatible opencode.db schema', 'incompatible schema')
    checks.push('incompatible schema: PASS')
    // Names the synthetic fixture that was built, because the previous wording
    // ("no real DB was read") was true of every run and therefore true of the run
    // in which the V2 ledger was read as V1 and silently dropped. A verdict that
    // cannot fail is not a verdict: it stayed green across the exact defect it
    // was meant to cover.
    emit(
      'PASS',
      `${checks.length} synthetic ${requestedVersion} checks passed against a temporary opencode.db (no user database was read)`,
      checks,
    )
  } catch (error) {
    emit('FAIL', diagnostic(error), checks)
  } finally {
    for (const [key, value] of Object.entries(previousPricingEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
}

await main()
