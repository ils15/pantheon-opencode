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
 *     file changes what the host fires and the assertions below fail. CI runs
 *     this mode on the prepared sandbox (`test-opencode-v2-sandbox.sh --hooks`).
 *
 * Requirements (skipped when unavailable, so `npm test` stays green on a
 * machine without a host):
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
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CANARY_SRC = join(here, '..', 'fixtures', 'opencode-v2-hook-canary', 'index.ts')
const REAL_PLUGIN_SRC = join(here, '..', '..', 'src', 'plugin-v2.ts')

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
let secretNonce = ''
let bashNonce = ''
const skipped = BINARY_AVAILABLE ? false : `opencode binary not found on PATH (${BIN})`

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
  secretNonce = `CANARY-SECRET-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  bashNonce = `CANARY-BASH-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

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

  // A self-contained permissive agent so the test does not depend on which
  // host agents happen to allow `bash`/`read`.
  writeFileSync(
    join(projectDir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        agent: {
          [AGENT]: {
            mode: 'primary',
            permissions: [
              { action: 'bash', resource: '*', effect: 'allow' },
              { action: 'read', resource: '*', effect: 'allow' },
              { action: 'glob', resource: '*', effect: 'allow' },
            ],
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

/** Read the real plugin source for static guards (real mode only). */
function readPluginSource() {
  return readFileSync(REAL_PLUGIN_SRC, 'utf8')
}

test('plugin loads, setup runs, and session.hook("prompt"/"context") fire', {
  skip: skipped,
}, async () => {
  const secretFile = join(projectDir, 'canary-secret.txt')
  writeFileSync(secretFile, `SECRET-${secretNonce}\n`)

  await prompt(
    `Use the read tool to read the file ${secretFile}. Then reply with exactly: CANARY-READ-DONE`,
  )

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

test('execute.before throws and blocks a read (mutation with visible effect)', {
  skip: skipped,
}, async () => {
  // Only the canary fixture installs the throwing execute.before guard; the
  // real plugin registers execute.before as a no-op delegation point.
  if (IS_REAL) return

  const proof = readProof()
  assert.match(
    proof,
    /^tool\.hook:execute\.before read$/m,
    'execute.before did not fire for the read tool',
  )

  // The visible consequence: the `read` tool call itself is recorded as an
  // error carrying the canary message. A silent no-op would leave the call
  // completed. (Asserting on the read call, not on reachability of the file:
  // an agent may route around a blocked tool with another tool.)
  const messages = JSON.parse(await messagesText()).data ?? []
  const readError = messages
    .flatMap((message) => message.content ?? [])
    .find((part) => part?.type === 'tool' && part?.name === 'read')
  assert.ok(readError, 'no read tool call was recorded at all')
  assert.equal(readError.state?.status, 'error', 'the read tool call did not fail')
  assert.match(
    JSON.stringify(readError.state?.error),
    /CANARY_BLOCKED_READ/,
    'the read failed for a different reason than the canary guard',
  )
})

test('execute.after and permission.evaluate fire on a successful tool call', {
  skip: skipped,
}, async () => {
  if (IS_REAL) return

  await prompt(
    `Using the bash tool, run the command: echo ${bashNonce}. Then reply with exactly: CANARY-BASH-DONE`,
  )

  const messages = await messagesText()
  assert.match(messages, new RegExp(bashNonce), 'the bash command did not actually run')

  const proof = readProof()
  assert.match(proof, /^tool\.hook:execute\.after /m, 'execute.after never fired')
  assert.match(proof, /^permission\.hook:evaluate /m, 'permission.evaluate never fired')
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

test('real plugin regression guards: no dead transform domains, correct compaction name', {
  skip: skipped || !IS_REAL,
}, () => {
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
  assert.doesNotMatch(
    source,
    /context\.skill\.transform/,
    'real plugin calls the removed skill transform',
  )
  assert.doesNotMatch(
    source,
    /draft\.source\(/,
    'real plugin calls the removed SkillEditor.source()',
  )
  assert.doesNotMatch(source, /hook\('compacting'/, 'real plugin registers "compacting"')
  // The context handler must emit canonical SystemParts, not raw pushes.
  assert.doesNotMatch(
    source,
    /rawSystem\.push\(toSystemEntry/,
    'real plugin pushes non-normalized system entries',
  )
})
