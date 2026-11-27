/**
 * S3 — protected ephemeral merge (v2.3.5 swarm hardening).
 *
 * Drives acceptance S3-1..S3-8 from `.pantheon/deepwork/v235-swarm-hardening/DESIGN.md`
 * against real git repositories in a temp directory (same precedent as
 * `ephemeral-worker.test.ts`): real branches, real `git merge-tree`, real
 * conflicts, real hooks. Nothing is stubbed except the sub-session domain.
 *
 * The two load-bearing mechanisms are proved both positively and negatively:
 * the token gate (minted by preview, single-use, invalid after drift) and the
 * abort/restore path (a squash conflict, an injected mid-apply conflict, a
 * pre-existing `MERGE_HEAD`, and a rejected commit must all leave the tree
 * byte-identical with no `MERGE_HEAD`/`MERGE_MSG`).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { readBoardMessages } from '../../src/pantheon/board-messages.ts'
import { getSharedBus, type StepMergeEventPayload } from '../../src/pantheon/bus.ts'
import {
  MERGE_TOKEN_TTL_MS,
  mergeEphemeralStep,
  mergeStatusFingerprint,
  recoverFromFailedMerge,
  resetMergeTokens,
} from '../../src/pantheon/ephemeral-merge.ts'
import { spawnEphemeralWorker } from '../../src/pantheon/ephemeral-worker.ts'
import {
  acquireFileLease,
  getFileLease,
  leaseClaimsPath,
  listActiveLeases,
  releaseFileLease,
} from '../../src/pantheon/file-leases.ts'
import { captureGitCheckpoint } from '../../src/pantheon/git-checkpoint.ts'
import {
  createStepLedgerTool,
  readStepLedger,
  updateStepLedger,
} from '../../src/pantheon/step-ledger.ts'

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function gitWorks(cwd: string, args: readonly string[]): boolean {
  try {
    git(cwd, args)
    return true
  } catch {
    return false
  }
}

/** Raw `git status --porcelain` (the user-visible tree state). */
function statusOf(cwd: string): string {
  return execFileSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
}

function commitAll(root: string, message: string): void {
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', message])
}

function initRepo(parent: string): string {
  const repo = join(parent, 'app')
  mkdirSync(repo, { recursive: true })
  git(parent, ['init', '-q', '-b', 'main', repo])
  git(repo, ['config', 'user.email', 'merge@pantheon.test'])
  git(repo, ['config', 'user.name', 'Pantheon Merge Test'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  // rerere would memorize conflict resolutions across the fixtures in one tmp
  // root, which is exactly the state this suite is trying to keep pristine.
  git(repo, ['config', 'rerere.enabled', 'false'])
  writeFileSync(join(repo, '.gitignore'), '.pantheon/\n')
  writeFiles(repo, {
    'src/a.ts': 'export const a = 1\n',
    'src/b.ts': 'export const b = 2\n',
  })
  commitAll(repo, 'init')
  return repo
}

interface MergeFixture {
  readonly parent: string
  readonly repo: string
  readonly stepKey: string
  readonly branch: string
  readonly baseHead: string
}

const DEFAULT_BRANCH_FILES: Record<string, string> = {
  'src/a.ts': 'export const a = "branch"\n',
}

async function setupMergeFixture(
  options: {
    readonly stepKey?: string
    readonly branchFiles?: Record<string, string>
    /** Committed on `main` AFTER the branch exists (drift-free conflict setup). */
    readonly mainFiles?: Record<string, string>
  } = {},
): Promise<MergeFixture> {
  const parent = mkdtempSync(join(tmpdir(), 'pantheon-merge-'))
  const repo = initRepo(parent)
  const stepKey = options.stepKey ?? 'eph-merge-1'
  const branch = `pantheon/eph/${stepKey}`

  const ledger = createStepLedgerTool(repo)
  const created = await ledger.execute(
    { action: 'init_step', stepKey, objective: 'merge fixture', agent: 'hermes' },
    { directory: repo },
  )
  assert.equal(JSON.parse(String(created.output)).ok, true)

  git(repo, ['checkout', '-q', '-b', branch])
  writeFiles(repo, options.branchFiles ?? DEFAULT_BRANCH_FILES)
  commitAll(repo, `worker ${branch}`)
  git(repo, ['checkout', '-q', 'main'])

  if (options.mainFiles) {
    writeFiles(repo, options.mainFiles)
    commitAll(repo, 'main moves after the worker branched')
  }

  const baseHead = git(repo, ['rev-parse', 'HEAD'])
  updateStepLedger(repo, (store) => {
    const entry = store.steps[stepKey]
    assert.ok(entry, 'fixture step must exist')
    entry.ephemeral = { ...entry.ephemeral, branch, baseHead }
  })
  return { parent, repo, stepKey, branch, baseHead }
}

async function treeOf(repo: string): Promise<string | undefined> {
  const snapshot = await captureGitCheckpoint(repo, 'merge-test')
  return snapshot.treeHash
}

function cleanup(fixture: MergeFixture): void {
  rmSync(fixture.parent, { recursive: true, force: true })
}

function ledgerEntry(repo: string, stepKey: string) {
  const entry = readStepLedger(repo).steps[stepKey]
  assert.ok(entry, `ledger entry ${stepKey} must exist`)
  return entry
}

// ---------------------------------------------------------------------------
// S3-1 — clean preview + token, and the preview changes nothing
// ---------------------------------------------------------------------------

test('S3-1 clean preview mints a MERGE- token, reports the merge tree, and changes nothing', async () => {
  resetMergeTokens()
  const fixture = await setupMergeFixture()
  try {
    const statusBefore = statusOf(fixture.repo)
    const headBefore = git(fixture.repo, ['rev-parse', 'HEAD'])
    const treeBefore = await treeOf(fixture.repo)

    const res = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'preview',
    })

    assert.equal(res.ok, true)
    assert.equal(res.mode, 'preview')
    assert.equal(res.branch, fixture.branch)
    assert.equal(res.baseHead, fixture.baseHead)
    assert.equal(res.head, headBefore)
    assert.deepEqual(res.changes, ['src/a.ts'])
    assert.equal(res.clean, true)
    assert.equal(res.previewVia, 'merge-tree')
    assert.deepEqual(res.blockers, [])
    assert.equal(res.readyToApply, true)
    assert.match(String(res.token), /^MERGE-[0-9a-f]{12}$/)
    assert.ok(res.mergeTree)
    assert.notEqual(res.mergeTree, git(fixture.repo, ['rev-parse', 'HEAD^{tree}']))
    assert.equal(gitWorks(fixture.repo, ['cat-file', '-e', `${res.mergeTree}^{tree}`]), true)

    // The preview guarantee: no tree/index/HEAD mutation.
    assert.equal(res.treeUntouched, true)
    assert.equal(statusOf(fixture.repo), statusBefore)
    assert.equal(git(fixture.repo, ['rev-parse', 'HEAD']), headBefore)
    assert.equal(await treeOf(fixture.repo), treeBefore)
    assert.equal(existsSync(join(fixture.repo, '.git', 'MERGE_HEAD')), false)
    assert.equal(existsSync(join(fixture.repo, '.git', 'MERGE_MSG')), false)
  } finally {
    cleanup(fixture)
  }
})

