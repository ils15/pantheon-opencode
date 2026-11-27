/**
 * S1 — `dependsOn` in the Step Ledger (v2.3.5 swarm hardening).
 *
 * Drives acceptance S1-1..S1-7 from `.pantheon/deepwork/v235-swarm-hardening/DESIGN.md`.
 * S1-8 is the `codemap-and-ledger.test.ts` regression guard run separately.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { getSharedBus } from '../../src/pantheon/bus.ts'
import {
  cascadeBlock,
  computeWaves,
  type DependencyNode,
  detectDependencyCycles,
  normalizeDependencies,
  readyStepKeys,
} from '../../src/pantheon/step-dependencies.ts'
import {
  createStepLedgerTool,
  readStepLedger,
  type StepLedgerEntry,
  type StepLedgerStore,
  updateStepLedger,
} from '../../src/pantheon/step-ledger.ts'
import type { PantheonToolDef } from '../../src/pantheon/tools.ts'

type Json = Record<string, unknown>

function makeTool(dir: string, sessionDomain?: unknown): PantheonToolDef {
  return sessionDomain === undefined
    ? createStepLedgerTool(dir)
    : createStepLedgerTool(dir, sessionDomain as never)
}

async function call(tool: PantheonToolDef, input: Json, ctx: unknown = {}): Promise<Json> {
  const res = await tool.execute(input, ctx)
  return JSON.parse(res.output) as Json
}

function ledgerFile(dir: string): string {
  return join(dir, '.pantheon', 'ledger', 'step-ledger.json')
}

function readRaw(dir: string): StepLedgerStore {
  return JSON.parse(readFileSync(ledgerFile(dir), 'utf8')) as StepLedgerStore
}

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@pantheon.dev'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Pantheon Test'], { cwd: dir })
  writeFileSync(join(dir, 'app.ts'), 'export const version = 1\n')
  execFileSync('git', ['add', 'app.ts'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
}

function stepEntry(stepKey: string, patch: Partial<StepLedgerEntry> = {}): StepLedgerEntry {
  return {
    stepKey,
    objective: `objective ${stepKey}`,
    agent: 'hermes',
    state: 'in_progress',
    mutatedFiles: [],
    lastMutationAt: null,
    lastVerifiedAt: null,
    updatedAt: new Date().toISOString(),
    ...patch,
  }
}

function seed(dir: string, entries: StepLedgerEntry[]): void {
  updateStepLedger(dir, (store) => {
    for (const entry of entries) store.steps[entry.stepKey] = entry
  })
}

function spawnChild(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`child ${command} ${args.join(' ')} exited with ${String(code)}`))
    })
  })
}

// ── Pure graph functions ───────────────────────────────────────────────────

test('S1 pure helpers: normalize, waves, cycles, readiness, cascade', () => {
  assert.deepEqual(normalizeDependencies(['a', ' a ', 'a', '', 3, null, 'b']), ['a', 'b'])
  assert.deepEqual(normalizeDependencies(undefined), [])

  const dag: DependencyNode[] = [
    { stepKey: 'a', state: 'done', dependsOn: [] },
    { stepKey: 'b', state: 'pending', dependsOn: ['a'] },
    { stepKey: 'c', state: 'pending', dependsOn: ['a'] },
    { stepKey: 'd', state: 'blocked', dependsOn: ['b', 'c'] },
  ]
  const waves = computeWaves(dag)
  assert.deepEqual(waves.waves, [['a'], ['b', 'c'], ['d']])
  assert.deepEqual(waves.cycles, [])
  assert.deepEqual(readyStepKeys(dag), ['b', 'c'])

  const cyclic: DependencyNode[] = [
    { stepKey: 'a', state: 'in_progress', dependsOn: ['c'] },
    { stepKey: 'b', state: 'pending', dependsOn: ['a'] },
    { stepKey: 'c', state: 'pending', dependsOn: ['b'] },
  ]
  assert.deepEqual(detectDependencyCycles(cyclic), [['a', 'c', 'b', 'a']])
  // Nodes inside a cycle are never scheduled into a wave.
  assert.deepEqual(computeWaves(cyclic).waves, [])
  assert.deepEqual(computeWaves(cyclic).unplaced, ['a', 'b', 'c'])
  // A `pending` step whose dependency is not done is never "ready".
  assert.deepEqual(readyStepKeys(cyclic), [])

  const cascade = cascadeBlock(cyclic, 'a', 'root rolled back')
  assert.deepEqual(
    cascade.map((c) => c.stepKey),
    ['b', 'c'],
  )
  assert.deepEqual(cascade[0]?.blockedBy, ['a'])
  assert.equal(cascade[0]?.cascadeReason, 'root rolled back')
})

// ── S1-1 — unknown / self / duplicate dependencies ─────────────────────────

test('S1-1 rejects unknown and self dependencies instead of silently dropping them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-unknown-'))
  try {
    const tool = makeTool(dir)
    const ctx = { directory: dir }

    const base = await call(
      tool,
      { action: 'init_step', stepKey: 'a-base', objective: 'base', agent: 'hermes' },
      ctx,
    )
    assert.equal(base.ok, true)

    const unknown = await call(
      tool,
      {
        action: 'init_step',
        stepKey: 'b-child',
        objective: 'child',
        agent: 'hermes',
        dependsOn: ['a-base', 'ghost-step'],
      },
      ctx,
    )
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error, 'dependency_not_found')
    assert.deepEqual(unknown.dependencies, ['ghost-step'])
    assert.match(String(unknown.message), /ghost-step/)

    const self = await call(
      tool,
      {
        action: 'init_step',
        stepKey: 'c-self',
        objective: 'self',
        agent: 'hermes',
        dependsOn: ['c-self'],
      },
      ctx,
    )
    assert.equal(self.ok, false)
    assert.equal(self.error, 'self_dependency')

    // A dangling dependency is refused, never dropped-and-accepted.
    assert.equal(readStepLedger(dir).steps['b-child'], undefined)
    assert.equal(readStepLedger(dir).steps['c-self'], undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── S1-2 — graph.ready + step:unlocked ────────────────────────────────────

test('S1-2 status.graph.ready and step:unlocked fire when the last dependency completes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-ready-'))
  const bus = getSharedBus()
  const unlocked: Array<{ stepKey: string; unlockedBy: string; dependsOn: string[] }> = []
  const off = bus.on('step:unlocked', (ev) => {
    unlocked.push({
      stepKey: ev.stepKey,
      unlockedBy: ev.unlockedBy,
      dependsOn: [...ev.dependsOn],
    })
  })
  try {
    const tool = makeTool(dir)
    const ctx = { directory: dir }

    const a = await call(
      tool,
      { action: 'init_step', stepKey: 'a-root', objective: 'root', agent: 'hermes' },
      ctx,
    )
    assert.equal(a.ok, true)
    assert.equal((a.step as Json).state, 'in_progress', 'dep-less steps stay in_progress')

    for (const key of ['b-left', 'c-right']) {
      const res = await call(
        tool,
        {
          action: 'init_step',
          stepKey: key,
          objective: key,
          agent: 'hermes',
          dependsOn: ['a-root'],
        },
        ctx,
      )
      assert.equal(res.ok, true)
      assert.equal((res.step as Json).state, 'pending', 'unmet deps defer the step to pending')
      assert.deepEqual((res.step as Json).dependsOn, ['a-root'])
    }

    const before = await call(tool, { action: 'status' }, ctx)
    const graphBefore = before.graph as Json
    assert.deepEqual(graphBefore.waves, [['a-root'], ['b-left', 'c-right']])
    assert.deepEqual(graphBefore.ready, [])
    assert.deepEqual(graphBefore.cycles, [])
    assert.deepEqual(graphBefore.dangling, [])
    assert.deepEqual(graphBefore.unmet, { 'b-left': ['a-root'], 'c-right': ['a-root'] })

    await call(
      tool,
      {
        action: 'record_verification',
        stepKey: 'a-root',
        command: 'npx tsx tests/a.test.ts',
        exitCode: 0,
      },
      ctx,
    )
    const done = await call(tool, { action: 'complete_step', stepKey: 'a-root' }, ctx)
    assert.equal(done.ok, true)
    assert.deepEqual(done.unlocked, ['b-left', 'c-right'])

    assert.deepEqual(unlocked, [
      { stepKey: 'b-left', unlockedBy: 'a-root', dependsOn: ['a-root'] },
      { stepKey: 'c-right', unlockedBy: 'a-root', dependsOn: ['a-root'] },
    ])

    const after = await call(tool, { action: 'status' }, ctx)
    assert.deepEqual((after.graph as Json).ready, ['b-left', 'c-right'])

    const single = await call(tool, { action: 'status', stepKey: 'b-left' }, ctx)
    assert.equal(single.ready, true)
    assert.deepEqual(single.unmet, [])
  } finally {
    off()
  }
  rmSync(dir, { recursive: true, force: true })
})

// ── S1-3 — cycle rejection with a canonical path ──────────────────────────

test('S1-3 rejects dependency cycles and reports the canonical path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-cycle-'))
  try {
    const tool = makeTool(dir)
    const ctx = { directory: dir }
    await call(tool, { action: 'init_step', stepKey: 'a', objective: 'a', agent: 'hermes' }, ctx)
    await call(
      tool,
      { action: 'init_step', stepKey: 'b', objective: 'b', agent: 'hermes', dependsOn: ['a'] },
      ctx,
    )
    await call(
      tool,
      { action: 'init_step', stepKey: 'c', objective: 'c', agent: 'hermes', dependsOn: ['b'] },
      ctx,
    )

    const res = await call(
      tool,
      {
        action: 'init_step',
        stepKey: 'a',
        objective: 'a reopened',
        agent: 'hermes',
        dependsOn: ['c'],
      },
      ctx,
    )
    assert.equal(res.ok, false)
    assert.equal(res.error, 'cycle_detected')
    assert.deepEqual(res.cycles, [['a', 'c', 'b', 'a']])
    assert.equal(readStepLedger(dir).steps.a?.objective, 'a', 'rejected init must not mutate')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── S1-4 — unmet/blocked deps refuse without creating a sub-session ───────

test('S1-4 execute_step and spawn_ephemeral refuse on unmet or blocked dependencies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-gate-'))
  try {
    const calls: string[] = []
    const sessionDomain = {
      create: async () => {
        calls.push('create')
        return { id: 'ses_should_not_exist' }
      },
      prompt: async () => {
        calls.push('prompt')
        return { ok: true }
      },
    }
    const tool = makeTool(dir, sessionDomain)
    const ctx = { directory: dir }

    seed(dir, [
      stepEntry('g-a', { state: 'in_progress' }),
      stepEntry('g-b', { state: 'pending', dependsOn: ['g-a'] }),
      stepEntry('g-c', { state: 'blocked', dependsOn: ['g-a'], blockedBy: ['g-a'] }),
    ])

    const execRes = await call(
      tool,
      { action: 'execute_step', stepKey: 'g-b', objective: 'b', agent: 'hermes' },
      ctx,
    )
    assert.equal(execRes.ok, false)
    assert.equal(execRes.error, 'dependencies_unmet')
    assert.deepEqual(execRes.unmet, ['g-a'])

    const spawnRes = await call(
      tool,
      { action: 'spawn_ephemeral', stepKey: 'g-b', objective: 'b' },
      ctx,
    )
    assert.equal(spawnRes.ok, false)
    assert.equal(spawnRes.error, 'dependencies_unmet')

    const blockedRes = await call(
      tool,
      { action: 'spawn_ephemeral', stepKey: 'g-c', objective: 'c' },
      ctx,
    )
    assert.equal(blockedRes.ok, false)
    assert.equal(blockedRes.error, 'step_blocked')
    assert.deepEqual(blockedRes.blockedBy, ['g-a'])

    assert.deepEqual(calls, [], 'a refused launch must not create or prompt a sub-session')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── S1-5 — rollback cascade semantics ─────────────────────────────────────

test('S1-5 rollback refuses done dependents unless cascade:true, which blocks and invalidates them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-cascade-'))
  const bus = getSharedBus()
  const blockedEvents: Array<{ stepKey: string; blockedBy: string[]; reason: string }> = []
  const off = bus.on('step:blocked', (ev) => {
    blockedEvents.push({ stepKey: ev.stepKey, blockedBy: [...ev.blockedBy], reason: ev.reason })
  })
  try {
    initGitRepo(dir)
    const tool = makeTool(dir)
    const ctx = { directory: dir }

    /** init -> mutation -> verification -> complete (mechanical gate). */
    const finish = async (key: string, deps?: string[]) => {
      const initRes = await call(
        tool,
        {
          action: 'init_step',
          stepKey: key,
          objective: key,
          agent: 'hermes',
          ...(deps ? { dependsOn: deps } : {}),
        },
        ctx,
      )
      assert.equal(initRes.ok, true)
      await call(tool, { action: 'record_mutation', stepKey: key, files: ['app.ts'] }, ctx)
      await call(
        tool,
        { action: 'record_verification', stepKey: key, command: 'npx tsx probe.ts', exitCode: 0 },
        ctx,
      )
      const done = await call(tool, { action: 'complete_step', stepKey: key }, ctx)
      assert.equal(done.ok, true, `complete_step(${key}) must pass: ${String(done.error)}`)
      return done
    }

    await finish('r-a')
    const bDone = await finish('r-b', ['r-a'])
    await finish('r-c', ['r-b'])

    const refused = await call(tool, { action: 'rollback_step', stepKey: 'r-a' }, ctx)
    assert.equal(refused.ok, false)
    assert.equal(refused.error, 'dependents_done')
    assert.deepEqual(refused.dependents, ['r-b', 'r-c'])
    assert.equal(readStepLedger(dir).steps['r-a']?.state, 'done', 'refusal restores nothing')

    const cascaded = await call(
      tool,
      { action: 'rollback_step', stepKey: 'r-a', cascade: true },
      ctx,
    )
    assert.equal(cascaded.ok, true)
    assert.equal((cascaded.step as Json).state, 'rolled_back')

    const store = readStepLedger(dir)
    for (const key of ['r-b', 'r-c']) {
      const entry = store.steps[key]
      assert.equal(entry?.state, 'blocked', `${key} must be blocked by the cascade`)
      assert.deepEqual(entry?.blockedBy, [key === 'r-b' ? 'r-a' : 'r-b'])
      assert.match(String(entry?.cascadeReason), /rolled back/)
    }
    // The invalidated receipt is returned, never silently discarded (D04).
    const invalidated = cascaded.invalidated as Array<{ stepKey: string; receiptId?: string }>
    assert.deepEqual(
      invalidated.map((i) => i.stepKey),
      ['r-b', 'r-c'],
    )
    assert.equal(invalidated[0]?.receiptId, bDone.receiptId)

    assert.deepEqual(
      blockedEvents.map((e) => e.stepKey),
      ['r-b', 'r-c'],
    )
    assert.match(blockedEvents[0]?.reason ?? '', /rolled back/)
  } finally {
    off()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── S1-6 — the ledger survives concurrent writers ─────────────────────────

test('S1-6 two concurrent updateStepLedger writers both persist (lock + atomic rename)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-concurrent-'))
  const controlDir = mkdtempSync(join(tmpdir(), 'pantheon-dep-concurrent-control-'))
  try {
    // 1) Locked writers: both processes hammer updateStepLedger concurrently.
    const tsxCli = createRequire(import.meta.url).resolve('tsx/cli')
    const ledgerUrl = pathToFileURL(
      join(import.meta.dirname, '..', '..', 'src', 'pantheon', 'step-ledger.ts'),
    ).href
    const writerScript = join(dir, 'concurrent-writer.ts')
    const writerSource = `import { updateStepLedger } from ${JSON.stringify(ledgerUrl)}

const [targetDir, prefix, iterations] = process.argv.slice(2)
const total = Number(iterations)
// Widen the read-modify-write window so an unlocked ledger demonstrably loses
// updates; the lock must serialize these critical sections.
const sleeper = new Int32Array(new SharedArrayBuffer(4))
for (let i = 0; i < total; i += 1) {
  updateStepLedger(targetDir, (store) => {
    Atomics.wait(sleeper, 0, 0, 2)
    const key = \`\${prefix}-\${i}\`
    store.steps[key] = {
      stepKey: key,
      objective: key,
      agent: 'hermes',
      state: 'pending',
      mutatedFiles: [],
      lastMutationAt: null,
      lastVerifiedAt: null,
      updatedAt: new Date().toISOString(),
    }
  })
}
`
    writeFileSync(writerScript, writerSource, 'utf8')

    const iterations = 12
    await Promise.all([
      spawnChild(process.execPath, [tsxCli, writerScript, dir, 'writerA', String(iterations)]),
      spawnChild(process.execPath, [tsxCli, writerScript, dir, 'writerB', String(iterations)]),
    ])

    const store = readStepLedger(dir)
    const written = Object.keys(store.steps)
    for (const prefix of ['writerA', 'writerB']) {
      for (let i = 0; i < iterations; i += 1) {
        assert.ok(
          written.includes(`${prefix}-${i}`),
          `${prefix}-${i} was lost — last-writer-wins regression`,
        )
      }
    }
    assert.equal(written.length, iterations * 2)

    const ledgerDir = join(dir, '.pantheon', 'ledger')
    const leftovers = readdirSync(ledgerDir).filter((f) => f.includes('.tmp.'))
    assert.deepEqual(leftovers, [], 'atomic temp files must never be left behind')
    assert.equal(existsSync(join(ledgerDir, '.step-ledger.lock')), false, 'lock must be released')

    // 2) Control: the same read-modify-write WITHOUT the lock is provably lossy.
    //    A ready-file barrier forces both readers to snapshot before either writes.
    seed(controlDir, [stepEntry('control-seed', { state: 'done' })])
    const raceScript = join(controlDir, 'unlocked-race.mjs')
    const raceSource = `import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const [root, prefix, peer] = process.argv.slice(2)
const ledgerPath = \`\${root}/.pantheon/ledger/step-ledger.json\`
const store = JSON.parse(readFileSync(ledgerPath, 'utf8'))
writeFileSync(\`\${root}/.race-ready-\${prefix}\`, '1')
const sleeper = new Int32Array(new SharedArrayBuffer(4))
const deadline = Date.now() + 10_000
while (!existsSync(\`\${root}/.race-ready-\${peer}\`)) {
  if (Date.now() > deadline) throw new Error('barrier timeout')
  Atomics.wait(sleeper, 0, 0, 1)
}
for (let i = 0; i < 10; i += 1) {
  const key = \`\${prefix}-\${i}\`
  store.steps[key] = {
    stepKey: key,
    objective: key,
    agent: 'hermes',
    state: 'pending',
    mutatedFiles: [],
    lastMutationAt: null,
    lastVerifiedAt: null,
    updatedAt: new Date().toISOString(),
  }
}
writeFileSync(ledgerPath, JSON.stringify(store))
`
    writeFileSync(raceScript, raceSource, 'utf8')
    await Promise.all([
      spawnChild(process.execPath, [raceScript, controlDir, 'raceA', 'raceB']),
      spawnChild(process.execPath, [raceScript, controlDir, 'raceB', 'raceA']),
    ])
    const controlKeys = Object.keys(readRaw(controlDir).steps)
    const raceA = controlKeys.filter((k) => k.startsWith('raceA-')).length
    const raceB = controlKeys.filter((k) => k.startsWith('raceB-')).length
    assert.equal(
      raceA + raceB,
      10,
      'control must lose one writer entirely (proves the locked test is sensitive)',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(controlDir, { recursive: true, force: true })
  }
})

