import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readBoardMessages } from '../../src/pantheon/board-messages.ts'
import { type EphemeralWorkerEventPayload, getSharedBus } from '../../src/pantheon/bus.ts'
import { spawnEphemeralWorker } from '../../src/pantheon/ephemeral-worker.ts'
import { createStepLedgerTool } from '../../src/pantheon/step-ledger.ts'

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q', dir])
  execFileSync('git', ['config', 'user.email', 'test@pantheon.dev'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Pantheon Test'], { cwd: dir })
  writeFileSync(join(dir, 'index.ts'), 'export const ok = true\n')
  execFileSync('git', ['add', 'index.ts'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
}

test('spawnEphemeralWorker creates disposable worktree, posts #seq board claim/done, runs sub-session, and cleans up without touching .opencode/agents', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'pantheon-eph-'))
  const repoDir = join(parent, 'my-app')
  const bus = getSharedBus()
  const events: EphemeralWorkerEventPayload[] = []
  const off = bus.on('ephemeral:worker', (ev) => events.push(ev))

  try {
    initGitRepo(repoDir)
    let capturedWorktree: string | undefined
    const removedSessions: string[] = []

    const sessionDomain = {
      create: async (opts?: { title?: string; agent?: string }) => {
        assert.equal(opts?.agent, 'hermes')
        return { id: 'ses-eph-1' }
      },
      prompt: async (input: {
        sessionID: string
        text: string
        agents?: ReadonlyArray<{ readonly name: string }>
      }) => {
        assert.equal(input.agents?.[0]?.name, 'hermes')
        assert.match(input.text, /db-migrator/)
        const wtMatch = /worktree:\s*(\S+)/.exec(input.text)
        capturedWorktree = wtMatch?.[1]
        assert.ok(capturedWorktree)
        assert.equal(existsSync(capturedWorktree), true)
        const ledger = createStepLedgerTool(capturedWorktree)
        await ledger.execute(
          {
            action: 'record_verification',
            stepKey: 'eph-step-1',
            command: 'echo ok',
            exitCode: 0,
          },
          { directory: capturedWorktree },
        )
        await ledger.execute(
          { action: 'complete_step', stepKey: 'eph-step-1' },
          { directory: capturedWorktree },
        )
        return { ok: true }
      },
      wait: async () => ({ status: 'completed' }),
      remove: async (input: { readonly sessionID: string }) => {
        removedSessions.push(input.sessionID)
      },
    }

    const res = await spawnEphemeralWorker({
      sessionDomain,
      cwd: repoDir,
      stepKey: 'eph-step-1',
      role: 'db-migrator',
      objective: 'Run ephemeral schema slice',
      parentSessionID: 'ses-zeus',
    })

    assert.equal(res.ok, true)
    assert.equal(res.role, 'db-migrator')
    assert.equal(res.baseAgent, 'hermes')
    assert.equal(res.claimSeq, 1)
    assert.equal(res.finalSeq, 2)
    assert.equal(res.worktreeCleaned, true)
    assert.deepEqual(removedSessions, ['ses-eph-1'])
    assert.ok(capturedWorktree)
    assert.equal(existsSync(capturedWorktree), false, 'disposable worktree must be cleaned up')
    assert.equal(
      existsSync(join(repoDir, '.opencode', 'agents')),
      false,
      'ephemeral worker must not pollute .opencode/agents/',
    )

    const board = readBoardMessages(repoDir, { since: 0 })
    assert.equal(board.messages.length, 2)
    assert.equal(board.messages[0]?.tag, 'claim')
    assert.equal(board.messages[0]?.ephemeral?.role, 'db-migrator')
    assert.equal(board.messages[1]?.tag, 'done')
    assert.equal(board.messages[1]?.replyToSeq, 1)
    assert.equal(board.messages[1]?.ephemeral?.status, 'cleaned')

    assert.deepEqual(
      events.map((e) => e.action),
      ['spawned', 'completed', 'cleaned'],
    )
  } finally {
    off()
    rmSync(parent, { recursive: true, force: true })
  }
})

test('pantheon_step_ledger spawn_ephemeral rejects invalid role slug and supports readOnly -> apollo baseAgent', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'pantheon-eph-tool-'))
  const repoDir = join(parent, 'repo')
  try {
    initGitRepo(repoDir)
    const sessionDomain = {
      create: async (opts?: { agent?: string }) => {
        assert.equal(opts?.agent, 'apollo')
        return { id: 'ses-ro-1' }
      },
      prompt: async () => ({ ok: true }),
      wait: async () => ({ status: 'completed' }),
      remove: async () => {},
    }
    const ledger = createStepLedgerTool(repoDir, sessionDomain)
    const bad = JSON.parse(
      (
        await ledger.execute(
          {
            action: 'spawn_ephemeral',
            stepKey: 's1',
            objective: 'bad role',
            role: 'Invalid Role!',
          },
          { directory: repoDir },
        )
      ).output,
    ) as { ok: boolean; error?: string }
    assert.equal(bad.ok, false)

    const roOut = JSON.parse(
      (
        await ledger.execute(
          {
            action: 'spawn_ephemeral',
            stepKey: 's2',
            objective: 'Read-only trace audit',
            role: 'trace-scout',
            readOnly: true,
            isolateWorktree: false,
          },
          { directory: repoDir },
        )
      ).output,
    ) as { ok: boolean; baseAgent: string; claimSeq?: number }
    assert.equal(roOut.baseAgent, 'apollo')
    assert.equal(roOut.claimSeq, 1)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
