/**
 * V2 hook canary — proves a hook callback FIRED, not just that a plugin loaded.
 *
 * Background: the V2 hook registry accepts any string as a hook name and
 * silently drops unknown ones, and no test in this repo ever dispatched a real
 * hook (the contract test hand-builds a mock context). That is how the shipped
 * `session.hook('compacting', ...)` survived: the real 2.0.16 name is
 * `'compaction'`.
 *
 * This test loads `tests/fixtures/opencode-v2-hook-canary` through a real
 * OpenCode V2 host, drives a real prompt, and reads proof written from INSIDE
 * each callback. It fails if any covered hook is silently dead.
 *
 * TWO MODES (env `PANTHEON_HOOK_CANARY_MODE`):
 *   `fixture` (default) — the self-contained canary plugin. Host-backed tests
 *     prove hook names dispatch on OpenCode; execute.before/after read lifecycle
 *     checks use an in-process replay host so no live model is asked to comply.
 *   `real` — loads `src/plugin-v2.ts` itself (via a re-export entry point).
 *     This is the regression gate: the real plugin's lifetime proof is written
 *     by an opt-in host env var (`PANTHEON_HOOK_CANARY_LIFETIME_PROOF`) that
 *     `plugin-v2.ts` only writes when the var is set, so a rename in the real
 *     file changes what the host fires and the assertions below fail. Set it
 *     with `PANTHEON_HOOK_CANARY_MODE=real npm run test:hooks`, or run
 *     `scripts/test-opencode-v2-sandbox.sh --hooks`, which sets it for you
 *     against the prepared sandbox's V2 binary.
 *
 * COVERAGE — what runs where, stated exactly:
 *   - CI's `npm run test:hooks` runs the deterministic local fixture replay and
 *     static plugin guards. Host-backed fixture checks skip without an
 *     `opencode` V2 binary; `real` mode is not run in CI.
 *   - The static `real plugin regression guards` test uses readFileSync + regex
 *     and also runs without a host. It complements, rather than replaces, the
 *     local replay fixture checks; CI has no live real-plugin coverage.
 *   - Full `real` mode (the real plugin loaded by a live host, its hooks
 *     observably firing) needs a prepared sandbox: `--hooks`.
 *
 * Host-backed prompt tests require an `opencode` binary (V2) and a usable model,
 * via PANTHEON_HOOK_CANARY_MODEL (provider/model). The local replay tests do not
 * require a host or model and can be selected with
 * PANTHEON_HOOK_CANARY_LOCAL_FIXTURE_ONLY=1.
 *
 * Isolation: a private `opencode serve` on a free port (never the shared
 * daemon on 49374), a throwaway project directory, and a proof file handed to
 * the host through the environment.
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CANARY_SRC = join(here, '..', 'fixtures', 'opencode-v2-hook-canary', 'index.ts')
const REAL_PLUGIN_SRC = join(here, '..', '..', 'src', 'plugin-v2.ts')
const UNSUPPORTED_SEED_SRC = join(here, '..', '..', 'src', 'pantheon', 'v2-unsupported.mjs')
const TEST_SRC = fileURLToPath(import.meta.url)

const BIN = process.env.PANTHEON_HOOK_CANARY_BIN ?? 'opencode'
const MODEL = process.env.PANTHEON_HOOK_CANARY_MODEL ?? 'opencode-go/mimo-v2.5'
const AGENT = process.env.PANTHEON_HOOK_CANARY_AGENT ?? 'canary'
const MODE = process.env.PANTHEON_HOOK_CANARY_MODE ?? 'fixture'
const IS_REAL = MODE === 'real'
const LOCAL_FIXTURE_ONLY = process.env.PANTHEON_HOOK_CANARY_LOCAL_FIXTURE_ONLY === '1'
const SERVER_TIMEOUT_MS = Number(process.env.PANTHEON_HOOK_CANARY_TIMEOUT_MS ?? 240000)

/** Label `plugin-v2.ts` writes only when this env var is set. */
const LIFETIME_PROOF_LABEL = 'plugin-v2:session.hook:compaction'

