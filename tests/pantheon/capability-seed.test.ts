/**
 * Capability-seed truth tests (issue #267).
 *
 * The V2 seed (`src/pantheon/unsupported.mjs`) is what install and `doctor`
 * show a migrating user, and what the plugin itself appends to at runtime. It
 * had drifted: it listed only the adapter's scope choices while several V1
 * behaviours (Zeus read guard, idle continuation, compaction context, tool
 * ceiling, todo restore, delegation audit) were missing from the plugin surface with
 * no marker at all.
 *
 * This file enforces the property that fixes that drift. Since 2.0 the V1
 * plugin line is DELETED, so the "V1 source" half of the original check (every
 * mechanism was verified against src/plugin.ts / src/plugins/pantheon-hooks.ts)
 * is gone; the truth property that remains verifiable is between the V2 SOURCE
 * and the SEED:
 *
 *   ported      → the V2 source contains the mechanism, and the seed does NOT
 *                 claim it is missing.
 *   missing     → the V2 source does NOT contain the V1-style mechanism marker,
 *                 and the seed DOES declare the reduction (the mechanism existed
 *                 only on the removed V1 generation).
 *   conditional → the V2 source contains it, but it depends on a host API that
 *                 the measured host may not expose, so the seed still declares
 *                 the reduction.
 *
 * What is DERIVED and what is DECLARED, stated precisely (the earlier version of
 * this file overclaimed): the mechanism list is declared, because only a reader
 * can say whether two markers are the same behaviour. The set of REGISTRATION
 * SITES is derived from `src/plugin.ts` — every `ctx.<domain>.hook('<name>')`
 * and the event/tool subscriptions are extracted from the source and compared
 * with {@link V2_HOOK_OWNERS}. A new wiring point added to the V2 entry without
 * an owner here therefore fails, and so does removing one; a mechanism whose
 * BODY is broken while its call stays in place is not detectable by any text
 * scan, and this file does not claim otherwise (the behavioural suites cover
 * that).
 *
 * Run with: npx tsx tests/pantheon/capability-seed.test.ts
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { UNSUPPORTED_FEATURE_SEED } from '../../src/pantheon/unsupported.mjs'

const read = (relative: string): string =>
  readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

const PLUGIN_SOURCE = read('src/plugin.ts')
const SHELL_HOOKS_SOURCE = read('src/pantheon/shell-hooks.ts')

type State = 'ported' | 'missing' | 'conditional'

interface Mechanism {
  /** Stable name used in failure messages. */
  id: string
  state: State
  /** Marker in the plugin source (src/plugin.ts, or the file named by `markerSource`). */
  marker: RegExp
  markerSource?: string
  /** Seed entry that must exist for a 'missing'/'conditional' mechanism. */
  seed?: string
}

const MECHANISMS: readonly Mechanism[] = [
  {
    id: 'zeus-read-guard (#264)',
    state: 'ported',
    marker: /zeusReadGuard\(/,
  },
  {
    id: 'idle-dispatch (#265)',
    // CONDITIONAL, not ported: the call site exists, but it can only reach an
    // enforcer the measured host cannot construct (see the enforcer entry).
    // Marking this "ported" would claim idle continuation works on every V2
    // install, which is exactly the overstatement #267 exists to stop.
    state: 'conditional',
    marker: /todoEnforcer\.onIdle\(/,
    seed: 'idle-todo-enforcer',
  },
  {
    id: 'idle-todo-enforcer (#265)',
    state: 'conditional',
    // The V1 enforcer was constructed from `client.session`; V2 builds the same
    // class only when the host's session domain exposes the four methods.
    marker: /new TodoEnforcer\(/,
    seed: 'idle-todo-enforcer',
  },
  {
    id: 'compaction-context (#266)',
    state: 'ported',
    marker: /buildCompactionContext\(/,
  },
  {
    id: 'vision-history-sanitization (#266)',
    state: 'ported',
    marker: /sanitizeVisionHistory\(/,
  },
  {
    id: 'formatter (#266)',
    state: 'ported',
    marker: /FORMATTER_SCRIPT/,
    markerSource: SHELL_HOOKS_SOURCE,
  },
  {
    id: 'delegation-audit (#266)',
    state: 'ported',
    marker: /DELEGATION_START_SCRIPT/,
    markerSource: SHELL_HOOKS_SOURCE,
  },
  {
    id: 'delegation-matrix (#264)',
    state: 'ported',
    marker: /evaluateDelegation\(/,
  },
  {
    id: 'prompt-admission (vision prompt context)',
    state: 'ported',
    marker: /sessionCtx\.hook\('prompt'/,
  },
  {
    id: 'tool-ceiling (#266)',
    state: 'missing',
    marker: /handleToolCeilingEvent\(/,
    seed: 'tool-ceiling',
  },
  {
    id: 'todo-restore (#266)',
    state: 'missing',
    marker: /todoPreserver\.capture\(/,
    seed: 'todo-restore',
  },
  {
    id: 'board-transitions',
    state: 'missing',
    // The board INSTANCE is injected on V2; what is missing is a writer. The
    // terminal audit listener was the first of V1's four board writers.
    marker: /board\.onTerminal\(/,
    seed: 'board-transitions',
  },
]

/**
 * Every registration site in `src/plugin.ts`, mapped to its owner.
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
function scanRegistrations(source: string): string[] {
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

  const seed = new Set<string>(UNSUPPORTED_FEATURE_SEED)

  for (const mechanism of MECHANISMS) {
    test(`${mechanism.id} is ${mechanism.state} in source and seed`, () => {
      const markerSource = mechanism.markerSource ?? PLUGIN_SOURCE

      if (mechanism.state === 'ported') {
        assert.match(
          markerSource,
          mechanism.marker,
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
        // The marker is the V1-style wiring; if V2 ever grows it, the seed
        // entry must go and the mechanism must be declared ported.
        assert.doesNotMatch(
          markerSource,
          mechanism.marker,
          `${mechanism.id} is now implemented on V2; drop "${mechanism.seed}" from the seed ` +
            'and declare the mechanism ported in this table',
        )
      } else {
        // conditional: present, but gated on a host API the measured host does
        // not expose.
        assert.match(
          markerSource,
          mechanism.marker,
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
    const derived = scanRegistrations(PLUGIN_SOURCE)
    const declared = Object.keys(REGISTRATION_OWNERS).sort()
    assert.deepEqual(
      derived,
      declared,
      'a wiring point was added to or removed from src/plugin.ts without an owner in ' +
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
    for (const entry of UNSUPPORTED_FEATURE_SEED) {
      assert.ok(
        modelled.has(entry) || SEED_ENTRIES_OUTSIDE_THE_TABLE.has(entry),
        `the seed grew a "${entry}" entry that this table does not explain — ` +
          'either model the mechanism above or exempt the entry with a reason',
      )
    }
  })

  test('the seed is not frozen twice: the plugin copies it into its live list', () => {
    assert.ok(Object.isFrozen(UNSUPPORTED_FEATURE_SEED), 'the seed must stay frozen')
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
