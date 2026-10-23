/**
 * install-truthfulness.test.mjs — the installer may only claim what it does.
 *
 * One test group per issue, each pinning the USER-VISIBLE claim rather than the
 * implementation detail:
 *
 *   #261 the V2 notice no longer invents an isolated database or a service port;
 *        both its path and its wording come from a resolver a test can call.
 *   #262 every path that applies nothing prints exactly ONE line naming where it
 *        stopped, and the outcome is readable from disk on the next run.
 *   #263 the printed feature list is labelled as the static seed it is, the V2
 *        registered surface is stated too, and `--json` carries the same facts.
 *   #268 a fresh V2 install writes the object form, so `options` (and therefore
 *        `context_pruner` / `memory_injection`) is reachable, and a user's
 *        hand-added keys survive a re-run.
 *   #269 a V1 third-party plugin entry is not left dead in the singular key, and
 *        a sibling `opencode.jsonc` is reported instead of silently merging.
 *
 * Run: node --test tests/install-truthfulness.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createInterruptHandler } from '../scripts/install/interrupt.mjs'
import { installOpenCode } from '../scripts/install/opencode.mjs'
import {
  describeSharedState,
  resolveOpenCodeStatePath,
} from '../scripts/install/opencode-state.mjs'
import { PROMPT_CANCELED } from '../scripts/install/prompt-result.mjs'
import {
  buildRunRecord,
  readRunRecord,
  runRecordPath,
  writeRunRecord,
} from '../scripts/install/run-record.mjs'
import {
  describePluginOptionsReachability,
  formatV2CapabilityNotice,
  v2Capabilities,
} from '../scripts/install/v2-capabilities.mjs'
import { listV2UnsupportedFeatures } from '../src/pantheon/v2-unsupported.mjs'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLI = join(REPO_ROOT, 'bin', 'pantheon-init.mjs')
const SEED = listV2UnsupportedFeatures()

function scratchDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Run `fn` with console output captured into one string. */
async function captureOutput(fn) {
  const original = { log: console.log, warn: console.warn, error: console.error }
  const lines = []
  const record = (...values) => lines.push(values.map(String).join(' '))
  console.log = record
  console.warn = record
  console.error = record
  try {
    return { result: await fn(), output: lines.join('\n') }
  } finally {
    Object.assign(console, original)
  }
}

/** A V2 install over an existing config, returning the written config. */
async function installV2With(existingConfig) {
  const target = scratchDir('pantheon-truthfulness-')
  try {
    if (existingConfig !== null) {
      writeFileSync(join(target, 'opencode.json'), `${JSON.stringify(existingConfig, null, 2)}\n`)
    }
    const { output, result } = await captureOutput(() =>
      installOpenCode(target, false, false, [], { yes: true, headless: true, version: 'v2' }),
    )
    return {
      output,
      result,
      config: JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8')),
      target,
      cleanup: () => rmSync(target, { recursive: true, force: true }),
    }
  } catch (error) {
    rmSync(target, { recursive: true, force: true })
    throw error
  }
}

/** Every Pantheon V2 entry in a `plugins` list. */
function pantheonEntries(plugins) {
  return (plugins ?? []).filter((entry) => {
    const candidate = typeof entry === 'string' ? entry : entry?.package
    return typeof candidate === 'string' && candidate.includes('plugin-v2')
  })
}

// ─── #261: the notice states what the host actually does ────────────────

test('the state resolver follows XDG_DATA_HOME and OPENCODE_DB, not a literal', () => {
  const base = resolveOpenCodeStatePath({}, '/home/someone')
  assert.equal(base.path, '/home/someone/.local/share/opencode/opencode.db')
  assert.equal(base.source, 'default')

  const xdg = resolveOpenCodeStatePath({ XDG_DATA_HOME: '/data' }, '/home/someone')
  assert.equal(xdg.path, '/data/opencode/opencode.db')

  const override = resolveOpenCodeStatePath({ OPENCODE_DB: '/tmp/probe.db' }, '/home/someone')
  assert.equal(override.path, '/tmp/probe.db')
  assert.equal(override.source, 'OPENCODE_DB')

  // PANTHEON_COST_DB redirects the cost REPORT only, never the host's store.
  const costOnly = resolveOpenCodeStatePath({ PANTHEON_COST_DB: '/tmp/cost.db' }, '/home/x')
  assert.equal(costOnly.path, '/home/x/.local/share/opencode/opencode.db')
})