const BINARY_AVAILABLE = (() => {
  try {
    return spawnSync(BIN, ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
})()
const HOST_VERSION = BINARY_AVAILABLE
  ? spawnSync(BIN, ['--version'], { encoding: 'utf8' }).stdout.trim()
  : ''

/** @type {import('node:child_process').ChildProcess | null} */
let server = null
let projectDir = ''
let proofFile = ''
let request = null
let sessionID = ''
let blockedReadPath = ''
let allowedReadPath = ''
let allowedReadNonce = ''
const skipped = LOCAL_FIXTURE_ONLY
  ? 'local fixture-only run; host-backed assertions were not requested'
  : BINARY_AVAILABLE
    ? false
    : `opencode binary not found on PATH (${BIN})`

/** Run a user-visible result assertion ONLY with the real plugin loaded by the host. */
function realOnlySkip(reason) {
  return skipped || (IS_REAL ? false : reason)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

function readProof() {
  try {
    return readFileSync(proofFile, 'utf8')
  } catch {
    return ''
  }
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

before(async () => {
  if (!BINARY_AVAILABLE || LOCAL_FIXTURE_ONLY) return

  projectDir = mkdtempSync(join(tmpdir(), 'pantheon-hook-canary-'))
  proofFile = join(projectDir, 'canary-proof.log')
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  blockedReadPath = join(projectDir, `canary-blocked-read-${uniqueSuffix}.txt`)
  allowedReadPath = join(projectDir, `canary-allowed-read-${uniqueSuffix}.txt`)
  allowedReadNonce = `CANARY-READ-ALLOWED-${uniqueSuffix}`
  writeFileSync(blockedReadPath, `CANARY-BLOCKED-READ-FILE-${uniqueSuffix}\n`)
  writeFileSync(allowedReadPath, `${allowedReadNonce}\n`)

  const pluginDir = join(projectDir, '.opencode', 'plugins', 'canary')
  mkdirSync(pluginDir, { recursive: true })
  if (IS_REAL) {
    // Re-export the real plugin so the host loads src/plugin-v2.ts itself.
    // The path is emitted as a JSON string so Windows backslashes stay valid.
    writeFileSync(
      join(pluginDir, 'index.ts'),
      `export { default } from ${JSON.stringify(REAL_PLUGIN_SRC)}\n`,
    )
  } else {
    writeFileSync(join(pluginDir, 'index.ts'), readFileSync(CANARY_SRC, 'utf8'))
  }

  // A self-contained read-enabled agent so this canary does not depend on
  // which host agents happen to allow the exact file-read action.
  const config = {
    $schema: 'https://opencode.ai/config.json',
    agents: {
      [AGENT]: {
        mode: 'primary',
        permissions: [{ action: 'read', resource: '*', effect: 'allow' }],
      },
    },
  }
  writeFileSync(join(projectDir, 'opencode.json'), JSON.stringify(config, null, 2))

  const port = await freePort()
  server = spawn(
    BIN,
    ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs'],
    {
      cwd: projectDir,
      env: {
        ...process.env,
        // Keep all live canary state out of the developer's shared DB.
        OPENCODE_DB: join(projectDir, 'opencode.db'),
        PANTHEON_HOOK_CANARY_PROOF: proofFile,
        PANTHEON_HOOK_CANARY_PERMISSION_PROOF: proofFile,
        PANTHEON_HOOK_CANARY_BLOCKED_READ_PATH: blockedReadPath,
        // Only the real plugin reads this; it opts the shipped handler into
        // writing an observable lifetime proof to the same file.
        PANTHEON_HOOK_CANARY_LIFETIME_PROOF: proofFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  let stdout = ''
  server.stdout.on('data', (chunk) => {
    stdout += String(chunk)
  })
  let stderr = ''
  server.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })

  const password = await waitFor(
    () => /server password (\S+)/.exec(stdout)?.[1],
    SERVER_TIMEOUT_MS,
    `opencode serve to print a password (stderr: ${stderr.slice(0, 400)})`,
  )

  const basic = Buffer.from(`opencode:${password}`).toString('base64')
  const headers = {
    authorization: `Basic ${basic}`,
    'x-opencode-directory': encodeURIComponent(projectDir),
    'content-type': 'application/json',
  }

  request = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
    })
    if (!response.ok) {
      const error = new Error(
        `${method} ${path} -> HTTP ${response.status}: ${await response.text()}`,
      )
      error.status = response.status
      throw error
    }
    const text = await response.text()
    return text === '' ? undefined : JSON.parse(text)
  }

  await waitFor(
    async () => {
      try {
        await request('GET', '/api/session')
        return true
      } catch {
        return false
      }
    },
    SERVER_TIMEOUT_MS,
    'opencode serve to become ready',
  )

  const [providerID, ...rest] = MODEL.split('/')
  const id = rest.join('/')
  const created = await request('POST', '/api/session', {
    title: 'pantheon-hook-canary',
    agent: AGENT,
    model: { providerID, id },
  })
  sessionID = created.data.id
})

after(async () => {
  if (server && !server.killed) server.kill('SIGTERM')
  if (projectDir) rmSync(projectDir, { recursive: true, force: true })
})

/** Use the current V2 route, with the 2.0.25-era route as a 404-only fallback. */
async function waitForPromptCompletion(requestFn, targetSessionID) {
  try {
    return await requestFn('POST', `/api/session/${targetSessionID}/wait`)
  } catch (error) {
    if (error?.status !== 404) throw error
    return requestFn('POST', `/api/experimental/session/${targetSessionID}/wait`)
  }
}

async function prompt(text) {
  await request('POST', `/api/session/${sessionID}/prompt`, { text })
  await waitForPromptCompletion(request, sessionID)
}

async function messagesText() {
  const listed = await request('GET', `/api/session/${sessionID}/message`)
  return JSON.stringify(listed)
}

function parseProofRecords(proof) {
  return proof
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(' ')
      if (separator < 0) return { label: line }

      const label = line.slice(0, separator)
      const detail = line.slice(separator + 1)
      try {
        return { label, ...JSON.parse(detail) }
      } catch {
        return { label, detail }
      }
    })
}

function messageToolParts(messages) {
  const entries = Array.isArray(messages)
    ? messages
    : Array.isArray(messages?.data)
      ? messages.data
      : []
  return entries.flatMap((message) => {
    if (Array.isArray(message?.parts)) return message.parts
    if (Array.isArray(message?.content)) return message.content
    return []
  })
}