test('S3-T1 pantheon_step_ledger exposes merge_ephemeral end to end (preview then apply)', async () => {
  resetMergeTokens()
  const fixture = await setupMergeFixture()
  try {
    const tool = createStepLedgerTool(fixture.repo)
    const previewRaw = await tool.execute(
      { action: 'merge_ephemeral', stepKey: fixture.stepKey, mode: 'preview' },
      { directory: fixture.repo },
    )
    const preview = JSON.parse(String(previewRaw.output)) as {
      ok: boolean
      token?: string
      readyToApply?: boolean
    }
    assert.equal(preview.ok, true)
    assert.equal(preview.readyToApply, true)
    assert.match(String(preview.token), /^MERGE-/)

    const applyRaw = await tool.execute(
      {
        action: 'merge_ephemeral',
        stepKey: fixture.stepKey,
        mode: 'apply',
        confirmToken: preview.token,
      },
      { directory: fixture.repo },
    )
    const applied = JSON.parse(String(applyRaw.output)) as {
      ok: boolean
      unstaged?: boolean
      error?: string
    }
    assert.equal(applied.error, undefined)
    assert.equal(applied.ok, true)
    assert.equal(applied.unstaged, true)
    assert.match(statusOf(fixture.repo), /^ M src\/a\.ts$/m)
  } finally {
    cleanup(fixture)
  }
})

test('S3-O1 merge_ephemeral refuses an unsupported option, an unknown mode, and an unsafe branch', async () => {
  resetMergeTokens()
  const fixture = await setupMergeFixture()
  try {
    const cascade = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'preview',
      cascade: true,
    })
    assert.equal(cascade.ok, false)
    assert.equal(cascade.error, 'unsupported_option')

    const badMode = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'appply' as unknown as 'apply',
    })
    assert.equal(badMode.ok, false)
    assert.equal(badMode.error, 'invalid_mode')

    updateStepLedger(fixture.repo, (store) => {
      const entry = store.steps[fixture.stepKey]
      assert.ok(entry)
      entry.ephemeral = { ...entry.ephemeral, branch: '--exec=evil' }
    })
    const badBranch = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'preview',
    })
    assert.equal(badBranch.ok, false)
    assert.equal(badBranch.error, 'invalid_branch')
    assert.equal(statusOf(fixture.repo), '')
  } finally {
    cleanup(fixture)
  }
})

