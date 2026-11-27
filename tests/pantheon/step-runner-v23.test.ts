import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createStepLedgerTool } from '../../src/pantheon/step-ledger.ts'
import {
  buildAtomicStepPrompt,
  forkStepContext,
  runAtomicStepSubSession,
  validateStepFinishPayload,
} from '../../src/pantheon/step-runner.ts'

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q', dir])
  execFileSync('git', ['config', 'user.email', 'test@pantheon.dev'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Pantheon Test'], { cwd: dir })
  writeFileSync(join(dir, 'app.ts'), 'export const x = 1\n')
  execFileSync('git', ['add', 'app.ts'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
}

test('validateStepFinishPayload validates required fields and rejects malformed payloads', () => {
  const okRes = validateStepFinishPayload({
    status: 'complete',
    summary: 'Implemented step cleanly',
    filesChanged: ['src/a.ts'],
    receiptId: 'rcpt-1',
  })
  assert.equal(okRes.ok, true)
  if (okRes.ok) {
    assert.equal(okRes.value.status, 'complete')
    assert.deepEqual(okRes.value.filesChanged, ['src/a.ts'])
  }

  const badRes = validateStepFinishPayload({
    status: 'unknown',
    summary: '',
    filesChanged: [42],
  })
  assert.equal(badRes.ok, false)
  if (!badRes.ok) {
    assert.ok(badRes.errors.length >= 2)
  }
})

test('runAtomicStepSubSession reuses caller-owned session without create/remove and supports maxTurns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-reuse-'))
  try {
    initGitRepo(dir)
    const ledger = createStepLedgerTool(dir)
    let createCalls = 0
    let removeCalls = 0
    let promptCalls = 0

    const sessionDomain = {
      create: async () => {
        createCalls += 1
        return { id: 'should-not-be-created' }
      },
      prompt: async (input: { sessionID: string; text: string }) => {
        promptCalls += 1
        assert.equal(input.sessionID, 'ses-existing')
        if (promptCalls === 2) {
          await ledger.execute(
            {
              action: 'record_verification',
              stepKey: 'reuse-1',
              command: 'node --test',
              exitCode: 0,
            },
            { directory: dir },
          )
          await ledger.execute({ action: 'complete_step', stepKey: 'reuse-1' }, { directory: dir })
        }
        return { ok: true }
      },
      wait: async () => ({ status: 'completed' }),
      remove: async () => {
        removeCalls += 1
      },
    }

    const res = await runAtomicStepSubSession({
      sessionDomain,
      cwd: dir,
      stepKey: 'reuse-1',
      objective: 'Multi-turn finish',
      agent: 'hermes',
      reuseSessionID: 'ses-existing',
      maxTurns: 3,
    })

    assert.equal(res.ok, true)
    assert.equal(res.sessionID, 'ses-existing')
    assert.equal(res.reusedSession, true)
    assert.equal(res.turnsUsed, 2)
    assert.equal(createCalls, 0)
    assert.equal(removeCalls, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('forkStepContext uses native sessionDomain.fork when available and falls back to create+prompt seed otherwise', async () => {
  const nativeFork = await forkStepContext(
    {
      fork: async (input) => {
        assert.equal(input.sessionID, 'ses-src')
        return { id: 'ses-forked-native' }
      },
    },
    { sourceSessionID: 'ses-src', title: 'Rebuttal fork', agent: 'athena' },
  )
  assert.equal(nativeFork.ok, true)
  assert.equal(nativeFork.mode, 'native_fork')
  assert.equal(nativeFork.sessionID, 'ses-forked-native')

  let seededPrompt = ''
  const fallbackFork = await forkStepContext(
    {
      create: async (input) => {
        assert.equal(input?.agent, 'athena')
        return { id: 'ses-forked-fallback' }
      },
      prompt: async (input) => {
        seededPrompt = input.text
        return { ok: true }
      },
    },
    {
      sourceSessionID: 'ses-src',
      agent: 'athena',
      fallbackSummary: 'Position summary from #1',
    },
  )
  assert.equal(fallbackFork.ok, true)
  assert.equal(fallbackFork.mode, 'fallback_seed')
  assert.equal(fallbackFork.sessionID, 'ses-forked-fallback')
  assert.match(seededPrompt, /Position summary from #1/)
})

test('buildAtomicStepPrompt renders ownedFiles and forbiddenFiles boundaries', () => {
  const prompt = buildAtomicStepPrompt({
    stepKey: 'scope-1',
    objective: 'Update auth helper',
    agent: 'hermes',
    ownedFiles: ['src/auth.ts', 'tests/auth.test.ts'],
    forbiddenFiles: ['src/billing.ts'],
  })
  assert.match(prompt, /ownedFiles: src\/auth\.ts, tests\/auth\.test\.ts/)
  assert.match(prompt, /forbiddenFiles: src\/billing\.ts/)
  assert.match(prompt, /ONLY mutate files within ownedFiles/)
  assert.match(prompt, /NEVER modify or touch forbiddenFiles/)
})

test('runAtomicStepSubSession halts cleanly with wall_clock_exceeded when wallClockMs is exceeded', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-wallclock-'))
  try {
    initGitRepo(dir)
    // Capture the real timer before virtualizing it, so test sequencing never
    // depends on the mocked clock.
    const realSetTimeout = globalThis.setTimeout
    let promptCalls = 0
    const sessionDomain = {
      create: async () => ({ id: 'ses-wc-1' }),
      prompt: async () => {
        promptCalls += 1
        // Parked until the test advances the virtual clock: the runner must
        // halt on its own wall-clock timer, never on this prompt completing.
        await new Promise((r) => setTimeout(r, 25))
        return { ok: true }
      },
      wait: async () => ({ status: 'running' }),
      remove: async () => {},
    }

    // Virtualize both the timer and Date so elapsedMs measures the runner's own
    // accounting (startedAt -> halt) instead of host scheduling jitter.
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })

    const runPromise = runAtomicStepSubSession({
      sessionDomain,
      cwd: dir,
      stepKey: 'wc-1',
      objective: 'Slow step',
      agent: 'hermes',
      maxTurns: 5,
      wallClockMs: 10,
    })

    // The ledger checkpoint spawns real git processes before the first prompt.
    // This wait only sequences the deterministic tick; it asserts nothing about
    // timing, and it fails loudly instead of hanging if the runner stalls.
    const readyDeadline = performance.now() + 10_000
    while (promptCalls === 0) {
      assert.ok(performance.now() < readyDeadline, 'runner never dispatched its first prompt')
      await new Promise((r) => realSetTimeout(r, 2))
    }
    // Let the runner register its wall-clock race timer now that prompt() returned.
    await new Promise((r) => setImmediate(r))

    t.mock.timers.tick(10)
    const res = await runPromise

    assert.equal(res.ok, false)
    assert.equal(res.haltedReason, 'wall_clock_exceeded')
    assert.equal(promptCalls, 1)
    // Deterministic: exactly the virtual budget elapsed before the halt.
    assert.equal(res.elapsedMs, 10)
    assert.match(res.error ?? '', /wall-clock timeout exceeded \(10ms >= 10ms\)/)

    // Drain the parked prompt so no mocked timer outlives the test.
    t.mock.timers.tick(15)
    await new Promise((r) => setImmediate(r))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runAtomicStepSubSession halts cleanly with max_cost_exceeded when cumulative cost exceeds maxCostUsd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-cost-'))
  try {
    initGitRepo(dir)
    let turn = 0
    const sessionDomain = {
      create: async () => ({ id: 'ses-cost-1' }),
      prompt: async () => {
        turn += 1
        return { ok: true }
      },
      wait: async () => ({ status: 'running' }),
      messages: async () => Array.from({ length: turn }, () => ({ info: { cost: 0.35 } })),
      remove: async () => {},
    }

    const res = await runAtomicStepSubSession({
      sessionDomain,
      cwd: dir,
      stepKey: 'cost-1',
      objective: 'Expensive step',
      agent: 'hermes',
      maxTurns: 5,
      maxCostUsd: 0.5,
    })

    assert.equal(res.ok, false)
    assert.equal(res.haltedReason, 'max_cost_exceeded')
    assert.equal(res.turnsUsed, 2)
    assert.ok(typeof res.costUsd === 'number' && res.costUsd > 0.5)
    assert.match(res.error ?? '', /max cost exceeded/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