function messageTextParts(messages) {
  const entries = Array.isArray(messages)
    ? messages
    : Array.isArray(messages?.data)
      ? messages.data
      : []
  return entries.flatMap((message) => {
    const parts = Array.isArray(message?.parts)
      ? message.parts
      : Array.isArray(message?.content)
        ? message.content
        : []
    return parts.filter((part) => part?.type === 'text' && typeof part.text === 'string')
  })
}

function partCallID(part) {
  return part.callID ?? part.toolCallID ?? part.id
}

function toolInput(part) {
  return part.state?.input ?? part.input ?? {}
}

function toolInputPath(part) {
  const input = toolInput(part)
  return input.filePath ?? input.filepath ?? input.path ?? input.file
}

function samePath(actualPath, expectedPath) {
  return (
    typeof actualPath === 'string' &&
    resolve(projectDir || '.', actualPath) === resolve(expectedPath)
  )
}

function completedToolOutput(state) {
  const output = state?.output ?? state?.result?.output ?? state?.content ?? state?.result?.content
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output
      .map((item) =>
        typeof item === 'string' ? item : typeof item?.text === 'string' ? item.text : '',
      )
      .join('\n')
  }
  return ''
}

function toolPartsNamed(messages, toolName) {
  const allToolCalls = messageToolParts(messages).filter((part) => part?.type === 'tool')
  return allToolCalls.filter((part) => part.tool === toolName || part.name === toolName)
}

function findToolCallForPath(messages, toolName, expectedPath) {
  const matchingTool = toolPartsNamed(messages, toolName)
  const target = matchingTool.find((part) => samePath(toolInputPath(part), expectedPath))
  const observedText = messageTextParts(messages)
    .map((part) => part.text)
    .join(' ')
    .slice(-400)
  assert.ok(
    target,
    `no ${toolName} tool-call part targeted the exact path ${expectedPath}; recorded ${toolName} paths: ${matchingTool.map((part) => String(toolInputPath(part) ?? '<missing>')).join(', ') || 'none'}; response text is not tool evidence: ${observedText || 'none'}`,
  )
  return target
}

function findCompletedReadCall(messages, expectedPath, nonce) {
  const target = findToolCallForPath(messages, 'read', expectedPath)
  const callID = partCallID(target)
  const state = target.state
  assert.equal(
    state?.status,
    'completed',
    `read tool call ${callID ?? '<no call ID>'} for ${expectedPath} did not complete (state=${state?.status ?? 'missing'}); no completed read result is available`,
  )

  const output = completedToolOutput(state)
  assert.ok(
    output.includes(nonce),
    `completed read tool result/output did not contain the unique file nonce (callID=${callID ?? '<no call ID>'}; result=${JSON.stringify(output).slice(0, 400)})`,
  )
  return target
}

/**
 * Assert the USER-VISIBLE read result carries a hashline tag on the nonce line.
 *
 * This is the REAL execute.after parity contract. A recorded proof event only
 * proves a callback fired; only the real plugin-v2 rewrites the read output, so
 * the tag must appear in the session's completed tool result itself.
 */
function assertHashlineTaggedRead(output, nonce) {
  const text = typeof output === 'string' ? output : String(output)
  const match = text.split('\n').find((line) => line.includes(nonce))
  assert.ok(
    match !== undefined,
    `completed read result did not contain the nonce: ${text.slice(0, 200)}`,
  )
  assert.match(
    match,
    /^\s*[0-9]+#[A-Za-z0-9]+\|/,
    `the nonce line is NOT hashline-tagged — user-visible parity is missing: ${match}`,
  )
}

function appendedProofRecords(beforeProof, afterProof) {
  assert.ok(
    afterProof.startsWith(beforeProof),
    'proof file changed instead of only appending records',
  )
  return parseProofRecords(afterProof.slice(beforeProof.length))
}

function assertExecuteBeforeForCall(beforeProof, afterProof, toolCall) {
  const toolName = toolCall.tool ?? toolCall.name
  const newBeforeEvents = appendedProofRecords(beforeProof, afterProof).filter(
    (record) => record.label === 'tool.hook:execute.before' && record.tool === toolName,
  )
  const callID = partCallID(toolCall)
  const matchingEvent = callID
    ? newBeforeEvents.find((record) => record.callID === callID)
    : newBeforeEvents[0]

  assert.ok(
    matchingEvent,
    `${toolName} tool call ${callID ?? '<no call ID>'} had no matching new execute.before event`,
  )
  return matchingEvent
}

function assertExecuteAfterForCall(beforeProof, afterProof, toolCall) {
  const toolName = toolCall.tool ?? toolCall.name
  assert.equal(
    toolCall?.state?.status,
    'completed',
    `cannot check execute.after because the intended ${toolName} call did not complete`,
  )

  const newToolAfterEvents = appendedProofRecords(beforeProof, afterProof).filter(
    (record) => record.label === 'tool.hook:execute.after' && record.tool === toolName,
  )
  const callID = partCallID(toolCall)
  const matchingEvent = callID
    ? newToolAfterEvents.find((record) => record.callID === callID)
    : newToolAfterEvents.find((record) => record.status === 'completed')

  assert.ok(
    matchingEvent,
    `completed ${toolName} call ${callID ?? '<no call ID>'} had no matching new execute.after event${callID ? ` (new ${toolName} after call IDs: ${newToolAfterEvents.map((record) => record.callID ?? '<missing>').join(', ') || 'none'})` : ''}`,
  )
  assert.equal(
    matchingEvent.status,
    'completed',
    'matching execute.after did not report completed status',
  )
  return matchingEvent
}

