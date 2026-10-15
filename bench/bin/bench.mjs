#!/usr/bin/env node
/**
 * bench/bin/bench.mjs — non-interactive latency baseline runner for the
 * beta-10 latency slice (Phase 0).
 *
 * WHAT IT DOES
 *   Runs the installed `opencode` CLI headlessly (`opencode run --format json
 *   --standalone`) N times per scenario, interleaved (A,B,A,B,…), one fresh
 *   sandbox directory and one private opencode.db per run, with the REPO's V2
 *   plugin (src/plugin-v2) forced via OPENCODE_CONFIG_CONTENT. After each run
 *   it reads the run's db STRICTLY READ-ONLY (same ledger as pantheon_cost)
 *   and the run's .pantheon/logs/hooks.log, aggregates tokens over the root +
 *   child sessions without double counting, and writes
 *   bench/results/baseline-<git-sha>.json after a secret scan.
 *
 * PROTOCOL (fixed; constants, no config system — YAGNI)
 *   - RUNS_PER_SCENARIO = 5, interleave A,B starting at A, same day
 *   - per-run timeout RUN_TIMEOUT_MS; a timeout is a RECORDED FAILURE, never
 *     a completed run
 *   - model pinned via BENCH_MODEL env (default below) and recorded from the
 *     db session row as ground truth
 *   - scenario A uses real web research; network variance is accepted and
 *     visible in the per-run records (controlled replay is a later phase —
 *     the per-run sandbox directories are kept under /tmp/opencode for it)
 *
 * FIDELITY (D4) — every run records, read from the db, the identity of the
 * instruction files the session actually loaded (instruction_state +
 * instruction_blob): per-file path, byte length and sha256. A claim can only
 * rest on a run whose provenance shows the intended global AND project
 * artifacts were loaded.
 *
 * PROFILES — stated, never inferred (see bench/lib/args.mjs):
 *   host              host global AGENTS.md only (run dirs empty)
 *   double-injection  host (or --global-agents) + --project-agents written into
 *                     every run directory — the profile the carve acts on
 *
 * Usage: node bench/bin/bench.mjs [--runs 5] [--scenarios A,B]
 *          [--profile host|double-injection] [--label <name>]
 *          [--global-agents <path>] [--project-agents <path>]
 *
 * @module bench/bin/bench
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, version as nodeVersion, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { agentFixtureIdentity, contentDirectoryIdentity } from '../lib/agent-fixture.mjs'
import { runIsCompleted, summarizeRuns } from '../lib/aggregate.mjs'
import { parseBenchArgs, UsageError } from '../lib/args.mjs'
import {
  collectFirstRequest,
  collectInstructionState,
  collectRunMetrics,
  openReadOnly,
} from '../lib/collector.mjs'
import { parseBenchHookLines, summarizeHookTimings } from '../lib/hooklog.mjs'
import { assessPairedRun, summarizePairedRunsByArm } from '../lib/paired-acceptance.mjs'
import { assertNoSecrets } from '../lib/redact.mjs'
import { buildRunPlan } from '../lib/run-plan.mjs'
import { resolveBenchEnv, runOnce } from '../lib/runner.mjs'

// ─── fixed protocol constants ────────────────────────────────────────────

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const RESULTS_DIR = join(REPO_ROOT, 'bench', 'results')
const RUN_TIMEOUT_MS = 20 * 60_000
const DEFAULT_MODEL = 'opencode-go/glm-5.3-flash'
const PLUGIN_GENERATION = 'v2'
const PLUGIN_REF = join(REPO_ROOT, 'src', 'plugin-v2')
/**
 * Config-dir entries the bench shadow dir symlinks from the host config, so
 * the runs see the user's real injected content (AGENTS.md, agents,
 * instructions…) — the double-injection effect under study stays faithful.
 * Never linked: secrets/, plugins/, node_modules/, .venv, *.bak*.
 */
const SHADOW_LINKED_ENTRIES = [
  'AGENTS.md',
  'agents',
  'instructions',
  'commands',
  'skills',
  'prompts',
  'routing.yml',
  'skills-lock.json',
]

const SCENARIOS = {
  A: {
    name: 'multi-step (reproduces the ~2x vs Codex CLI)',
    prompt:
      'Pesquise os melhores carros elétricos de passeio do Brasil até R$150.000. ' +
      'Crie a pasta bench-run-A e monte um site comparativo simples em web moderna ' +
      '(index.html/styles.css/app.js): imagens reais, especificações técnicas e link ' +
      'do fabricante de cada carro.',
  },
  B: {
    name: 'one-shot delimitado',
    prompt:
      'Crie o arquivo bench-run-B.md contendo uma tabela markdown com os 3 países ' +
      'mais populosos do mundo e suas populações.',
  },
}