// ── S1-7 — dedupe + new fields round-trip ─────────────────────────────────

test('S1-7 dedupes dependencies and round-trips the new ledger fields at version 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-fields-'))
  try {
    const tool = makeTool(dir)
    const ctx = { directory: dir }
    await call(tool, { action: 'init_step', stepKey: 'f-a', objective: 'a', agent: 'hermes' }, ctx)

    const child = await call(
      tool,
      {
        action: 'init_step',
        stepKey: 'f-b',
        objective: 'b',
        agent: 'hermes',
        dependsOn: ['f-a', 'f-a', '  f-a  ', 'f-a'],
        ownedFiles: ['src/pantheon/step-ledger.ts'],
        forbiddenFiles: ['src/agents/roster.json'],
      },
      ctx,
    )
    assert.equal(child.ok, true)
    const entry = child.step as Json
    assert.deepEqual(entry.dependsOn, ['f-a'])
    assert.deepEqual(entry.ownedFiles, ['src/pantheon/step-ledger.ts'])
    assert.deepEqual(entry.forbiddenFiles, ['src/agents/roster.json'])

    // verificationAttempts accumulates across failures (S4 reads this).
    for (let i = 0; i < 2; i += 1) {
      await call(
        tool,
        { action: 'record_verification', stepKey: 'f-b', command: 'npx tsx probe.ts', exitCode: 1 },
        ctx,
      )
    }
    assert.equal(readStepLedger(dir).steps['f-b']?.verificationAttempts, 2)

    // `ephemeral` (D06) and `blockedBy` survive an updateStepLedger round-trip.
    updateStepLedger(dir, (store) => {
      const target = store.steps['f-b']
      assert.ok(target)
      target.ephemeral = { branch: 'pantheon/eph/f-b', baseHead: 'a'.repeat(40) }
      target.blockedBy = ['f-a']
    })
    const raw = readRaw(dir)
    assert.equal(raw.version, 1)
    assert.deepEqual(raw.steps['f-b']?.ephemeral, {
      branch: 'pantheon/eph/f-b',
      baseHead: 'a'.repeat(40),
    })
    assert.deepEqual(raw.steps['f-b']?.blockedBy, ['f-a'])
    assert.deepEqual(raw.steps['f-b']?.dependsOn, ['f-a'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