function assertReadPermissionObserved(beforeProof, afterProof, expectedSessionID) {
  const readPermissionEvent = appendedProofRecords(beforeProof, afterProof).find(
    (record) =>
      record.label === 'permission.hook:evaluate' &&
      record.action === 'read' &&
      record.sessionID === expectedSessionID,
  )
  assert.ok(
    readPermissionEvent,
    'permission.evaluate did not record action=read in this prompt window; this is callback observation only, not a security-enforcement assertion',
  )
}

function assertLiveDelegationDeny(beforeProof, afterProof, toolCall) {
  const records = appendedProofRecords(beforeProof, afterProof).filter(
    (record) => record.label === 'permission.evaluate',
  )
  const targetRecord = records.find(
    (record) =>
      Array.isArray(record.resources) &&
      record.resources.some(
        (resource) =>
          resource === 'demeter' ||
          (resource && typeof resource === 'object' && resource.target === 'demeter'),
      ),
  )
  assert.ok(
    targetRecord,
    'OpenCode V2.0.25 did not provide permission.evaluate resources[] containing target demeter',
  )
  for (const field of ['resources', 'agent', 'sessionID', 'effect']) {
    assert.ok(
      targetRecord.eventFields?.includes(field),
      `OpenCode V2.0.25 permission.evaluate event did not expose ${field}`,
    )
  }
  assert.equal(targetRecord.outputPresent, true, 'permission hook output argument was absent')
  assert.equal(
    targetRecord.statusBefore,
    'ask',
    'permission hook did not receive an undecided output',
  )
  assert.equal(targetRecord.statusAfter, 'deny', 'Pantheon hook did not force a deny for demeter')
  assert.notEqual(
    targetRecord.statusBefore,
    targetRecord.statusAfter,
    'canary proof must show a real output mutation, not infer deny from policy',
  )
  assert.equal(
    toolCall?.state?.status,
    'error',
    'host should reject the delegated task before its body can return the canary marker',
  )
  assert.doesNotMatch(
    JSON.stringify(toolCall?.state?.output ?? toolCall?.state?.result ?? ''),
    /CANARY-DELEGATION-BODY-RAN/,
    'denied delegated body unexpectedly returned its marker',
  )
}

test('read-result assertion rejects a nonce present only in prompt text', () => {
  const nonce = 'CANARY-READ-prompt-only'
  const filePath = '/tmp/canary-allowed-read.txt'
  const messages = {
    data: [{ content: [{ type: 'text', text: `Read ${filePath}; it contains ${nonce}` }] }],
  }

  assert.throws(() => findCompletedReadCall(messages, filePath, nonce), /no read tool-call part/i)
})

test('session completion uses the current V2 wait route', async () => {
  const calls = []
  const requestStub = async (_method, path) => {
    calls.push(path)
    return { ok: true }
  }

  const result = await waitForPromptCompletion(requestStub, 'ses-current')

  assert.deepEqual(calls, ['/api/session/ses-current/wait'])
  assert.deepEqual(result, { ok: true })
})

test('session completion falls back to the legacy route only on 404', async () => {
  const calls = []
  const requestStub = async (_method, path) => {
    calls.push(path)
    if (path === '/api/session/ses-legacy/wait') {
      const error = new Error('not found')
      error.status = 404
      throw error
    }
    return { ok: true }
  }

  const result = await waitForPromptCompletion(requestStub, 'ses-legacy')

  assert.deepEqual(calls, [
    '/api/session/ses-legacy/wait',
    '/api/experimental/session/ses-legacy/wait',
  ])
  assert.deepEqual(result, { ok: true })
})

test('session completion does not hide non-404 host errors', async () => {
  const calls = []
  const requestStub = async (_method, path) => {
    calls.push(path)
    const error = new Error('unauthorized')
    error.status = 401
    throw error
  }

  await assert.rejects(() => waitForPromptCompletion(requestStub, 'ses-error'), /unauthorized/)
  assert.deepEqual(calls, ['/api/session/ses-error/wait'])
})

test('execute.after assertion ignores stale execute.before from the blocked read', () => {
  const blockedRead = `tool.hook:execute.before ${JSON.stringify({
    tool: 'read',
    callID: 'read-call-1',
    sessionID: 'ses-canary',
  })}\n`
  const successfulRead = {
    tool: 'read',
    callID: 'read-call-2',
    state: {
      status: 'completed',
      input: { filePath: '/tmp/canary-allowed-read.txt' },
      output: 'CANARY-READ-allowed\n',
    },
  }

  assert.throws(
    () => assertExecuteAfterForCall(blockedRead, blockedRead, successfulRead),
    /no matching new execute\.after/i,
  )
})

