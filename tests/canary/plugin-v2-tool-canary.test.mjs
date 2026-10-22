/**
 * Host-backed tool canary — proves a Pantheon tool SURVIVES the real host.
 *
 * ## Why this file exists
 *
 * `tests/pantheon/plugin-v2-hook-canary.test.mjs` drives only the built-in
 * `read` tool. It never references a Pantheon tool, so the shipped
 * `draft.add({ name, description, input, execute })` — with `output` missing —
 * shipped broken for 26 days while every test stayed green: `output` is a
 * property of the descriptor the HOST builds, and no hand-written mock context
 * reproduces that build. This is RCA matrix item 6.
 *
 * This file closes that hole: it starts a private `opencode serve`, loads
 * `src/plugin-v2.ts` through the real plugin loader, and drives `hashline_edit`
 * end-to-end — the plugin's own `draft.add`, the host's own input validation,
 * `execute()`, the host's own output-schema validation and the result surface.
 *
 * ## What is real here, and what is not
 *
 * Real: plugin loading, `ctx.tool.transform`, `ctx.tool.list()`, the host's tool
 * registry, input validation, `execute()`, the output biconditional, and the
 * tool-result surface. All of that is the host's own code.
 *
 * Mocked: ONLY the model. `@ai-sdk/openai-compatible` is pointed at a local SSE
 * endpoint that replays scripted `execute` (Code Mode) tool calls. A provider is
 * required to make the host run a turn at all, and substituting the model is the
 * narrowest substitution that gets there — replacing the host would defeat the
 * purpose of the canary.
 *
 * ## Measured facts this file depends on (opencode 2.0.22, against this repo)
 *
 *   1. `opencode serve` prints `server listening on <url>` then
 *      `server password <pw>` and answers HTTP 200 in ~250-330 ms. It prints
 *      the password ONLY when neither `OPENCODE_PASSWORD` nor
 *      `OPENCODE_SERVER_PASSWORD` is set, so both are stripped from the child
 *      environment and the password is read off stdout.
 *   2. Plugin tools do NOT appear in the model's flat tool list — only the 12
 *      built-ins do. They are reachable through the `execute` tool (Code Mode),
 *      whose `tools` global exposes them. Checking plugin tools through the
 *      model's tool surface reports them as nonexistent.
 *   3. `ctx.tool.transform` and `ctx.tool.hook` both exist in 2.0.22, and
 *      `ctx.tool.list()` returns the host-built descriptors.
 *   4. A `ctx.tool.list()` entry for a plugin tool carries an `output` key when
 *      the draft declared one. That is the host's build, not a mock's.
 *   5. `agent.tools:` is `@deprecated` and ignored in 2.0.22. Nothing here
 *      configures it, so the canary does not depend on it.
 *   6. The host resolves each `plugins` entry to a DIRECTORY holding a real
 *      `index.ts`; a bare file path is rejected. The real plugin is therefore
 *      reached through a one-line re-export shim, exactly like the shipped
 *      `src/plugin-v2/index.ts`.
 *   7. Plugins load LAZILY: nothing is registered until the first chat turn. A
 *      canary that stopped at server-up would see an empty registry and pass for
 *      the wrong reason.
 *   8. Two mock-model constraints, both measured here and both silent when
 *      violated: the request must be drained (`req.resume()`) or the socket
 *      stalls and the host's first model call never completes; and the FIRST
 *      model turn of every prompt must carry a tool call, or the session never
 *      reaches the state `/wait` resolves on. Either one shows up only as a
 *      timeout in `before` with no other symptom.
 *
 * ## Timeout
 *
 * 15 000 ms for a signal that arrives in ~300 ms (~50x margin). The hook canary
 * uses 240 000 ms; that is not a safety margin, it is a 700x one that hides a
 * dead host behind a four-minute hang. The canary captures `server.on('exit')`
 * and the pid, so a failure names the cause instead of printing an empty stderr.
 *
 * ## Serial
 *
 * Run it on its own: `npm run test:tool-canary`. It is deliberately NOT matched
 * by `test:node`'s `tests/pantheon/*.mjs` glob, because that glob runs every
 * file concurrently: the hook canary failed 15/15 under 24 workers from CPU
 * starvation rather than from a defect, and a canary that fails for reasons
 * unrelated to what it canaries is worse than no canary.
 *
 * ## Skips
 *
 * Skipped when no `opencode` binary is available, so `npm test` stays green on a
 * machine without a host. Override with `PANTHEON_TOOL_CANARY_BIN`.
 *
 * ## Hermeticity scope
 *
 * The escape guard in the probe plugin replaces `globalThis.fetch` and nothing
 * else. It therefore covers the native Vision path (which uses `fetch`), but NOT
 * `node:http`/`node:https` — e.g. `readRemoteImage` — nor `dns.lookup`; those
 * would leave the process without tripping the guard. The loopback allowlist is
 * substring-based (`//127.0.0.1:`, `//localhost:`, `//[::1]:`), not a
 * parsed-origin check, so it is an intent marker rather than a boundary. The
 * guard's job is to fail loudly when the mocked model or the native path leaks,
 * not to be a general network sandbox.
 *
 * Isolation: a private `opencode serve` on a free port, a throwaway project
 * directory, and a private `HOME` / `XDG_*` / `OPENCODE_CONFIG*` set. The
 * developer's real config is never readable or writable from the host; the last
 * test here proves it by diffing both trees.
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// The repo's own V1→V2 translator. The P0-5 matrix probe compares the action
// names it emits with the ones the host actually evaluates; importing the
// module keeps the comparison anchored to shipped code instead of a copy.
import { migrateV1toV2 } from '../../scripts/install/config-migration.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(here, '..', '..')
const REAL_PLUGIN_SRC = join(REPO_ROOT, 'src', 'plugin-v2.ts')

const BIN = process.env.PANTHEON_TOOL_CANARY_BIN ?? 'opencode'
const TIMEOUT_MS = Number(process.env.PANTHEON_TOOL_CANARY_TIMEOUT_MS ?? 15000)

/**
 * The two strings the host throws when a tool's declared `output` and the value
 * its `execute` resolves to disagree. A live call producing either one is the
 * historical Pantheon defect, so the canary asserts their ABSENCE on the
 * shipped plugin and asserts that the mutation run loses the tool.
 */
const NO_OUTPUT_SCHEMA_ERROR = 'Tool result declared output without an output schema'
const MISSING_OUTPUT_ERROR = 'Tool did not return its declared output'

/**
 * The only messages the host uses for an actual permission denial.
 *
 * The probe classifies an exception as `reject` only when this matches (the
 * regex is mirrored inside the generated probe). Anything else — a TypeError
 * from a changed `ctx.permission.assert` contract, for example — becomes
 * `probe-error`, so a broken harness cannot masquerade as host policy.
 */
const POLICY_DENIAL_MESSAGE = /Permission denied|Blocked by configuration policy/i

/** Config locations the host reads. All must point inside the sandbox. */
const HOST_ENV_REDIRECTED = [
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
]

/** Inherited config the host must never see. */
const HOST_ENV_STRIPPED = [
  'OPENCODE_PASSWORD',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG_CONTENT',
]

const BINARY_AVAILABLE = (() => {
  try {
    return spawnSync(BIN, ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
})()

const skipped = BINARY_AVAILABLE ? false : `opencode binary not found on PATH (${BIN})`
const subagentAdmissionProbeEnabled = process.env.PANTHEON_TOOL_CANARY_SUBAGENT_ADMISSION === '1'

// ─── hashline ref arithmetic (test-side, not host-side) ──────────────────

/** Mirrors `HASHLINE_DICT` in src/pantheon/hashline/xxhash.ts. */
const HASHLINE_DICT = 'ZPMQVRWSNKTXJBYH'

/**
 * Compute the 2-char hashline tag for `line` at `lineNumber`.
 *
 * This is the anchor arithmetic only — the same sha256-truncated tag the tool
 * recomputes before it writes. Everything the canary is actually testing
 * (registration, validation, the write, the output contract) happens inside the
 * host.
 */
function hashTag(line, lineNumber) {
  const normalized = line.replace(/\r$/, '').trimEnd()
  const seed = /[\p{L}\p{N}]/u.test(normalized) ? 0 : lineNumber
  const digest = createHash('sha256').update(`${seed}\u0000${normalized}`).digest()
  const first = digest[0] ?? 0
  return HASHLINE_DICT.charAt(first >> 4) + HASHLINE_DICT.charAt(first & 0x0f)
}

// ─── sandbox ─────────────────────────────────────────────────────────────

/** Create a self-contained project + config tree. */
function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-tool-canary-'))
  const sandbox = {
    root,
    projectDir: root,
    home: join(root, 'home'),
    configHome: join(root, 'xdg-config'),
    dataHome: join(root, 'xdg-data'),
    stateHome: join(root, 'xdg-state'),
    cacheHome: join(root, 'xdg-cache'),
    targetFile: join(root, 'target.txt'),
    proofFile: join(root, 'tool-list.json'),
    permissionProofFile: join(root, 'permission-events.jsonl'),
    matrixProofFile: join(root, 'permission-matrix-events.jsonl'),
    mcpServerFile: join(root, 'canary-mcp-server.cjs'),
    mcpLogFile: join(root, 'canary-mcp-server.log'),
    // A project-local skill gives the `skill` tool a real target without any
    // network access. The host scans `<project>/.opencode/skills`.
    skillFile: join(root, '.opencode', 'skills', 'canary-skill', 'SKILL.md'),
  }
  for (const dir of [
    sandbox.home,
    sandbox.configHome,
    sandbox.dataHome,
    sandbox.stateHome,
    sandbox.cacheHome,
    join(root, '.opencode', 'plugins', 'real'),
    join(root, '.opencode', 'plugins', 'probe'),
  ]) {
    mkdirSync(dir, { recursive: true })
  }
  return sandbox
}

/**
 * Build the host environment: private config roots, no inherited OpenCode
 * configuration, no inherited server password.
 */
function hostEnv(sandbox, extra = {}) {
  const env = { ...process.env }
  for (const key of HOST_ENV_STRIPPED) delete env[key]
  env.HOME = sandbox.home
  env.XDG_CONFIG_HOME = sandbox.configHome
  env.XDG_DATA_HOME = sandbox.dataHome
  env.XDG_STATE_HOME = sandbox.stateHome
  env.XDG_CACHE_HOME = sandbox.cacheHome
  return { ...env, ...extra }
}

/**
 * The real OpenCode CONFIG roots this canary must not touch.
 *
 * `homedir()/.config` is in the list because it is the fallback
 * `scripts/install/opencode.mjs` uses whenever `XDG_CONFIG_HOME` is undefined —
 * the exact path a canary mutates when it forgets to isolate the child
 * environment. It is the P2 finding the isolation requirement came from.
 *
 * The developer's DATA root (`~/.local/share/opencode`) is deliberately NOT
 * diffed here: a developer's own running host writes that tree continuously, so
 * a diff there cannot distinguish the canary from an unrelated writer. Data
 * isolation is proved positively instead — the sandbox data root must contain
 * the host's database after the run.
 */
function realConfigRoots() {
  const home = process.env.HOME ?? ''
  const configHome = process.env.XDG_CONFIG_HOME ?? ''
  return [join(configHome, 'opencode'), join(home, '.config', 'opencode')].filter((path) =>
    isAbsolute(path),
  )
}

/** Recursive snapshot of a directory tree: relative path -> `size:mtimeMs`. */
function snapshotTree(root) {
  const out = new Map()
  if (!root || !existsSync(root)) return out
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const key = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        walk(full, key)
        continue
      }
      try {
        const st = statSync(full)
        out.set(key, `${st.size}:${st.mtimeMs}`)
      } catch {
        // A path that vanished mid-walk is not a canary failure: something else
        // on the machine is writing there. Skipping keeps the check honest
        // instead of turning an unrelated race into a false alarm.
      }
    }
  }
  walk(root, '')
  return out
}

/** Snapshot every real config root, keyed by root so two roots cannot collide. */
function snapshotRealConfigRoots() {
  const out = new Map()
  for (const root of realConfigRoots()) {
    for (const [key, value] of snapshotTree(root)) out.set(`${root}::${key}`, value)
  }
  return out
}

/** Describe what changed between two snapshots. */
function treeDiff(before, after) {
  const changes = []
  for (const [key, value] of after) {
    if (!before.has(key)) changes.push(`created ${key}`)
    else if (before.get(key) !== value) changes.push(`modified ${key}`)
  }
  for (const key of before.keys()) {
    if (!after.has(key)) changes.push(`deleted ${key}`)
  }
  return changes
}

// ─── mock model ──────────────────────────────────────────────────────────

/**
 * A minimal `@ai-sdk/openai-compatible` SSE endpoint.
 *
 * One scripted `execute` (Code Mode) tool call per supplied script, in order,
 * then a plain message for every later turn so the session goes idle. Each
 * script is its own chat turn, which is what lets the test observe the target
 * file BETWEEN the rejected call and the accepted one.
 */
async function startMockModel(scripts, { emptySubagentResultProbe = false } = {}) {
  let turn = 0
  let nestedAthenaChildCalled = false
  let emptyChildResponseRequests = 0
  let lastToolNames = []
  const requestBodies = []
  const server = createServer((req, res) => {
    let requestBody = ''
    req.on('data', (chunk) => {
      requestBody += String(chunk)
    })
    req.on('end', () => {
      requestBodies.push(requestBody)
      // The nested image-analysis session sends an image_url. Keep that call
      // separate from the outer Code Mode script counter and answer it with a
      // deterministic result, so this canary tests OpenCode's native session
      // API without using a real provider or credential. The body is JSON, not
      // SSE: `describeImagesNative` reads the reply with `response.json()` (the
      // `@ai-sdk/openai-compatible` SSE shape is only for the outer chat turns).
      if (requestBody.includes('image_url')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'CANARY-VISION-RESULT' },
                finish_reason: 'stop',
              },
            ],
          }),
        )
        return
      }
      let request
      try {
        request = JSON.parse(requestBody)
      } catch {
        request = {}
      }
      const systemText = (Array.isArray(request.messages) ? request.messages : [])
        .filter((message) => message?.role === 'system')
        .flatMap((message) =>
          Array.isArray(message?.content)
            ? message.content.map((part) => part?.text ?? '')
            : [message?.content ?? ''],
        )
        .join('\n')
      const emptyChildRequest =
        emptySubagentResultProbe && systemText.includes(EMPTY_SUBAGENT_SYSTEM_MARKER)
      if (emptyChildRequest) {
        turn += 1
        emptyChildResponseRequests += 1
        const base = {
          id: `chatcmpl-tool-canary-${turn}`,
          object: 'chat.completion.chunk',
          created: 1_700_000_000,
          model: 'canary-model',
        }
        const chunks = [
          {
            ...base,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ]
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      turn += 1
      const nestedAthenaChild =
        !nestedAthenaChildCalled && requestBody.includes('ATHENA-CANARY-TRY-NESTED')
      if (nestedAthenaChild) nestedAthenaChildCalled = true
      // Alternating: every ODD turn is the scripted tool call, every EVEN turn
      // is the closing message that lets the session go idle. One script per
      // tool call, so the Nth chat prompt runs script N-1.
      const index = (turn - 1) / 2
      const base = {
        id: `chatcmpl-tool-canary-${turn}`,
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: 'canary-model',
      }
      const scripted = nestedAthenaChild || (turn % 2 === 1 && index < scripts.length)
      // A script entry may be a function of the tool names the HOST advertised
      // to the model on this request. That is how the MCP coverage case finds
      // the host-built name of a server tool without guessing the host's naming
      // scheme. A function must always return a step: returning undefined would
      // break the odd/even turn contract below.
      const availableToolNames = (Array.isArray(request.tools) ? request.tools : [])
        .map((tool) => (typeof tool?.function?.name === 'string' ? tool.function.name : undefined))
        .filter(Boolean)
      lastToolNames = availableToolNames
      const rawStep = nestedAthenaChild
        ? {
            name: 'subagent',
            arguments: {
              description: 'V2 child boundary canary',
              prompt: 'Reply with APOLLO-NESTED-CANARY only.',
              agent: 'apollo',
            },
          }
        : scripted
          ? scripts[index]
          : undefined
      const step = typeof rawStep === 'function' ? rawStep(availableToolNames) : rawStep
      const toolCall =
        typeof step === 'string' ? { name: 'execute', arguments: { code: step } } : step
      const chunks = scripted
        ? [
            {
              ...base,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: `call_tool_canary_${turn}`,
                        type: 'function',
                        function: {
                          name: toolCall.name,
                          arguments: JSON.stringify(toolCall.arguments),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          ]
        : [
            {
              ...base,
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: 'TOOL-CANARY-DONE' },
                  finish_reason: null,
                },
              ],
            },
            { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          ]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    turns: () => turn,
    // The last tool list the HOST advertised to the model. This is how the
    // matrix proves which name it actually invoked for an MCP server tool.
    toolNames: () => lastToolNames,
    emptyChildResponseRequests: () => emptyChildResponseRequests,
    requestSummary: () =>
      requestBodies.map((body) => {
        let parsed
        try {
          parsed = JSON.parse(body)
        } catch {
          parsed = {}
        }
        const messages = Array.isArray(parsed.messages) ? parsed.messages : []
        const last = messages.at(-1)
        const content = last?.content
        return {
          hasImageUrl: body.includes('image_url'),
          hasImageData: body.includes('data:image'),
          model: parsed.model,
          chars: body.length,
          messageKeys: last ? Object.keys(last) : [],
          contentTypes: Array.isArray(content)
            ? content.map((item) => ({ type: item?.type, keys: Object.keys(item ?? {}) }))
            : typeof content,
          lastText: typeof content === 'string' ? content.slice(-120) : undefined,
        }
      }),
    close: () => server.close(),
  }
}

// ─── host ────────────────────────────────────────────────────────────────