// ---------------------------------------------------------------------------
// S3-2 — HEAD drift refuses and leaves git status untouched
// ---------------------------------------------------------------------------
test('S3-2 apply refuses head_drift and leaves git status byte-identical', async () => {
  resetMergeTokens()
  const fixture = await setupMergeFixture()
  try {
    const preview = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'preview',
    })
    assert.equal(preview.readyToApply, true)

    writeFiles(fixture.repo, { 'src/b.ts': 'export const b = "moved on"\n' })
    commitAll(fixture.repo, 'main advances past the worker base')
    const driftHead = git(fixture.repo, ['rev-parse', 'HEAD'])
    const statusBefore = statusOf(fixture.repo)

    const res = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'apply',
      confirmToken: preview.token,
    })

    assert.equal(res.ok, false)
    assert.equal(res.error, 'head_drift')
    assert.equal(res.commits, 1)
    assert.deepEqual(res.headDrift?.files, ['src/b.ts'])
    assert.equal(res.tokenValid, false, 'the token is bound to headNow and must be dead')
    assert.equal(res.treeRestored, undefined)

    assert.equal(statusOf(fixture.repo), statusBefore)
    assert.equal(git(fixture.repo, ['rev-parse', 'HEAD']), driftHead)
    assert.equal(
      gitWorks(fixture.repo, ['rev-parse', '--verify', `refs/heads/${fixture.branch}`]),
      true,
    )
    assert.equal(existsSync(join(fixture.repo, '.git', 'MERGE_HEAD')), false)
  } finally {
    cleanup(fixture)
  }
})

// ---------------------------------------------------------------------------
// S3-3 — dirty overlap is a lease_conflict with source 'dirty'
// ---------------------------------------------------------------------------

test("S3-3 apply refuses a dirty overlap with lease_conflict{source:'dirty'}", async () => {
  resetMergeTokens()
  const fixture = await setupMergeFixture()
  try {
    const preview = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'preview',
    })
    writeFiles(fixture.repo, { 'src/a.ts': 'export const a = "local edit"\n' })

    const plain = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'apply',
      confirmToken: preview.token,
    })
    assert.equal(plain.error, 'worktree_dirty')

    const res = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'apply',
      confirmToken: preview.token,
      allowDirty: true,
    })
    assert.equal(res.ok, false)
    assert.equal(res.error, 'lease_conflict')
    assert.ok(
      res.leaseConflicts?.some(
        (conflict) =>
          conflict.file === 'src/a.ts' &&
          conflict.source === 'dirty' &&
          conflict.holder === 'working-tree',
      ),
      `expected a dirty overlap, got ${JSON.stringify(res.leaseConflicts)}`,
    )
    // The refusal is a no-op: the local edit is still the file's content.
    assert.equal(
      readFileSync(join(fixture.repo, 'src/a.ts'), 'utf8'),
      'export const a = "local edit"\n',
    )
    assert.equal(statusOf(fixture.repo), ' M src/a.ts\n')
  } finally {
    cleanup(fixture)
  }
})

// ---------------------------------------------------------------------------
// S3-4 — a second live pantheon/eph/* branch on the same file
// ---------------------------------------------------------------------------

test("S3-4 apply refuses a second live pantheon/eph branch on the same file (source:'branch')", async () => {
  resetMergeTokens()
  const fixture = await setupMergeFixture()
  try {
    const other = 'pantheon/eph/other-step'
    git(fixture.repo, ['checkout', '-q', '-b', other])
    writeFiles(fixture.repo, { 'src/a.ts': 'export const a = "other worker"\n' })
    commitAll(fixture.repo, 'other worker edits the same file')
    git(fixture.repo, ['checkout', '-q', 'main'])

    const preview = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'preview',
    })
    assert.equal(preview.readyToApply, false)
    assert.ok(preview.blockers?.includes('lease_conflict'))
    assert.ok(
      preview.leaseConflicts?.some(
        (conflict) =>
          conflict.file === 'src/a.ts' && conflict.source === 'branch' && conflict.holder === other,
      ),
      `expected a branch overlap, got ${JSON.stringify(preview.leaseConflicts)}`,
    )

    const res = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'apply',
      confirmToken: preview.token,
    })
    assert.equal(res.ok, false)
    assert.equal(res.error, 'lease_conflict')
    assert.ok(res.leaseConflicts?.some((conflict) => conflict.source === 'branch'))
    assert.equal(statusOf(fixture.repo), '')
    assert.equal(
      gitWorks(fixture.repo, ['rev-parse', '--verify', `refs/heads/${fixture.branch}`]),
      true,
    )
  } finally {
    cleanup(fixture)
  }
})

// ---------------------------------------------------------------------------
// S3-5 — conflicting merges never leave a half-merged tree
// ---------------------------------------------------------------------------

