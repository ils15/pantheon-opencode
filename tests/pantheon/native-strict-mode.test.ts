/**
 * TDD tests for PANTHEON_DELEGATE_MODE=native strict mode.
 *
 * Behaviors enforced in native mode:
 * 1. foregroundFallback hardcoded false (board full → throw, not foreground)
 * 2. models failover → empty array (no model retry)
 * 3. retryCount → 0 (no automatic retry)
 * 4. plugin.ts: legacy delegation tools NOT registered
 * 5. resolveDelegateMode: 'native' cannot be overridden by legacy env
 *
 * Run with: npx tsx tests/pantheon/native-strict-mode.test.ts
 */
import { strict as assert } from 'node:assert'

import { BackgroundJobBoard } from '../../src/pantheon/background-job-board.ts'
import { createDelegateManager, resolveDelegateMode } from '../../src/pantheon/delegate-manager.ts'

// ─── Harness ──────────────────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────

function noopTask() {
  return Promise.resolve({ content: 'ok', tokensInput: 0, tokensOutput: 0 })
}

// ─── Tests ────────────────────────────────────────────────────────────

async function main() {
  // ── resolveDelegateMode ──────────────────────────────────────────

  await testAsync(
    'resolveDelegateMode returns native when PANTHEON_DELEGATE_MODE=native',
    async () => {
      const mode = resolveDelegateMode({ PANTHEON_DELEGATE_MODE: 'native' })
      assert.strictEqual(mode, 'native')
    },
  )

  await testAsync('resolveDelegateMode returns legacy when env is empty', async () => {
    const mode = resolveDelegateMode({})
    assert.strictEqual(mode, 'legacy')
  })

  await testAsync('resolveDelegateMode normalizes case (Native → native)', async () => {
    const mode = resolveDelegateMode({ PANTHEON_DELEGATE_MODE: 'Native' })
    assert.strictEqual(mode, 'native')
  })

  await testAsync('resolveDelegateMode trims whitespace (" native " → native)', async () => {
    const mode = resolveDelegateMode({ PANTHEON_DELEGATE_MODE: ' native ' })
    assert.strictEqual(mode, 'native')
  })

  // ── foregroundFallback = false in native mode ─────────────────────

  await testAsync('native mode: foregroundFallback is ignored, throws on board full', async () => {
    const board = new BackgroundJobBoard()
    // Fill the board to max concurrency (default 3).
    board.registerLaunch({ taskID: 'r1', parentSessionID: 'p', agent: 'apollo', description: 'd' })
    board.registerLaunch({ taskID: 'r2', parentSessionID: 'p', agent: 'apollo', description: 'd' })
    board.registerLaunch({ taskID: 'r3', parentSessionID: 'p', agent: 'apollo', description: 'd' })

    const manager = createDelegateManager({
      board,
      task: noopTask,
      parentSessionID: 'p',
      env: { PANTHEON_DELEGATE_MODE: 'native', PANTHEON_DELEGATION: 'on' },
      foregroundFallback: true, // should be IGNORED in native mode
    })

    // apollo is at max — should throw, NOT foreground fallback.
    await assert.rejects(
      () => manager.launch({ agent: 'apollo', prompt: 'test' }),
      { message: /concurrency limit reached/ },
      'native mode should throw when board full, not use foreground fallback',
    )
  })

  await testAsync('legacy mode: foregroundFallback=true actually triggers foreground', async () => {
    const board = new BackgroundJobBoard()
    // Fill the board to max concurrency.
    board.registerLaunch({ taskID: 'r1', parentSessionID: 'p', agent: 'apollo', description: 'd' })
    board.registerLaunch({ taskID: 'r2', parentSessionID: 'p', agent: 'apollo', description: 'd' })
    board.registerLaunch({ taskID: 'r3', parentSessionID: 'p', agent: 'apollo', description: 'd' })

    const manager = createDelegateManager({
      board,
      task: noopTask,
      parentSessionID: 'p',
      env: { PANTHEON_DELEGATION: 'on' },
      foregroundFallback: true,
    })

    // Should NOT throw — uses foreground fallback.
    const receipt = await manager.launch({ agent: 'apollo', prompt: 'test' })
    assert.ok(
      receipt.line.includes('foreground'),
      'legacy mode with foregroundFallback should use foreground',
    )
  })

  // ── models failover = empty in native mode ───────────────────────

  await testAsync('native mode: models option is ignored, no failover attempted', async () => {
    let callCount = 0
    const countingTask = () => {
      callCount++
      return Promise.resolve({ content: 'ok', tokensInput: 0, tokensOutput: 0 })
    }

    const board = new BackgroundJobBoard()
    const manager = createDelegateManager({
      board,
      task: countingTask,
      parentSessionID: 'p',
      env: { PANTHEON_DELEGATE_MODE: 'native', PANTHEON_DELEGATION: 'on' },
      models: ['provider/model-a', 'provider/model-b', 'provider/model-c'],
    })

    await manager.launch({ agent: 'hermes', prompt: 'test' })
    // In native mode with empty effective models, task is called exactly once
    // (even though 3 models were passed).
    assert.strictEqual(callCount, 1, `expected 1 task call, got ${callCount}`)
  })

  // ── resolveDelegateMode is single source of truth ────────────────

  await testAsync(
    'resolveDelegateMode: PANTHEON_DELEGATE_MODE=native returns native even if PANTHEON_DELEGATION=off',
    async () => {
      const mode = resolveDelegateMode({
        PANTHEON_DELEGATE_MODE: 'native',
        PANTHEON_DELEGATION: 'off',
      })
      assert.strictEqual(mode, 'native', 'mode should be native regardless of kill-switch')
    },
  )

  await testAsync('resolveDelegateMode: garbage value returns legacy', async () => {
    const mode = resolveDelegateMode({ PANTHEON_DELEGATE_MODE: 'invalid' })
    assert.strictEqual(mode, 'legacy')
  })

  // ── Reporting ────────────────────────────────────────────────────

  const failed = results.filter((r) => !r.passed)
  for (const r of results) {
    if (r.passed) console.log(`PASS - ${r.name}`)
    else console.log(`FAIL - ${r.name}\n  ${r.error}`)
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exit(1)
}

void main()
