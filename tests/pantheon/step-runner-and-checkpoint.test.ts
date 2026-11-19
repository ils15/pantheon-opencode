import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { getSharedBus } from '../../src/pantheon/bus.ts'
import { captureGitCheckpoint, restoreGitCheckpoint } from '../../src/pantheon/git-checkpoint.ts'
import { createStepLedgerTool } from '../../src/pantheon/step-ledger.ts'
import { runAtomicStepSubSession } from '../../src/pantheon/step-runner.ts'

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@pantheon.dev'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Pantheon Test'], { cwd: dir })
  writeFileSync(join(dir, 'app.ts'), 'export const version = 1\n')
  execFileSync('git', ['add', 'app.ts'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
}

test('captureGitCheckpoint and restoreGitCheckpoint snapshot and roll back without touching real staged index', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-git-ckpt-'))
  try {
    initGitRepo(dir)
    const snap = await captureGitCheckpoint(dir, 'step-1')
    assert.equal(snap.ok, true)
    assert.match(snap.treeHash ?? '', /^[0-9a-f]{40}$/)

    // Mutate tracked file and add a new untracked file
    writeFileSync(join(dir, 'app.ts'), 'export const version = 999\n')
    writeFileSync(join(dir, 'stray.ts'), 'export const stray = true\n')

    assert.ok(snap.treeHash)
    const rollback = await restoreGitCheckpoint(dir, snap.treeHash)
    assert.equal(rollback.ok, true)
    assert.equal(readFileSync(join(dir, 'app.ts'), 'utf8'), 'export const version = 1\n')
    assert.equal(
      existsSync(join(dir, 'stray.ts')),
      false,
      'newly created untracked file must be cleaned',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('step_ledger captures baselineTree on init_step and auto-rolls back on themis:reflex:escalated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-ledger-rollback-'))
  try {
    initGitRepo(dir)
    const ledger = createStepLedgerTool(dir)
    const escalated: string[] = []
    const rolledBack: string[] = []
    const bus = getSharedBus()
    const offEsc = bus.on('themis:reflex:escalated', (e) => escalated.push(e.taskID))
    const offRb = bus.on('step:rollback', (e) => rolledBack.push(e.stepKey))

    try {
      const initRes = JSON.parse(
        (
          await ledger.execute(
            {
              action: 'init_step',
              stepKey: 'step-auto-rb',
              objective: 'Fix regression cleanly',
              agent: 'hermes',
            },
            { directory: dir },
          )
        ).output,
      ) as { ok: boolean; step: { baselineTree?: string } }
      assert.equal(initRes.ok, true)
      assert.match(initRes.step.baselineTree ?? '', /^[0-9a-f]{40}$/)

      writeFileSync(join(dir, 'app.ts'), 'export const version = -1 // broken\n')
      await ledger.execute(
        { action: 'record_mutation', stepKey: 'step-auto-rb', files: ['app.ts'] },
        { directory: dir },
      )

      // 3 failing verifications exhaust maxRetries (2) -> escalate -> auto-rollback
      for (let i = 0; i < 3; i += 1) {
        await ledger.execute(
          {
            action: 'record_verification',
            stepKey: 'step-auto-rb',
            command: 'npm test',
            exitCode: 1,
          },
          { directory: dir },
        )
      }

      assert.ok(escalated.includes('step-auto-rb'))
      assert.ok(rolledBack.includes('step-auto-rb'))
      assert.equal(readFileSync(join(dir, 'app.ts'), 'utf8'), 'export const version = 1\n')
    } finally {
      offEsc()
      offRb()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runAtomicStepSubSession and pantheon_step_ledger execute_step use real SDK shapes and clean up child session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-step-runner-'))
  try {
    initGitRepo(dir)
    const calls: string[] = []
    const removed: string[] = []
    const ledger = createStepLedgerTool(dir)

    const fakeSessionDomain = {
      create: async (opts?: { title?: string; agent?: string; parentID?: string }) => {
        calls.push(`create:${opts?.agent ?? ''}:${opts?.title ?? ''}`)
        assert.ok(opts?.agent, 'create must specify target agent matching SessionCreateInput')
        return { id: 'ses_atomic_1' }
      },
      prompt: async (input: {
        sessionID: string
        text: string
        agents?: ReadonlyArray<{ readonly name: string }>
      }) => {
        const keyMatch = /stepKey:\s*(\S+)/.exec(input.text)
        const targetKey = keyMatch?.[1] ?? 'sub-step-1'
        calls.push(`prompt:${input.sessionID}:${targetKey}`)
        assert.equal(
          input.agents?.[0]?.name,
          'hermes',
          'prompt must pass SessionPromptInput agents[]',
        )
        // Simulate sub-session completing verification & ledger
        await ledger.execute(
          { action: 'record_mutation', stepKey: targetKey, files: ['app.ts'] },
          { directory: dir },
        )
        await ledger.execute(
          {
            action: 'record_verification',
            stepKey: targetKey,
            command: 'node --test',
            exitCode: 0,
          },
          { directory: dir },
        )
        await ledger.execute({ action: 'complete_step', stepKey: targetKey }, { directory: dir })
        return { ok: true }
      },
      wait: async (input: { readonly sessionID: string }) => {
        calls.push(`wait:${input.sessionID}`)
        return { status: 'completed' }
      },
      remove: async (input: { readonly sessionID: string }) => {
        removed.push(input.sessionID)
      },
    }

    const res = await runAtomicStepSubSession({
      sessionDomain: fakeSessionDomain,
      cwd: dir,
      stepKey: 'sub-step-1',
      objective: 'Implement health route',
      agent: 'hermes',
    })
    assert.equal(res.ok, true)
    assert.equal(res.sessionID, 'ses_atomic_1')
    assert.equal(res.stepState, 'done')
    assert.deepEqual(removed, ['ses_atomic_1'])
    assert.ok(calls.some((c) => c.startsWith('create:hermes:')))
    assert.ok(calls.includes('wait:ses_atomic_1'))

    // Now invoke directly via pantheon_step_ledger(action="execute_step")
    const wiredLedger = createStepLedgerTool(dir, fakeSessionDomain)
    const toolOut = JSON.parse(
      (
        await wiredLedger.execute(
          {
            action: 'execute_step',
            stepKey: 'sub-step-2',
            objective: 'Add readiness check',
            agent: 'hermes',
          },
          { directory: dir, sessionID: 'ses_parent_zeus' },
        )
      ).output,
    ) as { ok: boolean; stepState?: string; receiptId?: string }
    assert.equal(toolOut.ok, true)
    assert.equal(toolOut.stepState, 'done')
    assert.ok(toolOut.receiptId)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