test('execute.after assertion rejects a completed read with no after event', () => {
  const beforeProof = 'setup\n'
  const afterProof =
    beforeProof +
    `tool.hook:execute.before ${JSON.stringify({ tool: 'read', callID: 'read-call-2' })}\n`
  const completedRead = {
    tool: 'read',
    callID: 'read-call-2',
    state: {
      status: 'completed',
      input: { filePath: '/tmp/canary-allowed-read.txt' },
      output: 'CANARY-READ-allowed\n',
    },
  }

  assert.throws(
    () => assertExecuteAfterForCall(beforeProof, afterProof, completedRead),
    /no matching new execute\.after/i,
  )
})

test('execute.before assertion correlates the blocked read by call ID', () => {
  const beforeProof = 'setup\n'
  const blockedRead = {
    tool: 'read',
    callID: 'read-call-blocked',
    state: { status: 'error', input: { filePath: '/tmp/canary-blocked-read.txt' } },
  }
  const afterProof =
    beforeProof +
    `tool.hook:execute.before ${JSON.stringify({
      tool: 'read',
      callID: 'read-call-blocked',
      sessionID: 'ses-canary',
    })}\n`

  assert.equal(
    assertExecuteBeforeForCall(beforeProof, afterProof, blockedRead).callID,
    'read-call-blocked',
  )
})

test('read-result assertion requires nonce in completed tool output, not only arguments', () => {
  const nonce = 'CANARY-READ-args-only'
  const filePath = '/tmp/canary-allowed-read.txt'
  const messages = {
    data: [
      {
        content: [
          {
            type: 'tool',
            tool: 'read',
            callID: 'read-call-3',
            state: {
              status: 'completed',
              input: { filePath },
              output: 'command completed without expected output',
            },
          },
        ],
      },
    ],
  }

  assert.throws(() => findCompletedReadCall(messages, filePath, nonce), /tool result\/output/i)
})

test('read-result assertion accepts the nonce only from a completed read result', () => {
  const nonce = 'CANARY-READ-output-proof'
  const filePath = '/tmp/canary-allowed-read-output-proof.txt'
  const call = {
    type: 'tool',
    tool: 'read',
    callID: 'read-call-output-proof',
    state: {
      status: 'completed',
      input: { filePath },
      content: [{ type: 'text', text: `Read file ${filePath}\n${nonce}\n` }],
    },
  }

  assert.equal(findCompletedReadCall({ data: [{ parts: [call] }] }, filePath, nonce), call)
})

test('read-result assertion rejects a read call that did not complete', () => {
  const nonce = 'CANARY-READ-running-only'
  const filePath = '/tmp/canary-allowed-read-running.txt'
  const messages = {
    data: [
      {
        parts: [
          {
            type: 'tool',
            tool: 'read',
            callID: 'read-call-running',
            state: { status: 'running', input: { filePath } },
          },
        ],
      },
    ],
  }

  assert.throws(() => findCompletedReadCall(messages, filePath, nonce), /no completed read result/i)
})

test('hashline read assertion accepts a tagged nonce line', () => {
  assert.doesNotThrow(() =>
    assertHashlineTaggedRead('1#AB12|CANARY-READ-tagged\n', 'CANARY-READ-tagged'),
  )
})

test('hashline read assertion rejects an untagged nonce line', () => {
  assert.throws(
    () => assertHashlineTaggedRead('1: CANARY-READ-untagged\n', 'CANARY-READ-untagged'),
    /NOT hashline-tagged/,
  )
})

test('hashline read assertion rejects a result that lacks the nonce', () => {
  assert.throws(
    () => assertHashlineTaggedRead('1#AB12|something else\n', 'CANARY-READ-missing'),
    /did not contain the nonce/,
  )
})

test('permission.evaluate assertion requires a new read action for this session', () => {
  const beforeProof = `permission.hook:evaluate ${JSON.stringify({ action: 'read', sessionID: 'ses-canary' })}\n`
  const unrelatedAfterProof =
    beforeProof +
    `permission.hook:evaluate ${JSON.stringify({ action: 'read', sessionID: 'ses-other' })}\n`

  assert.throws(
    () => assertReadPermissionObserved(beforeProof, unrelatedAfterProof, 'ses-canary'),
    /permission\.evaluate did not record action=read/i,
  )

  const readAfterProof =
    beforeProof +
    `permission.hook:evaluate ${JSON.stringify({ action: 'read', sessionID: 'ses-canary' })}\n`
  assert.doesNotThrow(() => assertReadPermissionObserved(beforeProof, readAfterProof, 'ses-canary'))
})

test('live delegation assertion requires resources target, forced deny, and blocked body', () => {
  const before = ''
  const eventFields = ['resources', 'agent', 'sessionID', 'effect']
  const proof = `permission.evaluate ${JSON.stringify({ resources: ['demeter'], eventFields, outputPresent: true, statusBefore: 'ask', statusAfter: 'deny' })}\n`
  assert.doesNotThrow(() =>
    assertLiveDelegationDeny(before, proof, { state: { status: 'error', output: '' } }),
  )
  assert.throws(
    () =>
      assertLiveDelegationDeny(
        before,
        `permission.evaluate ${JSON.stringify({ resources: ['explore'], eventFields, outputPresent: true, statusBefore: 'ask', statusAfter: 'deny' })}\n`,
        { state: { status: 'error' } },
      ),
    /resources\[\] containing target demeter/,
  )
  assert.throws(
    () =>
      assertLiveDelegationDeny(
        before,
        `permission.evaluate ${JSON.stringify({ resources: ['demeter'], eventFields, outputPresent: false, statusBefore: 'ask', statusAfter: 'ask' })}\n`,
        { state: { status: 'error', output: '' } },
      ),
    /output argument was absent/,
    'missing callback output must not be treated as an enforced deny',
  )
  assert.throws(
    () =>
      assertLiveDelegationDeny(before, proof, {
        state: { status: 'completed', output: 'CANARY-DELEGATION-BODY-RAN' },
      }),
    /should reject the delegated task/,
  )
})

