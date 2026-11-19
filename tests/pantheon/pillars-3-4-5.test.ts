import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAgentForgeTool } from '../../src/pantheon/agent-forge-tool.ts'
import { getSharedBus } from '../../src/pantheon/bus.ts'
import { evaluateReproductionGate } from '../../src/pantheon/reproduction-gate.ts'
import { createReviewVerdictTool } from '../../src/pantheon/review-verdict.ts'
import { detectRepositoryStacks } from '../../src/pantheon/stack-detector.ts'
import { createStepLedgerTool } from '../../src/pantheon/step-ledger.ts'
import {
  createPantheonWorktreeDefinition,
  createWorktreeTool,
  resolvePantheonWorktreePath,
} from '../../src/pantheon/worktree-orchestrator.ts'

test('worktree-orchestrator enforces sibling .pantheon-worktrees path and manages git worktree lifecycle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-wt-orch-'))
  try {
    const repo = join(root, 'my-app')
    mkdirSync(repo, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@pantheon.dev'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Pantheon Test'], { cwd: repo })
    writeFileSync(join(repo, 'README.md'), '# My App\n')
    execFileSync('git', ['add', 'README.md'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })

    const canonicalTarget = resolvePantheonWorktreePath(repo, 'feat-auth')
    assert.ok(canonicalTarget.includes('.pantheon-worktrees'))
    assert.equal(canonicalTarget.startsWith(repo), false, 'worktree must live outside main project')

    const def = createPantheonWorktreeDefinition()
    assert.equal(def.id, 'pantheon-worktree')
    const ac = new AbortController()
    const created = await def.create(
      { sourceDirectory: repo, directory: join(repo, '.pantheon', 'bad') },
      { signal: ac.signal },
    )
    assert.equal(
      created.directory.startsWith(repo),
      false,
      'never place worktree inside .pantheon or repo',
    )
    assert.ok(existsSync(join(created.directory, 'README.md')))

    const entries = await def.list(repo, { signal: ac.signal })
    assert.equal(entries.length, 2)
    assert.ok(entries.some((e) => realpathSync(e.directory) === realpathSync(created.directory)))

    await def.remove({ directory: created.directory, force: true }, { signal: ac.signal })
    assert.equal(existsSync(created.directory), false)

    // Also test direct agent tool interface `pantheon_worktree`
    const wtTool = createWorktreeTool(repo)
    const wtCreated = JSON.parse(
      (await wtTool.execute({ action: 'create', task: 'feat-tool' }, { directory: repo })).output,
    ) as { ok: boolean; directory: string }
    assert.equal(wtCreated.ok, true)
    assert.ok(existsSync(wtCreated.directory))
    assert.equal(wtCreated.directory.startsWith(repo), false)
    const wtRemoved = JSON.parse(
      (
        await wtTool.execute(
          { action: 'remove', directory: wtCreated.directory, force: true },
          { directory: repo },
        )
      ).output,
    ) as { ok: boolean }
    assert.equal(wtRemoved.ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pantheon_review_verdict emits bus event and routes bounded SessionSyntheticInput to parent session on BLOCK', async () => {
  const syntheticCalls: Array<Record<string, unknown>> = []
  const busVerdicts: string[] = []
  const off = getSharedBus().on('review:verdict', (e) => busVerdicts.push(e.verdict))

  try {
    const tool = createReviewVerdictTool({
      get: async ({ sessionID }) =>
        sessionID === 'ses_review_1' ? { parentID: 'ses_parent_zeus' } : undefined,
      synthetic: async (input) => {
        syntheticCalls.push(input as Record<string, unknown>)
      },
    })
    const res1 = JSON.parse(
      (
        await tool.execute(
          {
            verdict: 'BLOCK',
            summary: 'Missing null guard in auth callback',
            targetAgent: 'hermes',
            findings: [
              { severity: 'critical', file: 'src/auth.ts', message: 'Unhandled null user' },
            ],
          },
          { sessionID: 'ses_review_1', agent: 'themis' },
        )
      ).output,
    ) as {
      ok: boolean
      verdict: string
      syntheticTriggered: boolean
      syntheticSessionID?: string
    }

    assert.equal(res1.ok, true)
    assert.equal(res1.verdict, 'BLOCK')
    assert.equal(res1.syntheticTriggered, true)
    assert.equal(res1.syntheticSessionID, 'ses_parent_zeus')
    assert.equal(busVerdicts[0], 'BLOCK')
    assert.equal(syntheticCalls.length, 1)
    assert.equal(syntheticCalls[0]?.sessionID, 'ses_parent_zeus')
    assert.equal(syntheticCalls[0]?.resume, true)
    assert.equal(
      'agent' in (syntheticCalls[0] ?? {}),
      false,
      'SessionSyntheticInput forbids bare agent field',
    )
    assert.match(String(syntheticCalls[0]?.text ?? ''), /BLOCK/)
    assert.match(String(syntheticCalls[0]?.text ?? ''), /src\/auth\.ts/)

    // Bounded at 2 per session+agent so a third consecutive BLOCK stops auto-looping
    await tool.execute(
      { verdict: 'BLOCK', summary: 'Still failing', targetAgent: 'hermes' },
      { sessionID: 'ses_review_1', agent: 'themis' },
    )
    const res3 = JSON.parse(
      (
        await tool.execute(
          { verdict: 'BLOCK', summary: 'Still failing x3', targetAgent: 'hermes' },
          { sessionID: 'ses_review_1', agent: 'themis' },
        )
      ).output,
    ) as { syntheticTriggered: boolean }
    assert.equal(syntheticCalls.length, 2, 'remediation synthetic dispatch must stay bounded')
    assert.equal(res3.syntheticTriggered, false)
  } finally {
    off()
  }
})