test('S3-5 a conflicting squash merge refuses and leaves the tree byte-identical with no MERGE_HEAD', async () => {
  resetMergeTokens()
  // The branch was produced from the initial commit while the recorded base is
  // the newer HEAD, so the two sides genuinely conflict on src/a.ts with zero
  // HEAD drift (the case the drift gate cannot catch).
  const fixture = await setupMergeFixture({
    mainFiles: { 'src/a.ts': 'export const a = "main"\n' },
  })
  try {
    const statusBefore = statusOf(fixture.repo)
    const treeBefore = await treeOf(fixture.repo)
    const contentBefore = readFileSync(join(fixture.repo, 'src/a.ts'), 'utf8')

    const preview = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'preview',
    })
    assert.equal(preview.clean, false)
    assert.deepEqual(preview.conflicts, ['src/a.ts'])
    assert.equal(preview.readyToApply, false)
    assert.ok(preview.blockers?.includes('merge_conflict'))

    const res = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'apply',
      confirmToken: preview.token,
    })
    assert.equal(res.ok, false)
    assert.equal(res.error, 'merge_conflict')
    assert.deepEqual(res.conflicts, ['src/a.ts'])
    assert.equal(res.noOp, true)
    assert.equal(res.treeRestored, undefined, 'nothing was mutated, so nothing needed restoring')

    assert.equal(statusOf(fixture.repo), statusBefore)
    assert.equal(await treeOf(fixture.repo), treeBefore)
    assert.equal(readFileSync(join(fixture.repo, 'src/a.ts'), 'utf8'), contentBefore)
    assert.equal(existsSync(join(fixture.repo, '.git', 'MERGE_HEAD')), false)
    assert.equal(existsSync(join(fixture.repo, '.git', 'MERGE_MSG')), false)
  } finally {
    cleanup(fixture)
  }
})

test('S3-5b an injected mid-apply conflict is aborted and the tree is restored byte-identically', async () => {
  resetMergeTokens()
  const fixture = await setupMergeFixture()
  try {
    const preview = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'preview',
    })
    assert.equal(preview.readyToApply, true)

    const statusBefore = statusOf(fixture.repo)
    const contentBefore = readFileSync(join(fixture.repo, 'src/a.ts'), 'utf8')
    const treeBefore = await treeOf(fixture.repo)

    // Interleaving: a concurrent writer lands a conflicting commit in the exact
    // window between the pre-merge checkpoint and `git merge --squash`.
    const res = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'apply',
      confirmToken: preview.token,
      onBeforeMerge: () => {
        writeFiles(fixture.repo, { 'src/a.ts': 'export const a = "raced writer"\n' })
        commitAll(fixture.repo, 'racing writer commits first')
      },
    })

    assert.equal(res.ok, false)
    assert.equal(res.error, 'merge_conflict')
    assert.ok(res.conflicts?.includes('src/a.ts'), `conflicts: ${JSON.stringify(res.conflicts)}`)

    // The guarantee, asserted (not assumed):
    assert.equal(res.treeRestored, true)
    assert.equal(res.noOp, true)
    assert.equal(res.recovery?.mergeStatePresent, false)
    assert.equal(res.recovery?.aborted, false, 'a squash merge never creates MERGE_HEAD')
    assert.equal(res.recovery?.resetApplied, true)
    assert.equal(res.recovery?.compensated, true, 'the conflict markers had to be overwritten')
    assert.equal(res.recovery?.restoreFailed, undefined)

    const contentAfter = readFileSync(join(fixture.repo, 'src/a.ts'), 'utf8')
    assert.equal(contentAfter, contentBefore)
    assert.doesNotMatch(contentAfter, /<<<<<<<|>>>>>>>/)
    assert.equal(await treeOf(fixture.repo), treeBefore)
    // The injected commit is still HEAD, so git status reports its revert — but
    // no unmerged paths and no merge in progress survive.
    assert.doesNotMatch(statusOf(fixture.repo), /^(UU|AA|DD|AU|UA) /m)
    assert.equal(existsSync(join(fixture.repo, '.git', 'MERGE_HEAD')), false)
    assert.equal(existsSync(join(fixture.repo, '.git', 'MERGE_MSG')), false)
    assert.equal(statusBefore, '', 'the fixture started clean')
  } finally {
    cleanup(fixture)
  }
})

