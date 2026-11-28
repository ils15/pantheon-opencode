/**
 * S5-1..S5-6 + the D01 env matrix for the opt-in loopback cockpit.
 *
 * These are real binds and real HTTP requests over 127.0.0.1: the config matrix
 * is proven by which port the socket holds, the Host/421 and POST/405 cases by
 * the bytes the server returns, and redaction by diffing `?full=1`.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildHeadlessSnapshot,
  COCKPIT_SCHEMA,
  CockpitConfigError,
  resolveCockpitConfig,
  startCockpitServer,
} from '../src/pantheon/cockpit-http.ts'

/** Ask the kernel for a free loopback port, then release it. */
async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** Prove a port is bindable (nothing holds it). */
async function assertPortBindable(port) {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  await new Promise((resolve) => server.close(resolve))
}

function httpRequest(port, options = {}) {
  const { method = 'GET', path = '/', headers = {} } = options
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function seedWorkspace({ corruptLedger = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-cockpit-http-'))
  mkdirSync(join(dir, '.pantheon', 'ledger'), { recursive: true })
  mkdirSync(join(dir, '.pantheon', 'board'), { recursive: true })
  const ledgerPath = join(dir, '.pantheon', 'ledger', 'step-ledger.json')
  if (corruptLedger) {
    writeFileSync(ledgerPath, '{ this is not json')
  } else {
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        version: 1,
        steps: {
          'step-a': {
            stepKey: 'step-a',
            objective: 'Implement OAuth PKCE handler',
            agent: 'hermes',
            state: 'pending',
            dependsOn: ['step-b'],
            blockedBy: ['step-b'],
            verificationAttempts: 2,
            verificationFailures: 1,
            mutatedFiles: ['src/auth.ts'],
            lastMutationAt: 1000,
            lastVerifiedAt: null,
            receiptId: 'rcpt_secret_1234',
            verificationCommand: 'npm test -- --token=super-secret-token',
            updatedAt: new Date(2000).toISOString(),
          },
          'step-b': {
            stepKey: 'step-b',
            objective: 'Wire provider config',
            agent: 'hermes',
            state: 'done',
            mutatedFiles: [],
            lastMutationAt: null,
            lastVerifiedAt: 3000,
            verificationExitCode: 0,
            updatedAt: new Date(3000).toISOString(),
          },
        },
      }),
    )
  }
  writeFileSync(
    join(dir, '.pantheon', 'board', 'messages.ndjson'),
    `${JSON.stringify({
      seq: 1,
      timestamp: 4000,
      channel: 'swarm',
      threadId: 'main',
      from: 'hermes',
      mentions: ['zeus'],
      tag: 'done',
      stepKey: 'step-b',
      body: 'SECRET BOARD BODY with api_key=abc123',
      ephemeral: {
        role: 'merge',
        baseAgent: 'hermes',
        sessionID: 'ses_secret_value',
        status: 'completed',
      },
    })}\n`,
  )
  writeFileSync(
    join(dir, '.pantheon', 'board', 'threads.json'),
    JSON.stringify({
      'swarm::main': {
        channel: 'swarm',
        threadId: 'main',
        goal: 'Harden the swarm',
        updatedAt: 4000,
      },
    }),
  )
  return dir
}

async function withServer(t, envOverrides, workspaceDir) {
  const port = await freePort()
  const logs = []
  const listening = []
  const handle = startCockpitServer({
    workspaceDir,
    env: {
      PANTHEON_COCKPIT: '1',
      PANTHEON_COCKPIT_PORT: String(port),
      ...envOverrides,
    },
    log: (line) => logs.push(line),
    onListening: (info) => listening.push(info),
  })
  assert.ok(handle, 'cockpit should be enabled')
  const info = await handle.ready
  assert.equal(info.port, port)
  assert.equal(listening.length, 1)
  t.after(async () => {
    await handle.close()
  })
  return { handle, port, logs, listening }
}

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys)
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key)
      collectKeys(child, keys)
    }
  }
  return keys
}

