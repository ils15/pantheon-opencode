import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createStepLedgerTool } from '../../src/pantheon/step-ledger.ts'
import {
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