test('S3-5c recovery aborts a pre-existing MERGE_HEAD, clears MERGE_MSG, and restores the tree', async () => {
  resetMergeTokens()
  const fixture = await setupMergeFixture({
    mainFiles: { 'src/a.ts': 'export const a = "main"\n' },
  })
  try {
    const statusBefore = statusOf(fixture.repo)
    const treeBefore = await treeOf(fixture.repo)
    const fingerprintBefore = await mergeStatusFingerprint(fixture.repo)

    // A real, conflicting, non-squash merge: MERGE_HEAD + unmerged index +
    // conflict markers in the worktree. This is the half-merged tree the gate
    // must never leave behind.
    assert.equal(gitWorks(fixture.repo, ['merge', '--no-commit', '--no-ff', fixture.branch]), false)
    assert.equal(existsSync(join(fixture.repo, '.git', 'MERGE_HEAD')), true)
    assert.equal(existsSync(join(fixture.repo, '.git', 'MERGE_MSG')), true)
    assert.match(statusOf(fixture.repo), /^UU /m)

    const recovery = await recoverFromFailedMerge(fixture.repo, {
      treeHash: treeBefore,
      statusFingerprint: fingerprintBefore,
    })

    assert.equal(recovery.aborted, true, 'MERGE_HEAD must be aborted, not reset away')
    assert.equal(recovery.resetApplied, true)
    assert.equal(recovery.treeRestored, true)
    assert.equal(recovery.compensated, false, 'git merge --abort already restored the content')
    assert.equal(recovery.statusRestored, true)
    assert.equal(recovery.mergeStatePresent, false)

    assert.equal(statusOf(fixture.repo), statusBefore)
    assert.equal(await treeOf(fixture.repo), treeBefore)
    assert.equal(existsSync(join(fixture.repo, '.git', 'MERGE_HEAD')), false)
    assert.equal(existsSync(join(fixture.repo, '.git', 'MERGE_MSG')), false)
  } finally {
    cleanup(fixture)
  }
})

test('S3-5d commit:true rejected by a user hook undoes the squash and burns the token', async () => {
  resetMergeTokens()
  const fixture = await setupMergeFixture()
  try {
    const hooksDir = join(fixture.parent, 'rejecting-hooks')
    mkdirSync(hooksDir, { recursive: true })
    writeFileSync(join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    git(fixture.repo, ['config', 'core.hooksPath', hooksDir])

    const statusBefore = statusOf(fixture.repo)
    const treeBefore = await treeOf(fixture.repo)
    const preview = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'preview',
    })

    const res = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'apply',
      confirmToken: preview.token,
      commit: true,
    })

    assert.equal(res.ok, false)
    assert.equal(res.error, 'commit_failed')
    assert.equal(res.treeRestored, true)
    assert.equal(res.noOp, true)
    assert.equal(res.recovery?.mergeStatePresent, false)
    assert.equal(git(fixture.repo, ['diff', '--cached', '--name-only']), '')
    assert.equal(statusOf(fixture.repo), statusBefore)
    assert.equal(await treeOf(fixture.repo), treeBefore)
    assert.equal(readFileSync(join(fixture.repo, 'src/a.ts'), 'utf8'), 'export const a = 1\n')
    assert.equal(existsSync(join(fixture.repo, '.git', 'MERGE_HEAD')), false)
    assert.equal(existsSync(join(fixture.repo, '.git', 'MERGE_MSG')), false)

    // A failed attempt consumed the token: the operator must re-preview.
    const retry = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'apply',
      confirmToken: preview.token,
      commit: true,
    })
    assert.equal(retry.error, 'confirm_token_required')
    assert.match(String(retry.message), /already_used/)
  } finally {
    cleanup(fixture)
  }
})

// ---------------------------------------------------------------------------
// S3-6 — the token: required, single-use, expires, self-invalidates on drift
// ---------------------------------------------------------------------------

test('S3-6 apply requires a token that is single-use, expiring, and invalid after any change', async () => {
  resetMergeTokens()
  const fixture = await setupMergeFixture()
  const t0 = Date.now()
  try {
    const absent = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'apply',
    })
    assert.equal(absent.ok, false)
    assert.equal(absent.error, 'confirm_token_required')
    assert.match(String(absent.message), /missing/)
    assert.equal(absent.tokenValid, false)

    const malformed = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'apply',
      confirmToken: 'not-a-token',
    })
    assert.equal(malformed.error, 'confirm_token_required')
    assert.match(String(malformed.message), /malformed/)

    const first = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'preview',
      now: t0,
    })
    const expired = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'apply',
      confirmToken: first.token,
      now: t0 + MERGE_TOKEN_TTL_MS + 1,
    })
    assert.equal(expired.error, 'confirm_token_required')
    assert.match(String(expired.message), /expired/)

    const preview = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'preview',
      now: t0,
    })
    // The branch advances after the preview: same HEAD, different content.
    git(fixture.repo, ['checkout', '-q', fixture.branch])
    writeFiles(fixture.repo, { 'src/a.ts': 'export const a = "branch v2"\n' })
    commitAll(fixture.repo, 'worker pushes another commit')
    git(fixture.repo, ['checkout', '-q', 'main'])

    const stale = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'apply',
      confirmToken: preview.token,
      now: t0,
    })
    assert.equal(stale.ok, false)
    assert.equal(stale.error, 'confirm_token_required')
    assert.match(String(stale.message), /stale/)
    assert.equal(stale.tokenValid, false)
    assert.equal(statusOf(fixture.repo), '')
  } finally {
    cleanup(fixture)
  }
})