// ─── small helpers (I/O lives here; the lib/ modules stay pure) ──────────

function gitRev() {
  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim()
  const dirty =
    execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() !==
    ''
  // F-11: a dirty tree must be identifiable, not just flagged. Hash the tracked
  // diff against HEAD PLUS every untracked file except bench/results/ (results
  // accumulate across arms, so including them would make the two same-day arms
  // hash differently). Stable across arms; clean tree → null.
  const diffHash = dirty ? workingTreeHash() : null
  return { sha, dirty, diffHash }
}

/** Stable identity of the working tree at measurement start (see gitRev). */
function workingTreeHash() {
  const parts = [execFileSync('git', ['diff', 'HEAD'], { cwd: REPO_ROOT })]
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((rel) => !rel.startsWith('bench/results/'))
    .sort()
  for (const rel of untracked) {
    parts.push(Buffer.from(`${rel}\0`))
    parts.push(readFileSync(join(REPO_ROOT, rel)))
  }
  return createHash('sha256').update(Buffer.concat(parts)).digest('hex')
}

function opencodeVersion() {
  return execFileSync('opencode', ['--version'], { encoding: 'utf8' }).trim()
}

function readHostConfig() {
  const configDir = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  const path = join(configDir, 'opencode', 'opencode.json')
  if (!existsSync(path)) return { path, config: null }
  try {
    return { path, config: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (err) {
    console.warn(
      `bench: host config at ${path} is not valid JSON (${err.message}); proceeding without it`,
    )
    return { path, config: null }
  }
}

/**
 * Build the bench shadow config dir: host config content (AGENTS.md, agents,
 * instructions… are symlinked, never copied) with an opencode.json whose
 * `plugins` is pinned to THIS REPO's V2 plugin. A shadow dir — not a config
 * override — is required because opencode's config merge is ADDITIVE: an
 * OPENCODE_CONFIG override still loads the host's globally installed plugin,
 * and whichever copy registers first wins (plugin-once), so the instrumented
 * repo plugin could silently lose its registration.
 *
 * When `globalAgentsPath` is given, that file is installed as the shadow's
 * AGENTS.md (the global instruction surface) instead of symlinking the host's,
 * so a control and a candidate global artifact can be swapped same-day.
 */
function buildShadowConfigDir(
  hostConfig,
  model,
  sandboxRoot,
  globalAgentsPath,
  agentsDirPath,
  skillsDirPath,
) {
  const hostConfigDir = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  const hostOpencodeDir = join(hostConfigDir, 'opencode')
  // XDG_CONFIG_HOME must point at the PARENT: opencode looks for
  // <XDG_CONFIG_HOME>/opencode/opencode.json.
  const shadowHome = join(sandboxRoot, 'shadow-config')
  const shadow = join(shadowHome, 'opencode')
  mkdirSync(shadow, { recursive: true })
  for (const entry of SHADOW_LINKED_ENTRIES) {
    if (entry === 'AGENTS.md' && globalAgentsPath !== null) continue
    if (entry === 'agents' && agentsDirPath !== null) continue
    if (entry === 'skills' && skillsDirPath !== null) continue
    const source = join(hostOpencodeDir, entry)
    if (existsSync(source)) {
      try {
        symlinkSync(source, join(shadow, entry))
      } catch {
        // pre-existing link — fine
      }
    }
  }
  if (globalAgentsPath !== null) {
    writeFileSync(join(shadow, 'AGENTS.md'), readFileSync(globalAgentsPath, 'utf8'), 'utf8')
  }
  if (agentsDirPath !== null) symlinkSync(agentsDirPath, join(shadow, 'agents'))
  if (skillsDirPath !== null) symlinkSync(skillsDirPath, join(shadow, 'skills'))
  const base =
    hostConfig !== null && typeof hostConfig === 'object' && !Array.isArray(hostConfig)
      ? hostConfig
      : {}
  const benchConfig = { ...base, plugins: [PLUGIN_REF], model }
  writeFileSync(join(shadow, 'opencode.json'), `${JSON.stringify(benchConfig, null, 2)}\n`, 'utf8')
  return shadowHome
}

/** Identity (path, bytes, sha256) of a fixture file — recorded, never the content. */
function fixtureIdentity(path) {
  const content = readFileSync(path)
  return {
    path,
    bytes: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
  }
}

/**
 * The global opencode.db path — the metric source AND the provider-credential
 * source. Honors XDG_DATA_HOME exactly like the host CLI does.
 */
function globalDbPath() {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
  return join(dataHome, 'opencode', 'opencode.db')
}

function toolCallsToMap(toolCalls) {
  if (toolCalls?.status !== 'ok') return toolCalls
  return Object.fromEntries(toolCalls.calls.map((c) => [c.name, c.count]))
}

function collectRunArtifacts(dbPath, runDir, sessionId) {
  const hooksLogPath = join(runDir, '.pantheon', 'logs', 'hooks.log')
  let metrics = {
    root: { status: 'unavailable', reason: 'run database not available' },
    tokens: { status: 'unavailable', reason: 'run database not available' },
    toolCalls: { status: 'unavailable', reason: 'run database not available' },
    childrenCount: null,
  }
  let instructions = { status: 'unavailable', reason: 'run database not available' }
  let firstRequest = { status: 'unavailable', reason: 'run database not available' }
  let rootSession = null
  if (sessionId !== null && existsSync(dbPath)) {
    let db
    try {
      db = openReadOnly(dbPath)
    } catch (err) {
      metrics = {
        ...metrics,
        tokens: { status: 'unavailable', reason: err.message },
        toolCalls: { status: 'unavailable', reason: err.message },
      }
      instructions = { status: 'unavailable', reason: err.message }
      firstRequest = { status: 'unavailable', reason: err.message }
      db = null
    }
    if (db !== null) {
      try {
        metrics = collectRunMetrics(db, sessionId)
        instructions = collectInstructionState(db, sessionId)
        firstRequest = collectFirstRequest(db, sessionId)
        rootSession =
          metrics.root.status === 'ok'
            ? {
                idle_outcome: metrics.root.idle_outcome,
                agent: metrics.root.agent,
                parent_id: metrics.root.parent_id,
              }
            : null
      } finally {
        db.close()
      }
    }
  } else if (sessionId === null) {
    const reason = 'no sessionID in the CLI output — the session never started'
    metrics = {
      ...metrics,
      tokens: { status: 'unavailable', reason },
      toolCalls: { status: 'unavailable', reason },
    }
    instructions = { status: 'unavailable', reason }
    firstRequest = { status: 'unavailable', reason }
  }
  const hooks = existsSync(hooksLogPath)
    ? summarizeHookTimings(parseBenchHookLines(readFileSync(hooksLogPath, 'utf8')))
    : { status: 'unavailable', reason: 'hooks.log not found in the run sandbox' }
  return { metrics, rootSession, hooks, instructions, firstRequest }
}

// ─── main ────────────────────────────────────────────────────────────────

async function main() {
  let opts
  try {
    opts = parseBenchArgs(process.argv.slice(2))
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`bench: ${err.message}`)
      console.error(
        'usage: bench.mjs [--runs N] [--scenarios A,B] [--profile host|double-injection] ' +
          '[--label name] [--global-agents path] [--project-agents path] ' +
          '[--agents-dir path] [--skills-dir path] ' +
          '[--scenario B --root-agent talos --control-root-agent zeus --paired --out bench/results/file.json]',
      )
      process.exit(2)
    }
    throw err
  }
  const {
    runs: runsPerScenario,
    profile,
    label: requestedLabel,
    scenarios,
    paired,
    rootAgent,
    controlRootAgent,
    out,
  } = opts
  const runLabel =
    out === null ? requestedLabel : out.slice('bench/results/'.length, -'.json'.length)
  const model = process.env.BENCH_MODEL ?? DEFAULT_MODEL
  const startedAtIso = new Date().toISOString()
  const rev = gitRev()
  const version = opencodeVersion()
  const hostConfig = readHostConfig()

  // Fixtures must exist before anything is measured — a missing path is a
  // caller error, not an empty measurement.
  for (const [flag, fixture] of [
    ['--global-agents', opts.globalAgents],
    ['--project-agents', opts.projectAgents],
  ]) {
    if (fixture !== null && !existsSync(fixture)) {
      console.error(`bench: ${flag} path not found: ${fixture}`)
      process.exit(2)
    }
  }
  const globalFixture = opts.globalAgents === null ? null : fixtureIdentity(opts.globalAgents)
  const projectFixture = opts.projectAgents === null ? null : fixtureIdentity(opts.projectAgents)
  let agentsFixture = null
  if (opts.agentsDir !== null) {
    try {
      agentsFixture = agentFixtureIdentity(opts.agentsDir, [controlRootAgent, rootAgent])
    } catch (err) {
      console.error(`bench: invalid --agents-dir fixture: ${err.message}`)
      process.exit(2)
    }
  }
  let skillsFixture = null
  if (opts.skillsDir !== null) {
    try {
      skillsFixture = contentDirectoryIdentity(opts.skillsDir)
    } catch (err) {
      console.error(`bench: invalid --skills-dir fixture: ${err.message}`)
      process.exit(2)
    }
  }

  // Never clobber an existing result: the run identity lives in the file name.
  const resultPath =
    out === null ? join(RESULTS_DIR, `${runLabel}-${rev.sha}.json`) : resolve(REPO_ROOT, out)
  if (existsSync(resultPath)) {
    console.error(
      `bench: refusing to overwrite ${resultPath} — pick a different --label (run identity is in the file name)`,
    )
    process.exit(2)
  }

  const sandboxRoot = join(tmpdir(), 'opencode', `bench-${Date.now()}`)
  mkdirSync(sandboxRoot, { recursive: true })
  const shadowConfigDir = buildShadowConfigDir(
    hostConfig.config,
    model,
    sandboxRoot,
    opts.globalAgents,
    agentsFixture?.path ?? null,
    skillsFixture?.path ?? null,
  )
  const dbPath = globalDbPath()

  console.log(
    `bench: model=${model} runs=${runsPerScenario}/scenario scenarios=${scenarios.join(',')} profile=${profile} label=${runLabel} timeout=${RUN_TIMEOUT_MS / 60000}min${paired ? ` paired=${controlRootAgent}→${rootAgent}` : ''}`,
  )
  console.log(
    `bench: opencode ${version} | git ${rev.sha}${rev.dirty ? ' (dirty)' : ''} | plugin ${PLUGIN_GENERATION} (${PLUGIN_REF})`,
  )
  console.log(`bench: sandbox ${sandboxRoot} | shadow config ${shadowConfigDir}`)
  if (globalFixture) {
    console.log(`bench: global AGENTS fixture ${globalFixture.path} (${globalFixture.bytes}B)`)
  }
  if (projectFixture) {
    console.log(`bench: project AGENTS fixture ${projectFixture.path} (${projectFixture.bytes}B)`)
  }
  if (agentsFixture) {
    console.log(
      `bench: agent definitions ${agentsFixture.files.map((file) => `${file.name}:${file.sha256.slice(0, 12)}`).join(', ')} (${agentsFixture.path})`,
    )
  }
  if (skillsFixture) {
    console.log(
      `bench: skill definitions ${skillsFixture.files.length} files sha256=${skillsFixture.sha256} (${skillsFixture.path})`,
    )
  }
  console.log(`bench: metrics from ${dbPath} (read-only)`)

  const runs = []
  const order = buildRunPlan(
    runsPerScenario,
    scenarios,
    paired ? { rootAgent, controlRootAgent } : null,
  )
  let runNumber = 0
  for (const item of order) {
    runNumber += 1
    const { scenario, arm, agent, pair } = item
    const runLabelDir = `run-${String(runNumber).padStart(2, '0')}-${scenario}${arm === null ? '' : `-${arm}`}`
    const runDir = join(sandboxRoot, runLabelDir)
    mkdirSync(runDir, { recursive: true })
    // Double-injection profile: the project AGENTS.md the real repo carries is
    // materialized INSIDE the run dir, so opencode loads global + project —
    // the exact duplicate the carve splits. Without this the run dir is empty
    // and only the global artifact is ever injected.
    if (opts.projectAgents !== null) {
      writeFileSync(join(runDir, 'AGENTS.md'), readFileSync(opts.projectAgents, 'utf8'), 'utf8')
    }
    const env = resolveBenchEnv(process.env, { configDir: shadowConfigDir, cwd: runDir })
    const startedIso = new Date().toISOString()
    process.stdout.write(`bench: ${runLabelDir} started… `)
    let outcome
    try {
      outcome = await runOnce({
        cwd: runDir,
        prompt: SCENARIOS[scenario].prompt,
        model,
        title: `pantheon-bench-${runLabelDir}`,
        timeoutMs: RUN_TIMEOUT_MS,
        env,
        agent,
      })
    } catch (err) {
      outcome = {
        exitCode: null,
        timedOut: false,
        wallMs: 0,
        events: [],
        sessionId: null,
        stdoutTail: '',
        stderrTail: String(err?.message ?? err),
      }
    }
    const { metrics, rootSession, hooks, instructions, firstRequest } = collectRunArtifacts(
      dbPath,
      runDir,
      outcome.sessionId,
    )
    const completed = runIsCompleted({
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      rootSession,
    })
    let failureReason = null
    if (outcome.timedOut) failureReason = `timeout after ${RUN_TIMEOUT_MS}ms`
    else if (outcome.exitCode !== 0) failureReason = `exit code ${outcome.exitCode}`
    else if (rootSession === null)
      failureReason = 'root session not found or ended failed/interrupted'
    const record = {
      run: runNumber,
      scenario,
      arm,
      pair,
      scenarioName: SCENARIOS[scenario].name,
      rootAgentRequested: agent,
      startedAt: startedIso,
      status: completed ? 'completed' : 'failed',
      failureReason,
      wallMs: outcome.wallMs,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      sessionId: outcome.sessionId,
      modelRequested: model,
      rootAgentObserved: metrics.root.status === 'ok' ? metrics.root.agent : null,
      rootParentId: metrics.root.status === 'ok' ? metrics.root.parent_id : null,
      root: metrics.root,
      childrenCount: metrics.childrenCount,
      tokens:
        metrics.tokens.status === 'ok'
          ? {
              status: 'ok',
              input: metrics.tokens.input,
              output: metrics.tokens.output,
              reasoning: metrics.tokens.reasoning,
              cacheRead: metrics.tokens.cacheRead,
              cacheWrite: metrics.tokens.cacheWrite,
              tokenMessages: metrics.tokens.tokenMessages,
              assistantMessages: metrics.tokens.assistantMessages,
              tokenFieldMessages: metrics.tokens.tokenFieldMessages,
            }
          : metrics.tokens,
      toolCalls: toolCallsToMap(metrics.toolCalls),
      hooks,
      instructions,
      firstRequest,
      stderrTail: outcome.stderrTail === '' ? null : outcome.stderrTail,
    }
    record.armAcceptance = paired
      ? assessPairedRun({
          arm,
          completed,
          requestedAgent: agent,
          observedAgent: record.rootAgentObserved,
          rootAvailable: metrics.root.status === 'ok',
          rootParentId: record.rootParentId,
          childrenCount: metrics.childrenCount,
          toolCalls: record.toolCalls,
          instructions,
          globalInstructionFixture: globalFixture,
          projectInstructionFixture: projectFixture,
        })
      : null
    runs.push(record)
    console.log(
      completed
        ? `done in ${(outcome.wallMs / 1000).toFixed(1)}s (session ${outcome.sessionId})`
        : `FAILED (${failureReason})`,
    )
  }

  const summary = paired ? null : summarizeRuns(runs)
  const summaryByArm = paired ? summarizePairedRunsByArm(runs) : null
  const report = {
    meta: {
      kind: 'pantheon-bench-baseline',
      reportVersion: 3,
      createdAt: startedAtIso,
      gitSha: rev.sha,
      gitDirty: rev.dirty,
      gitDiffHash: rev.diffHash,
      opencodeVersion: version,
      nodeVersion,
      pluginGeneration: PLUGIN_GENERATION,
      pluginRef: PLUGIN_REF,
      hostConfigPath: hostConfig.path,
      hostConfigUsed: hostConfig.config !== null,
      shadowConfigDir,
      modelRequested: model,
      sandboxRoot,
      profile,
      label: runLabel,
      globalAgentsFixture: globalFixture,
      projectAgentsFixture: projectFixture,
      agentsDirFixture: agentsFixture
        ? { path: agentsFixture.path, files: agentsFixture.files, sha256: agentsFixture.sha256 }
        : null,
      skillsDirFixture: skillsFixture,
      protocol: {
        runsPerScenario,
        scenarios,
        interleave: `${scenarios.join(',')} starting at ${scenarios[0]}`,
        runTimeoutMs: RUN_TIMEOUT_MS,
        standaloneServerPerRun: true,
        permissionMode: '--auto (non-interactive auto-approve)',
        paired,
        agent: paired
          ? { control: controlRootAgent, candidate: rootAgent }
          : 'zeus (headless sessions default to agent=NULL, which the delegation policy denies; the TUI starts on the default agent)',
        armOrder: paired ? 'control,candidate per pair (C1,K1,…,C5,K5)' : null,
        logLevel:
          'debug (required for the V2 tool-hook registration to complete; protocol constant, equal across phases)',
        pluginSelection: 'XDG_CONFIG_HOME shadow config dir; repo plugin pinned via plugins[]',
        agentsSelection: paired
          ? 'shadow-config/agents symlinked to --agents-dir; requested agent markdown identities recorded in agentsDirFixture'
          : 'host config agents symlinked into shadow config',
        skillsSelection: paired
          ? 'shadow-config/skills symlinked to --skills-dir; all source file identities recorded in skillsDirFixture'
          : 'host config skills symlinked into shadow config',
        metricDb: dbPath,
        isolatedDbPerRun: false,
        scenarioAUsesRealWebResearch: true,
        profileDescription:
          profile === 'double-injection'
            ? 'global AGENTS.md + a project AGENTS.md materialized in every run dir'
            : 'host global AGENTS.md only; run dirs stay empty',
      },
    },
    scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, v]) => [k, v.name])),
    runs,
    summary,
    summaryByArm,
    schemaNotes: [
      'Tokens come from the V2 session_message ledger (assistant rows, data.tokens), the same source as pantheon_cost; cache read/write from data.tokens.cache.',
      'Child sessions resolved recursively via session_v2.parent_id with a visited set — each session counted once.',
      'Runs share the global opencode.db (provider credentials live there), but every metric is scoped by the run root sessionID and the db is opened READ-ONLY; no db writes are ever performed.',
      'Tool calls counted from assistant content parts with type=tool; only the tool NAME is read, never tool inputs.',
      'Hook timings come from the [bench] lines the V2 plugin appends to .pantheon/logs/hooks.log (instrumentation-only change).',
      'Per-run `instructions` is the D4 fidelity proof: the identity (path, bytes, sha256) of every instruction file the session actually loaded, read from instruction_state/instruction_blob. Content is never copied into the report.',
      "Per-run `firstRequest` is the proxy that isolates the injected payload: the first assistant row's tokens.input + tokens.cache.read. Tree-total input is dominated by session-length variance; the payload only lands on the first request.",
      'Paired root-agent runs replace the host agents directory with the explicit --agents-dir fixture; requested agent files are content-identified in meta.agentsDirFixture.',
      'Paired root-agent runs also replace host skills with --skills-dir; every skill fixture file is content-identified in meta.skillsDirFixture.',
      'Paired summary metrics include completed runs only when the requested root matches the observed root, the root has no parent, D4 proves both configured global/project instruction fixtures were loaded, and (for candidates) childrenCount is zero with an available tool ledger showing no subagent attempt. Failed and ineligible runs remain in runs with reasons.',
      'Artifact correctness is audited outside the timed interval using the pre-registered oracle; armAcceptance does not assert artifact correctness.',
      'A metric the schema cannot provide is {status:"unavailable", reason} — never zero.',
    ],
  }
  assertNoSecrets(report)

  mkdirSync(RESULTS_DIR, { recursive: true })
  writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  // ── console summary table ──
  console.log(`\nbench: report → ${resultPath}`)
  if (paired) {
    for (const arm of ['control', 'candidate']) {
      const armSummary = summaryByArm[arm]
      for (const key of scenarios) {
        const s = armSummary.metrics.perScenario[key] ?? { runs: 0, completed: 0, failures: 0 }
        const wall =
          s.wallMs && s.wallMs.median !== undefined
            ? `${(s.wallMs.median / 1000).toFixed(1)}s median / ${(s.wallMs.p80 / 1000).toFixed(1)}s p80`
            : 'wall-time unavailable'
        console.log(
          `  ${arm}/${key}: ${armSummary.eligible}/${armSummary.runs} acceptance-eligible, ${s.completed} runtime-completed — ${wall}`,
        )
      }
    }
  } else {
    for (const key of scenarios) {
      const s = summary.perScenario[key] ?? { runs: 0, completed: 0, failures: 0 }
      const wall =
        s.wallMs && s.wallMs.median !== undefined
          ? `${(s.wallMs.median / 1000).toFixed(1)}s median / ${(s.wallMs.p80 / 1000).toFixed(1)}s p80`
          : 'wall-time unavailable'
      console.log(`  ${key}: ${s.completed}/${s.runs} completed, ${s.failures} failures — ${wall}`)
    }
  }
}

main().catch((err) => {
  console.error(`bench: fatal: ${err?.stack ?? err}`)
  process.exit(1)
})
