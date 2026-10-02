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
 *   `fixture` (default) — the self-contained canary plugin. Proves the HOOK
 *     NAMES are real: every covered name is registered on a live host and the
 *     callback observably fires.
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
 *   - CI runs NEITHER behavioural mode usefully. The `npm run test:hooks` step
 *     in ci.yml sets no MODE (so it would be `fixture`) and the runner has no
 *     `opencode` V2 binary on PATH, so every host-gated test SKIPS. CI has no
 *     real-plugin coverage.
 *   - The static half — the `real plugin regression guards` test — is pure
 *     readFileSync + regex and is NOT host-gated, so it does run in CI and in
 *     `npm run test:hooks` on any machine. That is the only `real`-mode
 *     protection CI actually gets.
 *   - Full `real` mode (the real plugin loaded by a live host, its hooks
 *     observably firing) needs a prepared sandbox: `--hooks`.
 *
 * Requirements (skipped when unavailable, so `npm test` stays green on a
 * machine without a host — the static guard above is exempt):
 *   - an `opencode` binary (V2) on PATH, or PANTHEON_HOOK_CANARY_BIN
 *   - a usable model, via PANTHEON_HOOK_CANARY_MODEL (provider/model)
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
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CANARY_SRC = join(here, '..', 'fixtures', 'opencode-v2-hook-canary', 'index.ts')
const REAL_PLUGIN_SRC = join(here, '..', '..', 'src', 'plugin-v2.ts')
const TEST_SRC = fileURLToPath(import.meta.url)

const BIN = process.env.PANTHEON_HOOK_CANARY_BIN ?? 'opencode'
const MODEL = process.env.PANTHEON_HOOK_CANARY_MODEL ?? 'opencode-go/mimo-v2.5'
const AGENT = process.env.PANTHEON_HOOK_CANARY_AGENT ?? 'canary'
const MODE = process.env.PANTHEON_HOOK_CANARY_MODE ?? 'fixture'
const IS_REAL = MODE === 'real'
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

/** @type {import('node:child_process').ChildProcess | null} */
let server = null
let projectDir = ''
let proofFile = ''
let request = null
let sessionID = ''
let blockedReadPath = ''
let allowedReadPath = ''
let allowedReadNonce = ''
const skipped = BINARY_AVAILABLE ? false : `opencode binary not found on PATH (${BIN})`

function fixtureOnlySkip(reason) {
  return skipped || (IS_REAL ? reason : false)
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
  if (!BINARY_AVAILABLE) return

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
  writeFileSync(
    join(projectDir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        agent: {
          [AGENT]: {
            mode: 'primary',
            tools: { bash: false, read: true, shell: false, execute: false },
            permission: { read: 'allow' },
          },
        },
      },
      null,
      2,
    ),
  )

  const port = await freePort()
  server = spawn(
    BIN,
    ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs'],
    {
      cwd: projectDir,
      env: {
        ...process.env,
        PANTHEON_HOOK_CANARY_PROOF: proofFile,
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
      throw new Error(`${method} ${path} -> HTTP ${response.status}: ${await response.text()}`)
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

async function prompt(text) {
  await request('POST', `/api/session/${sessionID}/prompt`, { text })
  await request('POST', `/api/experimental/session/${sessionID}/wait`)
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

test('read-result assertion rejects a nonce present only in prompt text', () => {
  const nonce = 'CANARY-READ-prompt-only'
  const filePath = '/tmp/canary-allowed-read.txt'
  const messages = {
    data: [{ content: [{ type: 'text', text: `Read ${filePath}; it contains ${nonce}` }] }],
  }

  assert.throws(() => findCompletedReadCall(messages, filePath, nonce), /no read tool-call part/i)
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

/**
 * Read the real plugin source for static guards. Pure file I/O — no host
 * required, which is why the guard test that uses it is not host-gated.
 */
function readPluginSource() {
  return readFileSync(REAL_PLUGIN_SRC, 'utf8')
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

test('fixture canary execute.before blocks its synthetic read', {
  skip: fixtureOnlySkip(
    'S5b real-plugin execute.before enforcement is not implemented; this synthetic fixture guard is not Pantheon security coverage (deferred to S6)',
  ),
}, async () => {
  // This is deliberately fixture-only: its synthetic blocker does not prove
  // that Pantheon enforces execute.before security.
  const proofBefore = readProof()
  await prompt(
    `Use only the read tool to read this exact file path: ${blockedReadPath}. Do not use other tools. Then reply with exactly: CANARY-BLOCKED-READ-DONE`,
  )

  // The visible consequence: the `read` tool call itself is recorded as an
  // error carrying the canary message. A silent no-op would leave the call
  // completed. (Asserting on the read call, not on reachability of the file:
  // an agent may route around a blocked tool with another tool.)
  const messages = JSON.parse(await messagesText()).data ?? []
  const readError = findToolCallForPath(messages, 'read', blockedReadPath)
  assert.equal(readError.state?.status, 'error', 'the blocked read tool call did not fail')
  assert.match(
    JSON.stringify(readError.state?.error),
    /CANARY_BLOCKED_READ/,
    'the read failed for a different reason than the canary guard',
  )
  const proofAfter = readProof()
  const blockedBefore = assertExecuteBeforeForCall(proofBefore, proofAfter, readError)
  assert.equal(
    blockedBefore.filePath,
    blockedReadPath,
    'execute.before was not for the blocked path',
  )
})

test('fixture canary allows a read and correlates execute.after to its completed result', {
  skip: fixtureOnlySkip(
    'S5b real-plugin execute/permission callback effects are unproven; this fixture-only read lifecycle is not Pantheon behavior coverage',
  ),
}, async () => {
  const proofBefore = readProof()
  await prompt(
    `Use only the read tool to read this exact file path: ${allowedReadPath}. Do not use any other tool. Wait for the read result, then reply with exactly: CANARY-ALLOWED-READ-DONE`,
  )

  const messages = JSON.parse(await messagesText())
  const readCall = findCompletedReadCall(messages, allowedReadPath, allowedReadNonce)
  const proofAfter = readProof()
  const readAfter = assertExecuteAfterForCall(proofBefore, proofAfter, readCall)
  assert.equal(
    readAfter.filePath,
    allowedReadPath,
    'execute.after was not for the allowed read path',
  )
  assertReadPermissionObserved(proofBefore, proofAfter, sessionID)
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
  assert.match(source, /ctx\.integration and/, 'integration domain probe is not documented')
  assert.match(
    source,
    /ctx\.skill have callable `\.transform` methods/,
    'host-supported skill transform domain is not documented',
  )
  assert.match(
    source,
    /only ctx\.catalog was absent/i,
    'the runtime probe must distinguish catalog absence from supported domains',
  )
  assert.match(
    source,
    /callback effects were\s+\*\s+not observed for any domain/,
    'unproven transform callback effects are not disclosed',
  )
  assert.doesNotMatch(
    source,
    /ctx\.integration.*no longer a context domain|ctx\.skill.*no longer a context domain/s,
    'plugin must not describe integration or skill as host-absent',
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

test('real mode explicitly skips fixture-only execute/permission behavior', () => {
  const source = readFileSync(TEST_SRC, 'utf8')
  assert.equal(
    (source.match(/skip: fixtureOnlySkip\(/g) ?? []).length,
    2,
    'both fixture-only read lifecycle tests must use explicit mode-aware skips',
  )
  assert.doesNotMatch(
    source,
    /if \(IS_REAL\) return/,
    'real mode must not silently pass by returning',
  )
})