// ---------------------------------------------------------------------------
// Apply happy path: D05 (unstaged), ledger metadata (D06), event, board
// ---------------------------------------------------------------------------

test('S3-A1 apply leaves the squash unstaged, records ephemeral metadata, emits step:merge, and keeps the branch', async () => {
  resetMergeTokens()
  const fixture = await setupMergeFixture({
    branchFiles: {
      'src/a.ts': 'export const a = "branch"\n',
      'src/new.ts': 'export const n = 1\n',
    },
  })
  const events: StepMergeEventPayload[] = []
  const off = getSharedBus().on('step:merge', (event) => events.push(event))
  try {
    const headBefore = git(fixture.repo, ['rev-parse', 'HEAD'])
    const preview = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'preview',
    })
    assert.equal(preview.readyToApply, true)

    const res = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'apply',
      confirmToken: preview.token,
    })

    assert.equal(res.ok, true)
    assert.equal(res.committed, false)
    assert.equal(res.unstaged, true, 'D05: review-first, changes stay unstaged')
    assert.equal(res.branchKept, true)
    assert.equal(res.metadataRecorded, true)
    assert.equal(
      git(fixture.repo, ['rev-parse', 'HEAD']),
      headBefore,
      'no commit without commit:true',
    )

    // Unstaged, not staged: `git reset` ran after the squash.
    assert.equal(git(fixture.repo, ['diff', '--cached', '--name-only']), '')
    const porcelain = statusOf(fixture.repo)
    assert.match(porcelain, /^ M src\/a\.ts$/m)
    assert.match(porcelain, /^\?\? src\/new\.ts$/m)
    assert.equal(
      readFileSync(join(fixture.repo, 'src/a.ts'), 'utf8'),
      'export const a = "branch"\n',
    )
    assert.equal(readFileSync(join(fixture.repo, 'src/new.ts'), 'utf8'), 'export const n = 1\n')

    // D06: metadata lives on the ledger entry.
    const entry = ledgerEntry(fixture.repo, fixture.stepKey)
    assert.equal(entry.ephemeral?.branch, fixture.branch)
    assert.equal(entry.ephemeral?.baseHead, fixture.baseHead)
    assert.equal(entry.ephemeral?.mergedAt, res.mergedAt)
    assert.equal(entry.ephemeral?.mergeTree, preview.mergeTree)
    assert.equal(entry.ephemeral?.role, 'hermes')

    // The branch is kept; only discard deletes it.
    assert.equal(
      gitWorks(fixture.repo, ['rev-parse', '--verify', `refs/heads/${fixture.branch}`]),
      true,
    )

    assert.equal(events.length, 1)
    assert.equal(events[0]?.mode, 'apply')
    assert.equal(events[0]?.stepKey, fixture.stepKey)
    assert.equal(events[0]?.mergeTree, preview.mergeTree)

    const done = readBoardMessages(fixture.repo, { since: 0 }).messages.find(
      (message) => message.tag === 'done' && message.stepKey === fixture.stepKey,
    )
    assert.ok(done, 'a [done] board slot must announce the merge')
    assert.match(done.body, /pantheon\/eph\/eph-merge-1/)
    assert.deepEqual(done.mentions, ['hermes'])
  } finally {
    off()
    cleanup(fixture)
  }
})

test('S3-A2 two concurrent applies with one token: exactly one wins', async () => {
  resetMergeTokens()
  const fixture = await setupMergeFixture()
  try {
    const preview = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'preview',
    })
    assert.equal(preview.readyToApply, true)

    let releaseGate: () => void = () => {}
    let atSeam: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const reachedSeam = new Promise<void>((resolve) => {
      atSeam = resolve
    })

    const first = mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'apply',
      confirmToken: preview.token,
      onBeforeMerge: async () => {
        atSeam()
        await gate
      },
    })
    await reachedSeam

    const second = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'apply',
      confirmToken: preview.token,
    })
    releaseGate()
    const firstResult = await first

    assert.equal(second.ok, false)
    assert.equal(second.error, 'confirm_token_required')
    assert.match(String(second.message), /already_used/)
    assert.equal(firstResult.ok, true)
    assert.equal(firstResult.committed, false)

    // Exactly one merge landed: one modified file, no duplicated content.
    const porcelain = statusOf(fixture.repo)
    assert.equal(porcelain.trim(), 'M src/a.ts')
    assert.equal(
      readFileSync(join(fixture.repo, 'src/a.ts'), 'utf8'),
      'export const a = "branch"\n',
    )
  } finally {
    cleanup(fixture)
  }
})

