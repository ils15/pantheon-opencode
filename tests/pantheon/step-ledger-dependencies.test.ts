/**
 * S1 — `dependsOn` in the Step Ledger (v2.3.5 swarm hardening).
 *
 * Drives acceptance S1-1..S1-7 from `.pantheon/deepwork/v235-swarm-hardening/DESIGN.md`.
 * S1-8 is the `codemap-and-ledger.test.ts` regression guard run separately.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { getSharedBus } from '../../src/pantheon/bus.ts'
import {
  captureGitCheckpoint,
  checkpointTreeExists,
  listAnchoredBaselines,
  restoreGitCheckpoint,
} from '../../src/pantheon/git-checkpoint.ts'
import { evaluateReproductionGate } from '../../src/pantheon/reproduction-gate.ts'
import {
  buildDependencyGraph,
  cascadeBlock,
  computeWaves,
  type DependencyNode,
  detectDependencyCycles,
  isReservedStepKey,
  normalizeDependencies,
  readyStepKeys,
  validateDependencies,
} from '../../src/pantheon/step-dependencies.ts'
import {
  createStepLedgerTool,
  describeLedgerError,
  preserveLedgerBytes,
  readStepLedger,
  type StepLedgerEntry,
  StepLedgerLockError,
  type StepLedgerStore,
  scrubCheckpointHistory,
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

  // Minor 1: a dangling dependency makes a step unschedulable, never wave-1.
  const danglingNodes: DependencyNode[] = [
    { stepKey: 'd-ok', state: 'done', dependsOn: [] },
    { stepKey: 'd-orphan', state: 'pending', dependsOn: ['deleted-step'] },
    { stepKey: 'd-child', state: 'pending', dependsOn: ['d-orphan'] },
  ]
  const danglingWaves = computeWaves(danglingNodes)
  assert.deepEqual(danglingWaves.waves, [['d-ok']])
  assert.deepEqual(danglingWaves.unplaced, ['d-child', 'd-orphan'])
  // Minor 2: `unplaced` is reported in status.graph.
  assert.deepEqual(buildDependencyGraph(danglingNodes).unplaced, ['d-child', 'd-orphan'])
  assert.deepEqual(buildDependencyGraph(danglingNodes).dangling, [
    { stepKey: 'd-orphan', missing: ['deleted-step'] },
  ])

  // Minor 3: an overlapping cyclic region must not mask the candidate's cycle.
  //   a -> [w, s] (`s` dangling) and w -> a made the old DFS report only a<->w.
  const overlapping: DependencyNode[] = [
    { stepKey: 'a', state: 'in_progress', dependsOn: ['w', 's'] },
    { stepKey: 'w', state: 'pending', dependsOn: ['a'] },
  ]
  const sValidation = validateDependencies('s', ['w'], overlapping)
  assert.equal(sValidation.ok, false)
  assert.equal(sValidation.issues[0]?.code, 'cycle_detected')
  assert.deepEqual(sValidation.cycles, [['a', 's', 'w', 'a']])
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
      stepEntry('g-c', {
        state: 'blocked',
        dependsOn: ['g-a'],
        blockedBy: ['g-a'],
        cascadeReason: 'Step "g-a" was rolled back; dependent invalidated by cascade',
      }),
      // Reflex-escalation block: no cascade, no deps. Must stay retryable (M1).
      stepEntry('g-retry', { state: 'blocked' }),
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
    assert.match(String(blockedRes.cascadeReason), /rolled back/)

    assert.equal(calls.length, 0, 'a refused launch must not create or prompt a sub-session')

    // M1: a reflex-escalation `blocked` step (no cascade) is retryable again.
    const retryRes = await call(
      tool,
      { action: 'execute_step', stepKey: 'g-retry', objective: 'retry', agent: 'hermes' },
      ctx,
    )
    assert.ok(calls.includes('create'), 'a reflex-escalated step must be launchable')
    assert.notEqual(retryRes.error, 'step_blocked')
    assert.equal(readStepLedger(dir).steps['g-retry']?.state, 'in_progress')
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

    // C2: a refusal must be a no-op — uncommitted work survives, nothing restores.
    const dirtyFile = join(dir, 'wip.ts')
    writeFileSync(dirtyFile, 'export const wip = "uncommitted work"\n')

    const refused = await call(tool, { action: 'rollback_step', stepKey: 'r-a' }, ctx)
    assert.equal(refused.ok, false)
    assert.equal(refused.error, 'dependents_done')
    assert.deepEqual(refused.dependents, ['r-b', 'r-c'])
    assert.equal(refused.treeUntouched, true)
    assert.equal(
      readFileSync(dirtyFile, 'utf8'),
      'export const wip = "uncommitted work"\n',
      'a refused rollback must not destroy uncommitted work',
    )
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
    const writerSource = `import { existsSync, writeFileSync } from 'node:fs'
import { updateStepLedger } from ${JSON.stringify(ledgerUrl)}

const [targetDir, prefix, iterations, peer] = process.argv.slice(2)
const total = Number(iterations)
// Start barrier (M3): both writers leave the gate at the same instant, so a
// lucky stagger cannot hide a missing lock.
const sleeper = new Int32Array(new SharedArrayBuffer(4))
writeFileSync(\`\${targetDir}/.writer-ready-\${prefix}\`, '1')
const barrierDeadline = Date.now() + 10_000
while (!existsSync(\`\${targetDir}/.writer-ready-\${peer}\`)) {
  if (Date.now() > barrierDeadline) throw new Error('writer barrier timeout')
  Atomics.wait(sleeper, 0, 0, 1)
}
// Widen the read-modify-write window so an unlocked ledger demonstrably loses
// updates; the lock must serialize these critical sections.
for (let i = 0; i < total; i += 1) {
  updateStepLedger(targetDir, (store) => {
    Atomics.wait(sleeper, 0, 0, 2)
    const shared = store.steps['shared-counter'] ?? {
      stepKey: 'shared-counter',
      objective: 'shared increment counter',
      agent: 'hermes',
      state: 'in_progress',
      mutatedFiles: [],
      lastMutationAt: null,
      lastVerifiedAt: null,
      updatedAt: new Date().toISOString(),
    }
    store.steps['shared-counter'] = shared
    shared.verificationAttempts = (shared.verificationAttempts ?? 0) + 1
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
      spawnChild(process.execPath, [
        tsxCli,
        writerScript,
        dir,
        'writerA',
        String(iterations),
        'writerB',
      ]),
      spawnChild(process.execPath, [
        tsxCli,
        writerScript,
        dir,
        'writerB',
        String(iterations),
        'writerA',
      ]),
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
    assert.equal(written.length, iterations * 2 + 1)

    // The decisive assertion (M3): a lost read-modify-write loses *increments*,
    // which never re-absorb. A lucky stagger cannot satisfy 2N.
    assert.equal(
      store.steps['shared-counter']?.verificationAttempts,
      iterations * 2,
      'lost increments — last-writer-wins regression',
    )

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
    // Minor 7: failures are persisted separately so S4 can derive retries.
    assert.equal(readStepLedger(dir).steps['f-b']?.verificationFailures, 2)

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

// ── C3 — the cascade cannot be undone by a passing verification ───────────

test('C3 a cascade-blocked dependent stays blocked until unblock_step and its deps are done', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-c3-'))
  try {
    initGitRepo(dir)
    const tool = makeTool(dir)
    const ctx = { directory: dir }

    const finish = async (key: string, deps?: string[]) => {
      await call(
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
      await call(tool, { action: 'record_mutation', stepKey: key, files: ['app.ts'] }, ctx)
      await call(
        tool,
        { action: 'record_verification', stepKey: key, command: 'npx tsx probe.ts', exitCode: 0 },
        ctx,
      )
      const done = await call(tool, { action: 'complete_step', stepKey: key }, ctx)
      assert.equal(done.ok, true, `complete_step(${key}): ${String(done.error)}`)
    }

    await finish('c3-a')
    await finish('c3-b', ['c3-a'])

    const cascade = await call(
      tool,
      { action: 'rollback_step', stepKey: 'c3-a', cascade: true },
      ctx,
    )
    assert.equal(cascade.ok, true)
    assert.equal(readStepLedger(dir).steps['c3-b']?.state, 'blocked')

    // (a) A passing verification must NOT lift the cascade block.
    const verified = await call(
      tool,
      {
        action: 'record_verification',
        stepKey: 'c3-b',
        command: 'npx tsx probe.ts',
        exitCode: 0,
      },
      ctx,
    )
    assert.equal(verified.ok, true)
    const blockedEntry = readStepLedger(dir).steps['c3-b']
    assert.equal(blockedEntry?.state, 'blocked', 'verification must not unblock implicitly')
    assert.deepEqual(blockedEntry?.blockedBy, ['c3-a'])
    assert.match(String(blockedEntry?.cascadeReason), /cascade/)

    // (b) complete_step refuses while a declared dependency is not done.
    const refusedComplete = await call(tool, { action: 'complete_step', stepKey: 'c3-b' }, ctx)
    assert.equal(refusedComplete.ok, false)
    assert.equal(refusedComplete.error, 'dependencies_unmet')
    assert.deepEqual(refusedComplete.unmet, ['c3-a'])

    // unblock_step refuses until the prerequisite is done again.
    const refusedUnblock = await call(tool, { action: 'unblock_step', stepKey: 'c3-b' }, ctx)
    assert.equal(refusedUnblock.ok, false)
    assert.equal(refusedUnblock.error, 'dependencies_unmet')
    assert.deepEqual(refusedUnblock.unmet, ['c3-a'])

    // Re-run the prerequisite, then the explicit unblock is allowed.
    await finish('c3-a', [])
    const unblocked = await call(tool, { action: 'unblock_step', stepKey: 'c3-b' }, ctx)
    assert.equal(unblocked.ok, true)
    assert.equal((unblocked.step as Json).state, 'in_progress')
    assert.equal((unblocked.step as Json).blockedBy, undefined)
    assert.equal((unblocked.step as Json).cascadeReason, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── M2/M4 — lock ownership, stale break, actionable errors ────────────────

test('M2/M4 the lock is owner-checked, breaks stale holders fast, and names itself on failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-lock-'))
  const ledgerDir = join(dir, '.pantheon', 'ledger')
  const lockPath = join(ledgerDir, '.step-ledger.lock')
  try {
    seed(dir, [stepEntry('lock-a')])

    // (a) A writer whose lock was evicted mid-mutation aborts before committing,
    //     and its release never deletes the successor's lock.
    const foreignToken = '999999:someone-else'
    assert.throws(
      () =>
        updateStepLedger(dir, (store) => {
          const entry = store.steps['lock-a']
          assert.ok(entry)
          entry.objective = 'touched'
          writeFileSync(lockPath, `${foreignToken}\n`)
        }),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        assert.match(message, /no longer owned/)
        assert.match(message, /\.step-ledger\.lock/)
        return true
      },
    )
    assert.equal(
      readFileSync(lockPath, 'utf8').trim(),
      foreignToken,
      'the evicted writer must not delete the successor lock',
    )
    assert.equal(
      readStepLedger(dir).steps['lock-a']?.objective,
      'objective lock-a',
      'an aborted commit must not persist the mutation',
    )
    rmSync(lockPath)

    // (b) Stale lock (dead pid, old mtime) is broken quickly, not after 10 s.
    writeFileSync(lockPath, '999999:dead-writer\n')
    utimesSync(lockPath, new Date(Date.now() - 5_000), new Date(Date.now() - 5_000))
    const startedAt = Date.now()
    updateStepLedger(dir, (store) => {
      store.steps['lock-stale'] = stepEntry('lock-stale')
    })
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed < 2_000, `stale break took ${elapsed}ms`)
    assert.equal(existsSync(lockPath), false, 'lock released after the break')
    assert.deepEqual(
      readdirSync(ledgerDir).filter((f) => f.includes('.stale.')),
      [],
      'quarantine files are cleaned up',
    )

    // (c) A lock owned by this process is re-entrant misuse: immediate, actionable.
    writeFileSync(lockPath, `${process.pid}:self\n`)
    const selfStart = Date.now()
    assert.throws(
      () => updateStepLedger(dir, () => undefined),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        assert.match(message, /re-entrant/)
        assert.match(message, /.step-ledger\.lock/)
        return true
      },
    )
    assert.ok(Date.now() - selfStart < 500, 'self-owned lock must fail fast, not after the budget')
    rmSync(lockPath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── A2 — a corrupt ledger is quarantined, never overwritten ───────────────

test('A2 a corrupt ledger file is moved aside and the mutation fails loudly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-corrupt-'))
  const ledgerDir = join(dir, '.pantheon', 'ledger')
  const ledgerPath = join(ledgerDir, 'step-ledger.json')
  try {
    seed(dir, [stepEntry('keep-me', { state: 'done' })])
    writeFileSync(ledgerPath, '{ this is not json')

    assert.throws(
      () =>
        updateStepLedger(dir, (store) => {
          store.steps['would-wipe'] = stepEntry('would-wipe')
        }),
      /corrupt/,
    )

    const quarantined = readdirSync(ledgerDir).filter((f) =>
      f.startsWith('step-ledger.json.corrupt.'),
    )
    assert.equal(quarantined.length, 1, 'the corrupt file must be preserved')
    const preserved = quarantined[0]
    assert.ok(preserved)
    assert.equal(readFileSync(join(ledgerDir, preserved), 'utf8'), '{ this is not json')
    assert.equal(existsSync(ledgerPath), false, 'no empty store is written over the corrupt file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── A4 — orphan temp files are garbage-collected ──────────────────────────

test('A4 stale orphan temp files are swept while a live one is preserved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-tmp-'))
  const ledgerDir = join(dir, '.pantheon', 'ledger')
  try {
    seed(dir, [stepEntry('tmp-a')])
    const orphan = join(ledgerDir, 'step-ledger.json.tmp.424242')
    const live = join(ledgerDir, 'step-ledger.json.tmp.424243')
    writeFileSync(orphan, '{}')
    writeFileSync(live, '{}')
    utimesSync(orphan, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000))

    updateStepLedger(dir, (store) => {
      store.steps['tmp-b'] = stepEntry('tmp-b')
    })

    assert.equal(existsSync(orphan), false, 'old orphan tmp file must be collected')
    assert.equal(existsSync(live), true, 'a fresh tmp file may belong to a live writer')
    rmSync(live)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── Minor 4 — reserved step keys cannot pollute the prototype ─────────────

test('minor 4 reserved step keys are rejected and never pollute Object.prototype', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-proto-'))
  try {
    assert.equal(isReservedStepKey('__proto__'), true)
    assert.equal(isReservedStepKey('constructor'), true)
    assert.equal(isReservedStepKey('safe-step'), false)

    const tool = makeTool(dir)
    const res = await call(
      tool,
      { action: 'init_step', stepKey: '__proto__', objective: 'pollute', agent: 'hermes' },
      { directory: dir },
    )
    assert.equal(res.ok, false)
    assert.match(String(res.error), /reserved/)

    const polluted = ({} as Record<string, unknown>).polluted
    assert.equal(polluted, undefined)
    assert.deepEqual(Object.keys(readStepLedger(dir).steps), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── R-a — refusal/compensation are verified, atomic and ledger-safe ───────

async function prepareVerifiedStep(
  tool: PantheonToolDef,
  ctx: unknown,
  stepKey: string,
  dependsOn?: string[],
): Promise<void> {
  const init = await call(
    tool,
    {
      action: 'init_step',
      stepKey,
      objective: stepKey,
      agent: 'hermes',
      ...(dependsOn ? { dependsOn } : {}),
    },
    ctx,
  )
  assert.equal(init.ok, true, `init_step(${stepKey}): ${String(init.error)}`)
  await call(tool, { action: 'record_mutation', stepKey, files: ['app.ts'] }, ctx)
  const verified = await call(
    tool,
    { action: 'record_verification', stepKey, command: 'npx tsx probe.ts', exitCode: 0 },
    ctx,
  )
  assert.equal(verified.ok, true)
}

async function completeVerifiedStep(
  tool: PantheonToolDef,
  ctx: unknown,
  stepKey: string,
): Promise<void> {
  const done = await call(tool, { action: 'complete_step', stepKey }, ctx)
  assert.equal(done.ok, true, `complete_step(${stepKey}): ${String(done.error)}`)
}

test('R-a late refusal: a dependent completing mid-rollback is compensated, WIP and ledger survive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-late-'))
  try {
    initGitRepo(dir)
    const tool = makeTool(dir)
    const ctx = { directory: dir }

    await prepareVerifiedStep(tool, ctx, 'late-a')
    await completeVerifiedStep(tool, ctx, 'late-a')
    await prepareVerifiedStep(tool, ctx, 'late-b', ['late-a'])

    const wip = 'export const wip = "uncommitted work"\n'
    writeFileSync(join(dir, 'wip.ts'), wip)

    // Real interleaving: `call` runs the rollback synchronously up to its first
    // await (the pre-rollback checkpoint), so this dependent completes *after*
    // the locked decision and *before* the post-restore lock.
    const rollbackPromise = call(tool, { action: 'rollback_step', stepKey: 'late-a' }, ctx)
    const completed = await call(tool, { action: 'complete_step', stepKey: 'late-b' }, ctx)
    assert.equal(completed.ok, true, `late dependent completion: ${String(completed.error)}`)

    const refused = await rollbackPromise
    assert.equal(refused.ok, false)
    assert.equal(refused.error, 'dependents_done')
    assert.deepEqual(refused.dependents, ['late-b'])
    assert.equal(refused.treeRestored, true)
    assert.match(String(refused.restoredTree), /^[0-9a-f]{40}$/)
    assert.equal(refused.restoreFailed, undefined)

    // The refusal is a no-op: work survives and the ledger matches the tree.
    assert.equal(readFileSync(join(dir, 'wip.ts'), 'utf8'), wip)
    const store = readStepLedger(dir)
    assert.equal(store.steps['late-a']?.state, 'done', 'the rolled-back step is unchanged')
    assert.equal(store.steps['late-b']?.state, 'done', 'the mid-flight completion survives')
    assert.equal(store.steps['late-a']?.rolledBackAt, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R-a post-restore missing entry: the tree is compensated and reported, not destroyed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-vanish-'))
  try {
    initGitRepo(dir)
    const tool = makeTool(dir)
    const ctx = { directory: dir }

    await prepareVerifiedStep(tool, ctx, 'gone-a')
    const wip = 'export const wip = "keep me"\n'
    writeFileSync(join(dir, 'wip.ts'), wip)

    const rollbackPromise = call(tool, { action: 'rollback_step', stepKey: 'gone-a' }, ctx)
    // The entry disappears while the rollback waits on git.
    updateStepLedger(dir, (store) => {
      delete store.steps['gone-a']
    })

    const result = await rollbackPromise
    assert.equal(result.ok, false)
    assert.match(String(result.error), /not initialized/)
    assert.equal(result.treeRestored, true)
    assert.match(String(result.restoredTree), /^[0-9a-f]{40}$/)
    assert.equal(
      readFileSync(join(dir, 'wip.ts'), 'utf8'),
      wip,
      'compensation restores the WIP file',
    )
    assert.equal(readStepLedger(dir).steps['gone-a'], undefined, 'the ledger is not resurrected')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── D1 — checkpoints must not capture (or restore) `.pantheon/` ───────────

test('D1 rollback keeps every ledger step in a repo that does not ignore .pantheon', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-unignored-'))
  try {
    // No `.gitignore` rule for `.pantheon`: this is the reviewer's fixture.
    initGitRepo(dir)
    assert.throws(
      () => execFileSync('git', ['check-ignore', '-q', '.pantheon'], { cwd: dir }),
      'fixture must NOT ignore .pantheon, or this test could pass by accident',
    )

    const tool = makeTool(dir)
    const ctx = { directory: dir }
    for (const stepKey of ['u-a', 'u-b', 'u-c']) {
      const init = await call(
        tool,
        { action: 'init_step', stepKey, objective: stepKey, agent: 'hermes' },
        ctx,
      )
      assert.equal(init.ok, true)
    }

    // u-b's baseline was captured after u-a's entry existed; it must still not
    // contain runtime state.
    const baselineTree = readStepLedger(dir).steps['u-b']?.baselineTree
    assert.ok(baselineTree)
    const listing = execFileSync('git', ['ls-tree', '-r', '--name-only', baselineTree], {
      cwd: dir,
      encoding: 'utf8',
    })
    assert.equal(listing.includes('.pantheon'), false, 'checkpoint captured runtime state')

    const rb = await call(tool, { action: 'rollback_step', stepKey: 'u-b' }, ctx)
    assert.equal(rb.ok, true, `rollback: ${String(rb.error)}`)
    assert.notEqual(rb.error, 'Step "u-b" is not initialized')

    const store = readStepLedger(dir)
    assert.deepEqual(Object.keys(store.steps).sort(), ['u-a', 'u-b', 'u-c'])
    assert.equal(store.steps['u-b']?.state, 'rolled_back')
    assert.equal(store.steps['u-c']?.state, 'in_progress', 'unrelated step must survive')
    assert.equal(store.steps['u-a']?.state, 'in_progress')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── L1/L2/L3 — checkpoints never carry `.pantheon/` (now or historically) ─

/**
 * Build a checkpoint the way Pantheon < 2.3.5 did: `read-tree HEAD` + `add -A`
 * with no `.pantheon/` exclusion, so the tree captures the ledger.
 */