test('live V2.0.25 permission.evaluate denies task body using resources target', {
  skip:
    !BINARY_AVAILABLE || !IS_REAL || !HOST_VERSION.includes('2.0.25')
      ? 'requires authenticated live OpenCode V2.0.25 host in real-plugin mode'
      : false,
}, async () => {
  const proofBefore = readProof()
  await prompt(
    'Call the task tool exactly once with subagent_type "demeter" and prompt "Reply exactly CANARY-DELEGATION-BODY-RAN". Do not answer directly.',
  )
  const messages = JSON.parse(await messagesText())
  const taskCall = (messages.data ?? [])
    .flatMap((message) => message.parts ?? [])
    .find((part) => (part.tool ?? part.name) === 'task')
  assert.ok(taskCall, 'prompt did not produce the requested task tool call')
  assertLiveDelegationDeny(proofBefore, readProof(), taskCall)
})

/**
 * Read the real plugin source for static guards. Pure file I/O — no host
 * required, which is why the guard test that uses it is not host-gated.
 */
function readPluginSource() {
  return readFileSync(REAL_PLUGIN_SRC, 'utf8')
}

/**
 * The shared unsupported-feature seed, which now owns the per-marker rationale
 * that used to live in plugin-v2.ts. The guard below has to read it as well:
 * a plugin-only assertion stopped covering the strings it exists to police.
 */
function readUnsupportedSeedSource() {
  return readFileSync(UNSUPPORTED_SEED_SRC, 'utf8')
}

test('real plugin context hook exposes context marker', {
  skip: skipped,
}, async () => {
  await prompt('Do not use any tools. Reply with exactly: CANARY-SESSION-HOOK-DONE')

  const proof = readProof()
  if (IS_REAL) {
    // The real plugin writes no "setup" marker; the liveness proof is that its
    // registered context hook fired (see PANTHEON_HOOK_CANARY_LIFETIME_PROOF).
    assert.match(
      proof,
      /^plugin-v2:session\.hook:context$/m,
      'the real plugin\'s session.hook("context") never fired',
    )
  } else {
    assert.match(proof, /^setup$/m, 'canary setup() did not run')
    assert.match(proof, /^session\.hook:prompt$/m, 'session.hook("prompt") never fired')
    assert.match(proof, /^session\.hook:context$/m, 'session.hook("context") never fired')
  }
})

/**
 * Register the real fixture plugin against a deterministic in-process host.
 * This drives the same callback with explicit tool input and does not ask a
 * live model to comply with a tool-use instruction. Separate tests above/below
 * continue to exercise callbacks through the real V2 host.
 */
async function createFixtureHookHost(proofPath, blockedPath, targetSessionID) {
  const previousProof = process.env.PANTHEON_HOOK_CANARY_PROOF
  const previousBlockedPath = process.env.PANTHEON_HOOK_CANARY_BLOCKED_READ_PATH
  process.env.PANTHEON_HOOK_CANARY_PROOF = proofPath
  process.env.PANTHEON_HOOK_CANARY_BLOCKED_READ_PATH = blockedPath

  let plugin
  try {
    const moduleURL = `${pathToFileURL(CANARY_SRC).href}?fixture=${Date.now()}-${Math.random()}`
    plugin = (await import(moduleURL)).default
  } finally {
    if (previousProof === undefined) delete process.env.PANTHEON_HOOK_CANARY_PROOF
    else process.env.PANTHEON_HOOK_CANARY_PROOF = previousProof
    if (previousBlockedPath === undefined) delete process.env.PANTHEON_HOOK_CANARY_BLOCKED_READ_PATH
    else process.env.PANTHEON_HOOK_CANARY_BLOCKED_READ_PATH = previousBlockedPath
  }

  const callbacks = new Map()
  await plugin.setup({
    session: { hook: async (name, callback) => callbacks.set(`session.${name}`, callback) },
    tool: { hook: async (name, callback) => callbacks.set(`tool.${name}`, callback) },
    permission: {
      hook: async (name, callback) => callbacks.set(`permission.${name}`, callback),
    },
  })

  return {
    proof: () => readFileSync(proofPath, 'utf8'),
    async read(filePath, callID) {
      const event = { tool: 'read', input: { filePath }, id: callID, sessionID: targetSessionID }
      await callbacks.get('permission.evaluate')({ action: 'read', sessionID: targetSessionID })
      const previousBlockedPath = process.env.PANTHEON_HOOK_CANARY_BLOCKED_READ_PATH
      process.env.PANTHEON_HOOK_CANARY_BLOCKED_READ_PATH = blockedPath
      try {
        await callbacks.get('tool.execute.before')(event)
      } catch (error) {
        return {
          status: 'error',
          input: event.input,
          error: { message: error instanceof Error ? error.message : String(error) },
          executorCalled: false,
        }
      } finally {
        if (previousBlockedPath === undefined)
          delete process.env.PANTHEON_HOOK_CANARY_BLOCKED_READ_PATH
        else process.env.PANTHEON_HOOK_CANARY_BLOCKED_READ_PATH = previousBlockedPath
      }

      const output = readFileSync(filePath, 'utf8')
      await callbacks.get('tool.execute.after')({ ...event, status: 'completed', output })
      return { status: 'completed', input: event.input, output, executorCalled: true }
    },
  }
}