// ---------------------------------------------------------------------------
// Discard — the only mode that deletes the branch
// ---------------------------------------------------------------------------

test('S3-D1 discard deletes the branch with a single-use token and never touches the worktree', async () => {
  resetMergeTokens()
  const fixture = await setupMergeFixture()
  try {
    writeFiles(fixture.repo, { 'src/b.ts': 'export const b = "local dirt"\n' })
    const statusBefore = statusOf(fixture.repo)

    const noToken = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'discard',
    })
    assert.equal(noToken.error, 'confirm_token_required')
    assert.equal(
      gitWorks(fixture.repo, ['rev-parse', '--verify', `refs/heads/${fixture.branch}`]),
      true,
    )

    // A dirty tree must not block cleanup: discard never touches the worktree.
    const preview = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'preview',
    })
    assert.ok(preview.blockers?.includes('worktree_dirty'))

    const res = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'discard',
      confirmToken: preview.token,
    })
    assert.equal(res.ok, true)
    assert.equal(res.discarded, true)
    assert.equal(res.branchKept, false)
    assert.equal(
      gitWorks(fixture.repo, ['rev-parse', '--verify', `refs/heads/${fixture.branch}`]),
      false,
      'the branch must be gone',
    )
    assert.equal(statusOf(fixture.repo), statusBefore, 'the local edit is untouched')

    const entry = ledgerEntry(fixture.repo, fixture.stepKey)
    assert.ok(entry.ephemeral?.discardedAt)
    assert.equal(entry.ephemeral?.mergedAt, undefined)

    const again = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'discard',
      confirmToken: preview.token,
    })
    assert.equal(again.error, 'branch_missing')
  } finally {
    cleanup(fixture)
  }
})

// ---------------------------------------------------------------------------
// Pre-2.38 fallback: preview merges in a disposable worktree, never the checkout
// ---------------------------------------------------------------------------

test('S3-P1 the temp-worktree fallback previews clean and conflicting merges outside the user tree', async () => {
  resetMergeTokens()
  const clean = await setupMergeFixture()
  const conflicting = await setupMergeFixture({
    stepKey: 'eph-merge-conflict',
    mainFiles: { 'src/a.ts': 'export const a = "main"\n' },
  })
  try {
    const statusBefore = statusOf(clean.repo)
    const cleanPreview = await mergeEphemeralStep({
      cwd: clean.repo,
      stepKey: clean.stepKey,
      mode: 'preview',
      forceLegacyPreview: true,
    })
    assert.equal(cleanPreview.previewVia, 'temp-worktree')
    assert.equal(cleanPreview.clean, true)
    assert.ok(cleanPreview.mergeTree)
    assert.equal(statusOf(clean.repo), statusBefore)
    assert.equal(
      existsSync(
        join(clean.parent, '.pantheon-worktrees', 'app', `merge-preview-${clean.stepKey}`),
      ),
      false,
      'the disposable preview worktree must be removed',
    )
    assert.doesNotMatch(git(clean.repo, ['worktree', 'list']), /merge-preview/)

    const conflictPreview = await mergeEphemeralStep({
      cwd: conflicting.repo,
      stepKey: conflicting.stepKey,
      mode: 'preview',
      forceLegacyPreview: true,
    })
    assert.equal(conflictPreview.previewVia, 'temp-worktree')
    assert.equal(conflictPreview.clean, false)
    assert.deepEqual(conflictPreview.conflicts, ['src/a.ts'])
    assert.equal(conflictPreview.readyToApply, false)
    assert.equal(statusOf(conflicting.repo), '', 'the user tree stays clean')
  } finally {
    cleanup(clean)
    cleanup(conflicting)
  }
})

// ---------------------------------------------------------------------------
// S3-7 — the worker reports baseHead and records it on the ledger entry
// ---------------------------------------------------------------------------