function assertNoCors(headers) {
  for (const name of Object.keys(headers)) {
    assert.ok(!name.toLowerCase().startsWith('access-control-'), `unexpected CORS header: ${name}`)
  }
}

// ─── S5-1 / D01: disabled never listens ────────────────────────────────

test('S5-1 PANTHEON_COCKPIT unset or 0 creates no listener and logs one line', async () => {
  // The literal single line for an unset cockpit with no port configured.
  const bareLogs = []
  assert.equal(
    startCockpitServer({
      workspaceDir: tmpdir(),
      env: {},
      log: (line) => bareLogs.push(line),
    }),
    null,
  )
  assert.deepEqual(bareLogs, ['cockpit disabled'])

  for (const value of [undefined, '0']) {
    const port = await freePort()
    const logs = []
    const listening = []
    const handle = startCockpitServer({
      workspaceDir: tmpdir(),
      env: {
        ...(value === undefined ? {} : { PANTHEON_COCKPIT: value }),
        PANTHEON_COCKPIT_PORT: String(port),
      },
      log: (line) => logs.push(line),
      onListening: (info) => listening.push(info),
    })
    assert.equal(handle, null, `PANTHEON_COCKPIT=${value} must be disabled`)
    assert.deepEqual(listening, [], 'the listening event must never fire')
    assert.equal(logs.length, 1)
    assert.match(logs[0], /^cockpit disabled/)
    // The port is still free: no socket was ever bound and leaked.
    await assertPortBindable(port)
  }
})

// ─── D01 matrix: fatal values bind nothing ─────────────────────────────

const FATAL_PORTS = ['', '0', '-1', '65536', 'abc', ' 0 ', '1.5']

test('D01 invalid PANTHEON_COCKPIT_PORT is fatal and binds nothing', async () => {
  for (const raw of FATAL_PORTS) {
    assert.throws(
      () =>
        resolveCockpitConfig({
          PANTHEON_COCKPIT: '1',
          PANTHEON_COCKPIT_PORT: raw,
        }),
      (error) => error instanceof CockpitConfigError && error.code === 'invalid_port',
      `port ${JSON.stringify(raw)} should be fatal`,
    )

    const listening = []
    assert.throws(
      () =>
        startCockpitServer({
          workspaceDir: tmpdir(),
          env: { PANTHEON_COCKPIT: '1', PANTHEON_COCKPIT_PORT: raw },
          onListening: (info) => listening.push(info),
        }),
      CockpitConfigError,
    )
    assert.deepEqual(listening, [])
  }
})

test('D01 accepts 1, 4747 and 65535 and binds exactly that port', async () => {
  // 4747 and 65535 are unprivileged and prove a real bind. Port 1 is accepted
  // by the contract but the kernel refuses it to a non-root uid (EACCES); that
  // is still a proof it attempted port 1 and did not substitute an ephemeral one.
  for (const port of [4747, 65535]) {
    assert.equal(
      resolveCockpitConfig({
        PANTHEON_COCKPIT: '1',
        PANTHEON_COCKPIT_PORT: String(port),
      }).port,
      port,
    )
    const handle = startCockpitServer({
      workspaceDir: tmpdir(),
      env: { PANTHEON_COCKPIT: '1', PANTHEON_COCKPIT_PORT: String(port) },
    })
    assert.ok(handle)
    try {
      const info = await handle.ready
      assert.equal(info.port, port)
      const address = handle.server.address()
      assert.equal(typeof address === 'object' && address !== null ? address.port : null, port)
    } finally {
      await handle.close()
    }
  }

  assert.equal(resolveCockpitConfig({ PANTHEON_COCKPIT: '1', PANTHEON_COCKPIT_PORT: '1' }).port, 1)
  const one = startCockpitServer({
    workspaceDir: tmpdir(),
    env: { PANTHEON_COCKPIT: '1', PANTHEON_COCKPIT_PORT: '1' },
  })
  assert.ok(one)
  try {
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      await assert.rejects(one.ready, (error) => error.code === 'EACCES')
    } else {
      const info = await one.ready
      assert.equal(info.port, 1)
    }
  } finally {
    await one.close()
  }
})