test('fixture canary execute.before deterministically blocks a read without returning its body', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-hook-fixture-blocked-'))
  const proofPath = join(root, 'proof.log')
  const blockedPath = join(root, 'blocked.txt')
  const session = 'ses-fixture-blocked'
  const callID = 'call-fixture-blocked'
  writeFileSync(blockedPath, 'CANARY-BLOCKED-READ-FILE-secret-body\n')
  try {
    const host = await createFixtureHookHost(proofPath, blockedPath, session)
    const proofBefore = host.proof()
    const result = await host.read(blockedPath, callID)
    const messages = {
      data: [
        {
          parts: [
            {
              type: 'tool',
              tool: 'read',
              callID,
              state: { status: result.status, input: result.input, error: result.error },
            },
          ],
        },
      ],
    }
    const readError = findToolCallForPath(messages, 'read', blockedPath)
    assert.equal(readError.state?.status, 'error', 'the blocked read tool call did not fail')
    assert.match(JSON.stringify(readError.state?.error), /CANARY_BLOCKED_READ/)
    assert.equal(result.executorCalled, false, 'the prohibited file body reached the read executor')
    assert.doesNotMatch(JSON.stringify(readError.state), /CANARY-BLOCKED-READ-FILE-secret-body/)
    const blockedBefore = assertExecuteBeforeForCall(proofBefore, host.proof(), readError)
    assert.equal(blockedBefore.filePath, blockedPath)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fixture canary deterministically correlates allowed read with execute.after', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-hook-fixture-allowed-'))
  const proofPath = join(root, 'proof.log')
  const allowedPath = join(root, 'allowed.txt')
  const nonce = 'CANARY-READ-ALLOWED-fixture'
  const session = 'ses-fixture-allowed'
  const callID = 'call-fixture-allowed'
  writeFileSync(allowedPath, `${nonce}\n`)
  try {
    const host = await createFixtureHookHost(proofPath, join(root, 'blocked.txt'), session)
    const proofBefore = host.proof()
    const result = await host.read(allowedPath, callID)
    const messages = {
      data: [
        {
          parts: [
            {
              type: 'tool',
              tool: 'read',
              callID,
              state: { status: result.status, input: result.input, output: result.output },
            },
          ],
        },
      ],
    }
    const readCall = findCompletedReadCall(messages, allowedPath, nonce)
    const readAfter = assertExecuteAfterForCall(proofBefore, host.proof(), readCall)
    assert.equal(readAfter.filePath, allowedPath)
    assert.equal(result.executorCalled, true)
    assertReadPermissionObserved(proofBefore, host.proof(), session)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('real plugin execute.after exposes a hashline-tagged read result', {
  skip: realOnlySkip(
    'only the real plugin-v2 performs execute.after augmentation; the fixture records proof events, so a user-visible tag cannot be observed in fixture mode',
  ),
}, async () => {
  // The parity contract is USER-VISIBLE: a recorded execute.after event alone
  // is instrumentation. The real plugin must rewrite the completed read output
  // so the session shows `N#tag|content`.
  await prompt(
    `Use only the read tool to read this exact file path: ${allowedReadPath}. Do not use any other tool. Wait for the read result, then reply with exactly: CANARY-HASHLINE-READ-DONE`,
  )
  const messages = JSON.parse(await messagesText())
  const readCall = findCompletedReadCall(messages, allowedReadPath, allowedReadNonce)
  assertHashlineTaggedRead(completedToolOutput(readCall.state), allowedReadNonce)
})

test('fixture session.hook("prompt") fires on a host-backed prompt admission', {
  skip: skipped || IS_REAL,
}, async () => {
  const proofBefore = readProof()
  await request('POST', `/api/session/${sessionID}/prompt`, {
    text: 'CANARY-HOOK-ADMISSION-ONLY; no tool is required',
  })
  await waitFor(
    () => readProof() !== proofBefore && readProof().includes('session.hook:prompt'),
    10000,
    'fixture session.hook("prompt") after host prompt admission',
  )
  assert.match(readProof(), /^session\.hook:prompt$/m)
})

test('session.hook("compaction") fires on compaction', { skip: skipped }, async () => {
  // The real plugin proves its own registration via the opt-in lifetime
  // proof; the fixture proves the name itself. Both are the same assertion
  // from the host's point of view: a callback registered under `compaction`
  // fired. A rename back to `compacting` makes this wait time out.
  const label = IS_REAL ? LIFETIME_PROOF_LABEL : 'session.hook:compaction'
  await request('POST', `/api/session/${sessionID}/compact`, {})
  await waitFor(
    () => readProof().includes(label),
    60000,
    `session.hook("compaction") (${label}) to fire after a compact request`,
  )
  assert.ok(true)
})

test('negative control: session.hook("compacting") NEVER fires', { skip: skipped }, () => {
  assert.doesNotMatch(
    readProof(),
    /:hook:compacting$/m,
    'the wrong hook name "compacting" fired — the negative control is broken, or the host now accepts it',
  )
})

// Deliberately NOT gated on `skipped || !IS_REAL`: every assertion below is a
// pure readFileSync + regex against src/plugin-v2.ts. It needs no host, no
// model, and no port, so gating it on a live V2 host threw away hostless
// regression protection for nothing. This is the one test in this file that
// runs everywhere — plain `npm run test:hooks` on any machine, in either mode.
// The behavioural half (a callback actually firing) stays host-gated above.
test('real plugin regression guards: honest transform support claims and correct compaction name', () => {
  const source = readPluginSource()
  // The four mismatches this canary was built to catch. A regression to the
  // shipped 2.0.16-mismatched API would reappear as one of these.
  assert.doesNotMatch(
    source,
    /hook\('compacting'/,
    'real plugin registers the dead "compacting" name',
  )
  assert.match(
    source,
    /hook\('compaction'/,
    'real plugin no longer registers session.hook("compaction")',
  )
  assert.doesNotMatch(
    source,
    /context\.catalog\b/,
    'real plugin calls the removed ctx.catalog domain',
  )
  assert.match(
    source,
    /ctx\.integration and\s*\n?\s*ctx\.skill/,
    'host-supported integration and skill transform domains are not documented',
  )
  // The host-context claims must cite the host version the canary MEASURED, not
  // an older probe. A comment that says "2.0.18" here is exactly the drift that
  // let a stale claim about `ctx.tool` survive: the 2.0.22 host has
  // ctx.tool.transform and ctx.tool.hook, and the header now records that with
  // the measurement behind it.
  assert.doesNotMatch(
    source,
    /2\.0\.18 runtime probe/,
    'the host-context claims still cite the superseded 2.0.18 probe',
  )
  assert.match(
    source,
    /ctx\.tool\.transform\s+function/,
    'the measured 2.0.22 ctx.tool.transform result is not documented',
  )
  assert.match(
    source,
    /ctx\.catalog\s+absent/,
    'the measured 2.0.22 ctx.catalog absence is not documented',
  )
  // The four domains the 1.18.x SDK types omit must stay named, because that is
  // what `hostDomains` exists for and what the tool canary proves on a host.
  for (const domain of ['tool', 'event', 'permission', 'session']) {
    assert.match(
      source,
      new RegExp(`ctx\\.${domain}`),
      `ctx.${domain} is no longer named; hostDomains would be undocumented`,
    )
  }
  assert.match(
    source,
    /no `tool`, `event`, `permission` or `session`/,
    'the SDK-domain gap is no longer stated',
  )
  assert.doesNotMatch(
    source,
    /ctx\.integration.*no longer a context domain|ctx\.skill.*no longer a context domain/s,
    'plugin must not describe integration or skill as host-absent',
  )
  // Same guard, second source: the per-marker rationale moved into the shared
  // seed, so the stale wording could equally well be written there. Reading only
  // the plugin would leave that copy unpoliced.
  assert.doesNotMatch(
    readUnsupportedSeedSource(),
    /ctx\.integration.*no longer a context domain|ctx\.skill.*no longer a context domain/s,
    'the unsupported-feature seed must not describe integration or skill as host-absent',
  )
  assert.doesNotMatch(
    source,
    /context\.(?:integration|skill)\.transform/,
    'this S5b fix must not implement integration or skill transforms',
  )
  assert.doesNotMatch(
    source,
    /draft\.source\(/,
    'real plugin calls the removed SkillEditor.source()',
  )
  assert.doesNotMatch(source, /hook\('compacting'/, 'real plugin registers "compacting"')
  assert.match(source, /Promise\.allSettled/, 'transform setup must remain individually settled')
  assert.doesNotMatch(
    source,
    /would reject\s+setup\(\).*kill every hook|rejection also\s+kills every later hook/is,
    'setup comments must not claim a rejected transform kills later hook registrations',
  )
  // The context handler must emit canonical SystemParts, not raw pushes.
  assert.doesNotMatch(
    source,
    /rawSystem\.push\(toSystemEntry/,
    'real plugin pushes non-normalized system entries',
  )
})

test('fixture read lifecycle assertions are deterministic and independent of model use', () => {
  const source = readFileSync(TEST_SRC, 'utf8')
  const testMarker =
    "\ntest('fixture read lifecycle assertions are deterministic and independent of model use'"
  const testStart = source.indexOf(testMarker)
  assert.notEqual(testStart, -1, 'lifecycle assertions test must be present')
  const canaryImplementation = source.slice(0, testStart)
  assert.match(
    canaryImplementation,
    /createFixtureHookHost/,
    'read lifecycle must be replayed without a model',
  )
  assert.doesNotMatch(
    canaryImplementation,
    /fixtureOnlySkip/,
    'model-dependent fixture skips must be removed',
  )
  assert.doesNotMatch(
    canaryImplementation,
    /if \(IS_REAL\) return/,
    'real mode must not silently pass by returning from an assertion',
  )
})
