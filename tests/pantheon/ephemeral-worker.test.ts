import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readBoardMessages } from '../../src/pantheon/board-messages.ts'
import { type EphemeralWorkerEventPayload, getSharedBus } from '../../src/pantheon/bus.ts'
import {
  deriveEphemeralRoleSlug,
  type FileLeaseHook,
  partitionBranchesForVerifiers,
  resolveEphemeralArchetype,
  spawnEphemeralWorker,
  verifyEphemeralBranches,
} from '../../src/pantheon/ephemeral-worker.ts'
import { createStepLedgerTool, readStepLedger } from '../../src/pantheon/step-ledger.ts'

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

test('deriveEphemeralRoleSlug sanitizes arbitrary labels into validator-safe role slugs', () => {
  const safe = /^[a-z0-9][a-z0-9-]{0,31}$/
  assert.equal(deriveEphemeralRoleSlug('worker-eph-step-1'), 'worker-eph-step-1')
  assert.equal(
    deriveEphemeralRoleSlug('worker-Data.Migrate:Auth_V2'),
    'worker-data-migrate-auth-v2',
  )
  assert.equal(deriveEphemeralRoleSlug('worker-___..--'), 'worker')
  assert.equal(deriveEphemeralRoleSlug(''), 'worker')
  assert.equal(deriveEphemeralRoleSlug('-'.repeat(8)), 'worker')

  const longKey = `worker-${'A_b:C.'.repeat(18)}`
  const longSlug = deriveEphemeralRoleSlug(longKey)
  assert.equal(longSlug.length, 32)
  assert.match(longSlug, safe)
  assert.equal(longSlug.endsWith('-'), false)
  assert.match(deriveEphemeralRoleSlug(longKey), safe)
})