test('S3-7 spawnEphemeralWorker returns baseHead and records ephemeral.branch/baseHead on the ledger', async () => {
  resetMergeTokens()
  const parent = mkdtempSync(join(tmpdir(), 'pantheon-merge-worker-'))
  const repo = initRepo(parent)
  const stepKey = 'worker-step-1'
  try {
    const ledger = createStepLedgerTool(repo)
    const created = await ledger.execute(
      { action: 'init_step', stepKey, objective: 'worker merge fixture', agent: 'hermes' },
      { directory: repo },
    )
    assert.equal(JSON.parse(String(created.output)).ok, true)
    const baseHead = git(repo, ['rev-parse', 'HEAD'])

    let promptTurns = 0
    let worktreeSeen: string | undefined
    const sessionDomain = {
      create: async () => ({ id: 'ses-merge-worker-1' }),
      prompt: async (input: { sessionID: string; text: string }) => {
        promptTurns += 1
        if (promptTurns === 1) {
          const match = /worktree:\s*(\S+)/.exec(input.text)
          worktreeSeen = match?.[1]
          assert.ok(worktreeSeen)
          writeFileSync(join(worktreeSeen, 'feature.ts'), 'export const feature = 42\n')
          return { ok: true }
        }
        if (promptTurns === 3) {
          assert.ok(worktreeSeen)
          const workerLedger = createStepLedgerTool(worktreeSeen)
          await workerLedger.execute(
            { action: 'record_mutation', stepKey, files: ['feature.ts'] },
            { directory: worktreeSeen },
          )
          await workerLedger.execute(
            { action: 'record_verification', stepKey, command: 'node --test', exitCode: 0 },
            { directory: worktreeSeen },
          )
          await workerLedger.execute(
            { action: 'complete_step', stepKey },
            { directory: worktreeSeen },
          )
        }
        return { ok: true }
      },
      wait: async () => ({ status: 'completed' }),
      remove: async () => {},
    }

    const res = await spawnEphemeralWorker({
      sessionDomain,
      cwd: repo,
      stepKey,
      role: 'feature-builder',
      objective: 'Produce feature.ts and record the branch base',
    })

    assert.equal(res.ok, true)
    assert.equal(res.branch, `pantheon/eph/${stepKey}`)
    assert.equal(res.baseHead, baseHead, 'the worker must report the commit it started from')
    assert.equal(res.ledgerMetadataError, undefined)

    const entry = ledgerEntry(repo, stepKey)
    assert.equal(entry.ephemeral?.branch, `pantheon/eph/${stepKey}`)
    assert.equal(entry.ephemeral?.baseHead, baseHead)
    assert.equal(entry.ephemeral?.role, 'feature-builder')

    // End to end: the recorded metadata is enough for the merge gate.
    const preview = await mergeEphemeralStep({ cwd: repo, stepKey, mode: 'preview' })
    assert.equal(preview.ok, true)
    assert.equal(preview.branch, `pantheon/eph/${stepKey}`)
    assert.equal(preview.baseHead, baseHead)
    assert.ok(preview.changes?.includes('feature.ts'))
    assert.equal(preview.readyToApply, true)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// S3-8 — the real lease accessor, and the gate that consumes it
// ---------------------------------------------------------------------------

test('S3-8 listActiveLeases() exposes production leases and the merge gate honours them', async () => {
  resetMergeTokens()
  const sid = 'ses-merge-lease-1'
  const rootDir = '/repo/app'
  try {
    acquireFileLease(sid, {
      role: 'worker-alpha',
      rootDir,
      ownedFiles: ['src/a.ts'],
      forbiddenFiles: ['src/secret.ts'],
    })

    const scoped = listActiveLeases({ rootDir })
    assert.deepEqual(
      scoped.map((lease) => lease.sessionID),
      [sid],
    )
    assert.equal(listActiveLeases({ rootDir: '/repo/elsewhere' }).length, 0)
    assert.ok(listActiveLeases().some((lease) => lease.sessionID === sid))

    const lease = getFileLease(sid)
    assert.ok(lease)
    assert.equal(leaseClaimsPath(lease, 'src/a.ts'), true)
    assert.equal(leaseClaimsPath(lease, 'src/a.ts.bak'), false)
    assert.equal(leaseClaimsPath(lease, 'src/secret.ts'), true, 'forbidden files are claimed too')
  } finally {
    releaseFileLease(sid)
  }
  assert.equal(listActiveLeases({ rootDir }).length, 0)

  // The gate must consume the accessor: another session's lease blocks an apply.
  const fixture = await setupMergeFixture({ stepKey: 'eph-merge-lease' })
  const otherSession = 'ses-merge-other'
  try {
    const preview = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'preview',
    })
    acquireFileLease(otherSession, {
      role: 'worker-beta',
      rootDir: fixture.repo,
      ownedFiles: ['src/a.ts'],
    })

    const blocked = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'apply',
      confirmToken: preview.token,
      sessionID: 'ses-merge-caller',
    })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.error, 'lease_conflict')
    assert.ok(
      blocked.leaseConflicts?.some(
        (conflict) =>
          conflict.source === 'lease' &&
          conflict.holder === 'worker-beta' &&
          conflict.file === 'src/a.ts',
      ),
      `expected a lease overlap, got ${JSON.stringify(blocked.leaseConflicts)}`,
    )

    // The lease holder itself is not a conflict with its own claim.
    const own = await mergeEphemeralStep({
      cwd: fixture.repo,
      stepKey: fixture.stepKey,
      mode: 'apply',
      confirmToken: preview.token,
      sessionID: otherSession,
    })
    assert.equal(own.ok, true)
  } finally {
    releaseFileLease(otherSession)
    cleanup(fixture)
  }
})
