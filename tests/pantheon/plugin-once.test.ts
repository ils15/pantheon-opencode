/**
 * Tests for the runtime double-registration guard (pantheonPluginOnce).
 *
 * OpenCode MERGES the global (~/.config/opencode/opencode.json — npm-package
 * plugin paths) and project (opencode.json — repo source paths) plugin
 * configs, so `src/plugin.ts` and `src/plugins/pantheon-hooks.ts` are each
 * LOADED TWICE from two different filesystem paths in the SAME process
 * (verified 2026-08-12: duplicate delegation toasts + duplicate task_ids in
 * one process). The guard claims a stable per-plugin key on globalThis so the
 * SECOND factory invocation becomes a no-op — hooks register exactly once.
 *
 * The guard is deliberately process-global (globalThis Set), NOT module-
 * scoped: the two loads are separate module instances, so only a shared
 * global can dedupe them.
 *
 * Run with: npx tsx tests/pantheon/plugin-once.test.ts
 */
import { strict as assert } from 'node:assert'

import { pantheonPluginOnce } from '../../src/pantheon/plugin-once.ts'

// ─── Helpers (mirrors the repo test-runner convention) ─────────────────

const results: { name: string; passed: boolean; error?: string }[] = []

function test(name: string, fn: () => void) {
  try {
    fn()
    results.push({ name, passed: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    results.push({ name, passed: false, error: msg })
  }
}

async function testAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    results.push({ name, passed: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    results.push({ name, passed: false, error: msg })
  }
}

/** Directly inspect the shared guard Set (same globalThis the plugin uses). */
function guardSet(): Set<string> {
  return (globalThis as Record<string, unknown>).__pantheonPluginsLoaded as Set<string>
}

async function main() {
  // ═════════════════════════════════════════════════════════════════════
  // CLAIM SEMANTICS
  // ═════════════════════════════════════════════════════════════════════

  test('first claim returns false — the factory MUST run', () => {
    // Unique key per test so ordering never leaks between tests.
    const key = `pantheon:test-first:${Date.now()}`
    assert.equal(pantheonPluginOnce(key), false, 'first claim runs the factory')
  })

  test('second claim of the SAME key returns true — the factory MUST no-op', () => {
    const key = `pantheon:test-second:${Date.now()}`
    pantheonPluginOnce(key)
    assert.equal(pantheonPluginOnce(key), true, 'second claim must be a no-op')
    assert.equal(pantheonPluginOnce(key), true, 'stays claimed for the whole process')
  })

  test('distinct keys are independent — plugin and hooks do not collide', () => {
    const a = `pantheon:test-a:${Date.now()}`
    const b = `pantheon:test-b:${Date.now()}`
    assert.equal(pantheonPluginOnce(a), false)
    assert.equal(pantheonPluginOnce(b), false, 'different plugin key still runs')
    assert.equal(pantheonPluginOnce(a), true)
    assert.equal(pantheonPluginOnce(b), true)
  })

  // ═════════════════════════════════════════════════════════════════════
  // PROCESS-GLOBAL SEMANTICS (the actual double-load scenario)
  // ═════════════════════════════════════════════════════════════════════

  await testAsync('second module INSTANCE sees the key claimed (shared globalThis)', async () => {
    const key = `pantheon:test-double:${Date.now()}`
    // Cache-busting query strings force two SEPARATE module instances (the
    // npm-package path vs the repo path load the module twice — separate
    // module scopes, ONE shared globalThis).
    const copyA = await import(`../../src/pantheon/plugin-once.ts?copy=${Date.now()}-a`)
    const copyB = await import(`../../src/pantheon/plugin-once.ts?copy=${Date.now()}-b`)
    assert.equal(copyA.pantheonPluginOnce(key), false, 'copy A runs the factory')
    assert.equal(copyB.pantheonPluginOnce(key), true, 'copy B is a no-op — hooks register once')
  })

  // ═════════════════════════════════════════════════════════════════════
  // FAIL-SAFE / ROBUSTNESS
  // ═════════════════════════════════════════════════════════════════════

  test('helper never throws and is idempotent', () => {
    const key = `pantheon:test-safe:${Date.now()}`
    for (let i = 0; i < 5; i++) {
      pantheonPluginOnce(key) // must not throw
    }
    assert.equal(pantheonPluginOnce(key), true)
  })

  test('guard state lives on the documented globalThis key', () => {
    const key = `pantheon:test-global:${Date.now()}`
    pantheonPluginOnce(key)
    assert.ok(guardSet().has(key), 'key is registered on globalThis.__pantheonPluginsLoaded')
  })

  test('guard Set is shared — a stale Set survives module re-loads', () => {
    // If the runtime had pre-claimed keys from a PREVIOUS process crash, the
    // Set would be re-created empty (per-process). Within one process the
    // SAME Set object is reused across imports.
    const before = guardSet()
    const key = `pantheon:test-shared:${Date.now()}`
    pantheonPluginOnce(key)
    assert.equal(guardSet(), before, 'no Set replacement between claims')
    assert.ok(guardSet().has(key))
  })

  // ═════════════════════════════════════════════════════════════════════
  // REPORT
  // ═════════════════════════════════════════════════════════════════════

  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed)

  console.log('')
  for (const r of results) {
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? `: ${r.error}` : ''}`)
  }
  console.log(`\nResults: ${passed} passed, ${failed.length} failed`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main()