function freePort() {
  return new Promise((done, fail) => {
    const probe = createNetServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

async function waitFor(probe, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/**
 * Start a private `opencode serve` against `sandbox` and return a client.
 *
 * `--standalone` is rejected by 2.0.22 and must not be passed. The exit hook and
 * the pid land in the timeout message, so a dead host reports why instead of
 * surfacing an empty stderr slice.
 */
async function startHost(sandbox) {
  const port = await freePort()
  const server = spawn(BIN, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: sandbox.projectDir,
    env: hostEnv(sandbox, {
      PANTHEON_TOOL_CANARY_PROOF: sandbox.proofFile,
      PANTHEON_VISION_MODEL: 'opencode-go/mimo-v2.6-flash',
      PANTHEON_OPENCODE_API_KEY: 'canary-key',
      PANTHEON_HOOK_CANARY_PERMISSION_PROOF: sandbox.permissionProofFile,
      PANTHEON_TOOL_CANARY_MATRIX_PROOF: sandbox.matrixProofFile,
      ...(subagentAdmissionProbeEnabled
        ? { OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: 'true' }
        : {}),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  server.stdout.on('data', (chunk) => {
    stdout += String(chunk)
  })
  server.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })

  let exit = null
  server.on('exit', (code, signal) => {
    exit = `host pid ${server.pid} exited (code=${code} signal=${signal})`
  })

  const diagnose = () =>
    [
      exit ?? `host pid ${server.pid} is still running`,
      `stdout=${JSON.stringify(stdout.slice(0, 400))}`,
      `stderr=${JSON.stringify(stderr.slice(0, 400))}`,
    ].join('; ')

  const password = await waitFor(
    async () => /server password (\S+)/.exec(stdout)?.[1],
    TIMEOUT_MS,
    `opencode serve to print a password (${diagnose()})`,
  )

  const basic = Buffer.from(`opencode:${password}`).toString('base64')
  const headers = {
    authorization: `Basic ${basic}`,
    'x-opencode-directory': encodeURIComponent(sandbox.projectDir),
    'content-type': 'application/json',
  }

  const request = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 400)}`)
    }
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
    TIMEOUT_MS,
    `opencode serve to become ready (${diagnose()})`,
  )

  const created = await request('POST', '/api/session', {
    title: 'pantheon-tool-canary',
    model: { providerID: 'canary', id: 'canary-model' },
  })

  return {
    port,
    sessionID: created.data.id,
    diagnose,
    request,
    async createSession(title = 'pantheon-tool-canary-followup') {
      const session = await request('POST', '/api/session', {
        title,
        model: { providerID: 'canary', id: 'canary-model' },
      })
      return session.data.id
    },
    async prompt(text, { agent } = {}) {
      await request('POST', `/api/session/${created.data.id}/prompt`, {
        text,
        ...(agent ? { agent } : {}),
        model: { providerID: 'canary', id: 'canary-model' },
      })
      await request('POST', `/api/experimental/session/${created.data.id}/wait`)
    },
    async promptWithPermissionReply(text, reply, agent, sessionID = created.data.id) {
      const prompt = request('POST', `/api/session/${sessionID}/prompt`, {
        text,
        ...(agent ? { agent } : {}),
        model: { providerID: 'canary', id: 'canary-model' },
      })
      const pending = await waitFor(
        async () => {
          const result = await request('GET', `/api/session/${sessionID}/permission`)
          return (result?.data ?? []).find((item) => item.action === 'read')
        },
        TIMEOUT_MS,
        `native read permission request for ${reply}`,
      ).catch(async (error) => {
        const transcript = await request('GET', `/api/session/${sessionID}/message`).catch(
          (cause) => ({ error: String(cause) }),
        )
        const rows = Array.isArray(transcript?.data) ? transcript.data : []
        const summary = rows.slice(0, 5).map((row) => ({
          type: row.type,
          agent: row.agent,
          text: row.text,
          parts: (row.content ?? []).map((part) => ({
            type: part.type,
            name: part.name,
            status: part.state?.status,
            error: part.state?.error?.message,
            text: part.text,
          })),
        }))
        const proof = existsSync(sandbox.permissionProofFile)
          ? readFileSync(sandbox.permissionProofFile, 'utf8')
          : ''
        throw new Error(
          `${String(error)}; recentMessages=${JSON.stringify(summary)}; permissionProof=${proof.slice(-4000)}`,
        )
      })
      await request('POST', `/api/session/${sessionID}/permission/${pending.id}/reply`, {
        decision: reply,
      })
      await prompt
      await request('POST', `/api/experimental/session/${sessionID}/wait`)
      return pending
    },
    async savedPermissions() {
      return request('GET', '/api/permission/saved')
    },
    async transcript() {
      return JSON.stringify(await request('GET', `/api/session/${created.data.id}/message`))
    },
    async sessions() {
      return request('GET', '/api/session')
    },
    async messages(sessionID) {
      return request('GET', `/api/session/${sessionID}/message`)
    },
    stop() {
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM')
    },
  }
}

// ─── plugin wiring ───────────────────────────────────────────────────────

/**
 * Write the plugin tree the host will load.
 *
 * `.opencode/plugins/real` re-exports the plugin under test, so the host loads
 * that file itself through its own loader — no adapter wraps the real `setup`.
 * `.opencode/plugins/probe` registers nothing; it records, from inside the host:
 *
 *   - every key on the real `PluginContext` (this is what proves the four
 *     domains `src/plugin-v2.ts` reaches through a cast DO exist on a live
 *     2.0.22 host, rather than being a fingers-crossed assumption), and
 *   - the `ctx.tool.list()` dump, taken on the first `execute.after`, by which
 *     point the real plugin's `tool.transform` has already run.
 */
function writePlugins(
  sandbox,
  pluginSource,
  { permissionProbe = false, permissionAskProbe = false, matrixProbe = false } = {},
) {
  writeFileSync(join(sandbox.projectDir, '.opencode', 'plugins', 'real', 'index.ts'), pluginSource)
  writeFileSync(
    join(sandbox.projectDir, '.opencode', 'plugins', 'probe', 'index.ts'),
    [
      "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'",
      'export default {',
      "  id: 'pantheon-tool-canary-probe',",
      '  async setup(ctx) {',
      '    const proof = process.env.PANTHEON_TOOL_CANARY_PROOF',
      '    if (!proof) return',
      '    const visionRequests = []',
      '    const escapedRequests = []',
      '    const permissionResults = []',
      '    const permissionAskResults = []',
      '    const permissionEvents = []',
      '    const promptEvents = []',
      '    const originalFetch = globalThis.fetch',
      '    const isZenUrl = (url) => url.includes("opencode.ai/zen/")',
      '    const isLoopback = (url) => url.includes("//127.0.0.1:") || url.includes("//localhost:") || url.includes("//[::1]:")',
      '    globalThis.fetch = async (input, init) => {',
      '      const url = typeof input === "string" ? input : (input && input.url) || String(input)',
      '      if (isZenUrl(url)) {',
      '        const body = JSON.parse(String(init?.body ?? "{}"))',
      '        const headers = new Headers(init?.headers)',
      '        visionRequests.push({',
      '          url,',
      '          model: body.model,',
      '          messages: body.messages,',
      '          authorization: headers.get("authorization"),',
      '          session: headers.get("x-opencode-session"),',
      '        })',
      '        return Response.json({ choices: [{ message: { content: "CANARY-VISION-RESULT" } }] })',
      '      }',
      '      if (isLoopback(url)) {',
      '        return Reflect.apply(originalFetch, globalThis, [input, init])',
      '      }',
      '      escapedRequests.push(url)',
      '      return Response.json({ error: "canary blocked an un-intercepted network request" }, { status: 599 })',
      '    }',
      '    const kind = (value) => (value === undefined ? "absent" : typeof value)',
      '    const domains = {',
      '      contextKeys: Object.keys(ctx).sort(),',
      '      tool: {',
      '        transform: kind(ctx.tool && ctx.tool.transform),',
      '        hook: kind(ctx.tool && ctx.tool.hook),',
      '        list: kind(ctx.tool && ctx.tool.list),',
      '      },',
      '      event: { subscribe: kind(ctx.event && ctx.event.subscribe) },',
      '      permission: {',
      '        hook: kind(ctx.permission && ctx.permission.hook),',
      '        assert: kind(ctx.permission && ctx.permission.assert),',
      '      },',
      '      location: {',
      '        type: kind(ctx.location),',
      '        keys: Object.keys(ctx.location ?? {}).sort(),',
      '        entries: Object.fromEntries(Object.keys(ctx.location ?? {}).map((key) => [key, kind(ctx.location[key])])),',
      '      },',
      '      session: {',
      '        hook: kind(ctx.session && ctx.session.hook),',
      '        create: kind(ctx.session && ctx.session.create),',
      '        generate: kind(ctx.session && ctx.session.generate),',
      '        remove: kind(ctx.session && ctx.session.remove),',
      '        get: kind(ctx.session && ctx.session.get),',
      '      },',
      '      model: { list: kind(ctx.model && ctx.model.list) },',
      '      aisdk: {',
      '        type: kind(ctx.aisdk),',
      '        hook: kind(typeof ctx.aisdk === "function" ? ctx.aisdk : (ctx.aisdk && ctx.aisdk.hook)),',
      '      },',
      '      generate: { text: kind(ctx.generate && ctx.generate.text) },',
      '      catalog: kind(ctx.catalog),',
      '    }',
      "    await ctx.session.hook('prompt', async (event) => {",
      '      promptEvents.push({',
      '        keys: Object.keys(event ?? {}).sort(),',
      '        sessionID: event?.sessionID,',
      '        agent: event?.agent,',
      '        parentID: event?.parentID,',
      '      })',
      '    })',
      ...(permissionProbe
        ? [
            "    await ctx.permission.hook('evaluate', async (event) => {",
            '      const permissionSession = typeof ctx.session?.get === "function" && typeof event.sessionID === "string"',
            '        ? await ctx.session.get({ sessionID: event.sessionID })',
            '        : null',
            '      permissionEvents.push({',
            '        sessionID: event.sessionID,',
            '        agent: event.agent,',
            '        action: event.action,',
            '        resources: event.resources,',
            '        source: event.source,',
            '        effect: event.effect,',
            '        message: event.message,',
            '        session: permissionSession && {',
            '          id: permissionSession.id,',
            '          projectID: permissionSession.projectID,',
            '          agent: permissionSession.agent,',
            '          parentID: permissionSession.parentID,',
            '          keys: Object.keys(permissionSession),',
            '        },',
            '        locationProjectID: ctx.location?.project?.id,',
            '      })',
            '    })',
            '    await ctx.tool.transform((draft) => {',
            '      draft.add({',
            "        name: 'permission_probe',",
            "        description: 'Canary for the host permission assertion API',",
            "        input: { type: 'object', properties: {}, additionalProperties: false },",
            "        output: { type: 'object', properties: { output: { type: 'string' } }, required: ['output'], additionalProperties: false },",
            '        async execute(_input, toolContext) {',
            '          const source = { type: "tool", messageID: toolContext.messageID, id: toolContext.id }',
            '          const session = await ctx.session.get({ sessionID: toolContext.sessionID })',
            '          const sessionSummary = session && {',
            '            id: session.id,',
            '            agent: session.agent,',
            '            parentID: session.parentID,',
            '            keys: Object.keys(session),',
            '          }',
            '          const request = {',
            '            sessionID: toolContext.sessionID,',
            '            agent: toolContext.agent,',
            '            action: "shell",',
            '            resources: ["echo pantheon-permission-canary"],',
            '            source,',
            '          }',
            '          try {',
            '            if (process.env.PANTHEON_TOOL_CANARY_PROBE_FAULT === "contract") {',
            '              throw new TypeError("simulated host contract change: permission.assert rejected the request shape")',
            '            }',
            '            await ctx.permission.assert(request)',
            '            permissionResults.push({ decision: "allow", request, session: sessionSummary })',
            '            return { output: JSON.stringify({ decision: "allow" }) }',
            '          } catch (error) {',
            '            const message = String(error?.message ?? error)',
            '            // Only a host policy denial may become a `reject` verdict. A',
            '            // TypeError/contract change is a broken probe, not a decision.',
            '            const policy = /Permission denied|Blocked by configuration policy/i.test(message)',
            '            const result = { decision: policy ? "reject" : "probe-error", errorKind: policy ? "policy" : "non-policy", error: message, request, session: sessionSummary }',
            '            permissionResults.push(result)',
            '            return { output: JSON.stringify(result) }',
            '          }',
            '        },',
            '      })',
            '    })',
          ]
        : []),
      ...(matrixProbe
        ? [
            '    await ctx.permission.hook("evaluate", async (event) => {',
            '      const matrixProof = process.env.PANTHEON_TOOL_CANARY_MATRIX_PROOF',
            '      if (!matrixProof) return',
            '      try {',
            '        appendFileSync(matrixProof, JSON.stringify({',
            '          action: event?.action,',
            '          resources: event?.resources,',
            '          agent: event?.agent,',
            '          sessionID: event?.sessionID,',
            '          source: event?.source,',
            '          effect: event?.effect,',
            '          message: event?.message,',
            '        }) + "\\n")',
            '      } catch {',
            '        // Evidence only; never affect the permission decision.',
            '      }',
            '    })',
            '    await ctx.tool.transform((draft) => {',
            '      draft.add({',
            "        name: 'permission_matrix_probe',",
            "        description: 'Evaluate one explicit V2 permission request and return the decision',",
            "        input: { type: 'object', properties: { action: { type: 'string' }, resources: { type: 'array', items: { type: 'string' } } }, required: ['action', 'resources'], additionalProperties: false },",
            "        output: { type: 'object', properties: { output: { type: 'string' } }, required: ['output'], additionalProperties: false },",
            '        async execute(input, toolContext) {',
            '          const request = {',
            '            sessionID: toolContext.sessionID,',
            '            agent: toolContext.agent,',
            '            action: input.action,',
            '            resources: input.resources,',
            '            source: { type: "tool", messageID: toolContext.messageID, id: toolContext.id },',
            '          }',
            '          if (typeof ctx.permission.assert !== "function") {',
            '            // This case needs an API the host does not expose (2.0.22 has no',
            '            // ctx.permission.assert). The question is unobservable here, so',
            '            // report NOT_APPLICABLE — a TypeError caught below must never be',
            '            // read as a policy "reject".',
            '            return { output: JSON.stringify({ decision: "not-applicable", reason: "ctx.permission.assert is not a function", request }) }',
            '          }',
            '          try {',
            '            if (process.env.PANTHEON_TOOL_CANARY_MATRIX_PROBE_FAULT === "contract") {',
            '              throw new TypeError("simulated host contract change: permission.assert rejected the matrix request shape")',
            '            }',
            '            await ctx.permission.assert(request)',
            '            return { output: JSON.stringify({ decision: "allow", request }) }',
            '          } catch (error) {',
            '            const message = String(error?.message ?? error)',
            '            // A policy denial is the ONLY reject. Any other exception is a',
            '            // broken probe and must fail the case, not read as host policy.',
            '            const policy = /Permission denied|Blocked by configuration policy/i.test(message)',
            '            return { output: JSON.stringify({ decision: policy ? "reject" : "probe-error", errorKind: policy ? "policy" : "non-policy", error: message, request }) }',
            '          }',
            '        },',
            '      })',
            '    })',
          ]
        : []),
      ...(permissionAskProbe
        ? [
            '    await ctx.tool.transform((draft) => {',
            '      draft.add({',
            "        name: 'permission_ask_probe',",
            "        description: 'Live ask/reply and non-persistent permission canary',",
            "        input: { type: 'object', properties: {}, additionalProperties: false },",
            "        output: { type: 'object', properties: { output: { type: 'string' } }, required: ['output'], additionalProperties: false },",
            '        async execute(_input, toolContext) {',
            '          const request = {',
            '            sessionID: toolContext.sessionID,',
            '            agent: toolContext.agent,',
            '            action: "read",',
            `            resources: [${JSON.stringify(sandbox.targetFile)}],`,
            '            save: [],',
            '            source: { type: "tool", messageID: toolContext.messageID, id: toolContext.id },',
            '          }',
            '          await ctx.permission.assert(request)',
            '          const session = await ctx.session.get({ sessionID: request.sessionID })',
            '          permissionAskResults.push({ sessionID: request.sessionID, agent: request.agent, source: request.source, session: session && { id: session.id, parentID: session.parentID, projectID: session.projectID, workspaceID: session.workspaceID, directory: session.directory, keys: Object.keys(session).sort() }, locationDirectory: ctx.location?.directory, locationProjectID: ctx.location?.project?.id, locationProjectKeys: Object.keys(ctx.location?.project ?? {}).sort(), contextKeys: Object.keys(toolContext).sort() })',
            `          return { output: readFileSync(${JSON.stringify(sandbox.targetFile)}, 'utf8') }`,
            '        },',
            '      })',
            '    })',
          ]
        : []),
      "    await ctx.tool.hook('execute.after', async () => {",
      '      let toolList',
      '      try {',
      '        toolList = await ctx.tool.list()',
      '      } catch (err) {',
      '        writeFileSync(proof, JSON.stringify({ domains, visionRequests, escapedRequests, permissionResults, permissionAskResults, permissionEvents, promptEvents, listError: String(err) }, null, 2))',
      '        return',
      '      }',
      '      let models',
      '      try {',
      '        const result = await ctx.model.list()',
      '        models = Array.isArray(result) ? result : (result?.data ?? [])',
      '      } catch (err) {',
      '        models = { error: String(err) }',
      '      }',
      '      writeFileSync(',
      '        proof,',
      '        JSON.stringify(',
      '          {',
      '            domains,',
      '            visionRequests,',
      '            escapedRequests,',
      '            permissionResults,',
      '            permissionAskResults,',
      '            permissionEvents,',
      '            promptEvents,',
      '            models: Array.isArray(models)',
      '              ? models.map((model) => ({',
      '                  id: model.id,',
      '                  providerID: model.providerID,',
      '                  input: model.capabilities?.input ?? model.input,',
      '                  enabled: model.enabled,',
      '                }))',
      '              : models,',
      '            toolList: toolList.map((tool) => ({',
      '              name: tool.name,',
      '              id: tool.id,',
      '              keys: Object.keys(tool).sort(),',
      '              hasOutput: Object.hasOwn(tool, "output"),',
      '            })),',
      '          },',
      '          null,',
      '          2,',
      '        ),',
      '      )',
      '    })',
      '  },',
      '}',
      '',
    ].join('\n'),
  )
}

/** Everything the host needs to run a turn against the local mock model. */
function canaryProviderConfig(modelBaseURL) {
  return {
    provider: {
      opencode: {
        npm: '@ai-sdk/openai-compatible',
        name: 'OpenCode Zen canary',
        id: 'opencode',
        options: { baseURL: modelBaseURL, apiKey: 'canary-key' },
        models: {
          'mimo-v2.6-flash-free': {
            name: 'MiMo V2.6 Flash Free',
            tool_call: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
          },
        },
      },
      'opencode-go': {
        npm: '@ai-sdk/openai-compatible',
        name: 'OpenCode Go canary',
        id: 'opencode-go',
        options: { baseURL: modelBaseURL, apiKey: 'canary-key' },
        models: {
          'mimo-v2.6-flash': {
            name: 'MiMo V2.6 Flash',
            tool_call: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
          },
        },
      },
      canary: {
        npm: '@ai-sdk/openai-compatible',
        name: 'canary',
        id: 'canary',
        options: { baseURL: modelBaseURL, apiKey: 'canary-key' },
        models: {
          'canary-model': {
            name: 'canary-model',
            tool_call: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
          },
        },
      },
    },
    model: 'canary/canary-model',
  }
}

function writeProjectConfig(
  sandbox,
  modelBaseURL,
  {
    permissionProbe = false,
    permissionAskProbe = false,
    boundedReadProbe = false,
    boundedReadDenyProbe = false,
    subagentAdmissionProbe = false,
    emptySubagentResultProbe = false,
    subagentCaller = 'athena',
    subagentTarget = 'demeter',
  } = {},
) {
  writeFileSync(
    join(sandbox.projectDir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        // Each entry must be a DIRECTORY holding a real index.ts on 2.0.22.
        plugins: ['./.opencode/plugins/real', './.opencode/plugins/probe'],
        ...(permissionProbe
          ? {
              policies: [
                { action: 'tool.use', resource: 'shell:*', effect: 'allow' },
                ...(subagentAdmissionProbe
                  ? [
                      { action: 'tool.use', resource: 'task:*', effect: 'allow' },
                      { action: 'tool.use', resource: 'subagent:*', effect: 'allow' },
                    ]
                  : []),
              ],
            }
          : {}),
        ...(permissionAskProbe || boundedReadProbe || boundedReadDenyProbe
          ? {
              permissions: [
                {
                  action: 'read',
                  resource: '*',
                  effect: boundedReadDenyProbe ? 'deny' : 'ask',
                },
              ],
            }
          : {}),
        ...(boundedReadProbe || boundedReadDenyProbe
          ? {
              default_agent: 'zeus',
              agents: {
                zeus: {
                  mode: 'primary',
                  system: 'Use the dedicated bounded file reader for the live canary request.',
                },
              },
            }
          : {}),
        ...(subagentAdmissionProbe
          ? {
              default_agent: subagentCaller,
              experimental: { subagent_depth: 2 },
              permissions: [
                { action: 'task', resource: '*', effect: 'allow' },
                { action: 'subagent', resource: '*', effect: 'allow' },
              ],
              agents: {
                ...Object.fromEntries(
                  [...new Set([subagentTarget, 'apollo', 'demeter'])].map((agent) => [
                    agent,
                    {
                      mode: 'subagent',
                      description: `Isolated admission canary target ${agent}`,
                      system:
                        emptySubagentResultProbe && agent === subagentTarget
                          ? `${EMPTY_SUBAGENT_SYSTEM_MARKER}: deliberately produce no assistant text.`
                          : `Reply with ${agent.toUpperCase()}-CANARY-CHILD if you are started.`,
                      permissions: [{ action: 'tool.use', resource: 'execute', effect: 'deny' }],
                    },
                  ]),
                ),
                [subagentCaller]: {
                  mode: 'primary',
                  system: 'Use the native subagent dispatch tool only for an authorized agent.',
                  permissions: [
                    { action: 'task', resource: '*', effect: 'allow' },
                    { action: 'subagent', resource: '*', effect: 'allow' },
                  ],
                },
              },
            }
          : {}),
        ...canaryProviderConfig(modelBaseURL),
      },
      null,
      2,
    ),
  )
}

/**
 * Project config for one P0-5 matrix scenario.
 *
 * `permissions` is always the array the repo's own translator produces (or a
 * deliberately ordered literal for the resolution-order probe). Nothing here
 * guesses a host action name: the scenario observes what the host evaluates.
 */
function writePermissionMatrixConfig(
  sandbox,
  modelBaseURL,
  { permissions, policies, agents, defaultAgent, mcp },
) {
  writeFileSync(
    join(sandbox.projectDir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        plugins: ['./.opencode/plugins/real', './.opencode/plugins/probe'],
        ...canaryProviderConfig(modelBaseURL),
        ...(defaultAgent ? { default_agent: defaultAgent } : {}),
        ...(agents ? { agents } : {}),
        ...(policies ? { policies } : {}),
        ...(mcp ? { mcp } : {}),
        ...(permissions
          ? {
              // The host reads both spellings across generations; this probe
              // targets the V2 key, matching the converter's output.
              permissions,
            }
          : {}),
      },
      null,
      2,
    ),
  )
}

/** The re-export shim that makes the host load `src/plugin-v2.ts` itself. */
function realPluginShim() {
  const source = readFileSync(REAL_PLUGIN_SRC, 'utf8')
  const packageJSON = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  const identity = {
    packageName: packageJSON.name,
    packageVersion: packageJSON.version,
    sourcePath: REAL_PLUGIN_SRC,
    sourceSHA256: createHash('sha256').update(source).digest('hex'),
  }

  // Instrument the actual candidate handler at its registration boundary.
  // The wrapper delegates setup and every hook call to the unmodified candidate
  // source; it only records registration plus the event/result before and after
  // that handler runs. This distinguishes a missing hook from an adapter bug.
  return `
import candidate from ${JSON.stringify(REAL_PLUGIN_SRC)}
import { appendFileSync } from 'node:fs'
const identity = ${JSON.stringify(identity)}
const evidenceFile = () => {
  const proofFile = process.env.PANTHEON_TOOL_CANARY_PROOF
  return proofFile ? proofFile + '.execute-after.jsonl' : null
}
const describe = (value, depth = 0) => {
  if (value === null || value === undefined || typeof value !== 'object') {
    return typeof value === 'string' ? value.slice(0, 2000) : value
  }
  if (depth > 3) return { type: Array.isArray(value) ? 'array' : 'object' }
  if (Array.isArray(value)) return value.map((item) => describe(item, depth + 1))
  const summary = { keys: Object.keys(value).sort() }
  for (const key of ['type', 'text', 'output', 'content', 'metadata']) {
    if (Object.hasOwn(value, key)) summary[key] = describe(value[key], depth + 1)
  }
  return summary
}
const record = (entry) => {
  const path = evidenceFile()
  if (path && path !== '.execute-after.jsonl') {
    appendFileSync(path, JSON.stringify({ ...identity, ...entry }) + '\\n')
  }
}
export default {
  id: 'pantheon-candidate-instrumented',
  async setup(context) {
    record({ phase: 'setup' })
    const tool = context.tool
    const wrappedTool = new Proxy(tool, {
      get(target, property) {
        const value = Reflect.get(target, property, target)
        if (property !== 'hook' || typeof value !== 'function') {
          return typeof value === 'function' ? value.bind(target) : value
        }
        return async (name, handler) => {
          const observed = name === 'execute.after'
            ? async (event) => {
                const snapshot = (phase) => ({
                  phase,
                  tool: event?.tool,
                  status: event?.status,
                  sessionID: event?.sessionID,
                  id: event?.id,
                  eventKeys: Object.keys(event ?? {}).sort(),
                  result: describe(event?.result),
                })
                record(snapshot('before'))
                try {
                  return await handler(event)
                } finally {
                  record(snapshot('after'))
                }
              }
            : handler
          const registered = await Reflect.apply(value, target, [name, observed])
          record({ phase: 'registration', hook: name, success: true })
          return registered
        }
      },
    })
    const wrappedContext = new Proxy(context, {
      get(target, property) {
        return property === 'tool' ? wrappedTool : Reflect.get(target, property, target)
      },
    })
    return candidate.setup(wrappedContext)
  },
}
`
}

/**
 * Build a MUTANT of `src/plugin-v2.ts` with `output: def.output` removed from
 * the `draft.add` call.
 *
 * The mutant is a rewritten COPY written into the sandbox — never an edit to the
 * repository. Its relative imports are rewritten to absolute paths into the real
 * `src/` so the copy needs no tree duplication and still exercises the real
 * sibling modules.
 */
function mutantPluginShim() {
  const source = readFileSync(REAL_PLUGIN_SRC, 'utf8')
  assert.match(
    source,
    /output: def\.output/,
    'src/plugin-v2.ts no longer declares the output on draft.add — the mutation below has nothing to remove',
  )
  const absolute = source.replace(
    /from '(\.\/[^']+)'/g,
    (_match, rel) => `from ${JSON.stringify(join(REPO_ROOT, 'src', rel))}`,
  )
  const mutated = absolute.replace(/^\s*output: def\.output,\n/m, '')
  assert.notEqual(mutated, absolute, 'the mutation did not apply — the canary would prove nothing')
  assert.doesNotMatch(
    mutated,
    /output: def\.output/,
    'the mutation left another declaration in place',
  )
  return mutated
}

// ─── the canary run ──────────────────────────────────────────────────────

const TARGET_LINES = ['CANARY-ALPHA-LINE', 'CANARY-BETA-LINE', 'CANARY-GAMMA-LINE']
const TARGET_BODY = `${TARGET_LINES.join('\n')}\n`
const BETA_REF = `2#${hashTag(TARGET_LINES[1] ?? '', 2)}`
const EMPTY_SUBAGENT_SYSTEM_MARKER = 'PANTHEON-EMPTY-SUBAGENT-CANARY-CHILD'

/** Code Mode script: is `hashline_edit` reachable at all? */
const CATALOG_SCRIPT = `
const found = search({ query: 'hashline' });
return JSON.stringify({ catalog: found.items.map((item) => item.path) });
`.trim()

/** Code Mode script: one call with a ref the file does not have. */
const badRefScript = (targetFile) =>
  `
const out = {};
try {
  out.result = await tools.hashline_edit({
    file: ${JSON.stringify(targetFile)},
    edits: [{ op: 'replace', ref: '9#ZZ', lines: ['SHOULD-NEVER-BE-WRITTEN'] }],
  });
} catch (err) {
  out.error = String(err && err.message ? err.message : err);
}
return JSON.stringify(out);
`.trim()

/** Code Mode script: one call with the ref the file really has. */
const goodRefScript = (targetFile) =>
  `
const out = {};
try {
  out.result = await tools.hashline_edit({
    file: ${JSON.stringify(targetFile)},
    edits: [{ op: 'replace', ref: ${JSON.stringify(BETA_REF)}, lines: ['CANARY-BETA-REPLACED'] }],
  });
} catch (err) {
  out.error = String(err && err.message ? err.message : err);
}
return JSON.stringify(out);
`.trim()

const VISION_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

const visionScript = `
const result = await tools.vision_describe({
  path: ${JSON.stringify(VISION_IMAGE)},
  prompt: 'Describe this canary image.',
});
return JSON.stringify({ result });
`.trim()

const boundedReadScript = `
const result = await tools.pantheon_bounded_read({ path: 'bounded.txt', offset: 1, limit: 2 });
return JSON.stringify({ result });
`.trim()

/**
 * The rendered text of every `execute` tool call, oldest first.
 *
 * The session endpoint returns messages NEWEST FIRST, so the order is restored
 * from `time.created` before flattening — otherwise every observation would be
 * the FIRST prompt's result.
 */
function executeTexts(transcript) {
  const parsed = JSON.parse(transcript)
  const messages = (Array.isArray(parsed) ? parsed : (parsed?.data ?? []))
    .slice()
    .sort((a, b) => (a?.time?.created ?? 0) - (b?.time?.created ?? 0))
  return messages
    .flatMap((message) => message?.parts ?? message?.content ?? [])
    .filter((part) => part?.type === 'tool' && (part.tool ?? part.name) === 'execute')
    .flatMap((part) =>
      (part.state?.content ?? part.state?.result?.content ?? []).map((item) =>
        typeof item === 'string' ? item : (item?.text ?? ''),
      ),
    )
}

/** Return host-rendered calls for one native tool. */
function toolParts(transcript, toolName) {
  const parsed = JSON.parse(transcript)
  const messages = Array.isArray(parsed) ? parsed : (parsed?.data ?? [])
  return messages
    .flatMap((message) => message?.parts ?? message?.content ?? [])
    .filter((part) => part?.type === 'tool' && (part.tool ?? part.name) === toolName)
}

/** Every tool call in a transcript, whatever its name. */
function allToolParts(transcript) {
  const parsed = JSON.parse(transcript)
  const messages = Array.isArray(parsed) ? parsed : (parsed?.data ?? [])
  return messages
    .flatMap((message) => message?.parts ?? message?.content ?? [])
    .filter((part) => part?.type === 'tool')
}

/** Read the text returned by a completed native tool call from its host transcript. */
function toolResultText(part) {
  const state = part?.state
  const output = state?.output ?? state?.result?.output ?? state?.content ?? state?.result?.content
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output.map((item) => (typeof item === 'string' ? item : (item?.text ?? ''))).join('\n')
  }
  if (typeof output?.output === 'string') return output.output
  return ''
}

/** Parse the JSON a Code Mode script returned. */
function parseScriptResult(text) {
  const line = text.trim().split('\n').filter(Boolean).at(-1) ?? ''
  try {
    return JSON.parse(line)
  } catch {
    return { parseError: text.slice(0, 400) }
  }
}

/**
 * The rendered text of the Vision `execute` call, selected by CONTENT.
 *
 * Not by `time.created`: the host does not guarantee monotonic timestamps
 * across turns, and the native Vision turn perturbs the ordering (its
 * `session.generate` re-stamps neighbouring messages), so
 * `executeTexts(...).at(-1)` returned a neighbouring turn's result on ~2-4% of
 * runs — with the Zen request still intercepted and `CANARY-VISION-RESULT`
 * still returned, i.e. a false negative. The Vision call is the only scripted
 * turn whose output carries `CANARY-VISION-RESULT`, so matching that marker is
 * order-independent. The catalog/bad/good observations are captured immediately
 * after their own prompt, before Vision runs, and stay on `.at(-1)`.
 */
function visionExecuteText(transcript) {
  return executeTexts(transcript).find((text) => text.includes('CANARY-VISION-RESULT')) ?? ''
}

/**
 * Run the whole canary against one plugin source and return the observations.
 *
 * Four outer chat turns on one session — catalog, rejected call, accepted call,
 * and native Vision — so
 * the target file can be observed between the two calls.
 */
async function runCanary(
  pluginSource,
  {
    permissionProbe = false,
    permissionAskProbe = false,
    boundedReadProbe = false,
    boundedReadDenyProbe = false,
    subagentAdmissionProbe = false,
    emptySubagentResultProbe = false,
    subagentCaller = 'athena',
    subagentTarget = 'demeter',
  } = {},
) {
  const sandbox = makeSandbox()
  writeFileSync(sandbox.targetFile, TARGET_BODY)
  if (boundedReadProbe || boundedReadDenyProbe) {
    writeFileSync(join(sandbox.projectDir, 'bounded.txt'), TARGET_BODY)
  }
  const scripts = [
    CATALOG_SCRIPT,
    badRefScript(sandbox.targetFile),
    goodRefScript(sandbox.targetFile),
    visionScript,
    ...(permissionProbe
      ? ['const result = await tools.permission_probe({});\nreturn JSON.stringify({ result });']
      : []),
    ...(permissionAskProbe
      ? [
          'return await tools.permission_ask_probe({});',
          'return await tools.permission_ask_probe({});',
        ]
      : []),
    ...(boundedReadProbe ? [boundedReadScript, boundedReadScript, boundedReadScript] : []),
    ...(boundedReadDenyProbe ? [boundedReadScript] : []),
    ...(subagentAdmissionProbe
      ? [
          {
            name: 'subagent',
            arguments: {
              description: `V2 ${subagentCaller} to ${subagentTarget} admission canary`,
              prompt: emptySubagentResultProbe
                ? 'Produce no assistant text in response to this child task.'
                : subagentTarget === 'athena'
                  ? 'Return ATHENA-CANARY-TRY-NESTED only.'
                  : `Return ${subagentTarget.toUpperCase()}-CANARY-CHILD only.`,
              agent: subagentTarget,
            },
          },
        ]
      : []),
  ]
  const model = await startMockModel(scripts, { emptySubagentResultProbe })
  writePlugins(sandbox, pluginSource, {
    permissionProbe: permissionProbe || boundedReadProbe || boundedReadDenyProbe,
    permissionAskProbe,
  })
  writeProjectConfig(sandbox, model.baseURL, {
    permissionProbe,
    permissionAskProbe,
    boundedReadProbe,
    boundedReadDenyProbe,
    subagentAdmissionProbe,
    emptySubagentResultProbe,
    subagentCaller,
    subagentTarget,
  })

  const observation = { sandbox }
  const host = await startHost(sandbox)
  try {
    observation.diagnose = () => host.diagnose()

    await host.prompt('report the tools you can reach')
    observation.catalogText = executeTexts(await host.transcript()).at(-1) ?? ''
    observation.catalog = parseScriptResult(observation.catalogText).catalog ?? []
    observation.afterCatalog = readFileSync(sandbox.targetFile, 'utf8')

    await host.prompt('make the edit that must be rejected')
    observation.badText = executeTexts(await host.transcript()).at(-1) ?? ''
    observation.bad = parseScriptResult(observation.badText)
    observation.afterBadRef = readFileSync(sandbox.targetFile, 'utf8')

    await host.prompt('make the edit that must be accepted')
    observation.goodText = executeTexts(await host.transcript()).at(-1) ?? ''
    observation.good = parseScriptResult(observation.goodText)
    observation.afterGoodRef = readFileSync(sandbox.targetFile, 'utf8')

    try {
      await host.prompt('describe this image with Pantheon Vision')
    } catch (error) {
      const sessions = await host.sessions().catch((cause) => ({ error: String(cause) }))
      const sessionRows = Array.isArray(sessions) ? sessions : (sessions?.data ?? [])
      const sessionDetails = await Promise.all(
        sessionRows.map(async (session) => {
          const sessionID = session?.id ?? session?.sessionID
          if (!sessionID) return { session }
          const result = await host.messages(sessionID).catch((cause) => ({ error: String(cause) }))
          const rows = Array.isArray(result) ? result : (result?.data ?? [])
          return {
            sessionID,
            parentID: session?.parentID,
            title: session?.title,
            rows: rows.slice(0, 4).map((row) => ({
              type: row?.type,
              role: row?.role ?? row?.info?.role,
              agent: row?.agent ?? row?.info?.agent,
              parts: (row?.parts ?? row?.content ?? []).map((part) => ({
                type: part?.type,
                name: part?.name ?? part?.tool,
                status: part?.state?.status,
                text: part?.text?.slice?.(0, 200),
                error: part?.state?.error?.message,
              })),
            })),
          }
        }),
      )
      throw new Error(
        `native vision prompt failed: ${String(error)}; model requests=${JSON.stringify(model.requestSummary())}; host=${host.diagnose()}; sessions=${JSON.stringify(sessionDetails)}`,
      )
    }
    observation.visionText = visionExecuteText(await host.transcript())
    observation.vision = parseScriptResult(observation.visionText)

    if (permissionProbe) {
      await host.prompt('exercise the V2 permission assertion canary')
      observation.permissionText = executeTexts(await host.transcript()).at(-1) ?? ''
      observation.permission = parseScriptResult(observation.permissionText)
    }

    if (permissionAskProbe) {
      const savedBefore = await host.savedPermissions()
      observation.askRequests = []
      for (const reply of ['always', 'once']) {
        const pending = await host.promptWithPermissionReply(
          `exercise native read ask and answer ${reply}`,
          reply,
        )
        observation.askRequests.push({
          action: pending.action,
          resources: pending.resources,
          save: pending.save,
          reply,
          output: executeTexts(await host.transcript()).at(-1) ?? '',
        })
      }
      observation.savedBefore = savedBefore?.data ?? []
      observation.savedAfter = (await host.savedPermissions())?.data ?? []
    }

    if (boundedReadProbe) {
      observation.boundedReadSavedBefore = (await host.savedPermissions())?.data ?? []
      observation.boundedReadRequests = []
      for (const [index, reply] of ['once', 'once', 'once'].entries()) {
        const sessionID = index < 2 ? host.sessionID : await host.createSession()
        const pending = await host.promptWithPermissionReply(
          `exercise Pantheon bounded read and answer ${reply}`,
          reply,
          'zeus',
          sessionID,
        )
        observation.boundedReadRequests.push({
          sessionID,
          action: pending.action,
          resources: pending.resources,
          save: pending.save,
          reply,
          output: executeTexts(await host.transcript()).at(-1) ?? '',
        })
      }
      observation.boundedReadSavedAfter = (await host.savedPermissions())?.data ?? []
    }

    if (boundedReadDenyProbe) {
      await host.prompt('exercise Pantheon bounded read under host deny', { agent: 'zeus' })
      observation.boundedReadDenyOutput = executeTexts(await host.transcript()).at(-1) ?? ''
    }

    if (subagentAdmissionProbe) {
      await host.prompt(`dispatch a native subagent call to ${subagentTarget}`)
      observation.taskTranscript = await host.transcript()
      observation.subagentCalls = toolParts(observation.taskTranscript, 'subagent')
    }

    observation.transcript = await host.transcript()
    observation.turns = model.turns()
    observation.emptyChildResponseRequests = model.emptyChildResponseRequests()
    observation.modelRequests = model.requestSummary()
    observation.sessions = await host.sessions()
    const sessionRows = Array.isArray(observation.sessions)
      ? observation.sessions
      : (observation.sessions?.data ?? [])
    observation.childSessions = sessionRows.filter(
      (session) => session?.parentID === host.sessionID,
    )
    const childSession = observation.childSessions[0]
    if (childSession?.id) {
      observation.childTranscript = JSON.stringify(await host.messages(childSession.id))
      observation.childSubagentCalls = toolParts(observation.childTranscript, 'subagent')
    }
    observation.observation = existsSync(sandbox.proofFile)
      ? JSON.parse(readFileSync(sandbox.proofFile, 'utf8'))
      : null
    const executeAfterEvidencePath = `${sandbox.proofFile}.execute-after.jsonl`
    observation.executeAfterEvidence = existsSync(executeAfterEvidencePath)
      ? readFileSync(executeAfterEvidencePath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : []
    observation.rootSessionID = host.sessionID
    observation.permissionProof = existsSync(sandbox.permissionProofFile)
      ? readFileSync(sandbox.permissionProofFile, 'utf8')
      : ''
  } finally {
    host.stop()
    model.close()
  }
  return observation
}

// ─── P0-5 permission matrix probes ───────────────────────────────────────

/**
 * What the repo translator emits for one V1 permission key.
 *
 * The comparison below is keyed by the V1 spelling the repo actually writes
 * (`permission.bash`, `permission.task`, `permission.write`, …) so a rename in
 * the host vocabulary cannot be mistaken for a test-side naming choice.
 */
function translatorActionFor(v1Key) {
  const [rule] = migrateV1toV2({ permission: { [v1Key]: 'deny' } }).permissions ?? []
  return rule?.action
}

/**
 * The read-only profile the repo's agents declare, expressed in V1 and passed
 * through the shipped translator. If the host still lets `bash` or `write`
 * through this block, the declared profile is broken — that is a failure, not
 * an observation.
 */
const MATRIX_READ_ONLY_V1 = {
  bash: 'deny',
  task: { '*': 'deny' },
  write: { '*': 'deny' },
  edit: { '*': 'deny' },
  read: 'allow',
  skill: { '*': 'deny' },
  websearch: 'deny',
}

const MATRIX_READ_ONLY_PERMISSIONS = migrateV1toV2({ permission: MATRIX_READ_ONLY_V1 }).permissions

/**
 * Permissive superset used ONLY to observe the host's action vocabulary.
 *
 * Both candidate spellings are allowed so the host never asks or hides a tool
 * while the probe watches; the assertion still compares the action the host
 * EMITS with the translator's output, never this list.
 */
const MATRIX_ACTION_OBSERVATION_PERMISSIONS = [
  'bash',
  'shell',
  'write',
  'edit',
  'read',
  'task',
  'subagent',
  'skill',
  'websearch',
  'webfetch',
].map((action) => ({ action, resource: '*', effect: 'allow' }))

/** The two orderings of the nested-allow / wildcard-deny conflict. */
const MATRIX_ORDER_NESTED_FIRST = [
  { action: 'write', resource: '.pantheon/memory-bank/**', effect: 'allow' },
  { action: 'write', resource: '*', effect: 'deny' },
]

const MATRIX_ORDER_WILDCARD_FIRST = [
  { action: 'write', resource: '*', effect: 'deny' },
  { action: 'write', resource: '.pantheon/memory-bank/**', effect: 'allow' },
]

/**
 * The same two orderings in the namespace the host actually evaluates for a
 * write call: `edit` (measured on every V2 host). The `write` rows above are
 * kept as the historical probe; `edit` is the load-bearing one (D-2).
 */
const MATRIX_ORDER_NESTED_FIRST_EDIT = [
  { action: 'edit', resource: '.pantheon/memory-bank/**', effect: 'allow' },
  { action: 'edit', resource: '*', effect: 'deny' },
]

const MATRIX_ORDER_WILDCARD_FIRST_EDIT = [
  { action: 'edit', resource: '*', effect: 'deny' },
  { action: 'edit', resource: '.pantheon/memory-bank/**', effect: 'allow' },
]

/**
 * Real-call order probes. They use a broad `.pantheon/**` deny/allow instead of
 * the global `*` used by the assert probe: a global deny hides the write tool
 * from the catalog before any path can be evaluated, which would make the
 * real-call test vacuous. These three cover both directions of the overlap.
 */
const MATRIX_ORDER_REAL_DENY_BROAD_THEN_ALLOW = [
  { action: 'edit', resource: '.pantheon/**', effect: 'deny' },
  { action: 'edit', resource: '.pantheon/memory-bank/**', effect: 'allow' },
]

const MATRIX_ORDER_REAL_ALLOW_NESTED_THEN_DENY_BROAD = [
  { action: 'edit', resource: '.pantheon/memory-bank/**', effect: 'allow' },
  { action: 'edit', resource: '.pantheon/**', effect: 'deny' },
]

const MATRIX_ORDER_REAL_ALLOW_BROAD_THEN_DENY_NESTED = [
  { action: 'edit', resource: '.pantheon/**', effect: 'allow' },
  { action: 'edit', resource: '.pantheon/memory-bank/**', effect: 'deny' },
]

const MATRIX_ORDER_REAL_MEMORY = '.pantheon/memory-bank/00-index.md'
const MATRIX_ORDER_REAL_OUTSIDE = '.pantheon/other.md'

/** `permission.task: { "*": deny, apollo: allow }`, translated by the repo. */
const MATRIX_TASK_GLOB_PERMISSIONS = migrateV1toV2({
  permission: { task: { '*': 'deny', apollo: 'allow' } },
}).permissions

/**
 * One allow rule per action under test, plus the three already-proven names so
 * the same host boot also exercises the baseline.
 *
 * These rules exist only to keep the tools runnable while the probe watches.
 * The assertion compares the action the HOST evaluates with the action the repo
 * translator emits; the names in this list are never used as the expectation.
 */
const MATRIX_ACTION_COVERAGE_ACTIONS = [
  'shell',
  'edit',
  'read',
  'grep',
  'glob',
  'webfetch',
  'websearch',
  'skill',
  'hashline_edit',
  'vision_describe',
  'question',
  'mcp',
]

const MATRIX_ACTION_COVERAGE_PERMISSIONS = MATRIX_ACTION_COVERAGE_ACTIONS.map((action) => ({
  action,
  resource: '*',
  effect: 'allow',
}))

/**
 * Code Mode script for the MCP case.
 *
 * The catalog entry proves the host built a tool for the configured server;
 * the call uses the server and tool names the TEST owns (`canary`, `echo`), so
 * it is not a guess about the host's naming scheme. `search` is the host's own
 * catalog lookup, and the returned path is recorded as evidence.
 */
const MATRIX_MCP_CALL_SCRIPT = [
  'const found = search({ query: "canary" });',
  'const out = { paths: found.items.map((item) => item.path) };',
  'try {',
  '  out.result = await tools.canary.echo({ text: "action-coverage" });',
  '} catch (err) {',
  '  out.error = String(err && err.message ? err.message : err);',
  '}',
  'return JSON.stringify(out);',
].join('\n')

const MATRIX_MCP_CONFIG = (sandbox) => ({
  canary: {
    type: 'local',
    command: [process.execPath, sandbox.mcpServerFile, sandbox.mcpLogFile],
    enabled: true,
  },
})

/**
 * The smallest MCP server that proves the `mcp` action: stdio JSON-RPC 2.0,
 * one tool, no network, no dependencies. It is written into the sandbox and
 * launched by the HOST, so the call crosses the host's own MCP client path.
 */
const CANARY_MCP_SOURCE = `'use strict'
const readline = require('node:readline')
// Optional argv[2]: a log path inside the canary sandbox. It records the raw
// stdio exchange, which is what distinguishes "the host never connected" from
// "the server answered the wrong shape" without guessing.
const logPath = process.argv[2]
const log = (line) => {
  if (!logPath) return
  try {
    require('node:fs').appendFileSync(logPath, line + '\\n')
  } catch {
    // Evidence only.
  }
}
const send = (message) => {
  const line = JSON.stringify(message)
  log('OUT ' + line)
  process.stdout.write(line + '\\n')
}
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  log('IN ' + line)
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  // Notifications have no id and must not be answered.
  if (message.id === undefined) return
  const id = message.id
  switch (message.method) {
    case 'initialize':
      reply(id, {
        protocolVersion: (message.params && message.params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'canary-mcp', version: '1.0.0' },
      })
      break
    case 'ping':
      reply(id, {})
      break
    case 'tools/list':
      reply(id, {
        tools: [
          {
            name: 'echo',
            description: 'Return the text it receives',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
              additionalProperties: false,
            },
          },
        ],
      })
      break
    case 'tools/call':
      reply(id, {
        content: [
          {
            type: 'text',
            text: 'CANARY-MCP-ECHO:' + String((message.params && message.params.arguments && message.params.arguments.text) || ''),
          },
        ],
      })
      break
    case 'resources/list':
      reply(id, { resources: [] })
      break
    default:
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'unsupported method ' + String(message.method) },
      })
  }
})
`

function writeCanaryMcpServer(sandbox) {
  writeFileSync(sandbox.mcpServerFile, CANARY_MCP_SOURCE)
}

function writeCanarySkill(sandbox) {
  mkdirSync(dirname(sandbox.skillFile), { recursive: true })
  writeFileSync(
    sandbox.skillFile,
    [
      '---',
      'name: canary-skill',
      'description: Permission action coverage canary.',
      '---',
      '',
      'CANARY-SKILL-BODY',
      '',
    ].join('\n'),
  )
}

/**
 * Local HTTP target for `webfetch`. Loopback only; `--unshare-net` still brings
 * `lo` up, which is the same path the mocked model already uses.
 */
async function startWebFetchTarget() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('CANARY-WEBFETCH-BODY')
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/canary.txt`,
    close: () => server.close(),
  }
}

const MATRIX_TASK_AGENTS = {
  zeus: {
    mode: 'primary',
    system: 'Dispatch only the agent named in the task.',
  },
  apollo: {
    mode: 'subagent',
    description: 'Allowed task-glob target',
    system: 'Reply with APOLLO-MATRIX-CHILD only.',
  },
  demeter: {
    mode: 'subagent',
    description: 'Second task-glob target',
    system: 'Reply with DEMETER-MATRIX-CHILD only.',
  },
}

/** The action-name and ordering scenarios only need the default caller. */
const MATRIX_BASE_AGENTS = {
  zeus: {
    mode: 'primary',
    system: 'Exercise the permission matrix probe.',
  },
}

/** One nested-glob probe plus a control outside the allow glob. */
function matrixOrderScript(resource, controlResource, action = 'write') {
  return [
    `const probe = await tools.permission_matrix_probe({ action: ${JSON.stringify(action)}, resources: [${JSON.stringify(resource)}] });`,
    `const control = await tools.permission_matrix_probe({ action: ${JSON.stringify(action)}, resources: [${JSON.stringify(controlResource)}] });`,
    'return JSON.stringify({ probe, control });',
  ].join('\n')
}

/** Seed both real-call targets with distinguishable original content. */
function prepareOrderReal(sandbox) {
  const memory = join(sandbox.projectDir, MATRIX_ORDER_REAL_MEMORY)
  const outside = join(sandbox.projectDir, MATRIX_ORDER_REAL_OUTSIDE)
  mkdirSync(dirname(memory), { recursive: true })
  mkdirSync(dirname(outside), { recursive: true })
  writeFileSync(memory, 'ORIGINAL-MEMORY\n')
  writeFileSync(outside, 'ORIGINAL-OUTSIDE\n')
}

/** Two real `write` calls: one inside the nested scope, one outside. */
function matrixOrderRealScripts(sandbox) {
  return [
    {
      name: 'write',
      arguments: {
        path: join(sandbox.projectDir, MATRIX_ORDER_REAL_MEMORY),
        content: 'CANARY-MEMORY-WRITE',
      },
    },
    {
      name: 'write',
      arguments: {
        path: join(sandbox.projectDir, MATRIX_ORDER_REAL_OUTSIDE),
        content: 'CANARY-OUTSIDE-WRITE',
      },
    },
  ]
}

/** Ground truth for a real-call order scenario: file bytes, not just status. */
function summarizeOrderReal(observation) {
  const memoryPath = join(observation.sandbox.projectDir, MATRIX_ORDER_REAL_MEMORY)
  const outsidePath = join(observation.sandbox.projectDir, MATRIX_ORDER_REAL_OUTSIDE)
  const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '')
  return {
    memoryWritten: read(memoryPath).includes('CANARY-MEMORY-WRITE'),
    outsideWritten: read(outsidePath).includes('CANARY-OUTSIDE-WRITE'),
    memoryContent: read(memoryPath).slice(0, 200),
    outsideContent: read(outsidePath).slice(0, 200),
    writeCalls: observation.nativeCalls.write.map((part) => ({
      status: part.state?.status,
      error: part.state?.error?.message,
      input: part.state?.input,
    })),
    editEvaluations: (observation.matrixEvents ?? [])
      .filter((event) => event.action === 'edit')
      .map((event) => ({
        action: event.action,
        resources: event.resources,
        effect: event.effect,
      })),
  }
}

/**
 * Run one host against a config the scenario controls and return raw evidence.
 *
 * Nothing is asserted here: this function only drives the host and reads back
 * what it did. The tests decide which observations contradict a repo policy.
 */
async function runPermissionMatrixScenario({
  name,
  permissions,
  policies,
  agents,
  defaultAgent,
  mcp,
  scripts,
  prepare,
  promptLabel,
  // A `question` call does not resolve until a user answers, and this canary
  // has no interactive client. The permission evaluation still happens before
  // the tool blocks, so this mode drives the prompt, waits for the named
  // action's evaluation, and then stops the host instead of awaiting a result.
  awaitPrompt = true,
  waitForAction,
}) {
  const sandbox = makeSandbox()
  writeFileSync(sandbox.targetFile, TARGET_BODY)
  prepare?.(sandbox)
  const steps = typeof scripts === 'function' ? scripts(sandbox) : scripts
  const resolvedMcp = typeof mcp === 'function' ? mcp(sandbox) : mcp
  const model = await startMockModel(steps)
  writePlugins(sandbox, realPluginShim(), { matrixProbe: true })
  writePermissionMatrixConfig(sandbox, model.baseURL, {
    permissions,
    policies,
    agents,
    defaultAgent,
    mcp: resolvedMcp,
  })
  const host = await startHost(sandbox)
  const observation = { name, sandbox, responses: [] }
  if (resolvedMcp) {
    // Evidence, not an assertion: the host's own view of the MCP servers. A
    // failed connection here is what makes the `mcp` case unobservable, and the
    // report must say so instead of blaming the permission layer.
    // The host connects MCP servers asynchronously; a snapshot taken right
    // after `serve` is ready can legitimately be empty. Wait for the server to
    // appear (bounded) and say exactly what the host reported either way.
    observation.mcpStatus = await waitFor(
      async () => {
        const status = await host.request('GET', '/api/mcp').catch(() => null)
        const rows = Array.isArray(status?.data) ? status.data : []
        // `pending` is the host's startup state; the server tool is not in the
        // catalog until the connection settles. Gate on a non-pending status so
        // the MCP scripts are not racing process startup.
        return rows.length > 0 && rows.every((row) => row?.status?.status !== 'pending')
          ? status
          : null
      },
      20_000,
      'the host to finish connecting the canary MCP server',
    ).catch(async (error) => ({
      error: String(error),
      last: await host.request('GET', '/api/mcp').catch((cause) => String(cause)),
    }))
  }
  const readEvents = () =>
    existsSync(sandbox.matrixProofFile)
      ? readFileSync(sandbox.matrixProofFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : []
  try {
    if (awaitPrompt) {
      for (const [index] of steps.entries()) {
        await host.prompt(`${promptLabel ?? 'permission matrix'} ${name} ${index}`)
        observation.responses.push(executeTexts(await host.transcript()).at(-1) ?? '')
      }
    } else {
      host.prompt(`${promptLabel ?? 'permission matrix'} ${name} 0`).catch(() => {})
      await waitFor(
        () => readEvents().some((event) => event.action === waitForAction),
        TIMEOUT_MS,
        `a ${waitForAction} permission evaluation from ${name}`,
      ).catch((error) => {
        // Recorded, not swallowed: the test decides whether the absence is a
        // structural NOT_APPLICABLE or a defect, and says so by name.
        observation.waitError = String(error?.message ?? error)
      })
    }
    observation.matrixEvents = readEvents()
    observation.permissionProof = existsSync(sandbox.permissionProofFile)
      ? readFileSync(sandbox.permissionProofFile, 'utf8')
      : ''
    observation.toolList = existsSync(sandbox.proofFile)
      ? (JSON.parse(readFileSync(sandbox.proofFile, 'utf8')).toolList ?? [])
      : []
    observation.modelToolNames = model.toolNames()
    if (awaitPrompt) {
      observation.transcript = await host.transcript()
      observation.nativeCalls = {
        shell: toolParts(observation.transcript, 'shell'),
        bash: toolParts(observation.transcript, 'bash'),
        write: toolParts(observation.transcript, 'write'),
        read: toolParts(observation.transcript, 'read'),
        subagent: toolParts(observation.transcript, 'subagent'),
      }
      observation.sessions = await host.sessions()
      const sessionRows = Array.isArray(observation.sessions)
        ? observation.sessions
        : (observation.sessions?.data ?? [])
      observation.childSessions = sessionRows.filter(
        (session) => session?.parentID === host.sessionID,
      )
      observation.rootSessionID = host.sessionID
      observation.sideEffects = {
        shell: existsSync(join(sandbox.projectDir, 'shell-ran.txt')),
        write: existsSync(join(sandbox.projectDir, 'write-ran.txt')),
      }
    }
  } finally {
    host.stop()
    model.close()
  }
  return observation
}

/** Compact, secret-free evidence for one scenario's artifact entry. */
function summarizeMatrixObservation(observation) {
  return {
    scenario: observation.name,
    evaluations: observation.matrixEvents.map((event) => ({
      action: event.action,
      resources: event.resources,
      effect: event.effect,
    })),
    calls: Object.fromEntries(
      Object.entries(observation.nativeCalls).map(([tool, parts]) => [
        tool,
        parts.map((part) => ({
          status: part?.state?.status,
          error: part?.state?.error?.message,
          input: part?.state?.input,
        })),
      ]),
    ),
    sideEffects: observation.sideEffects,
    readOutput: toolParts(observation.transcript, 'read')
      .map(toolResultText)
      .join('\n')
      .slice(0, 200),
    toolCalls: allToolParts(observation.transcript ?? '[]').map((part) => ({
      name: part.tool ?? part.name,
      id: part.id,
      status: part.state?.status,
      error: part.state?.error?.message,
      output: toolResultText(part).slice(0, 400),
    })),
  }
}

/** Code Mode unwraps a tool's `output` to a JSON string; parse it back. */
function matrixDecision(value) {
  return typeof value === 'string' ? JSON.parse(value) : value
}

/** Classify the two-order evidence without assuming which rule the host uses. */
function classifyResolution(nestedFirst, wildcardFirst) {
  const decision = (value) => matrixDecision(value)?.decision
  // `not-applicable` is not a decision: the host lacked the API the probe calls,
  // so the ordering question was not answered at all.
  if (decision(nestedFirst) === 'not-applicable' || decision(wildcardFirst) === 'not-applicable') {
    return 'not-applicable'
  }
  // A non-policy failure is a broken probe, not a resolution rule. Returning it
  // makes the caller's allow-list assertion fail loudly instead of classifying
  // an exception as `deny-precedence`.
  if (decision(nestedFirst) === 'probe-error' || decision(wildcardFirst) === 'probe-error') {
    return 'probe-error'
  }
  const allowed = (value) => decision(value) === 'allow'
  const nested = allowed(nestedFirst)
  const wildcard = allowed(wildcardFirst)
  if (nested && wildcard) return 'most-specific-wins'
  if (nested && !wildcard) return 'first-match-wins'
  if (!nested && !wildcard) return 'deny-precedence'
  return 'last-match-wins'
}

/**
 * Run every P0-5 scenario and build the artifact payload.
 *
 * Each scenario owns a host and a config, so action names are correlated with
 * the scripted native call that produced them instead of with a guessed field.
 */
async function runPermissionMatrix() {
  const scenarios = {}
  // A loopback-only HTTP target for the webfetch case. The host fetches it
  // from its own process, so the request crosses the host's webfetch path.
  const webFetch = await startWebFetchTarget()

  scenarios.actionNames = await runPermissionMatrixScenario({
    name: 'action-names-permissive',
    permissions: MATRIX_ACTION_OBSERVATION_PERMISSIONS,
    // Tool gating is a separate policy layer (`tool.use`); without an allow
    // here a host with no managed config blocks shell before the permission
    // layer this probe measures can be observed.
    policies: [
      { action: 'tool.use', resource: 'shell:*', effect: 'allow' },
      { action: 'tool.use', resource: 'write:*', effect: 'allow' },
      { action: 'tool.use', resource: 'edit:*', effect: 'allow' },
      { action: 'tool.use', resource: 'read:*', effect: 'allow' },
    ],
    agents: MATRIX_BASE_AGENTS,
    defaultAgent: 'zeus',
    scripts: (sandbox) => [
      { name: 'shell', arguments: { command: 'echo CANARY-SHELL-RAN > shell-ran.txt' } },
      {
        name: 'write',
        arguments: {
          path: join(sandbox.projectDir, 'write-ran.txt'),
          content: 'CANARY-WRITE-RAN',
        },
      },
      { name: 'read', arguments: { path: sandbox.targetFile } },
    ],
    promptLabel: 'observe the host action vocabulary',
  })

  scenarios.readOnly = await runPermissionMatrixScenario({
    name: 'read-only-enforcement',
    permissions: MATRIX_READ_ONLY_PERMISSIONS,
    agents: MATRIX_BASE_AGENTS,
    defaultAgent: 'zeus',
    scripts: (sandbox) => [
      { name: 'shell', arguments: { command: 'echo CANARY-SHELL-RAN > shell-ran.txt' } },
      {
        name: 'write',
        arguments: {
          path: join(sandbox.projectDir, 'write-ran.txt'),
          content: 'CANARY-WRITE-RAN',
        },
      },
      { name: 'read', arguments: { path: sandbox.targetFile } },
    ],
    promptLabel: 'exercise the read-only profile',
  })

  scenarios.orderNestedFirst = await runPermissionMatrixScenario({
    name: 'order-nested-first',
    permissions: MATRIX_ORDER_NESTED_FIRST,
    agents: MATRIX_BASE_AGENTS,
    defaultAgent: 'zeus',
    scripts: [matrixOrderScript('.pantheon/memory-bank/00-index.md', '.pantheon/other.md')],
  })
  scenarios.orderWildcardFirst = await runPermissionMatrixScenario({
    name: 'order-wildcard-first',
    permissions: MATRIX_ORDER_WILDCARD_FIRST,
    agents: MATRIX_BASE_AGENTS,
    defaultAgent: 'zeus',
    scripts: [matrixOrderScript('.pantheon/memory-bank/00-index.md', '.pantheon/other.md')],
  })

  // D-2: the host evaluates a real write as action `edit`. Run the same two
  // orderings in that namespace; this is the evidence the sort policy needs.
  scenarios.orderEditNestedFirst = await runPermissionMatrixScenario({
    name: 'order-edit-nested-first',
    permissions: MATRIX_ORDER_NESTED_FIRST_EDIT,
    agents: MATRIX_BASE_AGENTS,
    defaultAgent: 'zeus',
    scripts: [matrixOrderScript('.pantheon/memory-bank/00-index.md', '.pantheon/other.md', 'edit')],
  })
  scenarios.orderEditWildcardFirst = await runPermissionMatrixScenario({
    name: 'order-edit-wildcard-first',
    permissions: MATRIX_ORDER_WILDCARD_FIRST_EDIT,
    agents: MATRIX_BASE_AGENTS,
    defaultAgent: 'zeus',
    scripts: [matrixOrderScript('.pantheon/memory-bank/00-index.md', '.pantheon/other.md', 'edit')],
  })

  // Strongest form: real `write` calls under `edit` rules. The broad scope is
  // `.pantheon/**`, not `*`, so the tool survives the catalog filter and the
  // path can actually be evaluated.
  const realOrderCases = {
    'deny-broad-then-allow': MATRIX_ORDER_REAL_DENY_BROAD_THEN_ALLOW,
    'allow-nested-then-deny-broad': MATRIX_ORDER_REAL_ALLOW_NESTED_THEN_DENY_BROAD,
    'allow-broad-then-deny-nested': MATRIX_ORDER_REAL_ALLOW_BROAD_THEN_DENY_NESTED,
  }
  for (const [key, permissions] of Object.entries(realOrderCases)) {
    scenarios[`orderReal:${key}`] = await runPermissionMatrixScenario({
      name: `order-real-${key}`,
      permissions,
      policies: [{ action: 'tool.use', resource: 'write:*', effect: 'allow' }],
      agents: MATRIX_BASE_AGENTS,
      defaultAgent: 'zeus',
      prepare: prepareOrderReal,
      scripts: matrixOrderRealScripts,
      promptLabel: `real write order ${key}`,
    })
  }

  for (const target of ['apollo', 'demeter']) {
    scenarios[`taskGlob:${target}`] = await runPermissionMatrixScenario({
      name: `task-glob-${target}`,
      permissions: MATRIX_TASK_GLOB_PERMISSIONS,
      agents: MATRIX_TASK_AGENTS,
      defaultAgent: 'zeus',
      scripts: [
        {
          name: 'subagent',
          arguments: {
            description: `task glob matrix ${target}`,
            prompt: `Return ${target.toUpperCase()}-MATRIX-CHILD only.`,
            agent: target,
          },
        },
      ],
      promptLabel: `dispatch the task-glob target ${target}`,
    })
  }

  // Action-name coverage for the tools the installer and the agent templates
  // can name but the matrix had never observed: mcp, webfetch, skill, websearch,
  // grep, glob, hashline_edit, vision_describe. One host, one config, one
  // scripted call per tool; the evaluate hook records what the HOST emits.
  scenarios.actionCoverage = await runPermissionMatrixScenario({
    name: 'action-coverage',
    permissions: MATRIX_ACTION_COVERAGE_PERMISSIONS,
    agents: MATRIX_BASE_AGENTS,
    defaultAgent: 'zeus',
    prepare: (sandbox) => {
      writeCanaryMcpServer(sandbox)
      writeCanarySkill(sandbox)
    },
    mcp: MATRIX_MCP_CONFIG,
    scripts: (sandbox) => [
      { name: 'grep', arguments: { pattern: 'CANARY-ALPHA', path: sandbox.projectDir } },
      { name: 'glob', arguments: { pattern: '*.txt', path: sandbox.projectDir } },
      { name: 'webfetch', arguments: { url: webFetch.url } },
      // The host schema for the skill tool keys on `id`, not `name`.
      { name: 'skill', arguments: { id: 'canary-skill' } },
      // Plugin tools are NOT in the model's flat tool list; the host exposes
      // them through the `execute` (Code Mode) tool. Calling them any other way
      // reports "No tool named ..." and would make the case vacuously pass.
      {
        name: 'execute',
        arguments: {
          code: [
            'const out = {};',
            'try {',
            `  out.result = await tools.hashline_edit({ file: ${JSON.stringify(sandbox.targetFile)}, edits: [{ op: 'replace', ref: ${JSON.stringify(BETA_REF)}, lines: ['CANARY-BETA-REPLACED'] }] });`,
            '} catch (err) {',
            '  out.error = String(err && err.message ? err.message : err);',
            '}',
            'return JSON.stringify(out);',
          ].join('\n'),
        },
      },
      {
        name: 'execute',
        arguments: {
          code: [
            'const out = {};',
            'try {',
            `  out.result = await tools.vision_describe({ path: ${JSON.stringify(VISION_IMAGE)}, prompt: 'Describe this canary image.' });`,
            '} catch (err) {',
            '  out.error = String(err && err.message ? err.message : err);',
            '}',
            'return JSON.stringify(out);',
          ].join('\n'),
        },
      },
      // MCP tools are not in the model's flat tool list; like the plugin tools
      // they are reached through Code Mode. Discover the host-built path from
      // the catalog instead of encoding a naming guess in the test.
      { name: 'execute', arguments: { code: MATRIX_MCP_CALL_SCRIPT } },
    ],
    promptLabel: 'observe the extended action vocabulary',
  })

  // The installer writes `permission.mcp.<server>` and the repo translator
  // passes the key through as the action `mcp`. These two scenarios differ in
  // ONE rule — the installer's `mcp.canary` effect — so any difference in
  // whether the server tool runs is attributable to that rule, not to boot
  // timing or to the MCP server itself.
  const mcpShapePermissions = (effect) => [
    ...MATRIX_ACTION_COVERAGE_ACTIONS.filter((action) => action !== 'mcp').map((action) => ({
      action,
      resource: '*',
      effect: 'allow',
    })),
    // The installer's legacy shape: action `mcp`, server in `resource`.
    { action: 'mcp', resource: 'canary', effect },
  ]

  scenarios.mcpAllowShape = await runPermissionMatrixScenario({
    name: 'mcp-installer-shape-allow',
    permissions: mcpShapePermissions('allow'),
    agents: MATRIX_BASE_AGENTS,
    defaultAgent: 'zeus',
    prepare: writeCanaryMcpServer,
    mcp: MATRIX_MCP_CONFIG,
    // The first chat turn builds the session tool/catalog snapshot BEFORE the
    // lazy plugin/MCP registration for that turn lands (measured: a first-turn
    // `search` finds no MCP path even with status "connected"). One warm-up
    // read makes the MCP turn the same shape as the coverage scenario, and it
    // is identical in the allow and deny runs, so the differential stays valid.
    scripts: (sandbox) => [
      { name: 'read', arguments: { path: sandbox.targetFile } },
      { name: 'execute', arguments: { code: MATRIX_MCP_CALL_SCRIPT } },
    ],
    promptLabel: 'exercise the installer mcp allow shape',
  })

  scenarios.mcpRuleShape = await runPermissionMatrixScenario({
    name: 'mcp-installer-shape-deny',
    permissions: mcpShapePermissions('deny'),
    agents: MATRIX_BASE_AGENTS,
    defaultAgent: 'zeus',
    prepare: writeCanaryMcpServer,
    mcp: MATRIX_MCP_CONFIG,
    scripts: (sandbox) => [
      { name: 'read', arguments: { path: sandbox.targetFile } },
      { name: 'execute', arguments: { code: MATRIX_MCP_CALL_SCRIPT } },
    ],
    promptLabel: 'exercise the installer mcp permission shape',
  })

  // `question` blocks on a human answer, which this canary has no client for.
  // The permission evaluation precedes that block, so a bounded wait for the
  // evaluation is enough; the run then stops without a tool result.
  scenarios.questionAction = await runPermissionMatrixScenario({
    name: 'question-action',
    permissions: MATRIX_ACTION_COVERAGE_PERMISSIONS,
    agents: MATRIX_BASE_AGENTS,
    defaultAgent: 'zeus',
    scripts: [
      {
        name: 'question',
        arguments: {
          questions: [
            {
              question: 'Canary question?',
              header: 'Canary',
              options: [{ label: 'A', description: 'canary option' }],
            },
          ],
        },
      },
    ],
    awaitPrompt: false,
    waitForAction: 'question',
    promptLabel: 'observe the question permission action',
  })

  webFetch.close()

  const nestedFirst = parseScriptResult(scenarios.orderNestedFirst.responses.at(-1) ?? '')
  const wildcardFirst = parseScriptResult(scenarios.orderWildcardFirst.responses.at(-1) ?? '')
  const editNestedFirst = parseScriptResult(scenarios.orderEditNestedFirst.responses.at(-1) ?? '')
  const editWildcardFirst = parseScriptResult(
    scenarios.orderEditWildcardFirst.responses.at(-1) ?? '',
  )

  const report = {
    host: {
      bin: BIN,
      version: spawnSync(BIN, ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? '',
    },
    isolation: {
      // The wrapper applies the managed deny/etc fixture ONLY to the precedence
      // run. `false` here proves the matrix scenarios ran against their own
      // project config, not that fixture.
      managedDenyFixture: process.env.PANTHEON_TOOL_CANARY_MANAGED_DENY_FIXTURE === '1',
    },
    toolList: scenarios.orderNestedFirst.toolList.map((tool) => tool.name),
    translator: {
      entries: Object.fromEntries(
        [...Object.keys(MATRIX_READ_ONLY_V1), ...MATRIX_ACTION_COVERAGE_ACTIONS].map((key) => [
          key,
          translatorActionFor(key),
        ]),
      ),
    },
    actionNames: summarizeMatrixObservation(scenarios.actionNames),
    actionCoverage: {
      ...summarizeMatrixObservation(scenarios.actionCoverage),
      observedActions: [
        ...new Set(scenarios.actionCoverage.matrixEvents.map((event) => event.action)),
      ].sort(),
      // The exact host-built name of the MCP tool the model was offered, so
      // the evidence says which tool was invoked, not just that "mcp" appeared.
      mcpToolNames: scenarios.actionCoverage.toolList
        .map((tool) => tool.name)
        .filter((name) => /canary/i.test(name)),
      mcpStatus: scenarios.actionCoverage.mcpStatus ?? null,
      mcpServerLog: existsSync(scenarios.actionCoverage.sandbox.mcpLogFile)
        ? readFileSync(scenarios.actionCoverage.sandbox.mcpLogFile, 'utf8').slice(-4000)
        : null,
      modelToolNames: scenarios.actionCoverage.modelToolNames ?? [],
      toolCalls: allToolParts(scenarios.actionCoverage.transcript).map((part) => ({
        name: part.tool ?? part.name,
        id: part.id,
        callID: part.callID,
        status: part.state?.status,
        error: part.state?.error?.message,
        output: toolResultText(part).slice(0, 600),
      })),
    },
    questionAction: {
      evaluations: scenarios.questionAction.matrixEvents.map((event) => ({
        action: event.action,
        resources: event.resources,
        effect: event.effect,
      })),
      waitError: scenarios.questionAction.waitError ?? null,
    },
    mcpShape: {
      allow: summarizeMatrixObservation(scenarios.mcpAllowShape),
      deny: summarizeMatrixObservation(scenarios.mcpRuleShape),
    },
    readOnly: summarizeMatrixObservation(scenarios.readOnly),
    order: {
      nestedFirst: {
        policies: MATRIX_ORDER_NESTED_FIRST,
        probe: matrixDecision(nestedFirst.probe),
        control: matrixDecision(nestedFirst.control),
      },
      wildcardFirst: {
        policies: MATRIX_ORDER_WILDCARD_FIRST,
        probe: matrixDecision(wildcardFirst.probe),
        control: matrixDecision(wildcardFirst.control),
      },
      resolution: classifyResolution(nestedFirst.probe, wildcardFirst.probe),
    },
    orderEdit: {
      nestedFirst: {
        policies: MATRIX_ORDER_NESTED_FIRST_EDIT,
        probe: matrixDecision(editNestedFirst.probe),
        control: matrixDecision(editNestedFirst.control),
      },
      wildcardFirst: {
        policies: MATRIX_ORDER_WILDCARD_FIRST_EDIT,
        probe: matrixDecision(editWildcardFirst.probe),
        control: matrixDecision(editWildcardFirst.control),
      },
      resolution: classifyResolution(editNestedFirst.probe, editWildcardFirst.probe),
    },
    orderReal: Object.fromEntries(
      Object.keys(realOrderCases).map((key) => [
        key,
        summarizeOrderReal(scenarios[`orderReal:${key}`]),
      ]),
    ),
    taskGlob: Object.fromEntries(
      ['apollo', 'demeter'].map((target) => {
        const observation = scenarios[`taskGlob:${target}`]
        const call = observation.nativeCalls.subagent.at(-1)
        return [
          target,
          {
            permissions: MATRIX_TASK_GLOB_PERMISSIONS,
            status: call?.state?.status,
            error: call?.state?.error?.message,
            evaluations: observation.matrixEvents.map((event) => ({
              action: event.action,
              resources: event.resources,
              effect: event.effect,
            })),
            childSessions: observation.childSessions.length,
          },
        ]
      }),
    ),
  }

  const reportPath = process.env.PANTHEON_TOOL_CANARY_MATRIX_REPORT
  if (reportPath) {
    try {
      writeFileSync(reportPath, JSON.stringify(report, null, 2))
      console.log(`permission matrix report: ${reportPath}`)
    } catch (error) {
      console.log(`permission matrix report could not be written: ${String(error)}`)
    }
  }
  console.log(`permission matrix evidence: ${JSON.stringify(report)}`)
  return { scenarios, report }
}

// ─── P0-5 MCP action-name gating probe ───────────────────────────────────

/**
 * The host evaluates an MCP tool call with action `<server>_<tool>` and
 * `resources: ["*"]`; the installer instead writes `permission.mcp.<server>`,
 * which the differential above proves inert. This probe answers the narrower
 * question — whether a rule whose `action` IS the emitted name blocks the call —
 * and at what granularity, on every supported host.
 *
 * The emitted name is DISCOVERED from a permissive run and only then used to
 * write the deny scenarios, so no host naming scheme is hard-coded here.
 */
const MCP_GATING_BASE_ACTIONS = [
  'shell',
  'edit',
  'read',
  'grep',
  'glob',
  'webfetch',
  'websearch',
  'skill',
  'hashline_edit',
  'vision_describe',
  'question',
]

function mcpGatingPermissions(rule) {
  return [
    ...MCP_GATING_BASE_ACTIONS.map((action) => ({ action, resource: '*', effect: 'allow' })),
    ...(rule ? [rule] : []),
  ]
}

/**
 * Catalog lookup + call in one Code Mode script.
 *
 * `paths` separates "the host removed the tool from the catalog" from "the host
 * let the call through". The result text separates "the tool executed" from
 * "the call was rejected"; the MCP server's own stdio log is the third,
 * independent witness.
 */
function mcpGatingTraceScript(callExpression) {
  return [
    'const found = search({ query: "canary" });',
    'const out = { paths: found.items.map((item) => item.path) };',
    'try {',
    `  out.result = await ${callExpression}({ text: "mcp-gating" });`,
    '  out.executed = true;',
    '} catch (err) {',
    '  out.error = String(err && err.message ? err.message : err);',
    '}',
    'return JSON.stringify(out);',
  ].join('\n')
}

function mcpGatingScripts(sandbox, { callExpression = 'tools.canary.echo' } = {}) {
  // Turn 1 warms the session catalog: the host builds the tool snapshot before
  // the lazy MCP registration for that turn lands (measured on 2.0.29). The
  // allow control and every deny run use the same shape, so the differential is
  // attributable to the one rule that differs.
  return [
    { name: 'read', arguments: { path: sandbox.targetFile } },
    { name: 'execute', arguments: { code: mcpGatingTraceScript(callExpression) } },
  ]
}

/** Everything needed to decide "blocked" without trusting a single surface. */
function summarizeMcpGating(observation, rule, codeNeedle = 'tools.canary.echo') {
  const part = matrixCodePart(observation, codeNeedle)
  const text = part ? toolResultText(part) : ''
  const parsed = parseScriptResult(text)
  const event = matrixEventForPart(observation, part)
  const log = existsSync(observation.sandbox.mcpLogFile)
    ? readFileSync(observation.sandbox.mcpLogFile, 'utf8')
    : ''
  const executed = /CANARY-MCP-ECHO/.test(text)
  return {
    rule,
    // `executed` is the positive fact; `blocked` is only claimed when the
    // scripted `execute` itself completed, so a dead host or a host that lost
    // the `execute` tool is reported as not-measured instead of as a block.
    verdict: executed
      ? 'executed'
      : observation
        ? part?.state?.status === 'completed'
          ? 'blocked'
          : 'not-measured'
        : 'not-measured',
    status: part?.state?.status ?? null,
    toolPresentInCatalog: Array.isArray(parsed?.paths) ? parsed.paths.length > 0 : null,
    catalogPaths: Array.isArray(parsed?.paths) ? parsed.paths : null,
    executed,
    literalMessage: part?.state?.error?.message ?? parsed?.error ?? event?.message ?? null,
    evaluation: event
      ? {
          action: event.action,
          resources: event.resources,
          effect: event.effect,
          message: event.message,
        }
      : null,
    mcpServerToolCalls: (log.match(/"method":"tools\/call"/g) ?? []).length,
    mcpStatus: observation?.mcpStatus ?? null,
    scriptResult: parsed,
  }
}

/** Run one scenario, recording a failed host boot as data instead of aborting. */
async function runMcpGatingScenario(
  name,
  rule,
  { mcp = MATRIX_MCP_CONFIG, callExpression = 'tools.canary.echo' } = {},
) {
  try {
    const observation = await runPermissionMatrixScenario({
      name,
      permissions: mcpGatingPermissions(rule),
      agents: MATRIX_BASE_AGENTS,
      defaultAgent: 'zeus',
      prepare: writeCanaryMcpServer,
      mcp,
      scripts: (sandbox) => mcpGatingScripts(sandbox, { callExpression }),
      promptLabel: `mcp gating ${name}`,
    })
    return {
      observation,
      summary: summarizeMcpGating(observation, rule, callExpression),
    }
  } catch (error) {
    return {
      observation: null,
      summary: {
        rule,
        verdict: 'not-measured',
        error: String(error?.message ?? error),
      },
    }
  }
}

/**
 * Enumerate a local MCP server's tools WITHOUT an OpenCode host.
 *
 * This is the install-time prerequisite: if an installer is to emit a rule per
 * tool (`<server>_<tool>`), it must learn the tool names before the host ever
 * runs. A plain stdio client does that with `initialize` + `tools/list`. The
 * cost and the failure modes are recorded with the result.
 */
function probeMcpToolsList(serverFile) {
  const started = Date.now()
  const requests = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'installer-discovery-probe', version: '0' },
      },
    },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]
  const child = spawnSync(process.execPath, [serverFile], {
    input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
    encoding: 'utf8',
    timeout: 5_000,
  })
  const replies = String(child.stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  const list = replies.find((reply) => reply.id === 2)
  return {
    tools: (list?.result?.tools ?? []).map((tool) => tool.name),
    elapsedMs: Date.now() - started,
    status: child.status,
    timedOut: child.error?.code === 'ETIMEDOUT',
    stderr: String(child.stderr ?? '').slice(0, 400),
  }
}

/** The granularities the gating question needs, in the order they are asked. */
function mcpGatingRules(actionName) {
  return {
    actionAllow: { action: actionName, resource: '*', effect: 'allow' },
    actionDeny: { action: actionName, resource: '*', effect: 'deny' },
    resourceToolDeny: { action: actionName, resource: 'echo', effect: 'deny' },
    resourceEmittedDeny: { action: actionName, resource: actionName, effect: 'deny' },
    resourceGlobDeny: { action: actionName, resource: 'canary_*', effect: 'deny' },
    actionGlobDeny: { action: 'canary_*', resource: '*', effect: 'deny' },
    serverNameActionDeny: { action: 'canary', resource: '*', effect: 'deny' },
    legacyMcpServerDeny: { action: 'mcp', resource: 'canary', effect: 'deny' },
    legacyMcpWildcardDeny: { action: 'mcp', resource: '*', effect: 'deny' },
  }
}

/**
 * `effect: "ask"` on the emitted action: does it prompt at call time, or hide
 * the tool from the catalog? The pending permission request is the observable.
 * The probe replies `reject`, then records what the host asked for. A bounded
 * wait turns "no prompt" into `not-measured` instead of a hung suite.
 */
async function runMcpAskScenario(actionName) {
  const sandbox = makeSandbox()
  const rule = { action: actionName, resource: '*', effect: 'ask' }
  const observation = { sandbox, matrixEvents: [], transcript: '[]', mcpStatus: null }
  writeFileSync(sandbox.targetFile, TARGET_BODY)
  writeCanaryMcpServer(sandbox)
  const model = await startMockModel(mcpGatingScripts(sandbox))
  writePlugins(sandbox, realPluginShim(), { matrixProbe: true })
  writePermissionMatrixConfig(sandbox, model.baseURL, {
    permissions: mcpGatingPermissions(rule),
    agents: MATRIX_BASE_AGENTS,
    defaultAgent: 'zeus',
    mcp: MATRIX_MCP_CONFIG,
  })
  let host
  try {
    host = await startHost(sandbox)
    observation.mcpStatus = await waitFor(
      async () => {
        const status = await host.request('GET', '/api/mcp').catch(() => null)
        const rows = Array.isArray(status?.data) ? status.data : []
        return rows.length > 0 && rows.every((row) => row?.status?.status !== 'pending')
          ? status
          : null
      },
      20_000,
      'the host to finish connecting the canary MCP server',
    ).catch((error) => ({ error: String(error) }))
    // Warm-up turn, identical to the deny scenarios.
    await host.prompt('mcp ask warmup')
    const running = host.prompt('mcp ask probe').catch(() => {})
    const pending = await waitFor(
      async () => {
        const result = await host.request('GET', `/api/session/${host.sessionID}/permission`)
        return (result?.data ?? []).find((item) => String(item.action).startsWith('canary')) ?? null
      },
      TIMEOUT_MS,
      'a pending ask for the MCP tool',
    ).catch((error) => ({ error: String(error) }))
    let reply = null
    if (pending?.id) {
      reply = 'reject'
      await host.request('POST', `/api/session/${host.sessionID}/permission/${pending.id}/reply`, {
        decision: reply,
      })
      await running
    }
    observation.transcript = await host.transcript()
    observation.matrixEvents = existsSync(sandbox.matrixProofFile)
      ? readFileSync(sandbox.matrixProofFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : []
    const summary = summarizeMcpGating(observation, rule)
    return {
      observation,
      summary: {
        ...summary,
        verdict: pending?.id
          ? 'prompted'
          : summary.executed
            ? 'not-gated'
            : summary.verdict === 'blocked'
              ? 'hidden'
              : 'not-measured',
        ask: pending?.id
          ? {
              action: pending.action,
              resources: pending.resources,
              message: pending.message,
              reply,
            }
          : (pending ?? null),
        // After a rejected ask the tool must not have run; this is the gate.
        executedAfterReject: summary.executed,
      },
    }
  } catch (error) {
    return {
      observation: null,
      summary: { rule, verdict: 'not-measured', error: String(error?.message ?? error) },
    }
  } finally {
    host?.stop()
    model.close()
  }
}

async function runMcpGatingProbe() {
  const observations = {}
  // Permissive discovery: allow the installer's current shape AND let the tool
  // run. The permission evaluate event this call produces is the host's own
  // spelling, which the deny scenarios then use.
  const discovery = await runMcpGatingScenario('mcp-gating-discover-action', {
    action: 'mcp',
    resource: '*',
    effect: 'allow',
  })
  if (discovery.observation) observations.discovery = discovery.observation
  const emitted = discovery.summary.evaluation?.action
  const actionDiscovered = typeof emitted === 'string' && emitted.length > 0 && emitted !== 'mcp'
  const actionName = actionDiscovered ? emitted : 'canary_echo'

  const scenarios = { discovery: discovery.summary }
  const rules = mcpGatingRules(actionName)
  for (const [key, rule] of Object.entries(rules)) {
    const result = await runMcpGatingScenario(`mcp-gating-${key}`, rule)
    if (result.observation) observations[key] = result.observation
    scenarios[key] = result.summary
  }

  // A real Pantheon server name contains hyphens (`pantheon-code-mode`). A
  // prefix glob in `action` is the cheapest install-time form, so it must be
  // proven on a hyphenated name, not inferred from the all-lowercase canary.
  const hyphenServer = 'canary-mcp'
  const hyphen = await runMcpGatingScenario(
    'mcp-gating-hyphenatedActionGlobDeny',
    { action: `${hyphenServer}_*`, resource: '*', effect: 'deny' },
    {
      mcp: (sandbox) => ({
        [hyphenServer]: {
          type: 'local',
          command: [process.execPath, sandbox.mcpServerFile, sandbox.mcpLogFile],
          enabled: true,
        },
      }),
      callExpression: `tools[${JSON.stringify(hyphenServer)}].echo`,
    },
  )
  if (hyphen.observation) observations.hyphenDeny = hyphen.observation
  scenarios.hyphenatedActionGlobDeny = hyphen.summary

  // The installer writes `ask`, not `deny`. Whether `ask` prompts at CALL time
  // (a usable gate) or hides the tool (same outcome, earlier) is a different
  // observable, so it gets its own bounded run.
  const ask = await runMcpAskScenario(actionName)
  if (ask.observation) observations.ask = ask.observation
  scenarios.askEffect = ask.summary

  const report = {
    host: {
      bin: BIN,
      version: spawnSync(BIN, ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? '',
    },
    actionName,
    actionDiscovered,
    discoveryToolsList: discovery.observation
      ? probeMcpToolsList(discovery.observation.sandbox.mcpServerFile)
      : null,
    scenarios,
  }
  return { observations, report }
}

// ─── state ───────────────────────────────────────────────────────────────

let live = null
let mutant = null
let permissionLive = null
let permissionAskLive = null
let boundedReadLive = null
let boundedReadDenyLive = null
let identityGapLive = null
let childBoundaryLive = null
let emptyChildLive = null
let permissionMatrix = null
let mcpGating = null
let rootsBefore = null
const permissionProbeEnabled = process.env.PANTHEON_TOOL_CANARY_PERMISSION_PROBE === '1'
const permissionAskProbeEnabled = process.env.PANTHEON_TOOL_CANARY_PERMISSION_ASK === '1'
const boundedReadProbeEnabled = process.env.PANTHEON_TOOL_CANARY_BOUNDED_READ === '1'
const boundedReadDenyProbeEnabled = process.env.PANTHEON_TOOL_CANARY_BOUNDED_READ_DENY === '1'
const permissionMatrixEnabled = process.env.PANTHEON_TOOL_CANARY_PERMISSION_MATRIX === '1'
const mcpGatingEnabled = process.env.PANTHEON_TOOL_CANARY_MCP_GATING === '1'

before(
  async () => {
    rootsBefore = snapshotRealConfigRoots()
    if (skipped) return
    live = await runCanary(realPluginShim())
    if (permissionProbeEnabled) {
      permissionLive = await runCanary(realPluginShim(), {
        permissionProbe: true,
        subagentAdmissionProbe: process.env.PANTHEON_TOOL_CANARY_SUBAGENT_ADMISSION === '1',
      })
      if (process.env.PANTHEON_TOOL_CANARY_SUBAGENT_ADMISSION === '1') {
        identityGapLive = await runCanary(realPluginShim(), {
          permissionProbe: true,
          subagentAdmissionProbe: true,
          subagentCaller: 'zeus',
          subagentTarget: 'apollo',
        })
        childBoundaryLive = await runCanary(realPluginShim(), {
          permissionProbe: true,
          subagentAdmissionProbe: true,
          subagentCaller: 'zeus',
          subagentTarget: 'athena',
        })
      }
    }
    if (subagentAdmissionProbeEnabled) {
      emptyChildLive = await runCanary(realPluginShim(), {
        permissionProbe: true,
        subagentAdmissionProbe: true,
        emptySubagentResultProbe: true,
        subagentCaller: 'zeus',
        subagentTarget: 'demeter',
      })
    }
    if (permissionAskProbeEnabled) {
      permissionAskLive = await runCanary(realPluginShim(), {
        permissionProbe: true,
        permissionAskProbe: true,
      })
    }
    if (boundedReadProbeEnabled) {
      boundedReadLive = await runCanary(realPluginShim(), { boundedReadProbe: true })
    }
    if (boundedReadDenyProbeEnabled) {
      boundedReadDenyLive = await runCanary(realPluginShim(), { boundedReadDenyProbe: true })
    }
    if (permissionMatrixEnabled) {
      permissionMatrix = await runPermissionMatrix()
    }
    if (mcpGatingEnabled) {
      mcpGating = await runMcpGatingProbe()
    }
  },
  { timeout: permissionMatrixEnabled || mcpGatingEnabled ? 420_000 : 60_000 },
)

after(() => {
  for (const observation of [
    live,
    mutant,
    permissionLive,
    permissionAskLive,
    boundedReadLive,
    boundedReadDenyLive,
    identityGapLive,
    childBoundaryLive,
    emptyChildLive,
    permissionMatrix?.scenarios?.actionNames,
    permissionMatrix?.scenarios?.readOnly,
    permissionMatrix?.scenarios?.orderNestedFirst,
    permissionMatrix?.scenarios?.orderWildcardFirst,
    permissionMatrix?.scenarios?.orderEditNestedFirst,
    permissionMatrix?.scenarios?.orderEditWildcardFirst,
    permissionMatrix?.scenarios?.['orderReal:deny-broad-then-allow'],
    permissionMatrix?.scenarios?.['orderReal:allow-nested-then-deny-broad'],
    permissionMatrix?.scenarios?.['orderReal:allow-broad-then-deny-nested'],
    permissionMatrix?.scenarios?.actionCoverage,
    permissionMatrix?.scenarios?.mcpAllowShape,
    permissionMatrix?.scenarios?.mcpRuleShape,
    permissionMatrix?.scenarios?.questionAction,
    permissionMatrix?.scenarios?.['taskGlob:apollo'],
    permissionMatrix?.scenarios?.['taskGlob:demeter'],
    ...Object.values(mcpGating?.observations ?? {}),
  ]) {
    if (observation?.sandbox) rmSync(observation.sandbox.root, { recursive: true, force: true })
  }
})

// ─── tests ───────────────────────────────────────────────────────────────

test('the host environment is redirected into the sandbox', () => {
  const sandbox = makeSandbox()
  try {
    const env = hostEnv(sandbox)
    for (const key of HOST_ENV_REDIRECTED) {
      assert.ok(
        String(env[key] ?? '').startsWith(sandbox.root),
        `${key} would point outside the sandbox: ${String(env[key])}`,
      )
    }
    for (const key of HOST_ENV_STRIPPED) {
      assert.equal(env[key], undefined, `${key} must not reach the host`)
    }
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true })
  }
})

test('the mutation really removes output from draft.add', () => {
  assert.doesNotMatch(mutantPluginShim(), /output: def\.output/)
  assert.match(readFileSync(REAL_PLUGIN_SRC, 'utf8'), /output: def\.output/)
})

test('the host drove every scripted turn', { skip: skipped }, () => {
  // One `execute` tool call plus one closing message per outer chat turn.
  assert.equal(live.turns, 8, `the mock model served ${live.turns} turns, expected 8`)
  assert.equal(
    executeTexts(live.transcript).length,
    4,
    'the transcript is not the 4 scripted calls',
  )
})

test('the host context exposes the V2 model and session APIs Pantheon needs', {
  skip: skipped,
}, () => {
  assert.ok(live.observation, `no probe dump was written: ${live.diagnose()}`)
  const { domains } = live.observation
  for (const key of ['tool', 'event', 'permission', 'session', 'model']) {
    assert.ok(
      domains.contextKeys.includes(key),
      `ctx.${key} is absent on this host: ctx keys = ${domains.contextKeys.join(', ')}`,
    )
  }
  // The cast in src/plugin-v2.ts is only safe because these are callable here.
  assert.equal(domains.tool.transform, 'function')
  assert.equal(domains.tool.hook, 'function')
  assert.equal(domains.tool.list, 'function')
  assert.equal(domains.event.subscribe, 'function')
  assert.equal(domains.permission.hook, 'function')
  assert.equal(domains.permission.assert, 'function')
  assert.equal(domains.session.hook, 'function')
  assert.equal(domains.model.list, 'function', 'native model catalog API is required for V2 Vision')
  assert.equal(domains.session.create, 'function')
  assert.equal(domains.session.generate, 'function')
  assert.equal(domains.session.remove, 'function')
  assert.equal(domains.generate.text, 'function')
  // And the one the plugin has always claimed is host-absent really is absent.
  assert.equal(domains.catalog, 'absent')
  assert.ok(Array.isArray(live.observation.models), 'the model catalog was not readable')
  assert.ok(
    live.observation.models.some(
      (model) => model.providerID === 'canary' && model.id === 'canary-model',
    ),
    `ctx.model.list() omitted the configured canary model: ${JSON.stringify(live.observation.models)}`,
  )
  const canaryModel = live.observation.models.find(
    (model) => model.providerID === 'canary' && model.id === 'canary-model',
  )
  assert.ok(
    Array.isArray(canaryModel.input)
      ? canaryModel.input.includes('image')
      : canaryModel.input?.image === true,
    `the live catalog lost the configured image modality: ${JSON.stringify(canaryModel)}`,
  )
  const freeVisionModel = live.observation.models.find(
    (model) => model.providerID === 'opencode' && model.id === 'mimo-v2.6-flash-free',
  )
  assert.ok(freeVisionModel, 'the live catalog omitted opencode/mimo-v2.6-flash-free')
  // The native path EXCLUDES free-tier models (the direct gateway rejects them
  // with HTTP 403), so the paid Go model is the one that must be selectable.
  const paidVisionModel = live.observation.models.find(
    (model) => model.providerID === 'opencode-go' && model.id === 'mimo-v2.6-flash',
  )
  assert.ok(paidVisionModel, 'the live catalog omitted opencode-go/mimo-v2.6-flash')
  assert.ok(
    Array.isArray(paidVisionModel.input)
      ? paidVisionModel.input.includes('image')
      : paidVisionModel.input?.image === true,
    `the live catalog did not mark Go MiMo as image-capable: ${JSON.stringify(paidVisionModel)}`,
  )
})

test('ctx.permission.assert evaluates a real tool-origin request against host policies', {
  skip: skipped || !permissionProbeEnabled,
}, () => {
  assert.ok(
    permissionLive?.observation,
    `no permission probe dump was written: ${permissionLive?.diagnose?.() ?? 'probe did not run'}`,
  )
  const result = permissionLive.observation.permissionResults?.at(-1)
  assert.ok(result, 'permission_probe did not call ctx.permission.assert')
  const expectedDecision = process.env.PANTHEON_TOOL_CANARY_PERMISSION_EXPECTED ?? 'reject'
  assert.equal(
    result.decision,
    expectedDecision,
    `host permission decision differed from ${expectedDecision}: ${JSON.stringify(result)}`,
  )
  if (expectedDecision === 'reject') {
    assert.match(result.error, POLICY_DENIAL_MESSAGE)
    assert.equal(result.errorKind, 'policy', JSON.stringify(result))
  } else {
    assert.equal(result.error, undefined, 'an allowed request returned a rejection reason')
  }
  assert.equal(result.request.action, 'shell')
  assert.deepEqual(result.request.resources, ['echo pantheon-permission-canary'])
  assert.ok(result.request.sessionID, 'assert request omitted the live session ID')
  assert.equal(typeof result.request.agent, 'string')
  assert.equal(result.request.source.type, 'tool')
  assert.equal(typeof result.request.source.messageID, 'string')
  assert.equal(typeof result.request.source.id, 'string')
})

test('P0-5 permission probe: only a policy denial is a reject verdict', () => {
  // Mirrors the regex the generated probes use. A contract change (TypeError)
  // must never be classified as host policy; that is the false-green the fault
  // injection (`PANTHEON_TOOL_CANARY_*_PROBE_FAULT=contract`) reproduces.
  const classify = (message) =>
    POLICY_DENIAL_MESSAGE.test(String(message)) ? 'reject' : 'probe-error'
  assert.equal(classify('Permission denied: write'), 'reject')
  assert.equal(classify('Blocked by configuration policy'), 'reject')
  assert.equal(
    classify('simulated host contract change: permission.assert rejected the request shape'),
    'probe-error',
  )
  assert.equal(classify('TypeError: Cannot read properties of undefined'), 'probe-error')
})

test('P0-5 action names: host evaluations match the repo translator', {
  skip: skipped || !permissionMatrixEnabled,
}, () => {
  const scenario = permissionMatrix?.scenarios?.actionNames
  assert.ok(scenario, 'the action-name matrix scenario did not run')
  assert.equal(
    permissionMatrix.report.isolation?.managedDenyFixture,
    false,
    'the matrix run inherited the managed deny fixture, so its action-name evidence is confounded',
  )

  // The matrix run is isolated from the managed `deny/etc` fixture (the
  // wrapper applies it only to the precedence run). Both permissions must
  // actually execute here; a blocked shell is the symptom of the old
  // contamination, not a host default.
  assert.equal(scenario.sideEffects.write, true, 'the probe write call did not run')
  assert.equal(
    scenario.sideEffects.shell,
    true,
    `the matrix run inherited a deny policy and blocked shell (events=${JSON.stringify(scenario.matrixEvents)}, calls=${JSON.stringify(permissionMatrix.report.actionNames.calls.shell)})`,
  )

  const checks = [
    { key: 'bash', needle: 'CANARY-SHELL-RAN' },
    { key: 'write', needle: 'write-ran.txt' },
    { key: 'read', needle: 'target.txt' },
  ]

  for (const check of checks) {
    const event = scenario.matrixEvents.find((candidate) =>
      (candidate.resources ?? []).some(
        (resource) => typeof resource === 'string' && resource.includes(check.needle),
      ),
    )
    check.event = event
  }

  // Every check is load-bearing: A2 is the only live proof of the `write→edit`
  // mapping, so a missing evaluation must fail instead of collapsing into
  // `checks.some(...)`. The hosts in this matrix all emit these events; if one
  // structurally did not, the reason has to be stated explicitly rather than
  // silently skipped.
  for (const check of checks) {
    assert.ok(
      check.event,
      `the host emitted no permission evaluation for "${check.key}" (${check.needle}); events=${JSON.stringify(scenario.matrixEvents)}`,
    )
    const expected = translatorActionFor(check.key)
    assert.equal(
      check.event.action,
      expected,
      `translator emits "${expected}" for permission.${check.key} but the host evaluated "${check.event.action}" (events=${JSON.stringify(scenario.matrixEvents)})`,
    )
  }

  // The artifact must carry the observed vocabulary, not just the assertions.
  assert.ok(
    Array.isArray(permissionMatrix.report.actionNames.evaluations),
    'the matrix report omitted the host action-name evidence',
  )
})

/**
 * One P0-5 acceptance check per action name the repo can emit but the matrix
 * had never observed.
 *
 * `needle` pins the evaluation to the scripted call's own resource when the
 * host exposes one; `action` is the fallback correlation. Absence of an
 * evaluation is a FAILURE, never a silent pass: the criterion is that the host
 * recognises the name the translator emits, and this file is the only place
 * that can observe it.
 */
const MATRIX_ACTION_COVERAGE_CASES = [
  { action: 'grep', needle: 'CANARY-ALPHA' },
  { action: 'glob', needle: '*.txt' },
  { action: 'webfetch', needle: 'canary.txt' },
  { action: 'skill', needle: 'canary-skill' },
  {
    action: 'hashline_edit',
    // Plugin tools are not host built-ins and are not in the model's flat tool
    // list; the only path is `execute` (Code Mode). The script that calls it is
    // the correlation key, so a missing event is about the permission layer,
    // not about a call that never happened.
    codeNeedle: 'tools.hashline_edit',
    structural:
      'plugin tools run inside `execute` (Code Mode); the host emitted no permission.evaluate event for the wrapped call',
  },
  {
    action: 'vision_describe',
    codeNeedle: 'tools.vision_describe',
    structural:
      'plugin tools run inside `execute` (Code Mode); the host emitted no permission.evaluate event for the wrapped call',
  },
  // `mcp` is deliberately NOT in this list: the host enforces it at the tool
  // CATALOG layer (a deny removes the server's tools) and evaluates the call
  // itself as `<server>_<tool>`. There is no evaluate event with action `mcp`
  // to compare, so the dedicated differential test below covers it instead of
  // inventing an equivalence.
]

/** The transcript part whose Code Mode script contains `needle`. */
function matrixCodePart(scenario, needle) {
  return allToolParts(scenario.transcript ?? '[]').find(
    (part) => typeof part.state?.input?.code === 'string' && part.state.input.code.includes(needle),
  )
}

/** The host permission evaluation raised by one tool-call part, if any. */
function matrixEventForPart(scenario, part) {
  return part
    ? (scenario.matrixEvents ?? []).find((event) => event.source?.id === part.id)
    : undefined
}

for (const { action, needle, codeNeedle, structural } of MATRIX_ACTION_COVERAGE_CASES) {
  test(`P0-5 action name coverage: the host evaluates "${action}" and the translator emits it`, {
    skip: skipped || !permissionMatrixEnabled,
  }, (t) => {
    const scenario = permissionMatrix?.scenarios?.actionCoverage
    assert.ok(scenario, 'the action-coverage matrix scenario did not run')

    const events = scenario.matrixEvents ?? []
    const part = codeNeedle ? matrixCodePart(scenario, codeNeedle) : undefined
    if (codeNeedle) {
      assert.ok(part, `the ${action} scripted call never reached the transcript`)
      assert.equal(
        part.state?.status,
        'completed',
        `the ${action} scripted call did not complete: ${JSON.stringify(part.state)}`,
      )
    }

    const event = codeNeedle
      ? matrixEventForPart(scenario, part)
      : ((needle
          ? events.find((candidate) =>
              (candidate.resources ?? []).some(
                (resource) => typeof resource === 'string' && resource.includes(needle),
              ),
            )
          : undefined) ?? events.find((candidate) => candidate.action === action))

    if (!event && structural) {
      // Never a pass: the tool ran, the host simply has no permission surface
      // for it. The risk is stated in the report so it cannot be read as
      // "the host accepts this name".
      t.skip(`NOT_APPLICABLE: ${structural}; part=${JSON.stringify(part?.state?.status)}`)
      return
    }

    assert.ok(
      event,
      `the host emitted no permission evaluation for "${action}" (${JSON.stringify(permissionMatrix.report.actionCoverage.toolCalls)}); events=${JSON.stringify(events)}`,
    )
    assert.equal(
      event.action,
      translatorActionFor(action),
      `translator emits "${translatorActionFor(action)}" for permission.${action} but the host evaluated "${event.action}" (events=${JSON.stringify(events)})`,
    )
  })
}

test('P0-5 action name coverage: the host evaluates "question" and the translator emits it', {
  skip: skipped || !permissionMatrixEnabled,
}, (t) => {
  const scenario = permissionMatrix?.scenarios?.questionAction
  assert.ok(scenario, 'the question-action matrix scenario did not run')

  const event = (scenario.matrixEvents ?? []).find((candidate) => candidate.action === 'question')
  if (!event) {
    // A timeout is not evidence that the host accepts a different name; it is
    // evidence that this probe could not reach the permission layer before the
    // tool blocked. Report NOT_APPLICABLE (a skip) with the concrete reason —
    // never a pass, and never an invented equivalence.
    t.skip(
      `NOT_APPLICABLE: the host emitted no question permission evaluation before the tool blocked (${scenario.waitError ?? 'no event'}); events=${JSON.stringify(scenario.matrixEvents)}`,
    )
    return
  }
  assert.equal(event.action, translatorActionFor('question'))
})

test('P0-5 mcp: no permission.evaluate event carries the action name the translator emits', {
  skip: skipped || !permissionMatrixEnabled,
}, (t) => {
  const scenario = permissionMatrix?.scenarios?.actionCoverage
  assert.ok(scenario, 'the action-coverage matrix scenario did not run')
  const part = matrixCodePart(scenario, 'tools.canary.echo')
  assert.ok(part, 'the MCP scripted call never reached the transcript')
  assert.equal(part.state?.status, 'completed', JSON.stringify(part.state))

  // The installer's legacy shape, not a translator output: the translator no
  // longer emits an `mcp` action at all (it emits `<server>_*`).
  const emitted = 'mcp'
  const event = matrixEventForPart(scenario, part)
  assert.ok(
    event,
    'the MCP call produced no permission evaluation at all; the differential test below cannot run',
  )
  assert.notEqual(
    event.action,
    emitted,
    `the host evaluated the MCP call as "${event.action}", so a permission.evaluate event for "${emitted}" should be asserted by this file instead of skipped`,
  )
  t.skip(
    `NOT_APPLICABLE: the host resolves permission.mcp.<server> at the tool-catalog layer and evaluates the call as "${event.action}"; no evaluate event with action "${emitted}" exists to compare. Behaviour is proven by the differential allow/deny test below.`,
  )
})

test('P0-5 mcp gating: <server>_* deny blocks, action "mcp" is inert, ask hides the tool', {
  skip: skipped || !mcpGatingEnabled,
}, () => {
  assert.ok(mcpGating, 'the MCP gating probe did not run')
  const { report } = mcpGating
  assert.equal(report.actionDiscovered, true, JSON.stringify(report.scenarios.discovery))

  // Positive control: the same server works when no rule denies it.
  assert.equal(report.scenarios.actionAllow.verdict, 'executed')

  // (a) The action rule is the gate. Both the exact `<server>_<tool>` and the
  // `<server>_*` glob block every tool of the server, and they do it by
  // removing it from the catalog: no execution, no `permission.evaluate`
  // event, zero `tools/call` on the MCP server.
  for (const key of ['actionDeny', 'actionGlobDeny', 'hyphenatedActionGlobDeny']) {
    const scenario = report.scenarios[key]
    assert.equal(scenario.verdict, 'blocked', `${key} did not block: ${JSON.stringify(scenario)}`)
    assert.equal(scenario.toolPresentInCatalog, false, `${key} left the tool in the catalog`)
    assert.equal(scenario.mcpServerToolCalls, 0, `${key} still called the MCP server`)
    assert.equal(scenario.evaluation, null, `${key} emitted a permission evaluation`)
    assert.match(String(scenario.literalMessage), /Unknown tool/i)
  }

  // (b) `action:"mcp"` (the installer's old shape) is inert, with either
  // resource. This is the measured fact that invalidated the old assertion.
  for (const key of ['legacyMcpServerDeny', 'legacyMcpWildcardDeny']) {
    const scenario = report.scenarios[key]
    assert.equal(
      scenario.verdict,
      'executed',
      `${key} unexpectedly gated the tool: ${JSON.stringify(scenario)}`,
    )
    assert.equal(scenario.mcpServerToolCalls, 1)
  }

  // (c) `ask` is not a prompt: the host removes the tool from the catalog.
  const ask = report.scenarios.askEffect
  assert.equal(ask.rule.effect, 'ask')
  assert.equal(ask.verdict, 'hidden', `ask did not hide the tool: ${JSON.stringify(ask)}`)
  assert.equal(ask.toolPresentInCatalog, false)
  assert.equal(ask.executed, false)
  assert.equal(ask.ask?.id, undefined, `ask produced a real prompt: ${JSON.stringify(ask.ask)}`)
  assert.equal(ask.mcpServerToolCalls, 0)
})

test('P0-5 mcp gating: the emitted action name is discovered and the allow control executes', {
  skip: skipped || !mcpGatingEnabled,
}, () => {
  assert.ok(mcpGating, 'the MCP gating probe did not run')
  const { report } = mcpGating
  const discovery = report.scenarios.discovery
  const allow = report.scenarios.actionAllow

  assert.equal(
    discovery.verdict,
    'executed',
    `the permissive discovery run did not execute the MCP tool, so no action name could be discovered: ${JSON.stringify(discovery)}`,
  )
  assert.equal(discovery.rule.action, 'mcp')
  assert.ok(
    report.actionName,
    `the host exposed no permission evaluation for the MCP call: ${JSON.stringify(discovery)}`,
  )
  assert.equal(
    report.actionDiscovered,
    true,
    `the host evaluation did not carry a <server>_<tool> action: ${JSON.stringify(discovery.evaluation)}`,
  )
  assert.equal(
    allow.verdict,
    'executed',
    `the allow control for action "${report.actionName}" did not execute, so the deny rows would be vacuous: ${JSON.stringify(allow)}`,
  )
  assert.equal(
    allow.evaluation?.action,
    report.actionName,
    'the allow control was evaluated under a different action than the deny rules use',
  )

  const table = Object.fromEntries(
    Object.entries(report.scenarios).map(([key, value]) => [
      key,
      {
        rule: value.rule,
        verdict: value.verdict,
        catalog: value.toolPresentInCatalog,
        message: value.literalMessage,
      },
    ]),
  )
  console.log(`P0-5 mcp gating matrix (${report.host.version}): ${JSON.stringify(table)}`)

  const reportPath = process.env.PANTHEON_TOOL_CANARY_MCP_GATING_REPORT
  if (reportPath) {
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log(`mcp gating report: ${reportPath}`)
  }
})

test('P0-5 mcp gating: install-time tools/list discovery needs no host', {
  skip: skipped || !mcpGatingEnabled,
}, () => {
  const sandbox = makeSandbox()
  try {
    writeCanaryMcpServer(sandbox)
    const probe = probeMcpToolsList(sandbox.mcpServerFile)
    assert.equal(probe.status, 0, `the discovery client failed: ${JSON.stringify(probe)}`)
    assert.ok(
      probe.tools.includes('echo'),
      `tools/list did not enumerate the canary tool without a host: ${JSON.stringify(probe)}`,
    )
    console.log(
      `MCP install-time discovery: tools=${JSON.stringify(probe.tools)} elapsedMs=${probe.elapsedMs}`,
    )
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true })
  }
})