test('pantheon_step_ledger spawn_ephemeral derives a safe role slug when role is omitted', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'pantheon-eph-default-role-'))
  const repoDir = join(parent, 'repo')
  try {
    initGitRepo(repoDir)
    const sessionDomain = {
      create: async () => ({ id: 'ses-default-role-1' }),
      prompt: async () => ({ ok: true }),
      wait: async () => ({ status: 'completed' }),
      remove: async () => {},
    }
    const ledger = createStepLedgerTool(repoDir, sessionDomain)
    const out = JSON.parse(
      (
        await ledger.execute(
          {
            action: 'spawn_ephemeral',
            stepKey: 'Data.Migrate:Auth_V2',
            objective: 'Default-role slice',
            isolateWorktree: false,
          },
          { directory: repoDir },
        )
      ).output,
    ) as { role?: string; claimSeq?: number; finalSeq?: number; error?: string }
    assert.equal(out.error, undefined)
    assert.equal(out.role, 'worker-data-migrate-auth-v2')
    assert.match(out.role ?? '', /^[a-z0-9][a-z0-9-]{0,31}$/)
    assert.equal(out.claimSeq, 1)
    assert.equal(out.finalSeq, 2)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('resolveEphemeralArchetype maps retired v2.2 agents and v2.3 archetypes with explicit override support', async () => {
  const gaiaAlias = resolveEphemeralArchetype('gaia')
  assert.equal(gaiaAlias?.role, 'geospatial')
  assert.equal(gaiaAlias?.baseAgent, 'apollo')
  assert.equal(gaiaAlias?.readOnly, true)

  const mnemAlias = resolveEphemeralArchetype('mnemosyne')
  assert.equal(mnemAlias?.role, 'memory-adr')
  assert.equal(mnemAlias?.baseAgent, 'iris')
  assert.equal(mnemAlias?.readOnly, false)

  const parent = mkdtempSync(join(tmpdir(), 'pantheon-eph-alias-'))
  const repoDir = join(parent, 'repo')
  try {
    initGitRepo(repoDir)
    const createdAgents: string[] = []
    const sessionDomain = {
      create: async (opts?: { agent?: string }) => {
        if (opts?.agent) createdAgents.push(opts.agent)
        return { id: `ses-${createdAgents.length}` }
      },
      prompt: async () => ({ ok: true }),
      wait: async () => ({ status: 'completed' }),
      remove: async () => {},
    }

    const fromAlias = await spawnEphemeralWorker({
      sessionDomain,
      cwd: repoDir,
      stepKey: 'alias-1',
      role: 'mnemosyne',
      objective: 'Consolidate memory entries',
      isolateWorktree: false,
    })
    assert.equal(fromAlias.role, 'memory-adr')
    assert.equal(fromAlias.baseAgent, 'iris')

    const explicitOverride = await spawnEphemeralWorker({
      sessionDomain,
      cwd: repoDir,
      stepKey: 'alias-2',
      role: 'geospatial',
      baseAgent: 'demeter',
      objective: 'Load spatial SQL table',
      isolateWorktree: false,
    })
    assert.equal(explicitOverride.role, 'geospatial')
    assert.equal(explicitOverride.baseAgent, 'demeter')
    assert.deepEqual(createdAgents, ['iris', 'demeter'])
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('spawnEphemeralWorker preserves worktree edits to pantheon/eph/<stepKey>, writes ledger to sharedRoot, defaults maxTurns >= 5, and supports peer to handoffs', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'pantheon-eph-preserve-'))
  const repoDir = join(parent, 'app')
  try {
    initGitRepo(repoDir)
    let promptTurns = 0
    let capturedWorktree: string | undefined

    const sessionDomain = {
      create: async () => ({ id: 'ses-preserve-1' }),
      prompt: async (input: { sessionID: string; text: string }) => {
        promptTurns += 1
        if (promptTurns === 1) {
          const wtMatch = /worktree:\s*(\S+)/.exec(input.text)
          capturedWorktree = wtMatch?.[1]
          assert.ok(capturedWorktree)
          // Simulate editing a file inside the isolated worktree on turn 1
          writeFileSync(join(capturedWorktree, 'feature.ts'), 'export const feature = 42\n')
          return { ok: true }
        }
        if (promptTurns === 3) {
          // Multi-turn continuation: verify + complete on turn 3 (requires default maxTurns >= 3)
          assert.ok(capturedWorktree)
          const ledger = createStepLedgerTool(capturedWorktree)
          await ledger.execute(
            { action: 'record_mutation', stepKey: 'preserve-1', files: ['feature.ts'] },
            { directory: capturedWorktree },
          )
          await ledger.execute(
            {
              action: 'record_verification',
              stepKey: 'preserve-1',
              command: 'node --test',
              exitCode: 0,
            },
            { directory: capturedWorktree },
          )
          await ledger.execute(
            { action: 'complete_step', stepKey: 'preserve-1' },
            { directory: capturedWorktree },
          )
        }
        return { ok: true }
      },
      wait: async () => ({ status: 'completed' }),
      remove: async () => {},
    }

    const res = await spawnEphemeralWorker({
      sessionDomain,
      cwd: repoDir,
      stepKey: 'preserve-1',
      role: 'feature-builder',
      objective: 'Create feature.ts across multiple turns and hand off to themis',
      to: ['themis'],
    })

    assert.equal(res.ok, true)
    assert.equal(promptTurns, 3, 'should run multi-turn without explicit maxTurns')
    assert.equal(res.worktreeCleaned, true)
    assert.equal(res.branch, 'pantheon/eph/preserve-1')
    assert.ok(res.diffSummary?.includes('feature.ts'))

    // Verify ledger receipt persisted in sharedRoot even after worktree cleanup
    const sharedLedger = readStepLedger(repoDir)
    assert.equal(sharedLedger.steps['preserve-1']?.state, 'done')
    assert.ok(sharedLedger.steps['preserve-1']?.receiptId?.startsWith('rcpt_'))

    // Verify preserved branch exists in shared repo and contains feature.ts
    const branchFiles = execFileSync(
      'git',
      ['ls-tree', '-r', '--name-only', 'pantheon/eph/preserve-1'],
      { cwd: repoDir, encoding: 'utf8' },
    )
    assert.match(branchFiles, /feature\.ts/)

    // Verify board [done] message routes to @themis and mentions preserved branch
    const board = readBoardMessages(repoDir, { since: 0 })
    const doneMsg = board.messages.find((m) => m.tag === 'done')
    assert.ok(doneMsg)
    assert.deepEqual(doneMsg.mentions, ['themis'])
    assert.match(doneMsg.body, /@themis/)
    assert.match(doneMsg.body, /pantheon\/eph\/preserve-1/)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('partitionBranchesForVerifiers allocates 1 verifier per 2-4 branches', () => {
  assert.deepEqual(partitionBranchesForVerifiers([]), [])
  assert.deepEqual(
    partitionBranchesForVerifiers(['b1']).map((b) => b.length),
    [1],
  )
  assert.deepEqual(
    partitionBranchesForVerifiers(['b1', 'b2', 'b3', 'b4']).map((b) => b.length),
    [4],
  )
  assert.deepEqual(
    partitionBranchesForVerifiers(['b1', 'b2', 'b3', 'b4', 'b5']).map((b) => b.length),
    [3, 2],
  )
  assert.deepEqual(
    partitionBranchesForVerifiers(['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7']).map((b) => b.length),
    [4, 3],
  )
  assert.deepEqual(
    partitionBranchesForVerifiers(['1', '2', '3', '4', '5', '6', '7', '8', '9']).map(
      (b) => b.length,
    ),
    [3, 3, 3],
  )
})

test('verifyEphemeralBranches spawns 1 verifier per 2-4 branches, runs git diff review, and posts [done]/[blocker] to @<workerRole>', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'pantheon-eph-verify-'))
  const repoDir = join(parent, 'repo')
  try {
    initGitRepo(repoDir)
    const branchTargets: Array<{ branch: string; stepKey: string; workerRole: string }> = []
    for (let i = 1; i <= 5; i += 1) {
      const branch = `pantheon/eph/step-${i}`
      execFileSync('git', ['checkout', '-q', '-b', branch], { cwd: repoDir })
      writeFileSync(join(repoDir, `mod-${i}.ts`), `export const m${i} = ${i}\n`)
      execFileSync('git', ['add', `mod-${i}.ts`], { cwd: repoDir })
      execFileSync('git', ['commit', '-q', '-m', `feat: step-${i}`], { cwd: repoDir })
      execFileSync('git', ['checkout', '-q', '-'], { cwd: repoDir })
      branchTargets.push({ branch, stepKey: `step-${i}`, workerRole: `worker-${i}` })
    }

    const createdSessions: Array<{ agent?: string; title?: string }> = []
    const removedSessions: string[] = []
    let sessionCounter = 0

    const sessionDomain = {
      create: async (opts?: { agent?: string; title?: string }) => {
        sessionCounter += 1
        createdSessions.push({
          ...(opts?.agent !== undefined ? { agent: opts.agent } : {}),
          ...(opts?.title !== undefined ? { title: opts.title } : {}),
        })
        return { id: `ses-ver-${sessionCounter}` }
      },
      prompt: async (input: { sessionID: string; text: string }) => {
        assert.match(input.text, /EPHEMERAL BRANCH DIFF REVIEW/)
        assert.match(input.text, /mod-/)
        return { ok: true }
      },
      wait: async () => ({ status: 'completed' }),
      messages: async (input: { readonly sessionID: string }) => {
        if (input.sessionID === 'ses-ver-2') {
          return [
            { text: 'pantheon/eph/step-4: APPROVE\npantheon/eph/step-5: BLOCK missing tests' },
          ]
        }
        return [
          {
            text: 'pantheon/eph/step-1: APPROVE\npantheon/eph/step-2: APPROVE\npantheon/eph/step-3: APPROVE',
          },
        ]
      },
      remove: async (input: { readonly sessionID: string }) => {
        removedSessions.push(input.sessionID)
      },
    }

    const ledger = createStepLedgerTool(repoDir, sessionDomain)
    const verifyOut = JSON.parse(
      (
        await ledger.execute(
          {
            action: 'verify_ephemeral',
            branches: branchTargets.map((t) => t.branch),
            verifierAgent: 'themis',
          },
          { directory: repoDir },
        )
      ).output,
    ) as {
      ok: boolean
      verifierAgent: string
      verifiersSpawned: number
      results: Array<{ branch: string; verdict: string; workerRole: string; boardSeq?: number }>
    }

    assert.equal(verifyOut.ok, false)
    assert.equal(verifyOut.verifierAgent, 'themis')
    assert.equal(verifyOut.verifiersSpawned, 2)
    assert.equal(createdSessions.length, 2)
    assert.equal(createdSessions[0]?.agent, 'themis')
    assert.equal(createdSessions[1]?.agent, 'themis')
    assert.deepEqual(removedSessions, ['ses-ver-1', 'ses-ver-2'])
    assert.equal(verifyOut.results.length, 5)
    assert.equal(verifyOut.results[0]?.verdict, 'APPROVE')
    assert.equal(verifyOut.results[4]?.verdict, 'BLOCK')

    const board = readBoardMessages(repoDir, { since: 0 })
    assert.equal(board.messages.length, 5)
    assert.equal(board.messages[0]?.tag, 'done')
    assert.deepEqual(board.messages[0]?.mentions, ['step-1'])
    assert.equal(board.messages[4]?.tag, 'blocker')
    assert.deepEqual(board.messages[4]?.mentions, ['step-5'])

    // Also verify direct call with explicit workerRole objects
    const directRes = await verifyEphemeralBranches({
      branches: branchTargets.slice(0, 2),
      sharedRoot: repoDir,
    })
    assert.equal(directRes.ok, true)
    assert.equal(directRes.verifiersSpawned, 1)
    assert.equal(directRes.results[0]?.workerRole, 'worker-1')
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('spawnEphemeralWorker integrates globalThis.__pantheonFileLeases, wallClockMs/maxCostUsd, and autoVerify', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'pantheon-eph-lease-'))
  const repoDir = join(parent, 'repo')
  const prevLeases = (globalThis as { __pantheonFileLeases?: FileLeaseHook }).__pantheonFileLeases
  try {
    initGitRepo(repoDir)
    const leaseEvents: string[] = []
    ;(globalThis as { __pantheonFileLeases?: FileLeaseHook }).__pantheonFileLeases = {
      acquireFileLease: ({ stepKey, ownedFiles }) => {
        leaseEvents.push(`acquire:${stepKey}:${ownedFiles.join(',')}`)
        if (ownedFiles.includes('conflict.ts')) {
          return { ok: false, error: 'lease held by another worker', conflicts: ['conflict.ts'] }
        }
        return { ok: true }
      },
      releaseFileLease: ({ stepKey }) => {
        leaseEvents.push(`release:${stepKey}`)
      },
    }

    const conflictRes = await spawnEphemeralWorker({
      sessionDomain: {
        create: async () => ({ id: 'ses-never' }),
        prompt: async () => ({ ok: true }),
      },
      cwd: repoDir,
      stepKey: 'lease-conflict',
      role: 'lease-worker',
      objective: 'Should fail fast on lease conflict',
      ownedFiles: ['conflict.ts'],
      isolateWorktree: false,
    })
    assert.equal(conflictRes.ok, false)
    assert.match(conflictRes.error ?? '', /lease held by another worker/)

    let capturedPrompt = ''
    const sessionDomain = {
      create: async (opts?: { agent?: string }) => ({ id: `ses-${opts?.agent ?? 'w'}` }),
      prompt: async (input: { sessionID: string; text: string }) => {
        if (input.sessionID === 'ses-hermes') {
          capturedPrompt = input.text
          const wtMatch = /worktree:\s*(\S+)/.exec(input.text)
          const wt = wtMatch?.[1]
          assert.ok(wt)
          writeFileSync(join(wt, 'leased.ts'), 'export const leased = true\n')
          const ledger = createStepLedgerTool(wt)
          await ledger.execute(
            { action: 'record_mutation', stepKey: 'lease-ok', files: ['leased.ts'] },
            { directory: wt },
          )
          await ledger.execute(
            {
              action: 'record_verification',
              stepKey: 'lease-ok',
              command: 'echo ok',
              exitCode: 0,
            },
            { directory: wt },
          )
          await ledger.execute({ action: 'complete_step', stepKey: 'lease-ok' }, { directory: wt })
        }
        return { ok: true }
      },
      wait: async () => ({ status: 'completed' }),
      messages: async () => [{ text: 'pantheon/eph/lease-ok: APPROVE' }],
      remove: async () => {},
    }

    const okRes = await spawnEphemeralWorker({
      sessionDomain,
      cwd: repoDir,
      stepKey: 'lease-ok',
      role: 'lease-worker',
      objective: 'Write leased.ts',
      ownedFiles: ['leased.ts'],
      forbiddenFiles: ['secret.ts'],
      wallClockMs: 10_000,
      maxCostUsd: 1.5,
      autoVerify: true,
    })

    assert.equal(okRes.ok, true)
    assert.match(capturedPrompt, /ownedFiles: leased\.ts/)
    assert.match(capturedPrompt, /forbiddenFiles: secret\.ts/)
    assert.equal(okRes.verification?.ok, true)
    assert.equal(okRes.verification?.verifierAgent, 'themis')
    assert.deepEqual(leaseEvents, [
      'acquire:lease-conflict:conflict.ts',
      'acquire:lease-ok:leased.ts',
      'release:lease-ok',
    ])
  } finally {
    if (prevLeases === undefined) {
      delete (globalThis as { __pantheonFileLeases?: FileLeaseHook }).__pantheonFileLeases
    } else {
      ;(globalThis as { __pantheonFileLeases?: FileLeaseHook }).__pantheonFileLeases = prevLeases
    }
    rmSync(parent, { recursive: true, force: true })
  }
})
