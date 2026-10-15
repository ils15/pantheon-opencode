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
async function startMockModel(scripts) {
  let turn = 0
  let nestedAthenaChildCalled = false
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
      const step = nestedAthenaChild
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
  { permissionProbe = false, permissionAskProbe = false } = {},
) {
  writeFileSync(join(sandbox.projectDir, '.opencode', 'plugins', 'real', 'index.ts'), pluginSource)
  writeFileSync(
    join(sandbox.projectDir, '.opencode', 'plugins', 'probe', 'index.ts'),
    [
      "import { readFileSync, writeFileSync } from 'node:fs'",
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
            '            await ctx.permission.assert(request)',
            '            permissionResults.push({ decision: "allow", request, session: sessionSummary })',
            '            return { output: JSON.stringify({ decision: "allow" }) }',
            '          } catch (error) {',
            '            const result = { decision: "reject", error: String(error?.message ?? error), request, session: sessionSummary }',
            '            permissionResults.push(result)',
            '            return { output: JSON.stringify(result) }',
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

function writeProjectConfig(
  sandbox,
  modelBaseURL,
  {
    permissionProbe = false,
    permissionAskProbe = false,
    boundedReadProbe = false,
    boundedReadDenyProbe = false,
    subagentAdmissionProbe = false,
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
                      system: `Reply with ${agent.toUpperCase()}-CANARY-CHILD if you are started.`,
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
      },
      null,
      2,
    ),
  )
}

/** The re-export shim that makes the host load `src/plugin-v2.ts` itself. */
function realPluginShim() {
  return `export { default } from ${JSON.stringify(REAL_PLUGIN_SRC)}\n`
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
              prompt:
                subagentTarget === 'athena'
                  ? 'Return ATHENA-CANARY-TRY-NESTED only.'
                  : `Return ${subagentTarget.toUpperCase()}-CANARY-CHILD only.`,
              agent: subagentTarget,
            },
          },
        ]
      : []),
  ]
  const model = await startMockModel(scripts)
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

// ─── state ───────────────────────────────────────────────────────────────

let live = null
let mutant = null
let permissionLive = null
let permissionAskLive = null
let boundedReadLive = null
let boundedReadDenyLive = null
let identityGapLive = null
let childBoundaryLive = null
let rootsBefore = null
const permissionProbeEnabled = process.env.PANTHEON_TOOL_CANARY_PERMISSION_PROBE === '1'
const permissionAskProbeEnabled = process.env.PANTHEON_TOOL_CANARY_PERMISSION_ASK === '1'
const boundedReadProbeEnabled = process.env.PANTHEON_TOOL_CANARY_BOUNDED_READ === '1'
const boundedReadDenyProbeEnabled = process.env.PANTHEON_TOOL_CANARY_BOUNDED_READ_DENY === '1'

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
  },
  { timeout: 60_000 },
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
    assert.match(result.error, /Blocked by configuration policy/i)
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
