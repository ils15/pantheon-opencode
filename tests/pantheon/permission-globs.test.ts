/**
 * Tests for O5 — permission globs for delegation (permission.task model).
 *
 * permission-globs.ts provides:
 *   - globToRegExp(): glob pattern → RegExp (* = any sequence, ? = one char)
 *   - matchPermissionRule(): last matching rule wins
 *   - isAgentAllowed(): whether an agent may be invoked as a subagent
 *   - filterAllowedAgents(): the allowed subset of a candidate list
 *   - buildAgentListDescription(): the delegate tool description with
 *     DENIED agents removed entirely (not just blocked at call time)
 *
 * Required behaviors (TDD):
 *   (a) glob allow — a pattern allows matching agents
 *   (b) glob deny — a pattern denies matching agents
 *   (c) last-match-wins — the LAST matching rule decides
 *   (d) deny removes the agent from the tool description entirely
 *
 * Run with: npx tsx tests/pantheon/permission-globs.test.ts
 */
import { strict as assert } from 'node:assert'

import {
  buildAgentListDescription,
  filterAllowedAgents,
  globToRegExp,
  isAgentAllowed,
  matchPermissionRule,
} from '../../src/pantheon/permission-globs.ts'

// ─── Harness ───────────────────────────────────────────────────────────

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

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  await testAsync('globToRegExp: * matches any sequence, ? one char, anchors exact', async () => {
    assert.equal(globToRegExp('*').test('anything'), true)
    assert.equal(globToRegExp('orchestrator-*').test('orchestrator-zeus'), true)
    assert.equal(globToRegExp('orchestrator-*').test('orchestrator-'), true)
    assert.equal(globToRegExp('orchestrator-*').test('zeus'), false, 'anchored — no prefix match')
    assert.equal(globToRegExp('apollo').test('apollo'), true)
    assert.equal(globToRegExp('apollo').test('apollo2'), false, 'exact match only')
    assert.equal(globToRegExp('a?ollo').test('apollo'), true)
    assert.equal(globToRegExp('a?ollo').test('abollo'), true)
    assert.equal(globToRegExp('a?ollo').test('aollo'), false)
  })

  // ── (a) glob allow ───────────────────────────────────────────────────
  await testAsync('(a) glob allow: matching agents are allowed', async () => {
    const rules = { '*': 'deny', 'orchestrator-*': 'allow' } as const
    assert.equal(isAgentAllowed(rules, 'orchestrator-zeus'), true, 'matches the allow glob')
    assert.equal(isAgentAllowed(rules, 'orchestrator-hermes'), true)
    assert.equal(isAgentAllowed(rules, 'hermes'), false, 'deny-all default applies')
  })

  // ── (b) glob deny ────────────────────────────────────────────────────
  await testAsync('(b) glob deny: matching agents are denied', async () => {
    const rules = { '*': 'allow', apollo: 'deny' } as const
    assert.equal(isAgentAllowed(rules, 'hermes'), true, 'allow-all default')
    assert.equal(isAgentAllowed(rules, 'apollo'), false, 'explicit deny wins')
    assert.equal(isAgentAllowed(rules, 'gaia'), true)
  })

  // ── (c) last-match-wins ──────────────────────────────────────────────
  await testAsync('(c) last-match-wins: the LAST matching rule decides', async () => {
    // apollo matches both "*" (deny) and "apollo" (allow) — allow is last → allowed
    const allowLast = { '*': 'deny', apollo: 'allow' } as const
    assert.equal(matchPermissionRule(allowLast, 'apollo'), 'allow')
    assert.equal(isAgentAllowed(allowLast, 'apollo'), true)

    // apollo matches both "apollo" (allow) and "*" (deny) — deny is last → denied
    const denyLast = { apollo: 'allow', '*': 'deny' } as const
    assert.equal(matchPermissionRule(denyLast, 'apollo'), 'deny')
    assert.equal(isAgentAllowed(denyLast, 'apollo'), false)
  })

  await testAsync('no rules → everything allowed (existing matrix still applies)', async () => {
    assert.equal(isAgentAllowed(undefined, 'apollo'), true)
    assert.equal(isAgentAllowed({}, 'apollo'), true)
  })

  // ── (d) deny removes the agent from the tool description ─────────────
  await testAsync('(d) deny removes the agent from the tool description entirely', async () => {
    const rules = { '*': 'deny', 'orchestrator-*': 'allow' } as const
    const agents = ['orchestrator-zeus', 'orchestrator-athena', 'hermes', 'apollo']
    const allowed = filterAllowedAgents(rules, agents)
    assert.deepEqual(
      allowed,
      ['orchestrator-zeus', 'orchestrator-athena'],
      'denied agents filtered out',
    )

    const description = buildAgentListDescription(rules, agents)
    assert.ok(description.includes('orchestrator-zeus'), 'allowed agent listed')
    assert.ok(description.includes('orchestrator-athena'), 'allowed agent listed')
    assert.ok(!description.includes('hermes'), 'denied agent REMOVED from the description')
    assert.ok(!description.includes('apollo'), 'denied agent REMOVED from the description')
  })

  await testAsync('buildAgentListDescription: all denied → explicit empty message', async () => {
    const rules = { '*': 'deny' } as const
    const description = buildAgentListDescription(rules, ['hermes', 'apollo'])
    assert.match(description, /no subagents available/i)
  })

  await testAsync('buildAgentListDescription: no rules → lists every agent', async () => {
    const description = buildAgentListDescription(undefined, ['hermes', 'apollo'])
    assert.ok(description.includes('hermes'))
    assert.ok(description.includes('apollo'))
  })

  // ═══════════════════════════════════════════════════════════════════════

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