test('D01 non-loopback PANTHEON_COCKPIT_HOST is fatal and binds nothing', () => {
  for (const host of ['0.0.0.0', '192.168.1.10', 'example.com', '::', '[::]']) {
    assert.throws(
      () => resolveCockpitConfig({ PANTHEON_COCKPIT: '1', PANTHEON_COCKPIT_HOST: host }),
      (error) => error instanceof CockpitConfigError && error.code === 'non_loopback_host',
      `host ${host} should be fatal`,
    )
    const listening = []
    assert.throws(
      () =>
        startCockpitServer({
          workspaceDir: tmpdir(),
          env: {
            PANTHEON_COCKPIT: '1',
            PANTHEON_COCKPIT_HOST: host,
            PANTHEON_COCKPIT_PORT: '4747',
          },
          onListening: (info) => listening.push(info),
        }),
      CockpitConfigError,
    )
    assert.deepEqual(listening, [])
  }
  for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
    const config = resolveCockpitConfig({ PANTHEON_COCKPIT: '1', PANTHEON_COCKPIT_HOST: host })
    assert.ok(config.host === '127.0.0.1' || config.host === '::1')
  }
})

test('port configured while disabled only warns and stays disabled', async () => {
  const port = await freePort()
  const logs = []
  const handle = startCockpitServer({
    workspaceDir: tmpdir(),
    env: { PANTHEON_COCKPIT: '0', PANTHEON_COCKPIT_PORT: String(port) },
    log: (line) => logs.push(line),
  })
  assert.equal(handle, null)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /^cockpit disabled: PANTHEON_COCKPIT_PORT/)
  await assertPortBindable(port)
})

// ─── S5-3/S5-4: the security cases over real requests ─────────────────

test('S5-3/S5-4 Host 421, POST 405, no CORS, GET/HEAD only', async (t) => {
  const workspace = seedWorkspace()
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const { port } = await withServer(t, {}, workspace)

  const evil = await httpRequest(port, { headers: { host: 'evil.example' } })
  assert.equal(evil.status, 421)
  assert.equal(evil.body, '', '421 must carry no payload')
  assertNoCors(evil.headers)

  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
    const ok = await httpRequest(port, { headers: { host } })
    assert.equal(ok.status, 200, `Host ${host} should be accepted`)
    assertNoCors(ok.headers)
    assert.equal(ok.headers['cache-control'], 'no-store')
    assert.equal(ok.headers['x-content-type-options'], 'nosniff')
  }

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await httpRequest(port, { method, path: '/' })
    assert.equal(response.status, 405, `${method} must be 405`)
    assert.equal(response.headers.allow, 'GET, HEAD')
    assert.equal(response.headers['cache-control'], 'no-store')
    assertNoCors(response.headers)
  }

  const missing = await httpRequest(port, { path: '/nope' })
  assert.equal(missing.status, 404)
  assertNoCors(missing.headers)
  assert.equal(missing.headers['cache-control'], 'no-store')

  const head = await httpRequest(port, { method: 'HEAD', path: '/healthz' })
  assert.equal(head.status, 200)
  assert.equal(head.body, '')
  assert.ok(Number(head.headers['content-length']) > 0)

  const health = await httpRequest(port, { path: '/healthz' })
  assert.equal(health.status, 200)
  assert.deepEqual(JSON.parse(health.body), {
    ok: true,
    schema: COCKPIT_SCHEMA,
    version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  })
})