test('P0-5 read-only profile: host does not execute shell or write and still allows read', {
  skip: skipped || !permissionMatrixEnabled,
}, () => {
  const scenario = permissionMatrix?.scenarios?.readOnly
  assert.ok(scenario, 'the read-only enforcement scenario did not run')

  assert.equal(
    scenario.sideEffects.shell,
    false,
    `a read-only profile still executed shell (events=${JSON.stringify(scenario.matrixEvents)}, calls=${JSON.stringify(permissionMatrix.report.readOnly.calls.shell)})`,
  )
  assert.equal(
    scenario.sideEffects.write,
    false,
    `a read-only profile still wrote a file (events=${JSON.stringify(scenario.matrixEvents)}, calls=${JSON.stringify(permissionMatrix.report.readOnly.calls.write)})`,
  )
  const shellCall = scenario.nativeCalls.shell.at(-1)
  const writeCall = scenario.nativeCalls.write.at(-1)
  // The scenario scripts both calls, so absence is a broken probe, not a pass:
  // `if (writeCall)` used to let a read-only profile that never attempted the
  // write look green.
  assert.ok(
    shellCall,
    `the read-only scenario never attempted shell: ${JSON.stringify(scenario.transcript)}`,
  )
  assert.ok(
    writeCall,
    `the read-only scenario never attempted write: ${JSON.stringify(scenario.transcript)}`,
  )
  assert.notEqual(
    shellCall.state?.status,
    'completed',
    `the read-only profile completed a shell call: ${JSON.stringify(shellCall.state)}`,
  )
  assert.notEqual(
    writeCall.state?.status,
    'completed',
    `the read-only profile completed a write call: ${JSON.stringify(writeCall.state)}`,
  )

  // Positive control: the same profile explicitly allows read.
  const readText = scenario.nativeCalls.read.map(toolResultText).join('\n')
  assert.match(
    readText,
    /CANARY-ALPHA-LINE/,
    `read was not allowed under the read-only profile: ${JSON.stringify(readText)}`,
  )

  // If the host evaluated rather than hid the denied tools, the emitted action
  // must still match the translator's name for the repo key.
  for (const [key, needle] of [
    ['bash', 'CANARY-SHELL-RAN'],
    ['write', 'write-ran.txt'],
  ]) {
    const event = scenario.matrixEvents.find((candidate) =>
      (candidate.resources ?? []).some(
        (resource) => typeof resource === 'string' && resource.includes(needle),
      ),
    )
    if (!event) continue
    assert.equal(
      event.action,
      translatorActionFor(key),
      `translator emits "${translatorActionFor(key)}" for permission.${key} but the host evaluated "${event.action}"`,
    )
  }
})

