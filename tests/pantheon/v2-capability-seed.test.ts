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
 * What is DERIVED and what is DECLARED, stated precisely (the earlier version of
 * this file overclaimed): the mechanism list is declared, because only a reader
 * can say whether two markers are the same behaviour. The set of REGISTRATION
 * SITES is derived from `src/plugin-v2.ts` — every `ctx.<domain>.hook('<name>')`
 * and the event/tool subscriptions are extracted from the source and compared
 * with {@link V2_HOOK_OWNERS}. A new wiring point added to the V2 entry without
 * an owner here therefore fails, and so does removing one; a mechanism whose
 * BODY is broken while its call stays in place is not detectable by any text
 * scan, and this file does not claim otherwise (the behavioural suites cover
 * that).
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
const V1_DELEGATION_ENFORCE = read('src/pantheon/delegation-enforce.ts')

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
    // CONDITIONAL, not ported: the call site exists, but it can only reach an
    // enforcer the measured host cannot construct (see the enforcer entry).
    // Marking this "ported" would claim idle continuation works on every V2
    // install, which is exactly the overstatement #267 exists to stop.
    state: 'conditional',
    v1: /idleDispatcher\.onIdle\(/,
    v2: /todoEnforcer\.onIdle\(/,
    seed: 'idle-todo-enforcer',
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
    id: 'delegation-matrix (#264)',
    state: 'ported',
    v1: /isDelegationAllowed\(/,
    v2: /evaluateV2Delegation\(/,
    v1Source: V1_DELEGATION_ENFORCE,
  },
  {
    id: 'prompt-admission (vision prompt context)',
    state: 'ported',
    v1: /'chat\.message':/,
    v2: /sessionCtx\.hook\('prompt'/,
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
 * Every registration site in `src/plugin-v2.ts`, mapped to its owner.
 *
 * The SCANNER derives this set from the source (hook names, transform and
 * event-subscription sites); the test fails if the two disagree, so a wiring
 * point added to the V2 entry without an owner here is caught. An owner is
 * either the id of a {@link MECHANISMS} entry, or an `exempt:` note explaining
 * why that site is out of this table's scope.
 */
const REGISTRATION_OWNERS: Readonly<Record<string, string>> = {
  'hook:execute.before': 'zeus-read-guard (#264)',
  'hook:execute.after': 'formatter (#266)',
  'hook:evaluate': 'delegation-matrix (#264)',
  'hook:context': 'vision-history-sanitization (#266)',
  'hook:prompt': 'prompt-admission (vision prompt context)',
  'hook:compaction': 'compaction-context (#266)',
  'transform:agent':
    'exempt: Phase 1 agent transform; its reductions are already seeded (agent-transform, agent-model-overrides)',
  'transform:command':
    'exempt: Phase 1 command transform; its reduction is already seeded (command-transform)',
  'transform:reference': 'exempt: Phase 1 reference transform; static, no reduction',
  'transform:tool': 'exempt: tool registration, covered by the tool-transform runtime marker',
  'subscribe:event':
    'exempt: the event subscription itself; each handled event is a behaviour, not a registration',
}

/**
 * Extract the registration sites that actually execute — comment lines are
 * skipped, because the module documents `permission.hook('evaluate')` in prose
 * and a naive scan would count it twice.
 */
function scanV2Registrations(source: string): string[] {
  const found: string[] = []
  for (const line of source.split('\n')) {
    const code = line.trim()
    if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) continue
    const hook = /\.hook\(\s*'([^']+)'/.exec(line)
    if (hook?.[1] !== undefined) found.push(`hook:${hook[1]}`)
    for (const match of line.matchAll(/context\.(agent|command|reference)\.transform\(/g)) {
      if (match[1] !== undefined) found.push(`transform:${match[1]}`)
    }
    if (/toolCtx\.transform\(/.test(line)) found.push('transform:tool')
    if (/eventCtx\.subscribe!?\(/.test(line)) found.push('subscribe:event')
  }
  return found.sort()
}

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

  test('the mechanism table covers every registration site derived from the V2 source', () => {
    const derived = scanV2Registrations(V2_PLUGIN)
    const declared = Object.keys(REGISTRATION_OWNERS).sort()
    assert.deepEqual(
      derived,
      declared,
      'a wiring point was added to or removed from src/plugin-v2.ts without an owner in ' +
        'REGISTRATION_OWNERS — model the mechanism and update the seed, or record why it is exempt',
    )
    const mechanismIds = new Set(MECHANISMS.map((mechanism) => mechanism.id))
    for (const [registration, owner] of Object.entries(REGISTRATION_OWNERS)) {
      if (owner.startsWith('exempt: ')) continue
      assert.ok(
        mechanismIds.has(owner),
        `${registration} is owned by "${owner}", which is not a mechanism in this table`,
      )
    }
  })

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