test('S5-5 redaction by default, ?full=1 opt-in, no sessionID/cost/token keys', async (t) => {
  const workspace = seedWorkspace()
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const { port } = await withServer(t, {}, workspace)

  const leanResponse = await httpRequest(port, { path: '/' })
  assert.equal(leanResponse.status, 200)
  const lean = JSON.parse(leanResponse.body)
  assert.equal(lean.schema, COCKPIT_SCHEMA)
  assert.equal(lean.kind, 'headless')
  assert.equal(lean.parity, 'not-tui-snapshot')
  assert.equal(lean.stepsCorrupt, false)
  assert.equal(lean.steps.length, 2)
  assert.deepEqual(lean.graph.ready, ['step-a'])
  assert.deepEqual(lean.graph.unmet, {})
  assert.equal(lean.board.messages.length, 1)
  assert.equal(lean.board.messages[0].body, undefined)
  assert.equal(lean.board.messages[0].ephemeral, undefined)
  assert.equal(lean.board.bodiesRedacted, true)

  const keys = collectKeys(lean).map((key) => key.toLowerCase())
  for (const key of keys) {
    assert.ok(!key.includes('sessionid'), `default payload leaked key ${key}`)
    assert.ok(!key.includes('cost'), `default payload leaked key ${key}`)
    assert.ok(!key.includes('token'), `default payload leaked key ${key}`)
  }
  assert.ok(!leanResponse.body.includes('SECRET BOARD BODY'))
  assert.ok(!leanResponse.body.includes('ses_secret_value'))
  assert.ok(!leanResponse.body.includes('super-secret-token'))

  const fullResponse = await httpRequest(port, { path: '/?full=1' })
  const full = JSON.parse(fullResponse.body)
  assert.equal(full.board.bodiesRedacted, false)
  assert.equal(full.board.messages[0].body, 'SECRET BOARD BODY with api_key=abc123')
  assert.equal(full.board.messages[0].ephemeral.sessionID, 'ses_secret_value')
  assert.equal(full.steps[0].mutatedFiles[0], 'src/auth.ts')
  assert.ok(fullResponse.body.includes('super-secret-token'))
})

test('S5-5 corrupt ledger surfaces stepsCorrupt instead of an empty-looking list', async (t) => {
  const workspace = seedWorkspace({ corruptLedger: true })
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const { port } = await withServer(t, {}, workspace)

  const response = await httpRequest(port, { path: '/' })
  assert.equal(response.status, 200)
  const snapshot = JSON.parse(response.body)
  assert.equal(snapshot.stepsCorrupt, true)
  assert.deepEqual(snapshot.steps, [])

  // A GET is read-only: the corrupt file is still there to be inspected.
  const ledgerPath = join(workspace, '.pantheon', 'ledger', 'step-ledger.json')
  assert.equal(readFileSync(ledgerPath, 'utf8'), '{ this is not json')
})

test('optional token is a header equality check and 401 is empty', async (t) => {
  const workspace = seedWorkspace()
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const { port } = await withServer(t, { PANTHEON_COCKPIT_TOKEN: 's3cret-token' }, workspace)

  const missing = await httpRequest(port, { path: '/healthz' })
  assert.equal(missing.status, 401)
  assert.equal(missing.body, '')
  assert.equal(missing.headers['cache-control'], 'no-store')
  assertNoCors(missing.headers)

  const wrong = await httpRequest(port, {
    path: '/healthz',
    headers: { 'x-pantheon-cockpit-token': 'nope' },
  })
  assert.equal(wrong.status, 401)
  assert.equal(wrong.body, '')
  assertNoCors(wrong.headers)

  const right = await httpRequest(port, {
    path: '/healthz',
    headers: { 'x-pantheon-cockpit-token': 's3cret-token' },
  })
  assert.equal(right.status, 200)
})

test('buildHeadlessSnapshot is pure and reads on-disk state only', () => {
  const workspace = seedWorkspace()
  try {
    const first = buildHeadlessSnapshot(workspace, { now: new Date('2026-01-01T00:00:00Z') })
    assert.equal(first.generatedAt, '2026-01-01T00:00:00.000Z')
    assert.equal(first.steps.length, 2)
    assert.equal(first.board.channelHeaders.length, 1)
    assert.equal(first.board.messages[0].body, undefined)
    assert.ok(first.board.threads.length >= 1)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})