test('P0-5 resolution order: both nested/wildcard orders are recorded and the wildcard deny still applies outside the allow glob', {
  skip: skipped || !permissionMatrixEnabled,
}, (t) => {
  const nested = parseScriptResult(
    permissionMatrix?.scenarios?.orderNestedFirst?.responses?.at(-1) ?? '',
  )
  const wildcard = parseScriptResult(
    permissionMatrix?.scenarios?.orderWildcardFirst?.responses?.at(-1) ?? '',
  )
  const nestedProbe = matrixDecision(nested?.probe)
  const wildcardProbe = matrixDecision(wildcard?.probe)
  const nestedControl = matrixDecision(nested?.control)
  const wildcardControl = matrixDecision(wildcard?.control)

  // The host is missing `ctx.permission.assert` (2.0.22): every cell above is a
  // caught TypeError, not a policy decision. Report NOT_APPLICABLE — a skip, so
  // it can never be rendered as a pass — instead of classifying a missing API as
  // `deny-precedence`.
  const decisions = [nestedProbe, wildcardProbe, nestedControl, wildcardControl].map(
    (decision) => decision?.decision,
  )
  if (decisions.includes('not-applicable')) {
    assert.ok(
      decisions.every((decision) => decision === 'not-applicable'),
      `host exposes the assert API for only part of the ordering probe: ${JSON.stringify(decisions)}`,
    )
    assert.equal(
      permissionMatrix.report.order.resolution,
      'not-applicable',
      `ordering was not observable but the report classified it: ${JSON.stringify(permissionMatrix.report.order)}`,
    )
    t.skip(
      'NOT_APPLICABLE: this host does not expose ctx.permission.assert, so the resolution order is unobservable (not a pass)',
    )
    return
  }

  assert.ok(
    nestedProbe?.decision,
    `nested-first probe produced no decision: ${JSON.stringify(nested)}`,
  )
  assert.ok(
    wildcardProbe?.decision,
    `wildcard-first probe produced no decision: ${JSON.stringify(wildcard)}`,
  )
  assert.notEqual(
    nestedProbe?.decision,
    'probe-error',
    `nested-first probe failed with a non-policy error instead of a decision: ${JSON.stringify(nestedProbe)}`,
  )
  assert.notEqual(
    wildcardProbe?.decision,
    'probe-error',
    `wildcard-first probe failed with a non-policy error instead of a decision: ${JSON.stringify(wildcardProbe)}`,
  )

  // Repo policy (not a host-semantics guess): `*: deny` must deny a path
  // outside the nested allow glob in BOTH orders. A `reject` alone is not
  // enough: a TypeError from a changed `assert` contract used to be reported
  // as `reject`, so the denial message is part of the assertion.
  for (const [label, control] of [
    ['nested-first', nestedControl],
    ['wildcard-first', wildcardControl],
  ]) {
    assert.equal(
      control?.decision,
      'reject',
      `wildcard deny did not apply outside the nested allow glob (${label}): ${JSON.stringify(control)}`,
    )
    assert.match(
      String(control?.error ?? ''),
      POLICY_DENIAL_MESSAGE,
      `the ${label} control rejected on a non-policy error: ${JSON.stringify(control)}`,
    )
    assert.equal(
      control?.errorKind,
      'policy',
      `the ${label} control was not classified as a policy denial: ${JSON.stringify(control)}`,
    )
  }

  const resolution = permissionMatrix.report.order.resolution
  assert.ok(
    ['most-specific-wins', 'first-match-wins', 'deny-precedence', 'last-match-wins'].includes(
      resolution,
    ),
    `the two orders produced an unclassifiable result: ${JSON.stringify(permissionMatrix.report.order)}`,
  )
  // Deliberately no assertion on WHICH rule won: the host semantics are the
  // unknown being measured. The artifact records the answer.
  console.log(
    `P0-5 resolution order observed: ${resolution} (nested-first=${nestedProbe.decision}, wildcard-first=${wildcardProbe.decision})`,
  )
})

