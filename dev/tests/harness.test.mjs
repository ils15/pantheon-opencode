import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runOfflineDecision, validateTypedAnswers } from './offline-decision.mjs'

test('pickleball typed-decision stub is explicitly offline and validates all question types', async () => {
  const evidence = await runOfflineDecision()

  assert.equal(evidence.fixture, 'pickleball')
  assert.equal(evidence.operation, 'decision.typed')
  assert.equal(evidence.mode, 'stub/offline')
  assert.equal(evidence.status, 'pass')
  assert.ok(Number.isFinite(evidence.durationMs))
  assert.ok(evidence.durationMs >= 0)
})

test('typed-decision stub rejects an out-of-range score', () => {
  assert.equal(
    validateTypedAnswers(
      [
        {
          type: 'score',
          name: 'rally_readiness',
          levels: [{ label: 'low' }, { label: 'high' }],
        },
      ],
      [{ name: 'rally_readiness', value: 'expert' }],
    ),
    false,
  )
})

test('synthetic MCP fixture supports resource reads but rejects tool calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pickleball-mcp-test-'))
  const auditPath = join(root, 'methods.log')
  const fixturePath = fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url))
  const child = spawn(process.execPath, [fixturePath], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', PICKLEBALL_MCP_AUDIT_PATH: auditPath },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  let buffered = ''
  const responses = new Map()
  child.stdout.on('data', (chunk) => {
    buffered += String(chunk)
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) continue
      try {
        const response = JSON.parse(line)
        responses.set(response.id, response)
      } catch {
        // The assertion below reports a missing/invalid fixture response.
      }
    }
  })

  const request = async (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    const deadline = Date.now() + 2_000
    while (!responses.has(id) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.ok(responses.has(id), `fixture did not answer ${method}`)
    return responses.get(id)
  }

  try {
    const initialized = await request(1, 'initialize', { protocolVersion: '2024-11-05' })
    assert.deepEqual(initialized.result.capabilities, {
      resources: { subscribe: false, listChanged: false },
    })
    const listed = await request(2, 'resources/list', {})
    const uri = listed.result.resources[0].uri
    assert.equal(uri, 'pickleball://fixture/serve-and-rally')
    const read = await request(3, 'resources/read', { uri })
    assert.match(read.result.contents[0].text, /pickleball practice/)
    const forbidden = await request(4, 'tools/call', { name: 'write', arguments: {} })
    assert.equal(forbidden.error.code, -32601)
    assert.deepEqual(readFileSync(auditPath, 'utf8').trim().split('\n'), [
      'resources/list',
      'resources/read',
    ])
  } finally {
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve()
        return
      }
      child.once('exit', resolve)
    })
    child.kill('SIGKILL')
    await exited
    rmSync(root, { recursive: true, force: true })
  }
})

const bwrapAvailable = ['/usr/sbin/bwrap', '/usr/bin/bwrap', '/sbin/bwrap', '/bin/bwrap'].some(
  (path) => existsSync(path),
)

test('minimal host sandbox hides host resources and ignores PATH-provided helpers', {
  skip: bwrapAvailable ? false : 'bubblewrap is not installed',
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pickleball-mount-test-'))
  const sentinelPath = join(root, 'outside-allowlist-sentinel.txt')
  const socketPath = join(root, 'outside-allowlist.sock')
  const helperMarkerPath = join(root, 'untrusted-helper-was-invoked')
  const runnerPath = fileURLToPath(new URL('./run-host-runtime.sh', import.meta.url))
  const canary = createServer()
  writeFileSync(sentinelPath, 'host-only sentinel; must not be readable in bwrap')
  for (const helper of [
    'awk',
    'bash',
    'bwrap',
    'dirname',
    'env',
    'ldconfig',
    'readelf',
    'realpath',
  ]) {
    writeFileSync(
      join(root, helper),
      '#!/bin/sh\n: > "$PICKLEBALL_UNTRUSTED_HELPER_MARKER"\nexit 99\n',
      { mode: 0o755 },
    )
  }

  try {
    await new Promise((resolve, reject) => {
      canary.once('error', reject)
      canary.listen(socketPath, resolve)
    })
    const result = spawnSync(runnerPath, ['--isolation-probe', sentinelPath, socketPath], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        PATH: `${root}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        PICKLEBALL_NODE_BIN: process.execPath,
        PICKLEBALL_UNTRUSTED_HELPER_MARKER: helperMarkerPath,
        PICKLEBALL_OPENCODE_BIN: process.execPath,
      },
    })

    assert.equal(
      existsSync(helperMarkerPath),
      false,
      'runner must not execute helpers from caller PATH',
    )
    assert.equal(
      result.status,
      0,
      result.stderr || result.stdout || result.error?.message || 'runner did not return a status',
    )
    assert.match(result.stdout, /sentinel=hidden.*unixSocket=hidden/)
  } finally {
    await new Promise((resolve) => canary.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
})

test('live Jev command refuses unless explicitly triggered', () => {
  const scriptPath = fileURLToPath(new URL('./live-jev.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    timeout: 2_000,
  })

  assert.equal(result.status, 2)
  assert.match(result.stderr, /separate explicit --live-jev command/)
})
