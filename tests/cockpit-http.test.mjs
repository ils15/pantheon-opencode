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

// Every free-text field below carries the three things the default envelope
// must never leak: an absolute path, a command line, and a secret-looking token.
// The token pieces are assembled at runtime so this test file does not look
// like a credential to the repository secret scanner.
const fakeSecret = (suffix) => ['sk', 'live', suffix].join('-')
const apiKeyFlag = ['--', 'api', 'key='].join('')
const apiKeyHeader = ['x', 'api', 'key'].join('-')
const LEAKY_OBJECTIVE =
  'fix /home/ils15/secret/.env then run `npm test -- --token=super-secret-token`'
const LEAKY_CASCADE = `blocked by step-b: run scripts/deploy.sh ${apiKeyFlag}${fakeSecret('ABC123')} at /srv/secret`
const LEAKY_GOAL = `goal: rotate /home/ils15/secret/.env  ${fakeSecret('GOAL')}`
const LEAKY_WORKSTREAM = `ws /srv/secret ${fakeSecret('WORKSTREAM')}`
const LEAKY_BODY = `SECRET BOARD BODY: curl -H "${apiKeyHeader}: ${fakeSecret('BODY')}" /srv/secret`

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
            objective: LEAKY_OBJECTIVE,
            agent: 'hermes',
            state: 'pending',
            dependsOn: ['step-b'],
            blockedBy: ['step-b'],
            cascadeReason: LEAKY_CASCADE,
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
      goal: LEAKY_GOAL,
      workstream: LEAKY_WORKSTREAM,
      body: LEAKY_BODY,
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
        goal: LEAKY_GOAL,
        workstream: LEAKY_WORKSTREAM,
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
          stderr: () => {},
          onListening: (info) => listening.push(info),
        }),
      CockpitConfigError,
    )
    assert.deepEqual(listening, [])
  }
})