test('P0-5 D-2: resolution order in the evaluated edit namespace matches write', {
  skip: skipped || !permissionMatrixEnabled,
}, (t) => {
  const order = permissionMatrix?.report?.order
  const orderEdit = permissionMatrix?.report?.orderEdit
  assert.ok(order, 'the write-namespace order report did not run')
  assert.ok(orderEdit, 'the edit-namespace order report did not run')

  const writeResolution = order.resolution
  const editResolution = orderEdit.resolution

  if (writeResolution === 'not-applicable' || editResolution === 'not-applicable') {
    t.skip(
      `NOT_APPLICABLE: ctx.permission.assert is unavailable (write=${writeResolution}, edit=${editResolution})`,
    )
    return
  }
  assert.notEqual(writeResolution, 'probe-error', JSON.stringify(order))
  assert.notEqual(editResolution, 'probe-error', JSON.stringify(orderEdit))

  // C1/C2 in the namespace that actually decides a write: both controls are
  // outside the nested allow glob and must be denied by host policy. A
  // non-policy exception is not a denial (the D-1 hardening).
  for (const [label, control] of [
    ['edit nested-first', orderEdit.nestedFirst.control],
    ['edit wildcard-first', orderEdit.wildcardFirst.control],
  ]) {
    assert.equal(control?.decision, 'reject', `${label} control: ${JSON.stringify(control)}`)
    assert.equal(control?.errorKind, 'policy', `${label} control: ${JSON.stringify(control)}`)
    assert.match(String(control?.error ?? ''), POLICY_DENIAL_MESSAGE)
  }

  // D-2: the `write` namespace was an inference. The class must be the same in
  // `edit`, the action the host evaluates for a real write, or the sort policy
  // rests on the wrong namespace. Equality is the closure condition.
  assert.equal(
    editResolution,
    writeResolution,
    `resolution class differs between write (${writeResolution}) and edit (${editResolution}): write=${JSON.stringify(order)} edit=${JSON.stringify(orderEdit)}`,
  )
  assert.ok(
    ['most-specific-wins', 'first-match-wins', 'deny-precedence', 'last-match-wins'].includes(
      editResolution,
    ),
    `edit namespace produced an unclassifiable result: ${JSON.stringify(orderEdit)}`,
  )

  // Record C3–C5 for both namespaces so the artifact answers the question even
  // when the class is one the assertions do not pin.
  console.log(
    `P0-5 D-2 order: write=${writeResolution} (C3=${order.nestedFirst.probe?.decision}, C4=${order.wildcardFirst.probe?.decision}) edit=${editResolution} (C3=${orderEdit.nestedFirst.probe?.decision}, C4=${orderEdit.wildcardFirst.probe?.decision})`,
  )
})

