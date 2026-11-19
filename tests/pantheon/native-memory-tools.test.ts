import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createNativeMemoryAndPersistenceTools } from '../../src/pantheon/native-memory-tools.ts'
import type { V2ToolDef } from '../../src/pantheon/tools.ts'

async function callTool(
  tools: Map<string, V2ToolDef>,
  name: string,
  input: Record<string, unknown>,
  ctx: unknown,
): Promise<Record<string, unknown>> {
  const tool = tools.get(name)
  assert.ok(tool, `expected tool ${name} to be registered`)
  const res = await tool.execute(input, ctx)
  return JSON.parse(res.output) as Record<string, unknown>
}

test('native memory tools store, recall, search via FTS5, filter expired entries, and delete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-native-mem-'))
  const prevHome = process.env.HOME
  const prevXdg = process.env.XDG_CONFIG_HOME
  process.env.HOME = dir
  process.env.XDG_CONFIG_HOME = join(dir, '.config')
  try {
    const tools = new Map(
      createNativeMemoryAndPersistenceTools(dir).map((tool) => [tool.name, tool]),
    )
    const ctx = { directory: dir, sessionID: 'ses_mem_1' }

    const storeRes = await callTool(
      tools,
      'memory_store',
      {
        namespace: 'auth',
        key: 'jwt-rotation',
        value: 'Use asymmetric RS256 refresh token rotation with strict 15m access TTL.',
      },
      ctx,
    )
    assert.equal(storeRes.ok, true)
    assert.equal(storeRes.status, 'stored')

    // Expired entry must be filtered out on recall and search
    await callTool(
      tools,
      'memory_store',
      {
        namespace: 'auth',
        key: 'expired-key',
        value: 'Legacy expired token rule RS256',
        expires_at: '2020-01-01T00:00:00.000Z',
      },
      ctx,
    )

    const recallActive = await callTool(
      tools,
      'memory_recall',
      { namespace: 'auth', key: 'jwt-rotation' },
      ctx,
    )
    assert.equal(recallActive.key, 'jwt-rotation')

    const recallExpired = await callTool(
      tools,
      'memory_recall',
      { namespace: 'auth', key: 'expired-key' },
      ctx,
    )
    assert.equal(recallExpired.error, 'not_found')

    const searchRes = await callTool(
      tools,
      'memory_search',
      { query: 'RS256 rotation', namespace: 'auth' },
      ctx,
    )
    assert.equal(searchRes.ok, true)
    assert.equal(searchRes.count, 1)
    const results = searchRes.results as Array<Record<string, unknown>>
    assert.equal(results[0]?.key, 'jwt-rotation')

    const statsRes = await callTool(tools, 'memory_stats', {}, ctx)
    assert.equal(statsRes.total, 1)

    const forgetRes = await callTool(
      tools,
      'memory_forget',
      { namespace: 'auth', key: 'jwt-rotation' },
      ctx,
    )
    assert.equal(forgetRes.deleted, true)
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdg
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native persistence and goal tools save/load state and block path traversal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-native-persist-'))
  const prevHome = process.env.HOME
  const prevXdg = process.env.XDG_CONFIG_HOME
  process.env.HOME = dir
  process.env.XDG_CONFIG_HOME = join(dir, '.config')
  try {
    const tools = new Map(
      createNativeMemoryAndPersistenceTools(dir).map((tool) => [tool.name, tool]),
    )
    const ctx = { directory: dir, sessionID: 'ses_persist_1' }

    const saveRes = await callTool(
      tools,
      'context_save',
      {
        session_id: 'ses_123',
        content: JSON.stringify({ phase: { current: 2 } }),
      },
      ctx,
    )
    assert.equal(saveRes.ok, true)

    const getRes = await callTool(tools, 'context_get', { session_id: 'ses_123' }, ctx)
    assert.equal(getRes.session_id, 'ses_123')

    // Path traversal attempt must fail closed
    const traversalRes = await callTool(
      tools,
      'context_save',
      {
        session_id: '../../package',
        content: '{}',
      },
      ctx,
    )
    assert.equal(traversalRes.ok, false)

    // Goal lifecycle
    const created = await callTool(
      tools,
      'goal_create',
      {
        id: 'goal-1',
        title: 'Migrate to native tools',
        criteria: ['Zero Python deps'],
      },
      ctx,
    )
    assert.equal(created.ok, true)
    assert.equal((created.goal as Record<string, unknown>).status, 'active')

    const done = await callTool(
      tools,
      'goal_done',
      {
        id: 'goal-1',
        summary: 'All native tools active',
      },
      ctx,
    )
    assert.equal(done.ok, true)
    assert.equal((done.goal as Record<string, unknown>).status, 'completed')
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdg
    rmSync(dir, { recursive: true, force: true })
  }
})

test('worktree sessions share the main repository memory, checkpoints, and goals store', async () => {
  const base = mkdtempSync(join(tmpdir(), 'pantheon-wt-mem-'))
  const mainRepo = join(base, 'repo')
  const worktreeDir = join(base, 'wt-task')
  const prevHome = process.env.HOME
  const prevXdg = process.env.XDG_CONFIG_HOME
  process.env.HOME = join(base, 'home')
  process.env.XDG_CONFIG_HOME = join(base, 'home', '.config')
  mkdirSync(mainRepo, { recursive: true })
  try {
    execFileSync('git', ['init'], { cwd: mainRepo, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: mainRepo,
      stdio: 'ignore',
    })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: mainRepo, stdio: 'ignore' })
    writeFileSync(join(mainRepo, 'README.md'), '# test\n')
    execFileSync('git', ['add', '.'], { cwd: mainRepo, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: mainRepo, stdio: 'ignore' })
    execFileSync('git', ['worktree', 'add', '-b', 'feat/wt', worktreeDir], {
      cwd: mainRepo,
      stdio: 'ignore',
    })

    const mainTools = new Map(
      createNativeMemoryAndPersistenceTools(mainRepo).map((tool) => [tool.name, tool]),
    )
    const wtTools = new Map(
      createNativeMemoryAndPersistenceTools(worktreeDir).map((tool) => [tool.name, tool]),
    )

    await callTool(
      mainTools,
      'memory_store',
      { namespace: 'arch', key: 'solo-rule', value: 'Share memory across worktrees' },
      { directory: mainRepo, sessionID: 'ses_main' },
    )

    const recalledFromWt = await callTool(
      wtTools,
      'memory_recall',
      { namespace: 'arch', key: 'solo-rule' },
      { directory: worktreeDir, worktree: worktreeDir, sessionID: 'ses_wt' },
    )
    assert.equal(recalledFromWt.key, 'solo-rule')
    assert.equal(recalledFromWt.value, 'Share memory across worktrees')

    await callTool(
      wtTools,
      'goal_create',
      { id: 'wt-goal-1', title: 'Keep goals visible from main', criteria: ['Shared root'] },
      { directory: worktreeDir, worktree: worktreeDir, sessionID: 'ses_wt' },
    )
    const goalFromMain = await callTool(
      mainTools,
      'goal_get',
      { id: 'wt-goal-1' },
      { directory: mainRepo, sessionID: 'ses_main' },
    )
    assert.equal(goalFromMain.id, 'wt-goal-1')
    assert.equal(goalFromMain.title, 'Keep goals visible from main')
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdg
    rmSync(base, { recursive: true, force: true })
  }
})
