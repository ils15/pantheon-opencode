/**
 * Native background task → shared board mirror (beta.5).
 *
 * Proves the `tool.execute.after` mirror in pantheon-hooks.ts registers a
 * native `task(background=true)` child on the SHARED BackgroundJobBoard so
 * the existing finalize path (session.idle + idle scan) can write the
 * terminal report and the TUI delegation panel tracks the child end-to-end.
 *
 * Also proves the board singleton is anchored on globalThis: opencode loads
 * each plugin TWICE from different filesystem paths (npm package + repo), so
 * a plain ESM singleton would yield two boards — the mirror must land on the
 * same instance plugin.ts finalizes against.
 *
 * Run with: npx tsx tests/pantheon/native-task-mirror.test.ts
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BackgroundJobBoard } from '../../src/pantheon/background-job-board.ts'

// ─── Harness ────────────────────────────────────────────────────────────

const results: { name: string; passed: boolean; error?: string }[] = []

async function testAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    results.push({ name, passed: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    results.push({ name, passed: false, error: msg })
  }
}

// The board persists to `.pantheon/board/state.json` RELATIVE to cwd — point
// cwd at a tmp dir BEFORE the first getSharedBoard() call so tests never
// touch repo state. PANTHEON_PLUGIN_ONCE=off disables the process-global
// double-registration guard so the factory can be invoked per test.
process.env.PANTHEON_PLUGIN_ONCE = 'off'
const workDir = mkdtempSync(join(tmpdir(), 'pantheon-native-mirror-'))
const HOOKS_URL = new URL('../../src/plugins/pantheon-hooks.ts', import.meta.url).href
process.chdir(workDir)

const DISPATCHED_RESULT = {
  title: 'Background task',
  output: '<task id="ses_child_9" state="running">\n<summary>Background task started</summary>',
  metadata: { background: true, jobId: 'job-1' },
}

async function loadHooksFactory(): Promise<(input: unknown) => Promise<Record<string, unknown>>> {
  process.env.PANTHEON_PLUGIN_ONCE = 'off'
  const mod = (await import(HOOKS_URL)) as {
    default: (input: unknown) => Promise<Record<string, unknown>>
  }
  return async (input: unknown) => {
    const hooks = await mod.default({
      directory: workDir,
      client: {
        app: { log: async () => {} },
        tui: { showToast: async () => {} },
      },
      ...input,
    })
    return hooks
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────

async function main() {
  const { getSharedBoard } = await import('../../src/pantheon/shared-board.ts')

  await testAsync(
    'dispatched native background task is mirrored onto the shared board',
    async () => {
      const factory = await loadHooksFactory()
      const hooks = (await factory({})) as {
        'tool.execute.after': (input: unknown, output: unknown) => Promise<void>
      }

      await hooks['tool.execute.after'](
        {
          tool: 'task',
          callID: 'call-1',
          sessionID: 'ses_parent_1',
          args: { subagent_type: 'apollo', description: 'Research auth flows' },
        },
        DISPATCHED_RESULT,
      )

      const job = getSharedBoard().get('ses_child_9')
      assert.ok(job !== undefined, 'MIRROR GAP: dispatched native task not registered on board')
      assert.equal(job.state, 'running')
      assert.equal(job.agent, 'apollo', 'agent must come from args.subagent_type')
      assert.equal(job.parentSessionID, 'ses_parent_1')
      assert.ok(
        String(job.description).includes('Research auth flows'),
        `description must carry the task description, got: ${job.description}`,
      )
    },
  )

  await testAsync('foreground (non-dispatched) task result is NOT mirrored', async () => {
    const factory = await loadHooksFactory()
    const hooks = (await factory({})) as {
      'tool.execute.after': (input: unknown, output: unknown) => Promise<void>
    }

    await hooks['tool.execute.after'](
      {
        tool: 'task',
        callID: 'call-fg',
        sessionID: 'ses_parent_2',
        args: { subagent_type: 'hermes' },
      },
      { title: 'Done', output: 'Analysis complete: 3 files changed.', metadata: {} },
    )

    const job = getSharedBoard().get('ses_child_9')
    assert.ok(job !== undefined, 'precondition: earlier mirror still present')
    assert.equal(
      getSharedBoard().list('ses_parent_2').length,
      0,
      'foreground task must not create a board record',
    )
  })

  await testAsync('mirror is idempotent — double dispatch keeps a single record', async () => {
    const factory = await loadHooksFactory()
    const hooks = (await factory({})) as {
      'tool.execute.after': (input: unknown, output: unknown) => Promise<void>
    }
    const before = getSharedBoard().get('ses_child_9')

    await hooks['tool.execute.after'](
      {
        tool: 'task',
        callID: 'call-again',
        sessionID: 'ses_parent_1',
        args: { subagent_type: 'apollo', description: 'Research auth flows' },
      },
      DISPATCHED_RESULT,
    )
    await hooks['tool.execute.after'](
      {
        tool: 'task',
        callID: 'call-again-2',
        sessionID: 'ses_parent_1',
        args: { subagent_type: 'apollo', description: 'Research auth flows' },
      },
      DISPATCHED_RESULT,
    )

    const after = getSharedBoard().get('ses_child_9')
    assert.ok(after !== undefined && before !== undefined)
    assert.equal(after.alias, before.alias, 'registerLaunchIfAbsent must not mint a new alias')
    assert.equal(after.state, 'running')
  })

  await testAsync('mirror never throws into the tool call (resilience)', async () => {
    const factory = await loadHooksFactory()
    const hooks = (await factory({})) as {
      'tool.execute.after': (input: unknown, output: unknown) => Promise<void>
    }

    // Missing sessionID → the board launch is invalid; the hook must swallow
    // the failure and still resolve.
    await assert.doesNotReject(
      hooks['tool.execute.after'](
        {
          tool: 'task',
          callID: 'call-broken',
          sessionID: '',
          args: { subagent_type: 'apollo' },
        },
        {
          title: 'Background task',
          output: '<task id="ses_child_broken" state="running">',
          metadata: { background: true },
        },
      ),
    )
  })

  await testAsync('shared board singleton survives a cache-busted module re-load', async () => {
    const { getSharedBoard: first } = await import('../../src/pantheon/shared-board.ts')
    const { getSharedBoard: second } = await import(
      '../../src/pantheon/shared-board.ts?cachebust=1'
    )
    const a = first()
    const b = second()
    assert.ok(a instanceof BackgroundJobBoard)
    assert.ok(b instanceof BackgroundJobBoard)
    assert.equal(
      a,
      b,
      'opencode double-loads plugins from npm+repo paths — the board must be globalThis-anchored',
    )
    assert.equal(b.get('ses_child_9')?.taskID, 'ses_child_9')
  })

  // ─── Summary ──────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed)
  for (const r of results) {
    console.log(`  ${r.passed ? '✅' : '❌'} ${r.name}${r.error ? ': ' + r.error : ''}`)
  }
  console.log(`\n📊 Results: ${passed} passed, ${failed.length} failed`)
  if (failed.length > 0) process.exit(1)
}

main().finally(() => {
  process.chdir('/')
  rmSync(workDir, { recursive: true, force: true })
})