/** Find the real write call whose target path ends with `suffix`. */
function realWriteCall(scenario, suffix) {
  return (scenario?.writeCalls ?? []).find((call) =>
    String(call?.input?.path ?? '').endsWith(suffix),
  )
}

test('P0-5 D-2: real write calls obey edit rules and last-match-wins', {
  skip: skipped || !permissionMatrixEnabled,
}, (t) => {
  const real = permissionMatrix?.report?.orderReal
  assert.ok(real, 'the real write order report did not run')

  const allCalls = Object.values(real).flatMap((scenario) => scenario.writeCalls ?? [])
  assert.ok(
    allCalls.length > 0,
    `the real write scenarios produced no calls: ${JSON.stringify(real)}`,
  )

  // If the host hides `write` because of the rules, the real-call proof is not
  // available. Say so with the host's own message; never claim the closure.
  if (allCalls.every((call) => /No tool named/i.test(String(call.error ?? '')))) {
    t.skip(
      `NOT_APPLICABLE: the host hid the write tool under the edit rules (${allCalls[0]?.error}); D-2 remains assert-only`,
    )
    return
  }

  const expected = {
    // broad deny first, specific allow last → the allowed path is written.
    'deny-broad-then-allow': { memory: true, outside: false },
    // specific allow first, broad deny last → the later deny wins for both.
    'allow-nested-then-deny-broad': { memory: false, outside: false },
    // broad allow first, specific deny last → only the outside path is written.
    'allow-broad-then-deny-nested': { memory: false, outside: true },
  }

  for (const [key, sideEffects] of Object.entries(expected)) {
    const scenario = real[key]
    assert.ok(scenario, `the real write scenario "${key}" did not run`)
    assert.equal(
      scenario.memoryWritten,
      sideEffects.memory,
      `${key}: memory-bank write mismatch (calls=${JSON.stringify(scenario.writeCalls)})`,
    )
    assert.equal(
      scenario.outsideWritten,
      sideEffects.outside,
      `${key}: outside write mismatch (calls=${JSON.stringify(scenario.writeCalls)})`,
    )

    const memoryCall = realWriteCall(scenario, MATRIX_ORDER_REAL_MEMORY)
    const outsideCall = realWriteCall(scenario, MATRIX_ORDER_REAL_OUTSIDE)
    assert.ok(memoryCall, `${key}: no write call for the memory-bank path`)
    assert.ok(outsideCall, `${key}: no write call for the outside path`)

    // The real denial is a host policy denial in the `edit` namespace, not a
    // contract error and not a missing tool.
    for (const [label, call, written] of [
      ['memory-bank', memoryCall, sideEffects.memory],
      ['outside', outsideCall, sideEffects.outside],
    ]) {
      if (written) {
        assert.equal(
          call.state?.status ?? call.status,
          'completed',
          `${key}: ${label} was written but the call did not complete: ${JSON.stringify(call)}`,
        )
        assert.equal(call.error, undefined, `${key}: ${label} completed with an error`)
      } else {
        assert.equal(
          call.state?.status ?? call.status,
          'error',
          `${key}: ${label} was not written but the call did not fail: ${JSON.stringify(call)}`,
        )
        assert.match(
          String(call.error ?? ''),
          /Permission denied: edit/i,
          `${key}: ${label} failed on something other than edit policy: ${JSON.stringify(call)}`,
        )
      }
    }
  }

  // Every allowed write was evaluated under the action the host really uses.
  const evaluatedActions = Object.values(real)
    .flatMap((scenario) => scenario.editEvaluations ?? [])
    .map((event) => event.action)
  assert.ok(evaluatedActions.length > 0, 'no edit evaluation was recorded for the allowed writes')
  assert.ok(
    evaluatedActions.every((action) => action === 'edit'),
    `real write evaluations used ${JSON.stringify([...new Set(evaluatedActions)])}, not edit`,
  )

  console.log(
    `P0-5 D-2 real writes: ${JSON.stringify(
      Object.fromEntries(
        Object.entries(real).map(([key, scenario]) => [
          key,
          { memory: scenario.memoryWritten, outside: scenario.outsideWritten },
        ]),
      ),
    )}`,
  )
})