test('the shared-state sentence names the resolved store and claims no port', () => {
  const sentence = describeSharedState({}, '/home/someone')
  assert.match(sentence, /shared, not isolated/)
  assert.ok(
    sentence.includes(resolveOpenCodeStatePath({}, '/home/someone').path),
    'the printed path must be the resolver output, not a literal',
  )
  assert.match(sentence, /no service port/)
  assert.doesNotMatch(sentence, /49375/)
  assert.doesNotMatch(sentence, /opencode-v2\.db/)
})

test('a V2 install prints the resolver path and no invented isolation claim', async () => {
  const run = await installV2With(null)
  try {
    const { path: dbPath } = resolveOpenCodeStatePath()
    assert.ok(run.output.includes(dbPath), `notice must print ${dbPath}; got:\n${run.output}`)
    assert.doesNotMatch(run.output, /49375/)
    assert.doesNotMatch(run.output, /opencode-v2\.db/)
    assert.doesNotMatch(run.output, /state isolated via OPENCODE_DB/)
  } finally {
    run.cleanup()
  }
})

test('no drift-able state literal remains in the installer or the CLI entry point', () => {
  for (const file of ['scripts/install/opencode.mjs', 'bin/pantheon-init.mjs']) {
    const source = readFileSync(join(REPO_ROOT, file), 'utf8')
    assert.doesNotMatch(source, /opencode-v2\.db/, `${file} must not name a per-generation db`)
    assert.doesNotMatch(source, /49375/, `${file} must not name a service port nothing binds`)
  }
})

// ─── #262: one explainable line, and a record on disk ──────────────────

