import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCodemapTools } from '../../src/pantheon/codemap-tools.ts'
import { createStepLedgerTool } from '../../src/pantheon/step-ledger.ts'
import type { PantheonToolDef } from '../../src/pantheon/tools.ts'

async function callTool(
  tools: Map<string, PantheonToolDef>,
  name: string,
  input: Record<string, unknown>,
  ctx: unknown,
): Promise<Record<string, unknown>> {
  const tool = tools.get(name)
  assert.ok(tool, `expected tool ${name} to be registered`)
  const res = await tool.execute(input, ctx)
  return JSON.parse(res.output) as Record<string, unknown>
}

test('codemap tools index TypeScript and Python files, query symbols, and traverse neighbors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-codemap-'))
  try {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'src', 'auth.ts'),
      [
        "import { hashToken } from './crypto.ts'",
        'export interface AuthSession { id: string }',
        'export class SessionManager extends BaseManager {}',
        'export async function verifySessionToken(token: string): Promise<boolean> {',
        '  return Boolean(hashToken(token))',
        '}',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(
      join(dir, 'src', 'worker.py'),
      [
        'from services.queue import TaskQueue',
        'class JobRunner(BaseRunner):',
        '    pass',
        'async def run_batch_jobs(items):',
        '    return len(items)',
      ].join('\n'),
      'utf8',
    )

    const tools = new Map(createCodemapTools(dir).map((t) => [t.name, t]))
    const ctx = { directory: dir }

    const idxRes = await callTool(tools, 'code_index', {}, ctx)
    assert.equal(idxRes.ok, true)
    assert.equal(idxRes.indexed, 2)
    assert.ok((idxRes.entities as number) >= 5)

    // Second run without force skips unchanged hashes
    const idxSkip = await callTool(tools, 'code_index', {}, ctx)
    assert.equal(idxSkip.skipped, 2)

    const queryFn = await callTool(
      tools,
      'code_query',
      { query: 'verifySessionToken', kind: 'function' },
      ctx,
    )
    assert.equal(queryFn.ok, true)
    assert.equal(queryFn.count, 1)
    const fnResults = queryFn.results as Array<Record<string, unknown>>
    assert.equal(fnResults[0]?.file, 'src/auth.ts')

    const neighbors = await callTool(
      tools,
      'code_neighbors',
      { target: 'SessionManager', direction: 'outgoing' },
      ctx,
    )
    assert.equal(neighbors.ok, true)
    const outgoing = neighbors.outgoing as Array<Record<string, unknown>>
    assert.equal(outgoing[0]?.target, 'BaseManager')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('step-ledger enforces mechanical completion gate and invalidates verification on subsequent mutation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-step-ledger-'))
  try {
    const tool = createStepLedgerTool(dir)
    const tools = new Map([[tool.name, tool]])
    const ctx = { directory: dir }

    const init = await callTool(
      tools,
      'pantheon_step_ledger',
      {
        action: 'init_step',
        stepKey: 'step-1-auth',
        objective: 'Implement token verifier',
        agent: 'hermes',
      },
      ctx,
    )
    assert.equal(init.ok, true)

    // Cannot complete before verification
    const premature = await callTool(
      tools,
      'pantheon_step_ledger',
      { action: 'complete_step', stepKey: 'step-1-auth' },
      ctx,
    )
    assert.equal(premature.ok, false)

    // Record file mutation
    await callTool(
      tools,
      'pantheon_step_ledger',
      {
        action: 'record_mutation',
        stepKey: 'step-1-auth',
        files: ['src/auth.ts'],
      },
      ctx,
    )

    // Failed verification triggers ThemisReflexController retry directive
    const failedVerify = await callTool(
      tools,
      'pantheon_step_ledger',
      {
        action: 'record_verification',
        stepKey: 'step-1-auth',
        command: 'node --test tests/auth.test.mjs',
        exitCode: 1,
        durationMs: 120,
      },
      ctx,
    )
    assert.equal(failedVerify.ok, false)
    assert.equal((failedVerify.reflex as Record<string, unknown>).action, 'retry')

    // Passing verification mints a cryptographic receipt
    const passedVerify = await callTool(
      tools,
      'pantheon_step_ledger',
      {
        action: 'record_verification',
        stepKey: 'step-1-auth',
        command: 'node --test tests/auth.test.mjs',
        exitCode: 0,
        durationMs: 95,
      },
      ctx,
    )
    assert.equal(passedVerify.ok, true)
    assert.match(String(passedVerify.receiptId), /^rcpt_[0-9a-f]{16}$/)

    // Now complete_step succeeds
    const completed = await callTool(
      tools,
      'pantheon_step_ledger',
      { action: 'complete_step', stepKey: 'step-1-auth' },
      ctx,
    )
    assert.equal(completed.ok, true)
    assert.equal(completed.status, 'done')

    // Mutating files AFTER completion re-opens step and blocks completion until re-verified
    await new Promise((r) => setTimeout(r, 5))
    await callTool(
      tools,
      'pantheon_step_ledger',
      {
        action: 'record_mutation',
        stepKey: 'step-1-auth',
        files: ['src/auth.ts'],
      },
      ctx,
    )
    const blockedAfterMutate = await callTool(
      tools,
      'pantheon_step_ledger',
      { action: 'complete_step', stepKey: 'step-1-auth' },
      ctx,
    )
    assert.equal(blockedAfterMutate.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('codemap prunes deleted files on query, neighbors, and re-index', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-codemap-prune-'))
  try {
    const fileA = join(dir, 'probe.mjs')
    const fileB = join(dir, 'probe.test.mjs')
    writeFileSync(fileA, 'export function orphanSum(a, b) { return a + b }\n', 'utf8')
    writeFileSync(fileB, "import { orphanSum } from './probe.mjs'\n", 'utf8')

    const tools = new Map(createCodemapTools(dir).map((t) => [t.name, t]))
    const ctx = { directory: dir }
    const idx1 = await callTool(tools, 'code_index', {}, ctx)
    assert.equal(idx1.indexed, 2)

    // Delete probe.mjs and probe.test.mjs from disk
    rmSync(fileA)
    rmSync(fileB)

    // Query and neighbors must prune missing files instead of returning stale symbols
    const q = await callTool(tools, 'code_query', { query: 'orphanSum' }, ctx)
    assert.equal(q.count, 0)
    assert.deepEqual(q.results, [])

    const n = await callTool(tools, 'code_neighbors', { target: 'probe.mjs' }, ctx)
    assert.deepEqual(n.outgoing, [])
    assert.deepEqual(n.incoming, [])

    // Re-create one file, delete it, then verify code_index reports pruned >= 1
    writeFileSync(fileA, 'export function orphanSum2(a, b) { return a + b }\n', 'utf8')
    await callTool(tools, 'code_index', {}, ctx)
    rmSync(fileA)
    const idx2 = await callTool(tools, 'code_index', {}, ctx)
    assert.equal(idx2.ok, true)
    assert.ok((idx2.pruned as number) >= 1, `expected pruned >= 1, got ${String(idx2.pruned)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