test('P0-5 permission.task glob: the named target passes and a second target is denied', {
  skip: skipped || !permissionMatrixEnabled,
}, () => {
  const apollo = permissionMatrix?.scenarios?.['taskGlob:apollo']
  const demeter = permissionMatrix?.scenarios?.['taskGlob:demeter']
  assert.ok(apollo, 'the allowed task-glob target scenario did not run')
  assert.ok(demeter, 'the denied task-glob target scenario did not run')

  const apolloCall = apollo.nativeCalls.subagent.at(-1)
  const demeterCall = demeter.nativeCalls.subagent.at(-1)
  assert.ok(apolloCall, `the host transcript omitted the apollo dispatch: ${apollo.transcript}`)
  assert.ok(demeterCall, `the host transcript omitted the demeter dispatch: ${demeter.transcript}`)

  assert.notEqual(
    apolloCall.state?.status,
    'error',
    `permission.task allowed target apollo was blocked: ${JSON.stringify(apolloCall.state)}`,
  )
  assert.ok(
    apollo.childSessions.length >= 1,
    `permission.task allowed target apollo created no child session: ${JSON.stringify(apollo.sessions)}`,
  )

  assert.equal(
    demeterCall.state?.status,
    'error',
    `permission.task denied target demeter was not blocked: ${JSON.stringify(demeterCall.state)}`,
  )
  assert.match(
    String(demeterCall.state?.error?.message ?? ''),
    /permission|denied|blocked/i,
    `the demeter denial did not come from a permission policy: ${JSON.stringify(demeterCall.state)}`,
  )
  assert.equal(
    demeter.childSessions.length,
    0,
    `a denied task-glob target still created a child session: ${JSON.stringify(demeter.sessions)}`,
  )

  // The host's action for a real dispatch is compared with the translator's
  // action for the `task` key. This is the P0-5 row-3 check on this path.
  const apolloEvaluation = apollo.matrixEvents.find((event) =>
    (event.resources ?? []).includes('apollo'),
  )
  if (apolloEvaluation) {
    assert.equal(
      apolloEvaluation.action,
      translatorActionFor('task'),
      `translator emits "${translatorActionFor('task')}" for permission.task but the host evaluated "${apolloEvaluation.action}"`,
    )
  }
})

test('V2 native ask/reply works and an empty save scope does not persist an always reply', {
  skip: skipped || !permissionAskProbeEnabled,
}, () => {
  assert.ok(
    permissionAskLive?.observation,
    `no ask/reply probe dump was written: ${permissionAskLive?.diagnose?.() ?? 'probe did not run'}`,
  )
  const { askRequests, savedBefore, savedAfter } = permissionAskLive
  assert.equal(askRequests?.length, 2, 'the two bounded reads did not each produce a native ask')
  for (const [index, reply] of ['always', 'once'].entries()) {
    const request = askRequests[index]
    assert.equal(request.reply, reply)
    assert.equal(request.action, 'read')
    assert.deepEqual(request.resources, [permissionAskLive.sandbox.targetFile])
    assert.deepEqual(request.save ?? [], [], 'the host request was given a persistence scope')
    assert.match(request.output, /CANARY-ALPHA-LINE/)
  }
  assert.deepEqual(savedAfter, savedBefore, 'an empty save scope created a persisted permission')

  const rows = permissionAskLive.observation.permissionEvents.filter(
    (event) => event.action === 'read' && event.sessionID === permissionAskLive.rootSessionID,
  )
  assert.equal(rows.length, 2, `expected two root permission evaluations, got ${rows.length}`)
  for (const event of rows) {
    assert.equal(event.effect, 'ask')
    assert.equal(event.source?.type, 'tool')
    assert.equal(typeof event.source?.messageID, 'string')
    assert.equal(typeof event.source?.id, 'string')
  }
  const executions = permissionAskLive.observation.permissionAskResults
  assert.equal(executions.length, 2)
  for (const execution of executions) {
    assert.equal(execution.sessionID, permissionAskLive.rootSessionID)
    assert.equal(execution.session?.id, permissionAskLive.rootSessionID)
    assert.equal(execution.locationDirectory, permissionAskLive.sandbox.projectDir)
    assert.equal(execution.session?.parentID, undefined)
    assert.ok(!execution.session?.keys?.includes('parentID'))
    assert.ok(execution.session?.projectID, JSON.stringify(execution.session))
    assert.equal(execution.session.projectID, execution.locationProjectID)
    assert.equal(execution.source?.type, 'tool')
    assert.equal(typeof execution.source.messageID, 'string')
    assert.equal(typeof execution.source.id, 'string')
  }
})

test('Pantheon bounded read is registered, asks per call, and returns only its bounded text window', {
  skip: skipped || !boundedReadProbeEnabled,
}, () => {
  assert.ok(
    boundedReadLive?.observation,
    `no bounded-read host probe dump was written: ${boundedReadLive?.diagnose?.() ?? 'probe did not run'}`,
  )
  const tool = boundedReadLive.observation.toolList.find(
    (entry) => entry.name === 'pantheon_bounded_read',
  )
  assert.ok(
    tool?.hasOutput,
    'the real host did not register the bounded reader with its output schema',
  )

  const requests = boundedReadLive.boundedReadRequests
  assert.equal(requests.length, 3)
  for (const [index, reply] of ['once', 'once', 'once'].entries()) {
    const request = requests[index]
    assert.equal(request.reply, reply)
    assert.equal(request.action, 'read')
    assert.deepEqual(request.resources, [join(boundedReadLive.sandbox.projectDir, 'bounded.txt')])
    assert.deepEqual(request.save ?? [], [], 'bounded reader requested a persistent permission')
    assert.ok(request.output.includes('CANARY-ALPHA-LINE'))
    assert.ok(request.output.includes('CANARY-BETA-LINE'))
    assert.equal(request.output.includes('CANARY-GAMMA-LINE'), false)
  }
  assert.deepEqual(
    boundedReadLive.boundedReadSavedAfter,
    boundedReadLive.boundedReadSavedBefore,
    'an always reply with an empty save scope persisted permission',
  )

  const proofLines = boundedReadLive.permissionProof.split('\n').filter(Boolean)
  const origins = proofLines
    .filter((line) => line.startsWith('tool.execute.before bounded-read '))
    .map((line) => JSON.parse(line.slice('tool.execute.before bounded-read '.length)))
  const boundedSessionIDs = new Set(requests.map((request) => request.sessionID))
  const rows = boundedReadLive.observation.permissionEvents.filter(
    (event) =>
      event.action === 'read' &&
      boundedSessionIDs.has(event.sessionID) &&
      (event.resources ?? []).includes(join(boundedReadLive.sandbox.projectDir, 'bounded.txt')),
  )
  assert.equal(origins.length, 3, JSON.stringify(origins))
  assert.equal(rows.length, 3, JSON.stringify(rows))
  for (const origin of origins) {
    const event = rows.find((row) => row.source?.id === origin.callID)
    assert.ok(event, `permission source did not match tool origin ${origin.callID}`)
    assert.equal(origin.sessionID, event.sessionID)
    assert.ok(boundedSessionIDs.has(origin.sessionID))
    assert.equal(origin.agent, 'zeus')
    assert.equal(event.effect, 'ask')
    assert.equal(event.source?.type, 'tool')
    assert.equal(event.source.messageID, origin.messageID)
    assert.equal(event.session?.id, event.sessionID)
    assert.equal(event.session?.parentID, undefined)
    assert.ok(!event.session?.keys?.includes('parentID'))
    assert.equal(event.session?.projectID, event.locationProjectID)
  }
})

test('Pantheon bounded read returns no content when the host denies its exact file permission', {
  skip: skipped || !boundedReadDenyProbeEnabled,
}, () => {
  assert.ok(boundedReadDenyLive?.observation, 'the denied bounded-read host probe did not run')
  assert.ok(boundedReadDenyLive.boundedReadDenyOutput.includes('TOOL_DENIED'))
  assert.equal(boundedReadDenyLive.boundedReadDenyOutput.includes('CANARY-ALPHA-LINE'), false)
  assert.equal(boundedReadDenyLive.boundedReadDenyOutput.includes('CANARY-BETA-LINE'), false)

  const origin = boundedReadDenyLive.permissionProof
    .split('\n')
    .filter((line) => line.startsWith('tool.execute.before bounded-read '))
    .map((line) => JSON.parse(line.slice('tool.execute.before bounded-read '.length)))
  assert.equal(origin.length, 1, JSON.stringify(origin))
  assert.equal(origin[0].sessionID, boundedReadDenyLive.rootSessionID)
  assert.equal(origin[0].agent, 'zeus')
})

