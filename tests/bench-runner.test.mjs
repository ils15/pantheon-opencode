/**
 * bench-runner.test.mjs — TDD contract tests for bench/lib/runner.mjs
 * (beta-10 latency slice, Phase 0 baseline harness).
 *
 * Locked contracts:
 *   - resolveBenchEnv isolates the child WITHOUT touching the host process env:
 *     strips stale session/config-override vars and points XDG_CONFIG_HOME at
 *     the bench shadow config dir, preserving everything else
 *   - runOnce measures wall time, parses NDJSON events, and records a TIMEOUT
 *     as a failed run (kills the child) — a timed-out child can never count as
 *     a completed run
 *   - the spawned command is exactly [opencode, run, --format, json,
 *     --standalone, --auto, --log-level, debug, --agent, zeus, --title, …,
 *     --model, …, <prompt>] (non-interactive, no shell interpolation)
 *
 * Run: node --test tests/bench-runner.test.mjs
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

const { extractSessionId, resolveBenchEnv, runOnce } = await import('../bench/lib/runner.mjs')

// ─── resolveBenchEnv ─────────────────────────────────────────────────────

test('resolveBenchEnv strips stale session/config vars and pins the shadow config dir', () => {
  const host = {
    PATH: '/usr/bin:/bin',
    OPENCODE_SESSION_ID: 'ses_stale',
    OPENCODE_CONFIG: '/host/config.json',
    OPENCODE_CONFIG_CONTENT: '{"plugins":["host"]}',
    OPENCODE_CONFIG_DIR: '/host/cfgdir',
    XDG_CONFIG_HOME: '/home/user/.config',
    PWD: '/home/ils15/pantheon',
    OLDPWD: '/home/user',
    HOME: '/home/user',
  }
  const env = resolveBenchEnv(host, { configDir: '/sandbox/shadow-config', cwd: '/sandbox/run-1' })
  assert.equal('OPENCODE_SESSION_ID' in env, false, 'stale session id must not leak into the run')
  assert.equal('OPENCODE_CONFIG' in env, false, 'host config file override must not leak')
  assert.equal(
    'OPENCODE_CONFIG_CONTENT' in env,
    false,
    'host config content override must not leak',
  )
  assert.equal('OPENCODE_CONFIG_DIR' in env, false, 'host config dir override must not leak')
  assert.equal('OLDPWD' in env, false, 'stale OLDPWD must not leak')
  assert.equal(env.XDG_CONFIG_HOME, '/sandbox/shadow-config')
  assert.equal(
    env.PWD,
    '/sandbox/run-1',
    'PWD must match the run dir or workspace resolution breaks',
  )
  assert.equal(env.PATH, '/usr/bin:/bin')
  assert.equal(env.HOME, '/home/user')
})

test('resolveBenchEnv never mutates the host env object', () => {
  const host = { PATH: '/bin', OPENCODE_SESSION_ID: 'ses_stale' }
  resolveBenchEnv(host, { configDir: '/sandbox/shadow-config', cwd: '/sandbox/run-1' })
  assert.deepEqual(host, { PATH: '/bin', OPENCODE_SESSION_ID: 'ses_stale' })
})

// ─── spawn contract ──────────────────────────────────────────────────────

test('runOnce spawns opencode run non-interactively with json format, auto-approve and model pin', async () => {
  const calls = []
  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return {
      stdout: '{"type":"step_start","sessionID":"ses_1"}\n',
      stderr: '',
      exitCode: 0,
      killed: false,
    }
  }
  const result = await runOnce({
    cwd: '/sandbox/run-1',
    prompt: 'hello',
    model: 'p/m',
    timeoutMs: 5_000,
    spawn: fakeSpawn,
  })
  assert.equal(calls.length, 1)
  const { cmd, args, opts } = calls[0]
  assert.equal(cmd, 'opencode')
  assert.equal(args[0], 'run')
  assert.equal(args[1], '--format')
  assert.equal(args[2], 'json')
  assert.equal(args[3], '--standalone')
  assert.equal(args[4], '--auto')
  assert.equal(args[5], '--log-level')
  assert.equal(args[6], 'debug')
  assert.equal(args[7], '--agent')
  assert.equal(args[8], 'zeus')
  assert.equal(args.join(' ').includes('--model p/m'), true)
  assert.equal(args.at(-1), 'hello', 'prompt rides as the final positional argument')
  assert.equal(opts.cwd, '/sandbox/run-1')
  assert.equal(result.exitCode, 0)
  assert.equal(result.timedOut, false)
  assert.ok(result.wallMs >= 0)
})

test('runOnce measures elapsed wall time with its monotonic clock', async () => {
  const ticks = [100, 101, 145]
  const result = await runOnce({
    cwd: '/sandbox/run-clock',
    prompt: 'hello',
    model: 'p/m',
    timeoutMs: 5_000,
    spawn: () => ({ stdout: '', stderr: '', exitCode: 0, killed: false }),
    monotonicNow: () => ticks.shift(),
  })
  assert.equal(result.wallMs, 45)
})

test('runOnce honors the explicitly selected specialist root agent', async () => {
  let argsSeen
  await runOnce({
    cwd: '/sandbox/run-talos',
    prompt: 'hello',
    model: 'p/m',
    agent: 'talos',
    timeoutMs: 5_000,
    spawn: (_cmd, args) => {
      argsSeen = args
      return { stdout: '', stderr: '', exitCode: 0, killed: false }
    },
  })
  const agentIndex = argsSeen.indexOf('--agent')
  assert.notEqual(agentIndex, -1)
  assert.equal(argsSeen[agentIndex + 1], 'talos')
})

test('runOnce parses NDJSON events and extractSessionId picks the first sessionID', async () => {
  const result = await runOnce({
    cwd: '/sandbox/run-2',
    prompt: 'hello',
    model: 'p/m',
    timeoutMs: 5_000,
    spawn: () => ({
      stdout:
        '{"type":"step_start","sessionID":"ses_a"}\nnot json at all\n{"type":"step_finish","sessionID":"ses_a"}\n',
      stderr: '',
      exitCode: 0,
      killed: false,
    }),
  })
  assert.equal(result.events.length, 2)
  assert.equal(extractSessionId(result.events), 'ses_a')
})

test('a timed-out child is killed and the run is marked timedOut (never completed)', async () => {
  let killed = false
  const slowSpawn = () => ({
    stdout: '',
    stderr: '',
    exitCode: null,
    killed: false,
    onKill: () => {
      killed = true
    },
  })
  const result = await runOnce({
    cwd: '/sandbox/run-3',
    prompt: 'hello',
    model: 'p/m',
    timeoutMs: 10,
    spawn: slowSpawn,
  })
  assert.equal(result.timedOut, true)
  assert.equal(killed, true, 'runOnce must kill the hung child')
})

test('a non-zero exit is surfaced as a failed exit code, events still collected', async () => {
  const result = await runOnce({
    cwd: '/sandbox/run-4',
    prompt: 'hello',
    model: 'p/m',
    timeoutMs: 5_000,
    spawn: () => ({
      stdout: '{"type":"error","sessionID":"ses_b"}\n',
      stderr: 'boom',
      exitCode: 1,
      killed: false,
    }),
  })
  assert.equal(result.exitCode, 1)
  assert.equal(result.stderrTail, 'boom')
  assert.equal(extractSessionId(result.events), 'ses_b')
})
