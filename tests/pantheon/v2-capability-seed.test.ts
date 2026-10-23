/**
 * Capability-seed truth tests (issue #267).
 *
 * The V2 seed (`src/pantheon/v2-unsupported.mjs`) is what install and `doctor`
 * show a migrating user, and what the plugin itself appends to at runtime. It
 * had drifted: it listed only the adapter's scope choices while four V1
 * behaviours (Zeus read guard, idle continuation, compaction context, tool
 * ceiling, todo restore, delegation audit) were missing from the V2 surface with
 * no marker at all.
 *
 * This file enforces the property that fixes that drift: for every mechanism
 * this repository wires, the SEED and the SOURCE must agree.
 *
 *   ported      → the V2 source contains the mechanism, and the seed does NOT
 *                 claim it is missing.
 *   missing     → the V1 source contains it, the V2 source does not, and the
 *                 seed DOES declare it.
 *   conditional → both sources contain it, but it depends on a host API that
 *                 the measured host may not expose, so the seed still declares
 *                 the reduction.
 *
 * The list is hardcoded on purpose: a diff computed from hook names alone
 * cannot tell an equivalent implementation from a stub, and this file must fail
 * when a mechanism is added to or removed from `src/plugin-v2.ts` without a
 * matching seed update.
 *
 * Run with: npx tsx tests/pantheon/v2-capability-seed.test.ts
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { V2_UNSUPPORTED_FEATURE_SEED } from '../../src/pantheon/v2-unsupported.mjs'

const read = (relative: string): string =>
  readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

const V1_PLUGIN = read('src/plugin.ts')
const V2_PLUGIN = read('src/plugin-v2.ts')
const V1_HOOKS_PLUGIN = read('src/plugins/pantheon-hooks.ts')
const V2_SHELL_HOOKS = read('src/pantheon/v2-shell-hooks.ts')

type State = 'ported' | 'missing' | 'conditional'

interface Mechanism {
  /** Stable name used in failure messages. */
  id: string
  state: State
  /** Marker in the V1 source (plugin.ts, or the file named by `v1Source`). */
  v1: RegExp
  /** Marker in the V2 source (plugin-v2.ts, or the file named by `v2Source`). */
  v2: RegExp
  v1Source?: string
  v2Source?: string
  /** Seed entry that must exist for a 'missing'/'conditional' mechanism. */
  seed?: string
}