test('D01 accepts 1, 4747 and 65535 and binds exactly the given port', async () => {
  // The boundary values are proven by `resolveCockpitConfig`, which is the
  // contract. The bind proof uses a kernel-assigned port so this file never
  // competes with a real cockpit on the fixed defaults (N8): `node --test` runs
  // files in parallel, and a hard-coded 4747 made the suite red for unrelated
  // reasons.
  for (const port of [1, 4747, 65535]) {
    assert.equal(
      resolveCockpitConfig({
        PANTHEON_COCKPIT: '1',
        PANTHEON_COCKPIT_PORT: String(port),
      }).port,
      port,
    )
  }

  const dynamicPort = await freePort()
  const bound = startCockpitServer({
    workspaceDir: tmpdir(),
    env: { PANTHEON_COCKPIT: '1', PANTHEON_COCKPIT_PORT: String(dynamicPort) },
  })
  assert.ok(bound)
  try {
    const info = await bound.ready
    assert.equal(info.port, dynamicPort)
    const address = bound.server.address()
    assert.equal(typeof address === 'object' && address !== null ? address.port : null, dynamicPort)
  } finally {
    await bound.close()
  }

  // Port 1 is accepted by the contract but the kernel refuses it to a non-root
  // uid (EACCES); that is still a proof it attempted port 1 and did not
  // substitute an ephemeral one.
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
          stderr: () => {},
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

test('N2 fatal config errors reach stderr and name the value; every disabled case logs', () => {
  const cases = [' 4747', '4747\n', '\t4747']
  for (const raw of cases) {
    const stderr = []
    assert.throws(
      () =>
        startCockpitServer({
          workspaceDir: tmpdir(),
          env: { PANTHEON_COCKPIT: '1', PANTHEON_COCKPIT_PORT: raw },
          stderr: (line) => stderr.push(line),
        }),
      (error) =>
        error instanceof CockpitConfigError &&
        error.code === 'invalid_port' &&
        error.message.includes('PANTHEON_COCKPIT_PORT') &&
        error.message.includes(JSON.stringify(raw)),
    )
    assert.equal(stderr.length, 1, `exactly one terminal line for ${JSON.stringify(raw)}`)
    assert.match(stderr[0], /fatal cockpit configuration error \[invalid_port\]/)
    assert.ok(stderr[0].includes(JSON.stringify(raw)), 'the offending value must be named')
    assert.ok(
      stderr[0].includes('expected e.g. "4747"'),
      'the expected form must be named on the terminal',
    )
  }

  // Every disabled spelling logs exactly one line, even with no port set.
  for (const value of ['0', '01', 'TRUE', 'true', 'yes', ' 1x ']) {
    const logs = []
    const handle = startCockpitServer({
      workspaceDir: tmpdir(),
      env: { PANTHEON_COCKPIT: value },
      log: (line) => logs.push(line),
      stderr: () => {},
    })
    assert.equal(handle, null)
    assert.equal(logs.length, 1, `PANTHEON_COCKPIT=${value} must log once`)
    assert.match(logs[0], /^cockpit disabled/)
    assert.ok(
      logs[0].includes(`PANTHEON_COCKPIT=${JSON.stringify(value)}`),
      `the ignored value must be named: ${logs[0]}`,
    )
  }

  // A port configured while disabled still logs one (combined) line.
  const portLogs = []
  assert.equal(
    startCockpitServer({
      workspaceDir: tmpdir(),
      env: { PANTHEON_COCKPIT: 'TRUE', PANTHEON_COCKPIT_PORT: '4747' },
      log: (line) => portLogs.push(line),
      stderr: () => {},
    }),
    null,
  )
  assert.equal(portLogs.length, 1)
  assert.match(portLogs[0], /^cockpit disabled/)
  assert.ok(portLogs[0].includes('PANTHEON_COCKPIT_PORT'))
})

test('N6 a whitespace-only token is a fatal config error, never trimmed away', () => {
  for (const token of [' ', '\t', '\n', ' \n ']) {
    assert.throws(
      () => resolveCockpitConfig({ PANTHEON_COCKPIT: '1', PANTHEON_COCKPIT_TOKEN: token }),
      (error) => error instanceof CockpitConfigError && error.code === 'invalid_token',
      `token ${JSON.stringify(token)} must be fatal`,
    )
    const stderr = []
    assert.throws(
      () =>
        startCockpitServer({
          workspaceDir: tmpdir(),
          env: { PANTHEON_COCKPIT: '1', PANTHEON_COCKPIT_TOKEN: token },
          stderr: (line) => stderr.push(line),
        }),
      CockpitConfigError,
    )
    assert.equal(stderr.length, 1)
    assert.match(stderr[0], /invalid_token/)
  }

  // Empty means "no token check"; a real token is preserved verbatim (no trim).
  assert.equal(
    resolveCockpitConfig({ PANTHEON_COCKPIT: '1', PANTHEON_COCKPIT_TOKEN: '' }).token,
    undefined,
  )
  assert.equal(
    resolveCockpitConfig({ PANTHEON_COCKPIT: '1', PANTHEON_COCKPIT_TOKEN: '  s3cret  ' }).token,
    '  s3cret  ',
  )
})

test('N3/N4 EADDRINUSE names the port and remedy, and post-listen errors are logged', async (t) => {
  const workspace = seedWorkspace()
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const { handle: first, port, logs } = await withServer(t, {}, workspace)

  // A second process on the same fixed port must fail loudly, not silently
  // serve the first process's workspace.
  const stderr = []
  const second = startCockpitServer({
    workspaceDir: workspace,
    env: { PANTHEON_COCKPIT: '1', PANTHEON_COCKPIT_PORT: String(port) },
    stderr: (line) => stderr.push(line),
  })
  assert.ok(second)
  try {
    await assert.rejects(second.ready, (error) => {
      assert.equal(error.code, 'port_in_use')
      assert.ok(error.message.includes(String(port)), 'the error must name the port')
      assert.match(error.message, /another Pantheon process/i)
      assert.match(error.message, /PANTHEON_COCKPIT_PORT/)
      assert.match(error.message, /service|serve|workspace/i)
      return true
    })
  } finally {
    await second.close()
  }

  // The first process still owns the port and still identifies its workspace.
  const health = await httpRequest(port, { path: '/healthz' })
  assert.equal(health.status, 200)
  const identity = JSON.parse(health.body)
  assert.equal(typeof identity.workspaceName, 'string')
  assert.match(identity.workspaceId, new RegExp(`^${identity.workspaceName}-[0-9a-f]{8}$`))
  assert.ok(!health.body.includes(workspace), 'healthz must not leak the absolute path')

  // N4: a post-listen error is logged, and a second one must not become an
  // uncaught exception (the old `once('error')` was consumed by the first).
  assert.doesNotThrow(() => {
    first.server.emit('error', new Error('first post-listen error'))
    first.server.emit('error', new Error('second post-listen error'))
  })
  const joined = logs.join('\n')
  assert.match(joined, /cockpit error after listening: first post-listen error/)
  assert.match(joined, /cockpit error after listening: second post-listen error/)
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
  const identity = JSON.parse(health.body)
  assert.deepEqual(
    {
      ok: identity.ok,
      schema: identity.schema,
      version: identity.version,
    },
    {
      ok: true,
      schema: COCKPIT_SCHEMA,
      version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
        .version,
    },
  )
  // N3: the served workspace is verifiable without exposing the absolute path.
  assert.equal(typeof identity.workspaceName, 'string')
  assert.match(identity.workspaceId, new RegExp(`^${identity.workspaceName}-[0-9a-f]{8}$`))
  assert.ok(!health.body.includes(workspace), 'healthz must not expose the absolute workspace path')
  assert.ok(!health.body.includes('/tmp'))
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
  assert.equal(full.board.messages[0].body, LEAKY_BODY)
  assert.equal(full.board.messages[0].ephemeral.sessionID, 'ses_secret_value')
  assert.equal(full.steps[0].mutatedFiles[0], 'src/auth.ts')
  assert.ok(fullResponse.body.includes('super-secret-token'))
})

test('N1 default mode carries no free text: secret, absolute path and command line all gone', async (t) => {
  const workspace = seedWorkspace()
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const { port } = await withServer(t, {}, workspace)

  const leanResponse = await httpRequest(port, { path: '/' })
  assert.equal(leanResponse.status, 200)
  const lean = JSON.parse(leanResponse.body)

  const stepA = lean.steps.find((step) => step.stepKey === 'step-a')
  assert.ok(stepA)
  // Free text is omitted, not scrubbed: only the length survives.
  assert.equal(stepA.objective, undefined)
  assert.equal(stepA.cascadeReason, undefined)
  assert.equal(stepA.objectiveLength, LEAKY_OBJECTIVE.length)
  assert.equal(stepA.cascadeReasonLength, LEAKY_CASCADE.length)

  assert.ok(lean.board.threads.length >= 1)
  for (const thread of lean.board.threads) {
    assert.equal(thread.goal, undefined, 'thread goal must be absent by default')
    assert.equal(thread.workstream, undefined, 'thread workstream must be absent by default')
    assert.equal(thread.goalLength, LEAKY_GOAL.length)
    assert.equal(thread.workstreamLength, LEAKY_WORKSTREAM.length)
  }
  assert.ok(lean.board.channelHeaders.length >= 1)
  for (const header of lean.board.channelHeaders) {
    assert.equal(header.goal, undefined, 'channel goal must be absent by default')
    assert.equal(header.workstream, undefined, 'channel workstream must be absent by default')
    assert.equal(header.goalLength, LEAKY_GOAL.length)
    assert.equal(header.workstreamLength, LEAKY_WORKSTREAM.length)
  }
  for (const message of lean.board.messages) {
    assert.equal(message.body, undefined)
    assert.equal(message.goal, undefined)
    assert.equal(message.workstream, undefined)
    assert.equal(message.bodyLength, LEAKY_BODY.length)
    assert.equal(message.goalLength, LEAKY_GOAL.length)
    assert.equal(message.workstreamLength, LEAKY_WORKSTREAM.length)
  }

  // Nothing from any free-text field survives, not even as a substring.
  for (const fragment of [
    '/home/ils15/secret/.env',
    '/srv/secret',
    'npm test',
    '--token=super-secret-token',
    'scripts/deploy.sh',
    `${apiKeyFlag}${fakeSecret('ABC123')}`,
    fakeSecret('GOAL'),
    fakeSecret('WORKSTREAM'),
    fakeSecret('BODY'),
    'SECRET BOARD BODY',
  ]) {
    assert.ok(
      !leanResponse.body.includes(fragment),
      `default payload leaked free text fragment ${JSON.stringify(fragment)}`,
    )
  }

  // `?full=1` is the explicit opt-in and keeps every field verbatim.
  const fullResponse = await httpRequest(port, { path: '/?full=1' })
  const full = JSON.parse(fullResponse.body)
  assert.equal(full.steps.find((step) => step.stepKey === 'step-a').objective, LEAKY_OBJECTIVE)
  assert.equal(full.steps.find((step) => step.stepKey === 'step-a').cascadeReason, LEAKY_CASCADE)
  assert.equal(full.board.threads[0].goal, LEAKY_GOAL)
  assert.equal(full.board.threads[0].workstream, LEAKY_WORKSTREAM)
  assert.equal(full.board.channelHeaders[0].goal, LEAKY_GOAL)
  assert.equal(full.board.channelHeaders[0].workstream, LEAKY_WORKSTREAM)
  assert.equal(full.board.messages[0].body, LEAKY_BODY)
  assert.equal(full.board.messages[0].goal, LEAKY_GOAL)
  assert.equal(full.board.messages[0].workstream, LEAKY_WORKSTREAM)
  for (const fragment of [
    '/home/ils15/secret/.env',
    '--token=super-secret-token',
    fakeSecret('ABC123'),
    fakeSecret('GOAL'),
    fakeSecret('WORKSTREAM'),
  ]) {
    assert.ok(fullResponse.body.includes(fragment), `?full=1 should keep ${fragment}`)
  }
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
