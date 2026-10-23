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
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createInterruptHandler } from '../scripts/install/interrupt.mjs'
import { installOpenCode, v2PluginEntryLoadability } from '../scripts/install/opencode.mjs'
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
const HAS_SCRIPT = spawnSync('script', ['--version'], { encoding: 'utf8' }).status === 0

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1
}

/** A minimal EventEmitter stand-in for the interrupt handler's lifetime. */
function fakeEmitter() {
  const listeners = new Map()
  return {
    once(event, listener) {
      listeners.set(event, listener)
    },
    removeListener(event, listener) {
      if (listeners.get(event) === listener) listeners.delete(event)
    },
    emit(event) {
      const listener = listeners.get(event)
      if (listener === undefined) return
      listeners.delete(event)
      listener()
    },
    has(event) {
      return listeners.has(event)
    },
  }
}

/** Sandboxed env for a spawned CLI run: never the real HOME/config. */
function sandboxEnv(home, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    ...extra,
  }
}

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
async function installV2With(existingConfig, prepare = () => {}) {
  const target = scratchDir('pantheon-truthfulness-')
  try {
    prepare(target)
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

test('a cancel after choosing the project target reports THAT target, not the global one', async () => {
  // The review finding: the confirmation cancel returned no target, so the run
  // record landed in ~/.config/opencode while the message claimed nothing was
  // written — even when the user had picked "Current project".
  const prompts = {
    isCancel: () => false,
    cancel: () => {},
    intro: () => {},
    multiselect: async () => ['agents'],
    select: async () => 'project',
    confirm: async () => false,
  }
  const { result } = await captureOutput(() =>
    installOpenCode(undefined, false, false, ['agents'], {
      interactive: true,
      version: 'v1',
      deps: { prompts, isTTY: true },
    }),
  )
  assert.equal(result.reason, 'canceled')
  assert.equal(result.cancelPoint, 'confirmation')
  assert.equal(result.applied, false)
  assert.equal(result.target, process.cwd(), 'the chosen project directory must be recorded')
  assert.notEqual(result.target, join(process.env.HOME ?? '', '.config', 'opencode'))
})

test('a cancel before the location prompt reports the resolved default target', async () => {
  const prompts = {
    isCancel: () => false,
    cancel: () => {},
    intro: () => {},
    multiselect: async () => ['agents'],
    select: async () => 'global',
    confirm: async () => false,
  }
  const { result } = await captureOutput(() =>
    installOpenCode('/tmp/pantheon-cancel-target-probe', false, false, ['agents'], {
      interactive: true,
      version: 'v1',
      global: true,
      deps: { prompts, isTTY: true },
    }),
  )
  assert.equal(result.reason, 'canceled')
  assert.equal(result.target, '/tmp/pantheon-cancel-target-probe')
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
  const emitter = fakeEmitter()
  const handler = createInterruptHandler({
    message: 'Installation canceled at interrupt (Ctrl-C) — nothing was applied.',
    endGaugeLine: () => {
      closedLine += 1
    },
    logStderr: (line) => printed.push(line),
    onInterrupt: () => recorded.push('record'),
    exit: (code) => exits.push(code),
    emitter,
  })

  assert.equal(emitter.has('SIGINT'), true, 'the handler registers itself')
  handler()
  handler() // a second Ctrl-C must not double-print or double-record

  assert.deepEqual(printed, ['Installation canceled at interrupt (Ctrl-C) — nothing was applied.'])
  assert.deepEqual(recorded, ['record'])
  assert.deepEqual(exits, [130])
  assert.equal(closedLine, 1, 'the progress gauge line is closed before printing')
})

test('Ctrl-C under --json writes the line to stderr and never to stdout', () => {
  const stderr = []
  const stdout = []
  const original = console.log
  console.log = (...values) => stdout.push(values.join(' '))
  try {
    const emitter = fakeEmitter()
    createInterruptHandler({
      message: 'Installation canceled at interrupt (Ctrl-C).',
      json: true,
      writeStderr: (line) => stderr.push(line),
      // If the JSON branch ever fell back to logStderr, this records the
      // mistake instead of silently producing an "empty stdout" pass.
      logStderr: (line) => stdout.push(line),
      exit: () => {},
      emitter,
    })
    emitter.emit('SIGINT')
  } finally {
    console.log = original
  }
  assert.deepEqual(stderr, ['Installation canceled at interrupt (Ctrl-C).'])
  assert.deepEqual(stdout, [], 'the line must not reach stdout through any fallback')
})

test('a deactivated handler ignores SIGINT so it cannot rewrite a finished run', () => {
  const printed = []
  const recorded = []
  const exits = []
  const emitter = fakeEmitter()
  const handler = createInterruptHandler({
    message: 'Installation canceled at interrupt (Ctrl-C).',
    logStderr: (line) => printed.push(line),
    onInterrupt: () => recorded.push('record'),
    exit: (code) => exits.push(code),
    emitter,
  })

  handler.deactivate()
  assert.equal(emitter.has('SIGINT'), false, 'the listener is removed, not just flagged')
  emitter.emit('SIGINT')

  assert.deepEqual(printed, [])
  assert.deepEqual(recorded, [])
  assert.deepEqual(exits, [], 'a completed install must not be rewritten as canceled')
})

test('a real SIGINT during an interactive install exits 130 with one message', {
  skip: !HAS_SCRIPT ? 'requires the `script` binary for a TTY' : false,
}, async () => {
  // A REAL child, a REAL signal, and a deterministic window: the child is
  // parked on an interactive prompt (which awaits), so the signal cannot race
  // the install. The prompt runs AFTER the handler is registered.
  const root = scratchDir('pantheon-sigint-real-')
  const home = join(root, 'home')
  const project = join(root, 'project')
  const pidFile = join(root, 'child.pid')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  try {
    const scriptCmd =
      `exec sh -c 'echo $$ > ${pidFile}; exec ${process.execPath} ${CLI} ` +
      "init --interactive --project --no-mcp --components agents --opencode-version v1'"
    const child = spawn('script', ['-q', '-e', '-c', scriptCmd, '/dev/null'], {
      cwd: project,
      env: sandboxEnv(home, { OPENCODE_VERSION: 'v1' }),
    })
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      out += chunk
    })

    // Wait for the child PID file, then give the prompt time to render. The
    // prompt waits for input forever, so there is no upper race.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const childPid = Number(readFileSync(pidFile, 'utf8').trim())
    process.kill(childPid, 'SIGINT')

    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })

    assert.equal(code, 130, `Ctrl-C must exit 130; output:\n${out}`)
    // The pty renders one byte per line in places; flatten before counting.
    const flat = out.replace(/\r\n/g, '')
    assert.equal(
      countOccurrences(flat, 'Installation canceled at interrupt (Ctrl-C)'),
      1,
      `exactly one cancel line; output:\n${flat}`,
    )
    const record = readRunRecord(project)
    assert.equal(record?.status, 'canceled')
    assert.equal(record?.cancel_point, 'interrupt')
    assert.equal(record?.applied, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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

test('a V2 install prints the capability notice exactly once', async () => {
  const run = await installV2With(null)
  try {
    assert.equal(
      countOccurrences(run.output, 'what this install registers'),
      1,
      `the registered-surface notice must appear once:\n${run.output}`,
    )
    assert.equal(countOccurrences(run.output, 'OpenCode V2 target'), 1)
    assert.match(run.output, /session context\/prompt\/compaction/)
    for (const feature of SEED) {
      assert.ok(run.output.includes(feature), `missing "${feature}"`)
    }
  } finally {
    run.cleanup()
  }
})

test('an unauthorized V2 preview prints each notice exactly once (not twice)', () => {
  // Reproduces the review finding: the gate's internal plan pass and the outer
  // run share one output channel, so an ungated notice printed twice on
  // `init` without --yes (exit 2, plan printed, nothing applied).
  const home = scratchDir('pantheon-unauthorized-notice-')
  const project = join(home, 'project')
  mkdirSync(project, { recursive: true })
  try {
    const result = spawnSync(
      process.execPath,
      [CLI, 'init', '--project', '--no-mcp', '--components', 'agents', '--opencode-version', 'v2'],
      {
        cwd: project,
        encoding: 'utf8',
        env: sandboxEnv(home, { OPENCODE_VERSION: 'v2' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const output = `${result.stdout}\n${result.stderr}`
    assert.equal(result.status, 2, `apply-without-authorization must exit 2:\n${output}`)
    assert.equal(
      countOccurrences(output, 'OpenCode V2 target'),
      1,
      `the state notice must appear once:\n${output}`,
    )
    assert.equal(
      countOccurrences(output, 'what this install registers'),
      1,
      `the capability notice must appear once:\n${output}`,
    )
    assert.match(output, /re-run with --yes/i)
  } finally {
    rmSync(home, { recursive: true, force: true })
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

test('v2PluginEntryLoadability accepts only an existing directory', () => {
  const dir = scratchDir('pantheon-loadability-')
  try {
    const pluginDir = join(dir, 'vendor', 'acme-plugin')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'index.ts'), 'export default {}\n')
    const pluginFile = join(dir, 'vendor', 'single-file.ts')
    writeFileSync(pluginFile, 'export default {}\n')

    assert.deepEqual(v2PluginEntryLoadability('./vendor/acme-plugin', dir), {
      loadable: true,
      reason: 'directory',
      resolved: pluginDir,
    })
    assert.equal(v2PluginEntryLoadability('./vendor/single-file.ts', dir).reason, 'file')
    assert.equal(v2PluginEntryLoadability('./vendor/missing', dir).reason, 'missing')
    assert.equal(v2PluginEntryLoadability('acme-plugin', dir).reason, 'npm-spec')
    assert.equal(v2PluginEntryLoadability('@scope/acme', dir).reason, 'npm-spec')
    assert.equal(v2PluginEntryLoadability('npm:@scope/acme', dir).reason, 'npm-spec')
    assert.equal(v2PluginEntryLoadability({ package: 'acme' }, dir).reason, 'unverifiable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('only a loadable third-party directory moves into the V2 plural key', async () => {
  const run = await installV2With(
    {
      plugin: ['./vendor/acme-plugin', 'acme-plugin', './vendor/missing-plugin'],
      plugins: ['third-party-v2'],
    },
    (target) => {
      mkdirSync(join(target, 'vendor', 'acme-plugin'), { recursive: true })
      writeFileSync(join(target, 'vendor', 'acme-plugin', 'index.ts'), 'export default {}\n')
    },
  )
  try {
    // The directory the V2 loader can actually load is re-registered…
    assert.deepEqual(run.config.plugins.slice(0, 2), ['third-party-v2', './vendor/acme-plugin'])
    assert.equal(pantheonEntries(run.config.plugins).length, 1)
    // …the V1 list itself is the user's data and is left intact, so a downgrade
    // still finds every entry; the two the host cannot load are never copied.
    assert.deepEqual(run.config.plugin, [
      './vendor/acme-plugin',
      'acme-plugin',
      './vendor/missing-plugin',
    ])
    // …and the warning names each entry with its exact failure mode.
    assert.match(run.output, /also registered 1 third-party entry under "plugins"/)
    assert.match(run.output, /acme-plugin is a package\/GitHub shorthand/)
    assert.match(run.output, /NpmInstallFailedError/)
    assert.match(run.output, /\.\/vendor\/missing-plugin does not exist/)
    assert.match(run.output, /must be a directory|only accepts an existing directory/)
  } finally {
    run.cleanup()
  }
})

test('a Pantheon V1 path is never moved into the V2 list', async () => {
  const stalePantheon = join(REPO_ROOT, 'src', 'plugin.ts')
  const run = await installV2With({ plugin: [stalePantheon, 'acme-plugin'], plugins: [] })
  try {
    assert.ok(!run.config.plugins.includes(stalePantheon))
    assert.ok(!run.config.plugins.includes('acme-plugin'))
    // The user's own V1 entry stays where they put it (a downgrade still finds
    // it); only Pantheon's stale path is removed from that list.
    assert.deepEqual(run.config.plugin, ['acme-plugin'])
  } finally {
    run.cleanup()
  }
})

test('a provable relocated Pantheon install is retired, not registered twice', async () => {
  // `managedPluginIdentity` recognizes a V2 entry inside any
  // node_modules/pantheon-opencode copy, so the stale one is provably Pantheon:
  // keeping both would run every hook twice.
  const relocated = '/old/prefix/node_modules/pantheon-opencode/src/plugin-v2'
  const run = await installV2With({ plugins: [relocated] })
  try {
    const entries = pantheonEntries(run.config.plugins)
    assert.equal(entries.length, 1, 'exactly one Pantheon V2 entry may remain')
    assert.equal(typeof entries[0], 'object')
    assert.ok(entries[0].package.endsWith(join('src', 'plugin-v2')))
    assert.ok(!run.config.plugins.includes(relocated), 'the stale copy is retired')
    assert.doesNotMatch(run.output, /another copy of the Pantheon V2 plugin/)
  } finally {
    run.cleanup()
  }
})

test('a Pantheon-lookalike this installer cannot prove it owns is kept and reported', async () => {
  // Outside node_modules/pantheon-opencode the path is indistinguishable from a
  // third-party plugin that happens to share the name. Deleting it would be
  // destructive, so it stays — and the double-registration risk is announced.
  const lookalike = '/old/install/src/plugin-v2'
  const run = await installV2With({ plugins: [lookalike] })
  try {
    assert.ok(run.config.plugins.includes(lookalike))
    assert.equal(pantheonEntries(run.config.plugins).length, 2)
    assert.match(run.output, /another copy of the Pantheon V2 plugin/)
    assert.match(run.output, /hooks would run twice/)
  } finally {
    run.cleanup()
  }
})

test('a sibling opencode.jsonc is reported in the --json advisories', () => {
  const root = scratchDir('pantheon-jsonc-json-')
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'opencode.jsonc'), '{ // user config\n}\n')
  try {
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        'init',
        '--dry-run',
        '--json',
        '--project',
        '--no-mcp',
        '--components',
        'agents',
        '--opencode-version',
        'v2',
      ],
      {
        cwd: project,
        encoding: 'utf8',
        env: sandboxEnv(root, { OPENCODE_VERSION: 'v2' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    const jsoncAdvisory = payload.advisories.find((entry) => entry.includes('opencode.jsonc'))
    assert.ok(jsoncAdvisory, `--json must carry the .jsonc advisory; got ${payload.advisories}`)
    assert.match(jsoncAdvisory, /writes only opencode\.json/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