const MECHANISMS: readonly Mechanism[] = [
  {
    id: 'zeus-read-guard (#264)',
    state: 'ported',
    v1: /zeusReadGuard\(/,
    v2: /zeusReadGuard\(/,
  },
  {
    id: 'idle-dispatch (#265)',
    state: 'ported',
    v1: /idleDispatcher\.onIdle\(/,
    v2: /todoEnforcer\.onIdle\(/,
  },
  {
    id: 'idle-todo-enforcer (#265)',
    state: 'conditional',
    // The V1 enforcer is constructed from `client.session`; V2 builds the same
    // class only when the host's session domain exposes the four methods.
    v1: /new TodoEnforcer\(/,
    v2: /new TodoEnforcer\(/,
    seed: 'idle-todo-enforcer',
  },
  {
    id: 'compaction-context (#266)',
    state: 'ported',
    v1: /buildCompactionContext\(/,
    v2: /buildCompactionContext\(/,
  },
  {
    id: 'vision-history-sanitization (#266)',
    state: 'ported',
    v1: /experimental\.chat\.messages\.transform/,
    v2: /sanitizeVisionHistory\(/,
  },
  {
    id: 'formatter (#266)',
    state: 'ported',
    v1: /format-multi-language\.sh/,
    v2: /FORMATTER_SCRIPT/,
    v1Source: V1_HOOKS_PLUGIN,
    v2Source: V2_SHELL_HOOKS,
  },
  {
    id: 'delegation-audit (#266)',
    state: 'ported',
    v1: /on-subagent-delegation-start\.sh/,
    v2: /DELEGATION_START_SCRIPT/,
    v1Source: V1_HOOKS_PLUGIN,
    v2Source: V2_SHELL_HOOKS,
  },
  {
    id: 'tool-ceiling (#266)',
    state: 'missing',
    v1: /handleToolCeilingEvent\(/,
    v2: /handleToolCeilingEvent\(/,
    seed: 'tool-ceiling',
  },
  {
    id: 'todo-restore (#266)',
    state: 'missing',
    v1: /todoPreserver\.capture\(/,
    v2: /todoPreserver\.capture\(/,
    seed: 'todo-restore',
  },
  {
    id: 'board-transitions',
    state: 'missing',
    // The board INSTANCE is injected on V2; what is missing is a writer. The
    // terminal audit listener is the first of V1's four board writers.
    v1: /board\.onTerminal\(/,
    v2: /board\.onTerminal\(/,
    seed: 'board-transitions',
  },
]

/**
 * Seed entries this table deliberately does not model: each is an adapter
 * scope choice or host-absent domain, not a mechanism wired in either plugin
 * source. Keeping them here makes an unexplained NEW seed entry fail the suite.
 */
const SEED_ENTRIES_OUTSIDE_THE_TABLE = new Set([
  'legacy-hooks',
  'catalog-transform',
  'integration-transform',
  'skill-transform',
  'goal-tools',
])

// ─── Harness ─────────────────────────────────────────────────────────────

const results: { name: string; passed: boolean; error?: string }[] = []

function test(name: string, fn: () => void): void {
  try {
    fn()
    results.push({ name, passed: true })
  } catch (e: unknown) {
    results.push({ name, passed: false, error: e instanceof Error ? e.message : String(e) })
  }
}

function main(): void {
  console.log('\n🧾 V2 capability-seed truth tests')

  const seed = new Set<string>(V2_UNSUPPORTED_FEATURE_SEED)

  for (const mechanism of MECHANISMS) {
    test(`${mechanism.id} is ${mechanism.state} in source and seed`, () => {
      const v2Source = mechanism.v2Source ?? V2_PLUGIN
      const v1Source = mechanism.v1Source ?? V1_PLUGIN
      // Sanity: the V1 marker must exist, otherwise the table is describing a
      // mechanism that was renamed or removed in V1 too.
      assert.match(
        v1Source,
        mechanism.v1,
        `the V1 marker for ${mechanism.id} no longer matches — update this table`,
      )

      if (mechanism.state === 'ported') {
        assert.match(
          v2Source,
          mechanism.v2,
          `${mechanism.id} is declared ported but its V2 wiring is gone; ` +
            'restore it or move it to the seed',
        )
        assert.equal(
          mechanism.seed !== undefined && seed.has(mechanism.seed),
          false,
          `${mechanism.id} is implemented on V2 — the seed must not claim "${mechanism.seed}" is missing`,
        )
        return
      }

      if (mechanism.state === 'missing') {
        assert.doesNotMatch(
          v2Source,
          mechanism.v2,
          `${mechanism.id} is now implemented on V2; drop "${mechanism.seed}" from the seed ` +
            'and declare the mechanism ported in this table',
        )
      } else {
        // conditional: present, but gated on a host API the measured host does
        // not expose.
        assert.match(
          v2Source,
          mechanism.v2,
          `${mechanism.id} is declared conditional but its V2 wiring is gone`,
        )
      }

      assert.ok(mechanism.seed !== undefined, `${mechanism.id} must name a seed entry`)
      assert.ok(
        seed.has(mechanism.seed as string),
        `the seed must declare "${mechanism.seed}" — ${mechanism.id} is not fully available on V2`,
      )
    })
  }

  test('every seed entry is either modelled in the table or explicitly exempted', () => {
    const modelled = new Set(MECHANISMS.map((mechanism) => mechanism.seed).filter(Boolean))
    for (const entry of V2_UNSUPPORTED_FEATURE_SEED) {
      assert.ok(
        modelled.has(entry) || SEED_ENTRIES_OUTSIDE_THE_TABLE.has(entry),
        `the seed grew a "${entry}" entry that this table does not explain — ` +
          'either model the mechanism above or exempt the entry with a reason',
      )
    }
  })

  test('the seed is not frozen twice: the plugin copies it into its live list', () => {
    assert.ok(Object.isFrozen(V2_UNSUPPORTED_FEATURE_SEED), 'the seed must stay frozen')
  })

  let passed = 0
  let failed = 0
  for (const result of results) {
    if (result.passed) {
      passed++
      console.log(`  ✅ ${result.name}`)
    } else {
      failed++
      console.log(`  ❌ ${result.name}: ${result.error}`)
    }
  }
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main()