test('reproduction gate blocks production edits in bugfix steps until a failing RED test is recorded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-repro-gate-'))
  try {
    const ledger = createStepLedgerTool(dir)
    await ledger.execute(
      {
        action: 'init_step',
        stepKey: 'fix-login-500',
        objective: 'Fix login null crash',
        agent: 'hermes',
        taskType: 'bugfix',
      },
      { directory: dir },
    )

    // Test file edits ARE allowed before reproduction so specialist can write RED repro
    const allowTest = evaluateReproductionGate({
      cwd: dir,
      tool: 'write',
      agent: 'hermes',
      args: { filePath: join(dir, 'tests', 'login.test.ts') },
    })
    assert.equal(allowTest.allowed, true)

    // Production file edit is BLOCKED before failing reproduction is recorded
    const blockProd = evaluateReproductionGate({
      cwd: dir,
      tool: 'hashline_edit',
      agent: 'hermes',
      args: { file: 'src/login.ts' },
    })
    assert.equal(blockProd.allowed, false)
    assert.match(blockProd.message ?? '', /\[Reproduction-Gate\]/)

    // Recording exitCode === 0 must be rejected as a bugfix reproduction
    const badRepro = JSON.parse(
      (
        await ledger.execute(
          {
            action: 'record_reproduction',
            stepKey: 'fix-login-500',
            command: 'node --test tests/login.test.ts',
            exitCode: 0,
          },
          { directory: dir },
        )
      ).output,
    ) as { ok: boolean }
    assert.equal(badRepro.ok, false)

    // Recording failing RED reproduction unlocks production edits
    const goodRepro = JSON.parse(
      (
        await ledger.execute(
          {
            action: 'record_reproduction',
            stepKey: 'fix-login-500',
            command: 'node --test tests/login.test.ts',
            exitCode: 1,
          },
          { directory: dir },
        )
      ).output,
    ) as { ok: boolean }
    assert.equal(goodRepro.ok, true)

    const allowProd = evaluateReproductionGate({
      cwd: dir,
      tool: 'hashline_edit',
      agent: 'hermes',
      args: { file: 'src/login.ts' },
    })
    assert.equal(allowProd.allowed, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stack-detector and agent_forge detect_stack identify polyglot manifests cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-stack-'))
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'web',
        dependencies: { react: '^19.0.0' },
        devDependencies: { typescript: '^5.0.0' },
      }),
    )
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\ndependencies = ["fastapi", "pytest"]\n')
    writeFileSync(join(dir, 'go.mod'), 'module example.com/svc\n\ngo 1.23\n')

    const detected = detectRepositoryStacks(dir)
    const ids = detected.stacks.map((s) => s.id)
    assert.ok(ids.includes('node-typescript'))
    assert.ok(ids.includes('python'))
    assert.ok(ids.includes('go'))
    assert.ok(detected.suggestedSpecialists.length >= 2)

    const forge = createAgentForgeTool(dir)
    const forgeOut = JSON.parse(
      (await forge.execute({ action: 'detect_stack' }, { directory: dir })).output,
    ) as { ok: boolean; stacks: Array<{ id: string }>; suggestedSpecialists: unknown[] }
    assert.equal(forgeOut.ok, true)
    assert.ok(forgeOut.stacks.some((s) => s.id === 'python'))
    assert.ok(forgeOut.suggestedSpecialists.length >= 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