function buildLegacyCheckpoint(dir: string): string {
  const tmpIndex = join(dir, '.legacy-index')
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex }
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim()
  try {
    git(['read-tree', 'HEAD'])
    git(['add', '-A'])
    return git(['write-tree'])
  } finally {
    rmSync(tmpIndex, { force: true })
  }
}

function treeEntries(dir: string, treeHash: string): string[] {
  return execFileSync('git', ['ls-tree', '-r', '--name-only', treeHash], {
    cwd: dir,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
}

test('L1 a legacy checkpoint cannot roll back .pantheon runtime state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-l1-'))
  try {
    initGitRepo(dir)
    seed(dir, [stepEntry('l1-a', { state: 'done' }), stepEntry('l1-b', { state: 'in_progress' })])
    const liveLedger = readFileSync(ledgerFile(dir), 'utf8')

    // A legacy checkpoint that DID capture the ledger, with stale content.
    writeFileSync(ledgerFile(dir), JSON.stringify({ version: 1, steps: { 'l1-a': { stale: 1 } } }))
    const legacyTree = buildLegacyCheckpoint(dir)
    writeFileSync(ledgerFile(dir), liveLedger)
    assert.ok(treeEntries(dir, legacyTree).includes('.pantheon/ledger/step-ledger.json'))

    const rb = await restoreGitCheckpoint(dir, legacyTree)
    assert.equal(rb.ok, true, `restore failed: ${String(rb.reason)}`)
    assert.equal(
      readFileSync(ledgerFile(dir), 'utf8'),
      liveLedger,
      'restore must never apply .pantheon/ paths from a legacy checkpoint',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('L2 capture excludes .pantheon runtime state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-l2-'))
  try {
    initGitRepo(dir)
    seed(dir, [stepEntry('l2-a', { state: 'in_progress' })])
    writeFileSync(join(dir, 'app.ts'), 'export const version = 2\n')

    const captured = await captureGitCheckpoint(dir, 'l2')
    assert.equal(captured.ok, true)
    const entries = treeEntries(dir, String(captured.treeHash))
    assert.ok(entries.includes('app.ts'), 'work-tree changes are still captured')
    assert.equal(
      entries.some((entry) => entry.startsWith('.pantheon/')),
      false,
      'checkpoint must not capture runtime state',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('L3 scrub rewrites legacy checkpoints without .pantheon and leaves them GC-able', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-l3-'))
  try {
    initGitRepo(dir)
    seed(dir, [stepEntry('l3-a', { state: 'in_progress' })])
    // Build a legacy checkpoint with stale runtime state, then point a ledger
    // entry at it (the ledger is the only index of "checkpoints" that exists).
    writeFileSync(ledgerFile(dir), JSON.stringify({ version: 1, steps: { stale: true } }))
    const legacyTree = buildLegacyCheckpoint(dir)
    seed(dir, [stepEntry('l3-a', { state: 'in_progress', baselineTree: legacyTree })])

    // Dry run reports without persisting.
    const dry = await scrubCheckpointHistory(dir, { dryRun: true })
    assert.equal(dry.dryRun, true)
    assert.equal(dry.rewritten.length, 1)
    assert.equal(readStepLedger(dir).steps['l3-a']?.baselineTree, legacyTree)

    const scrubbed = await scrubCheckpointHistory(dir)
    assert.equal(scrubbed.ok, true)
    assert.deepEqual(scrubbed.remaining, [])
    assert.equal(scrubbed.rewritten.length, 1)
    assert.notEqual(scrubbed.rewritten[0]?.to, legacyTree)
    // Legacy entries are anchored by the scrub (their migration path).
    assert.equal(scrubbed.anchored.length, 1)
    assert.equal(scrubbed.anchored[0]?.ref, 'refs/pantheon/step-baselines/l3-a')

    const store = readStepLedger(dir)
    const rewrittenTree = String(store.steps['l3-a']?.baselineTree)
    assert.notEqual(rewrittenTree, legacyTree)
    // Every checkpoint the ledger references is now free of runtime state.
    for (const entry of Object.values(store.steps)) {
      if (!entry.baselineTree) continue
      assert.equal(
        treeEntries(dir, entry.baselineTree).some((path) => path.startsWith('.pantheon/')),
        false,
        `checkpoint for ${entry.stepKey} still contains .pantheon/`,
      )
    }

    // Idempotent, and the old tree is unreachable -> reclaimable by Git.
    const again = await scrubCheckpointHistory(dir)
    assert.deepEqual(again.rewritten, [])

    // The maintenance action works without a stepKey (it is a ledger-wide scrub).
    const tool = makeTool(dir)
    const viaTool = await call(tool, { action: 'scrub_checkpoints' }, { directory: dir })
    assert.equal(viaTool.ok, true)
    assert.deepEqual(viaTool.rewritten, [])

    const unreachable = execFileSync('git', ['fsck', '--unreachable', '--no-reflogs'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    assert.match(unreachable, new RegExp(legacyTree))
    execFileSync('git', ['gc', '--prune=now', '--quiet'], { cwd: dir })
    assert.throws(() =>
      execFileSync('git', ['cat-file', '-e', legacyTree], { cwd: dir, stdio: 'ignore' }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── F1/F2 — baselines survive GC, pruned baselines fail loudly, and the
//    runtime-state predicate matches the exact `.pantheon` name ────────────

test('F1 an anchored baseline survives aggressive GC and can still be rolled back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-anchor-'))
  try {
    initGitRepo(dir)
    const tool = makeTool(dir)
    const ctx = { directory: dir }

    const init = await call(tool, { action: 'init_step', stepKey: 'anchor-a', objective: 'a' }, ctx)
    assert.equal(init.ok, true)
    const entry = readStepLedger(dir).steps['anchor-a']
    assert.ok(entry?.baselineTree)
    assert.equal(entry.baselineRef, 'refs/pantheon/step-baselines/anchor-a')

    const anchors = await listAnchoredBaselines(dir)
    assert.equal(anchors.length, 1)
    assert.equal(anchors[0]?.ref, 'refs/pantheon/step-baselines/anchor-a')
    assert.equal(anchors[0]?.tree, entry.baselineTree)

    // The baseline is reachable, so even `--prune=now` cannot delete it.
    execFileSync('git', ['gc', '--prune=now', '--quiet'], { cwd: dir })
    assert.equal(await checkpointTreeExists(dir, entry.baselineTree), true)

    const rb = await call(tool, { action: 'rollback_step', stepKey: 'anchor-a' }, ctx)
    assert.equal(rb.ok, true, `rollback after gc: ${String(rb.error)}`)
    assert.equal(readStepLedger(dir).steps['anchor-a']?.state, 'rolled_back')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F1 a pruned baseline fails loudly and leaves the step untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-missing-baseline-'))
  try {
    initGitRepo(dir)
    const tool = makeTool(dir)
    const ctx = { directory: dir }
    seed(dir, [
      stepEntry('miss-a', {
        state: 'in_progress',
        baselineTree: 'a'.repeat(40),
        baselineRef: 'refs/pantheon/step-baselines/miss-a',
      }),
    ])

    const rb = await call(tool, { action: 'rollback_step', stepKey: 'miss-a' }, ctx)
    assert.equal(rb.ok, false)
    assert.equal(rb.error, 'baseline_missing')
    assert.equal(rb.baselineTree, 'a'.repeat(40))
    assert.equal(rb.treeUntouched, true)
    assert.match(String(rb.hint), /pruned|Re-initialize/)
    assert.equal(readStepLedger(dir).steps['miss-a']?.state, 'in_progress')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F2 the runtime-state predicate matches the exact `.pantheon` name (file and symlink)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-exact-'))
  const outside = mkdtempSync(join(tmpdir(), 'pantheon-dep-exact-outside-'))
  try {
    initGitRepo(dir)
    const baseline = await captureGitCheckpoint(dir, 'exact')
    assert.equal(baseline.ok, true)

    // A *symlink* named exactly `.pantheon`: `startsWith('.pantheon/')` misses
    // it, and the restore's untracked cleanup would delete it.
    const symlink = join(dir, '.pantheon')
    symlinkSync(outside, symlink)
    assert.equal(
      execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd: dir,
        encoding: 'utf8',
      }).includes('.pantheon'),
      true,
    )
    await restoreGitCheckpoint(dir, String(baseline.treeHash))
    assert.equal(lstatSync(symlink).isSymbolicLink(), true, 'symlink named .pantheon must survive')

    // A regular *file* named exactly `.pantheon`.
    rmSync(symlink)
    writeFileSync(symlink, 'runtime state placeholder\n')
    await restoreGitCheckpoint(dir, String(baseline.treeHash))
    assert.equal(existsSync(symlink), true, 'file named .pantheon must survive')
    assert.equal(readFileSync(symlink, 'utf8'), 'runtime state placeholder\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

// ── D1 — the restore guard (second layer) ────────────────────────────────

test('D1 the restore guard merges a clobbered ledger back without losing concurrent work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-guard-'))
  try {
    seed(dir, [
      stepEntry('g-1', { state: 'done', objective: 'one' }),
      stepEntry('g-2', { state: 'in_progress', objective: 'two' }),
    ])
    const before = readStepLedger(dir)

    await preserveLedgerBytes(dir, async () => {
      // Simulate a legacy restore rewriting the ledger with an older snapshot
      // (g-1 only) *and* a concurrent writer adding g-3 in the same window.
      writeFileSync(
        ledgerFile(dir),
        JSON.stringify({
          version: 1,
          steps: { 'g-1': before.steps['g-1'], 'g-3': stepEntry('g-3') },
        }),
      )
    })

    const after = readStepLedger(dir)
    assert.deepEqual(Object.keys(after.steps).sort(), ['g-1', 'g-2', 'g-3'])
    assert.equal(after.steps['g-2']?.objective, 'two', 'clobbered entry restored from the snapshot')
    assert.equal(after.steps['g-3']?.objective, 'objective g-3', 'concurrent addition survives')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── D3 — lock failures surface as structured results ─────────────────────

test('D3 a lost lock is a structured tool result, and the error carries a code', () => {
  const mapped = describeLedgerError(
    new StepLedgerLockError(
      'lock_lost',
      'lock .pantheon/ledger/.step-ledger.lock is no longer owned',
    ),
  )
  assert.ok(mapped)
  assert.equal(mapped.ok, false)
  assert.equal(mapped.error, 'lock lost mid-mutation')
  assert.match(mapped.hint, /Re-run the action/)
  assert.match(mapped.detail, /no longer owned/)

  assert.equal(describeLedgerError(new Error('plain')), undefined)

  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-d3-'))
  try {
    seed(dir, [stepEntry('d3-a')])
    const lockPath = join(dir, '.pantheon', 'ledger', '.step-ledger.lock')
    assert.throws(
      () =>
        updateStepLedger(dir, (store) => {
          store.steps['d3-a'] = { ...stepEntry('d3-a'), objective: 'changed' }
          writeFileSync(lockPath, '999999:someone-else\n')
        }),
      (err: unknown) =>
        err instanceof StepLedgerLockError &&
        err.code === 'lock_lost' &&
        describeLedgerError(err)?.error === 'lock lost mid-mutation',
    )
    rmSync(lockPath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R-e the reproduction gate reports an unreadable ledger instead of failing silently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dep-gate-corrupt-'))
  try {
    seed(dir, [stepEntry('bug-1', { state: 'in_progress', taskType: 'bugfix' })])
    writeFileSync(ledgerFile(dir), '{ definitely not json')

    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }
    let allowed = false
    try {
      const verdict = evaluateReproductionGate({
        cwd: dir,
        tool: 'edit',
        agent: 'hermes',
        args: { filePath: 'src/app.ts' },
      })
      allowed = verdict.allowed
    } finally {
      console.warn = originalWarn
    }

    assert.equal(allowed, true, 'the gate fails open, but loudly')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /reproduction-gate/)
    assert.match(warnings[0] ?? '', /could not read the step ledger/)
    // `readStepLedger` quarantines instead of overwriting (A2).
    const quarantined = readdirSync(join(dir, '.pantheon', 'ledger')).filter((f) =>
      f.includes('.corrupt.'),
    )
    assert.equal(quarantined.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