test('F4A rejects a disallowed V2 subagent dispatch without a persisted child or extra model request', {
  skip: skipped || !permissionProbeEnabled || !subagentAdmissionProbeEnabled,
}, () => {
  const permissionRows = (permissionLive?.permissionProof ?? '')
    .split('\n')
    .filter((line) => line.startsWith('permission.evaluate '))
    .map((line) => JSON.parse(line.slice('permission.evaluate '.length)))
  const demeterDecisions = permissionRows.filter((event) =>
    (Array.isArray(event.resources) ? event.resources : []).includes('demeter'),
  )
  const subagentCall = permissionLive.subagentCalls?.at(-1)
  assert.ok(subagentCall, 'the host transcript did not contain the native subagent call')
  assert.equal(subagentCall.state?.input?.agent, 'demeter', JSON.stringify(subagentCall))
  assert.equal(subagentCall.state?.status, 'error', JSON.stringify(subagentCall))
  assert.match(
    String(subagentCall.state?.error?.message ?? ''),
    /Pantheon delegation denied/i,
    JSON.stringify(subagentCall),
  )
  assert.equal(demeterDecisions.length, 1, JSON.stringify(demeterDecisions))
  const taskDecision = demeterDecisions[0]
  assert.equal(taskDecision.action, 'subagent', JSON.stringify(taskDecision))
  assert.equal(taskDecision.agent, 'athena', JSON.stringify(taskDecision))
  assert.equal(taskDecision.sessionID, permissionLive.rootSessionID, JSON.stringify(taskDecision))
  assert.deepEqual(taskDecision.source, {
    type: 'tool',
    messageID: taskDecision.matchedOrigin?.messageID,
    id: taskDecision.matchedOrigin?.callID,
  })
  assert.deepEqual(taskDecision.matchedOrigin, {
    sessionID: permissionLive.rootSessionID,
    messageID: taskDecision.source.messageID,
    callID: taskDecision.source.id,
    caller: 'athena',
    target: 'demeter',
  })
  assert.equal(taskDecision.decision, 'deny')
  assert.equal(taskDecision.effectBefore, 'allow', JSON.stringify(taskDecision))
  assert.equal(taskDecision.effectAfter, 'deny', JSON.stringify(taskDecision))
  assert.match(String(taskDecision.message), /^Pantheon delegation denied:/i)
  const sessions = Array.isArray(permissionLive.sessions)
    ? permissionLive.sessions
    : (permissionLive.sessions?.data ?? [])
  const sessionIDs = sessions.map((session) => session?.id ?? session?.sessionID)
  assert.deepEqual(sessionIDs, [permissionLive.rootSessionID])
  assert.equal(
    permissionLive.turns,
    12,
    'denied subagent dispatch triggered an extra model request',
  )
  const lifecycle = (permissionLive.permissionProof ?? '').split('\n')
  const beforeIndex = lifecycle.findIndex((line) => line.startsWith('tool.execute.before '))
  const permissionIndex = lifecycle.findIndex((line) => {
    if (!line.startsWith('permission.evaluate ')) return false
    const evaluation = JSON.parse(line.slice('permission.evaluate '.length))
    return (Array.isArray(evaluation.resources) ? evaluation.resources : []).includes('demeter')
  })
  assert.ok(beforeIndex >= 0, 'host tool.execute.before origin was not recorded')
  assert.ok(permissionIndex > beforeIndex, 'permission evaluation did not follow execute.before')
  assert.equal(
    lifecycle.some(
      (line) =>
        line.startsWith('session.created ') &&
        JSON.parse(line.slice('session.created '.length)).parentID === permissionLive.rootSessionID,
    ),
    false,
    'denied admission created a child session',
  )
})

test('V2 host replaces a no-text child result with an error and preserves completed status', {
  skip: skipped || !subagentAdmissionProbeEnabled,
}, () => {
  assert.ok(emptyChildLive, 'the no-text child host probe did not run')
  assert.equal(
    emptyChildLive.emptyChildResponseRequests,
    1,
    `the local provider did not serve exactly one empty child response: ${JSON.stringify({ childSessions: emptyChildLive.childSessions, childTranscript: emptyChildLive.childTranscript, modelRequests: emptyChildLive.modelRequests })}`,
  )
  assert.equal(emptyChildLive.childSessions.length, 1, 'the native child session did not run')
  const expectedSource = readFileSync(REAL_PLUGIN_SRC, 'utf8')
  const sourceSHA256 = createHash('sha256').update(expectedSource).digest('hex')
  const candidatePackage = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  const hookEvidence = emptyChildLive.executeAfterEvidence ?? []
  assert.ok(
    hookEvidence.some(
      (entry) =>
        entry.phase === 'setup' &&
        entry.packageName === candidatePackage.name &&
        entry.packageVersion === candidatePackage.version &&
        entry.sourcePath === REAL_PLUGIN_SRC &&
        entry.sourceSHA256 === sourceSHA256,
    ),
    `the canary did not load this candidate source: ${JSON.stringify(hookEvidence)}`,
  )
  assert.ok(
    hookEvidence.some((entry) => entry.phase === 'registration' && entry.hook === 'execute.after'),
    `the candidate did not register execute.after: ${JSON.stringify(hookEvidence)}`,
  )
  const childAfterEvent = hookEvidence.find(
    (entry) => entry.phase === 'before' && entry.tool === 'subagent',
  )
  assert.ok(
    childAfterEvent,
    `the candidate execute.after handler did not receive the native child event: ${JSON.stringify(hookEvidence)}`,
  )
  assert.equal(
    childAfterEvent.status,
    'completed',
    `the host child event had an unexpected status: ${JSON.stringify(childAfterEvent)}`,
  )
  assert.equal(
    childAfterEvent.result?.output?.output,
    'Subagent completed without a text response.',
    `the native event result shape differed from the measured placeholder: ${JSON.stringify(childAfterEvent)}`,
  )
  const childAfterHook = hookEvidence.find(
    (entry) =>
      entry.phase === 'after' && entry.tool === 'subagent' && entry.id === childAfterEvent.id,
  )
  assert.ok(
    childAfterHook,
    `the registered candidate handler did not return from the child event: ${JSON.stringify(hookEvidence)}`,
  )
  assert.match(
    childAfterHook.result?.output?.output ?? '',
    /^ERROR: task\(\) returned empty output — child session produced no assistant or tool output\./,
    `the candidate handler did not rewrite the host-consumed nested output field: ${JSON.stringify({ before: childAfterEvent, after: childAfterHook })}`,
  )
  assert.match(
    childAfterHook.result?.content?.[0]?.text ?? '',
    /^ERROR: task\(\) returned empty output — child session produced no assistant or tool output\./,
    `the candidate handler did not rewrite the parent-visible content mirror: ${JSON.stringify(childAfterHook)}`,
  )
  const subagentCall = emptyChildLive.subagentCalls?.at(-1)
  assert.ok(subagentCall, 'the parent transcript has no native subagent result')
  assert.equal(subagentCall.state?.input?.agent, 'demeter', JSON.stringify(subagentCall))
  assert.equal(subagentCall.state?.status, 'completed', JSON.stringify(subagentCall))
  const parentVisibleResult = toolResultText(subagentCall)
  assert.match(
    parentVisibleResult,
    /^ERROR: task\(\) returned empty output — child session produced no assistant or tool output\./,
    `the completed parent-visible result was not replaced by the task guard: ${JSON.stringify(subagentCall)}`,
  )
})

test('F4A admits an allowed root dispatch using the matched host tool identity', {
  skip: skipped || !subagentAdmissionProbeEnabled,
}, () => {
  assert.ok(identityGapLive, 'the identity-gap host run did not execute')
  const probe = identityGapLive.observation?.permissionResults?.at(-1)
  assert.ok(probe, 'permission_probe did not record the live session lookup')
  assert.equal(probe.decision, 'allow', JSON.stringify(probe))
  assert.equal(probe.request.agent, 'zeus')
  assert.equal(probe.request.sessionID, identityGapLive.rootSessionID)
  assert.equal(probe.session?.id, identityGapLive.rootSessionID)
  assert.equal(probe.session?.agent, undefined)
  assert.equal(probe.session?.parentID, undefined)
  assert.ok(!probe.session?.keys?.includes('agent'), JSON.stringify(probe.session))
  assert.ok(!probe.session?.keys?.includes('parentID'), JSON.stringify(probe.session))
  const rootPromptEvents = (identityGapLive.observation?.promptEvents ?? []).filter(
    (event) => event.sessionID === identityGapLive.rootSessionID,
  )
  assert.ok(rootPromptEvents.length > 0, 'session.hook(prompt) did not report the root session')
  assert.equal(rootPromptEvents.at(-1)?.agent, undefined)
  assert.equal(rootPromptEvents.at(-1)?.parentID, undefined)
  assert.ok(!rootPromptEvents.at(-1)?.keys?.includes('agent'))
  assert.ok(!rootPromptEvents.at(-1)?.keys?.includes('parentID'))

  const permissionRows = (identityGapLive.permissionProof ?? '')
    .split('\n')
    .filter((line) => line.startsWith('permission.evaluate '))
    .map((line) => JSON.parse(line.slice('permission.evaluate '.length)))
  const apolloDecisions = permissionRows.filter((event) =>
    (Array.isArray(event.resources) ? event.resources : []).includes('apollo'),
  )
  assert.equal(apolloDecisions.length, 1, JSON.stringify(apolloDecisions))
  assert.equal(apolloDecisions[0].agent, 'zeus', JSON.stringify(apolloDecisions[0]))
  assert.equal(apolloDecisions[0].action, 'subagent')
  assert.equal(apolloDecisions[0].sessionID, identityGapLive.rootSessionID)
  assert.equal(apolloDecisions[0].effectBefore, 'allow')
  assert.equal(apolloDecisions[0].effectAfter, 'allow')
  assert.equal(apolloDecisions[0].decision, 'allow')
  assert.deepEqual(apolloDecisions[0].matchedOrigin, {
    sessionID: identityGapLive.rootSessionID,
    messageID: apolloDecisions[0].source.messageID,
    callID: apolloDecisions[0].source.id,
    caller: 'zeus',
    target: 'apollo',
  })

  const call = identityGapLive.subagentCalls?.at(-1)
  assert.ok(call, 'the host transcript did not contain the native subagent call')
  assert.equal(call.state?.input?.agent, 'apollo', JSON.stringify(call))
  assert.notEqual(call.state?.status, 'error', JSON.stringify(call))
  assert.match(
    toolResultText(call),
    /TOOL-CANARY-DONE/,
    `a non-empty child result was modified or lost: ${JSON.stringify(call)}`,
  )
  const sessions = Array.isArray(identityGapLive.sessions)
    ? identityGapLive.sessions
    : (identityGapLive.sessions?.data ?? [])
  assert.equal(identityGapLive.childSessions.length, 1, JSON.stringify(sessions))
  const child = identityGapLive.childSessions[0]
  assert.equal(child.parentID, identityGapLive.rootSessionID, JSON.stringify(child))
  assert.equal(child.agent, 'apollo', JSON.stringify(child))
  const lifecycle = (identityGapLive.permissionProof ?? '').split('\n')
  const beforeIndex = lifecycle.findIndex((line) => line.startsWith('tool.execute.before '))
  const permissionIndex = lifecycle.findIndex((line) => {
    if (!line.startsWith('permission.evaluate ')) return false
    const evaluation = JSON.parse(line.slice('permission.evaluate '.length))
    return (Array.isArray(evaluation.resources) ? evaluation.resources : []).includes('apollo')
  })
  const childCreateIndex = lifecycle.findIndex((line) => {
    if (!line.startsWith('session.created ')) return false
    const created = JSON.parse(line.slice('session.created '.length))
    return created.id === child.id
  })
  assert.ok(beforeIndex >= 0, 'host tool.execute.before origin was not recorded')
  assert.ok(permissionIndex > beforeIndex, 'permission evaluation did not follow execute.before')
  assert.ok(
    childCreateIndex > permissionIndex,
    `child session was created before admission: ${JSON.stringify({ child, lifecycle })}`,
  )
  assert.equal(identityGapLive.turns > 12, true, 'the admitted child did not run a model request')
  assert.equal(
    lifecycle.some(
      (line) =>
        line.startsWith('session.created ') &&
        JSON.parse(line.slice('session.created '.length)).parentID ===
          identityGapLive.rootSessionID,
    ),
    true,
    'the event stream did not expose the created child parentID',
  )
})

test('F4A rejects an otherwise allowed dispatch from a child session', {
  skip: skipped || !subagentAdmissionProbeEnabled,
}, () => {
  assert.ok(childBoundaryLive, 'the child-boundary host run did not execute')
  const rootCall = childBoundaryLive.subagentCalls?.at(-1)
  assert.ok(rootCall, 'the root session did not dispatch its subagent')
  assert.equal(rootCall.state?.input?.agent, 'athena', JSON.stringify(rootCall))
  assert.notEqual(rootCall.state?.status, 'error', JSON.stringify(rootCall))
  assert.equal(childBoundaryLive.childSessions.length, 1)
  const child = childBoundaryLive.childSessions[0]
  assert.equal(child.agent, 'athena', JSON.stringify(child))
  assert.equal(child.parentID, childBoundaryLive.rootSessionID, JSON.stringify(child))

  const nestedCall = childBoundaryLive.childSubagentCalls?.at(-1)
  assert.ok(nestedCall, 'the child model did not attempt its nested native subagent call')
  assert.equal(nestedCall.state?.input?.agent, 'apollo', JSON.stringify(nestedCall))
  assert.equal(nestedCall.state?.status, 'error', JSON.stringify(nestedCall))
  assert.match(
    String(nestedCall.state?.error?.message ?? ''),
    /Pantheon delegation denied/i,
    JSON.stringify(nestedCall),
  )

  const rows = (childBoundaryLive.permissionProof ?? '')
    .split('\n')
    .filter((line) => line.startsWith('permission.evaluate '))
    .map((line) => JSON.parse(line.slice('permission.evaluate '.length)))
  const nestedDecision = rows.find(
    (row) =>
      row.sessionID === child.id &&
      (Array.isArray(row.resources) ? row.resources : []).includes('apollo'),
  )
  assert.ok(nestedDecision, 'no permission decision was recorded for the child dispatch')
  assert.equal(nestedDecision.action, 'subagent')
  assert.equal(nestedDecision.agent, 'athena')
  assert.equal(nestedDecision.callerSessionParentID, childBoundaryLive.rootSessionID)
  assert.equal(nestedDecision.decision, 'deny')
  assert.equal(nestedDecision.effectBefore, 'allow')
  assert.equal(nestedDecision.effectAfter, 'deny')
  assert.equal(nestedDecision.matchedOrigin.caller, 'athena')
  assert.equal(nestedDecision.matchedOrigin.target, 'apollo')

  const sessionRows = Array.isArray(childBoundaryLive.sessions)
    ? childBoundaryLive.sessions
    : (childBoundaryLive.sessions?.data ?? [])
  assert.equal(
    sessionRows.some((session) => session?.parentID === child.id),
    false,
    'the rejected child dispatch persisted a grandchild session',
  )
})

test('hashline_edit is registered and its host-built descriptor carries output', {
  skip: skipped,
}, () => {
  assert.ok(live.observation, `the probe wrote no dump: ${live.diagnose()}`)
  const entry = live.observation.toolList.find((tool) => tool.name === 'hashline_edit')
  assert.ok(
    entry,
    `ctx.tool.list() has no hashline_edit; host-built names: ${live.observation.toolList
      .map((tool) => tool.name)
      .join(', ')}`,
  )
  assert.equal(entry.id, 'hashline_edit', 'the host registered hashline_edit under a different id')
  assert.ok(
    entry.hasOutput && entry.keys.includes('output'),
    `the host-built descriptor carries no output: keys=${entry.keys.join(', ')}`,
  )
})

test('vision_describe is registered by the real V2 host with the output contract', {
  skip: skipped,
}, () => {
  assert.ok(live.observation, `the probe wrote no dump: ${live.diagnose()}`)
  const entry = live.observation.toolList.find((tool) => tool.name === 'vision_describe')
  assert.ok(
    entry,
    `ctx.tool.list() has no vision_describe; host-built names: ${live.observation.toolList
      .map((tool) => tool.name)
      .join(', ')}`,
  )
  assert.equal(entry.id, 'vision_describe')
  assert.ok(entry.hasOutput && entry.keys.includes('output'))
})

test('native V2 Vision sends image data to the live-catalog paid Go MiMo model', {
  skip: skipped,
}, () => {
  // The intercept is the ONLY thing standing between this canary and the real
  // Zen gateway, so it must have fired (a real request would have returned 401).
  assert.ok(
    Array.isArray(live.observation?.visionRequests),
    `the probe did not record the Zen interceptor: ${live.diagnose()}`,
  )
  // Hermeticity first: the interceptor is the only path to the network, and the
  // escape guard fails the run (naming the URL) if a real request left the
  // sandbox. Checked before the request assertions so a leak reports its cause.
  assert.deepEqual(
    live.observation.escapedRequests,
    [],
    `the canary leaked a request to the network: ${JSON.stringify(live.observation.escapedRequests)}`,
  )
  const zenRequest = live.observation.visionRequests.find(
    (request) =>
      request.model === 'mimo-v2.6-flash' &&
      JSON.stringify(request.messages).includes('data:image/png;base64,') &&
      request.authorization === 'Bearer canary-key',
  )
  assert.ok(
    zenRequest,
    `no authenticated image request reached Go MiMo 2.6 Flash: ${JSON.stringify(live.observation.visionRequests)}`,
  )
  // The interceptor must have caught the REAL gateway URL the native path
  // builds (zen/go/v1), not a mock stand-in.
  assert.match(
    String(zenRequest.url),
    /^https:\/\/opencode\.ai\/zen\//,
    `the intercepted request did not target the real Zen gateway: ${JSON.stringify(zenRequest.url)}`,
  )
  // The Zen gateway rejects a sessionless request (HTTP 400 MissingSessionID),
  // so the intercepted call MUST carry the session header — and only Zen sees it.
  assert.ok(
    typeof zenRequest.session === 'string' && zenRequest.session.trim() !== '',
    `the intercepted Zen request carried no x-opencode-session header: ${JSON.stringify(zenRequest)}`,
  )
  assert.match(
    JSON.stringify(live.vision),
    /CANARY-VISION-RESULT/,
    `native V2 Vision did not return the intercepted response: ${live.visionText}; Zen requests=${JSON.stringify(live.observation.visionRequests)}`,
  )
})

test('hashline_edit is reachable through the execute (Code Mode) surface', {
  skip: skipped,
}, () => {
  assert.deepEqual(
    live.catalog,
    ['tools.hashline_edit'],
    `the Code Mode catalog did not expose hashline_edit: ${live.catalogText}`,
  )
  assert.equal(live.afterCatalog, TARGET_BODY, 'the catalog turn wrote to the target file')
})

test('a real hashline_edit call reports neither host output-contract error', {
  skip: skipped,
}, () => {
  for (const [name, text] of [
    ['catalog turn', live.catalogText],
    ['rejected call', live.badText],
    ['accepted call', live.goodText],
    ['whole transcript', live.transcript],
  ]) {
    assert.ok(!text.includes(NO_OUTPUT_SCHEMA_ERROR), `${name} raised: ${NO_OUTPUT_SCHEMA_ERROR}`)
    assert.ok(!text.includes(MISSING_OUTPUT_ERROR), `${name} raised: ${MISSING_OUTPUT_ERROR}`)
  }
  assert.equal(
    live.good.error,
    undefined,
    `the accepted call threw instead of returning: ${JSON.stringify(live.good)}`,
  )
  assert.match(
    String(live.good.result ?? ''),
    /1 edit\(s\) applied/,
    `the accepted call did not report an applied edit: ${JSON.stringify(live.good)}`,
  )
})

test('an invalid hashline ref comes back as text and writes nothing', { skip: skipped }, () => {
  const rejected = String(live.bad.result ?? live.bad.error ?? '')
  assert.match(
    rejected,
    /hashline_edit:/,
    `an invalid ref was not reported as error-as-text: ${JSON.stringify(live.bad)}`,
  )
  assert.match(
    rejected,
    /out of range|invalid ref|Did you mean/i,
    `an invalid ref produced the wrong diagnostic: ${JSON.stringify(live.bad)}`,
  )
  assert.equal(
    live.afterBadRef,
    TARGET_BODY,
    'the rejected call modified the file; a bad ref must never write',
  )
})

test('the accepted call rewrites exactly the anchored line', { skip: skipped }, () => {
  assert.equal(
    live.afterGoodRef,
    `${TARGET_LINES[0]}\nCANARY-BETA-REPLACED\n${TARGET_LINES[2]}\n`,
    'the accepted call did not apply exactly the anchored replacement',
  )
})

test('the canary fails when output: def.output is removed from draft.add', {
  skip: skipped,
}, async () => {
  mutant = await runCanary(mutantPluginShim())
  const entry = mutant.observation?.toolList?.find((tool) => tool.name === 'hashline_edit')
  assert.ok(
    entry === undefined || !entry.hasOutput,
    'the mutant still registered hashline_edit WITH an output descriptor — the mutation no longer demonstrates anything',
  )
  // Each of these mirrors a positive assertion above: with `output` removed the
  // host drops the tool, so every one of them flips. If any of them still held,
  // this canary would have shipped green over the original defect.
  assert.notDeepEqual(
    mutant.catalog,
    live.catalog,
    'the mutant still exposed hashline_edit through the Code Mode catalog; this canary would not have caught the defect',
  )
  assert.doesNotMatch(
    String(mutant.good.result ?? ''),
    /1 edit\(s\) applied/,
    'the mutant still applied the edit; this canary would not have caught the defect',
  )
  assert.equal(
    mutant.afterGoodRef,
    TARGET_BODY,
    'the mutant still wrote to the file; this canary would not have caught the defect',
  )
})

test('the run leaves the real OpenCode config roots untouched', { skip: skipped }, () => {
  const changes = treeDiff(rootsBefore, snapshotRealConfigRoots())
  assert.deepEqual(
    changes,
    [],
    `the canary wrote outside its sandbox; watched roots: ${realConfigRoots().join(', ')}`,
  )
})

test('the host state landed inside the sandbox data root', { skip: skipped }, () => {
  // Positive half of the isolation proof: the host really did keep its database
  // under the redirected XDG_DATA_HOME, so the real data root was never the
  // target. (The real data root cannot be diffed — a developer's own running
  // host writes it continuously.)
  const sandboxData = join(live.sandbox.dataHome, 'opencode')
  assert.ok(existsSync(sandboxData), `the host wrote no state under ${sandboxData}`)
  assert.ok(
    readdirSync(sandboxData).some(
      (entry) => entry.endsWith('.db') || entry.startsWith('opencode.db'),
    ),
    `no host database under ${sandboxData}: ${readdirSync(sandboxData).join(', ')}`,
  )
})