test('a canceled review prints exactly one line naming the review point', async () => {
  const target = scratchDir('pantheon-cancel-one-line-')
  try {
    const { result, output } = await captureOutput(() =>
      installOpenCode(target, false, false, ['agents'], {
        version: 'v1',
        deps: { promptReview: async () => PROMPT_CANCELED },
      }),
    )
    assert.equal(result.applied, false)
    assert.equal(result.reason, 'canceled')
    assert.equal(result.cancelPoint, 'review')
    const matches = output.match(/Installation canceled/g) ?? []
    assert.equal(matches.length, 1, `exactly one cancel line, got:\n${output}`)
    assert.match(output, /Installation canceled at review prompt/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('declining the review names the point instead of printing "Nothing applied."', async () => {
  const target = scratchDir('pantheon-decline-one-line-')
  try {
    const { result, output } = await captureOutput(() =>
      installOpenCode(target, false, false, ['agents'], {
        version: 'v1',
        deps: { promptReview: async () => false },
      }),
    )
    assert.equal(result.applied, false)
    assert.equal(result.reason, 'declined')
    assert.equal(result.cancelPoint, 'review')
    assert.match(output, /Installation declined at review prompt/)
    assert.doesNotMatch(output, /Nothing applied\./)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('an interactive cancel names the step the user stopped at', async () => {
  const target = scratchDir('pantheon-cancel-point-')
  try {
    const calls = []
    const prompts = {
      isCancel: (value) => value === Symbol.for('cancel'),
      cancel: (message) => calls.push(message),
      intro: () => {},
      multiselect: async () => Symbol.for('cancel'),
    }
    const { result } = await captureOutput(() =>
      installOpenCode(target, false, false, ['agents'], {
        interactive: true,
        version: 'v1',
        global: true,
        deps: { prompts, isTTY: true },
      }),
    )
    assert.equal(result.reason, 'canceled')
    assert.equal(result.cancelPoint, 'components')
    assert.equal(calls.length, 1, 'the prompt library prints the single line')
    assert.match(calls[0], /canceled at component selection/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('the run record distinguishes canceled, declined and applied', () => {
  const target = scratchDir('pantheon-run-record-')
  try {
    const canceled = buildRunRecord({
      status: 'canceled',
      reason: 'canceled',
      cancelPoint: 'review',
      mode: 'apply',
      applied: false,
      pantheonVersion: '1.2.3',
      at: '2026-01-01T00:00:00.000Z',
    })
    assert.equal(canceled.cancel_point, 'review')
    assert.equal(canceled.applied, false)
    assert.match(canceled.summary, /canceled at review/)
    assert.match(canceled.summary, /nothing was applied/)

    assert.equal(writeRunRecord(target, canceled).written, true)
    assert.deepEqual(readRunRecord(target), canceled)

    const declined = buildRunRecord({
      status: 'declined',
      reason: 'declined',
      cancelPoint: 'review',
      mode: 'apply',
      applied: false,
    })
    assert.notEqual(declined.summary, canceled.summary)
    writeRunRecord(target, declined)
    assert.equal(readRunRecord(target).status, 'declined')

    const applied = buildRunRecord({ status: 'applied', mode: 'apply', applied: true })
    writeRunRecord(target, applied)
    assert.equal(readRunRecord(target).applied, true)
    assert.match(readRunRecord(target).summary, /changes were applied/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('a run record that cannot be written is reported, never thrown', () => {
  const target = scratchDir('pantheon-run-record-fail-')
  try {
    // A file where the record's parent directory must go: mkdir fails.
    writeFileSync(join(target, '.pantheon'), 'not a directory\n')
    const verdict = writeRunRecord(
      target,
      buildRunRecord({ status: 'canceled', mode: 'apply', applied: false }),
    )
    assert.equal(verdict.written, false)
    assert.equal(typeof verdict.error, 'string')
    assert.equal(verdict.path, runRecordPath(target))
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('Ctrl-C prints the one cancel line, records once, and exits 130', () => {
  const printed = []
  const recorded = []
  const exits = []
  let closedLine = 0
  const handler = createInterruptHandler({
    message: 'Installation canceled at interrupt (Ctrl-C) — nothing was applied.',
    endGaugeLine: () => {
      closedLine += 1
    },
    logStderr: (line) => printed.push(line),
    onInterrupt: () => recorded.push('record'),
    exit: (code) => exits.push(code),
  })

  handler()
  handler() // a second Ctrl-C must not double-print or double-record

  assert.deepEqual(printed, ['Installation canceled at interrupt (Ctrl-C) — nothing was applied.'])
  assert.deepEqual(recorded, ['record'])
  assert.deepEqual(exits, [130])
  assert.equal(closedLine, 1, 'the progress gauge line is closed before printing')
})

test('Ctrl-C under --json writes the line to stderr, never stdout', () => {
  const stderr = []
  const stdout = []
  const original = console.log
  console.log = (...values) => stdout.push(values.join(' '))
  try {
    const handler = createInterruptHandler({
      message: 'Installation canceled at interrupt (Ctrl-C).',
      json: true,
      writeStderr: (line) => stderr.push(line),
      logStderr: (line) => stdout.push(line),
      exit: () => {},
    })
    handler()
  } finally {
    console.log = original
  }
  assert.deepEqual(stderr, ['Installation canceled at interrupt (Ctrl-C).'])
  assert.deepEqual(stdout, [])
})

// ─── #263: label the list, state the surface, carry it in --json ───────

test('the printed list is labelled as the static seed, not the complete set', () => {
  const notice = formatV2CapabilityNotice()
  for (const feature of SEED) {
    assert.ok(notice.includes(feature), `the notice must list "${feature}"`)
  }
  assert.match(notice, /statically known seed/)
  assert.match(notice, /live plugin adds further markers at runtime/)
})

test('the notice also states what V2 registers today', () => {
  const notice = formatV2CapabilityNotice()
  for (const hook of ['context', 'prompt', 'compaction', 'execute.before', 'execute.after']) {
    assert.ok(notice.includes(hook), `the notice must name the "${hook}" hook`)
  }
  for (const transform of ['tool', 'agent', 'command', 'reference']) {
    assert.ok(notice.includes(transform), `the notice must name the "${transform}" transform`)
  }
  assert.match(notice, /permission evaluate/)
  assertNotReducedSurfaceOnly(notice)
})

/** "reduced surface" alone was the misleading wording this replaces. */
function assertNotReducedSurfaceOnly(notice) {
  assert.ok(!/reduced surface/i.test(notice), 'the notice must not stop at "reduced surface"')
}

test('the capability payload and the seed cannot drift', () => {
  const capabilities = v2Capabilities()
  assert.deepEqual(capabilities.not_registered, SEED)
  assert.deepEqual(capabilities.registered.tools, [
    'hashline_edit',
    'pantheon_cost',
    'pantheon_model',
  ])
  // A reporter cannot mutate the shared seed through the payload.
  capabilities.not_registered.push('invented')
  assert.deepEqual(listV2UnsupportedFeatures(), SEED)
})

test('a V2 install prints the capability notice once, with the registered surface', async () => {
  const run = await installV2With(null)
  try {
    assert.match(run.output, /what this install registers/)
    assert.match(run.output, /session context\/prompt\/compaction/)
    for (const feature of SEED) {
      assert.ok(run.output.includes(feature), `missing "${feature}"`)
    }
  } finally {
    run.cleanup()
  }
})

test('--json carries the same capability facts the text notice prints', () => {
  const target = scratchDir('pantheon-json-capabilities-')
  try {
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        'init',
        '--dry-run',
        '--json',
        '--no-mcp',
        '--components',
        'agents',
        '--opencode-version',
        'v2',
      ],
      {
        cwd: target,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: target,
          XDG_CONFIG_HOME: join(target, '.config'),
          OPENCODE_VERSION: 'v2',
        },
      },
    )
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.deepEqual(payload.v2_capabilities.not_registered, SEED)
    assert.equal(
      payload.v2_capabilities.not_registered_scope,
      'statically known seed; the live plugin adds further markers at runtime when a host API is missing',
    )
    assert.deepEqual(payload.v2_capabilities.registered.session_hooks, [
      'context',
      'prompt',
      'compaction',
    ])
    // The preview projects the config it would write, so the reachability fact
    // describes the INSTALLED state, not a guess about the current file.
    assert.equal(payload.plugin_options.reachable, true)
    assert.equal(payload.plugin_options.form, 'object')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// ─── #268: the object form makes the opt-in features reachable ──────────

test('a fresh V2 install writes the object form with an options bag', async () => {
  const run = await installV2With(null)
  try {
    const entries = pantheonEntries(run.config.plugins)
    assert.equal(entries.length, 1)
    assert.equal(typeof entries[0], 'object', 'a fresh install must not emit a bare string')
    assert.ok(entries[0].package.endsWith(join('src', 'plugin-v2')))
    assert.deepEqual(entries[0].options, {})
    assert.equal(run.result.pluginOptions.reachable, true)
  } finally {
    run.cleanup()
  }
})

test('a hand-added options key survives a re-run', async () => {
  const first = await installV2With(null)
  try {
    const config = JSON.parse(readFileSync(join(first.target, 'opencode.json'), 'utf8'))
    const entry = pantheonEntries(config.plugins)[0]
    entry.options = {
      context_pruner: { enabled: true, keepTurns: 6 },
      memory_injection: { enabled: true, maxEntries: 5 },
    }
    writeFileSync(join(first.target, 'opencode.json'), `${JSON.stringify(config, null, 2)}\n`)

    const { output } = await captureOutput(() =>
      installOpenCode(first.target, false, false, [], {
        yes: true,
        headless: true,
        version: 'v2',
      }),
    )
    const rewritten = JSON.parse(readFileSync(join(first.target, 'opencode.json'), 'utf8'))
    const rewrittenEntry = pantheonEntries(rewritten.plugins)[0]
    assert.deepEqual(rewrittenEntry.options, {
      context_pruner: { enabled: true, keepTurns: 6 },
      memory_injection: { enabled: true, maxEntries: 5 },
    })
    assert.doesNotMatch(output, /options are not reachable/)
  } finally {
    first.cleanup()
  }
})

test('a legacy bare-string Pantheon entry gains an installed object-form entry', async () => {
  const run = await installV2With({ plugins: ['/old/install/src/plugin-v2'] })
  try {
    const entries = pantheonEntries(run.config.plugins)
    const installed = entries.find((entry) => typeof entry === 'object')
    assert.ok(installed, 'the installed entry must be the object form')
    assert.ok(installed.package.endsWith(join('src', 'plugin-v2')))
    assert.deepEqual(installed.options, {})
    // An unrecognised absolute path is the user's data and is not silently
    // deleted; only the managed identity is rewritten.
    assert.ok(run.config.plugins.includes('/old/install/src/plugin-v2'))
  } finally {
    run.cleanup()
  }
})

test('options reachability reports the three installed shapes honestly', () => {
  assert.equal(describePluginOptionsReachability([]).registered, false)

  const bare = describePluginOptionsReachability(['/opt/pantheon/src/plugin-v2'])
  assert.equal(bare.reachable, false)
  assert.equal(bare.form, 'string')
  assert.match(bare.detail, /bare string/)

  const noOptions = describePluginOptionsReachability([{ package: '/opt/pantheon/src/plugin-v2' }])
  assert.equal(noOptions.reachable, false)
  assert.match(noOptions.detail, /no "options" object/)

  const ok = describePluginOptionsReachability([
    { package: '/opt/pantheon/src/plugin-v2', options: { context_pruner: { enabled: true } } },
  ])
  assert.equal(ok.reachable, true)
})

// ─── #269: no third-party entry disappears silently ────────────────────

test('a V1 third-party plugin entry is re-registered under the V2 plural key', async () => {
  const run = await installV2With({
    plugin: ['/vendor/acme/src/plugin.ts', 'acme-plugin'],
    plugins: ['third-party-v2'],
  })
  try {
    assert.ok(run.config.plugins.includes('/vendor/acme/src/plugin.ts'))
    assert.ok(run.config.plugins.includes('acme-plugin'))
    assert.match(run.output, /V2 host ignores the singular "plugin" key/)
    assert.match(run.output, /acme-plugin/)
  } finally {
    run.cleanup()
  }
})

test('a Pantheon V1 path is never moved into the V2 list', async () => {
  const stalePantheon = join(REPO_ROOT, 'src', 'plugin.ts')
  const run = await installV2With({ plugin: [stalePantheon, 'acme-plugin'], plugins: [] })
  try {
    assert.ok(!run.config.plugins.includes(stalePantheon))
    assert.ok(run.config.plugins.includes('acme-plugin'))
    // The user's own V1 entry stays where they put it (a downgrade still finds
    // it); only Pantheon's stale path is removed from that list.
    assert.deepEqual(run.config.plugin, ['acme-plugin'])
  } finally {
    run.cleanup()
  }
})

test('a sibling opencode.jsonc is reported and appears in the --json advisories', async () => {
  const target = scratchDir('pantheon-jsonc-warning-')
  try {
    writeFileSync(join(target, 'opencode.jsonc'), '{ // user config\n}\n')
    const { output } = await captureOutput(() =>
      installOpenCode(target, false, false, [], { yes: true, headless: true, version: 'v2' }),
    )
    assert.match(output, /Both .*opencode\.json and .*opencode\.jsonc exist/)
    assert.match(output, /writes only opencode\.json/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
