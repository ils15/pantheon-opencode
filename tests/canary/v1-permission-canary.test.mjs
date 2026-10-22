/**
 * V1 permission canary — does `permission.ask` exist on an installed 1.19.x host?
 *
 * ## Why this file exists
 *
 * The P0-5 matrix proved the V2 permission mechanism (`ctx.permission.hook
 * ('evaluate')` + `ctx.permission.assert`) on 2.0.22–2.1.2. The 1.19.x row is a
 * different mechanism: the V1 plugin API declares
 * `"permission.ask"?: (input: Permission, output: { status: "ask"|"deny"|"allow" })`
 * (`@opencode-ai/plugin@1.18.33`, dist/index.d.ts:225-227). Nothing in the repo
 * exercised it, so the 1.19.x cell had no evidence at all — neither PASS nor
 * FAIL.
 *
 * This canary registers a V1 plugin shaped exactly like `src/plugin.ts`
 * (`export default` a `Plugin` function) against the real 1.19.4 host, drives
 * real `bash`/`write`/`read` tool calls through the host's own session API and
 * records:
 *
 *   1. whether the `permission.ask` hook fires at all;
 *   2. the `input` shape it receives (when it fires);
 *   3. whether setting `output.status = "deny"` actually blocks the tool (proved
 *      by side effect: no file, no command output);
 *   4. the repo's read-only profile on V1 (`bash`/`write`/`edit` denied, `read`
 *      allowed) — hard assertions, because that is a policy the repo declares.
 *
 * ## Honesty rules
 *
 * - Unknown host semantics are RECORDED, not asserted. The only hard failures
 *   are (a) a declared repo policy being violated and (b) the real config roots
 *   being mutated.
 * - If the hook exists but a `deny` does not block, that is a FAIL — a mechanism
 *   that reports deny and executes anyway is worse than no mechanism.
 * - If the hook never fires, the cases that need it report NOT_APPLICABLE (a
 *   node:test skip, never a pass), and the structured evidence says
 *   `mechanism: "absent"` with the observed alternative (the host asked the
 *   client instead).
 *
 * ## Isolation
 *
 * Same pattern as the V2 tool canary: a private `opencode serve` on a free port
 * with `HOME`/`XDG_*` redirected into a throwaway tree, plus a before/after
 * snapshot of the real config roots. The wrapper (`run-v1-permission-proof.sh`)
 * adds bwrap.
 *
 * Run it: `bash tests/canary/run-v1-permission-proof.sh`
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
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
import { createServer as createModelServer, request as httpRequest } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { after, before, test } from 'node:test'

const BIN = process.env.PANTHEON_V1_CANARY_BIN ?? 'opencode'
const TIMEOUT_MS = Number(process.env.PANTHEON_V1_CANARY_TIMEOUT_MS ?? 20_000)
const HOST_START_MS = Number(process.env.PANTHEON_V1_CANARY_START_TIMEOUT_MS ?? 60_000)
/**
 * Session creation waits for the host's background `bun add @opencode-ai/plugin`
 * in the config directory. With no network that install burns its retry budget
 * (~70 s on 1.19.4), so this call gets a larger budget than a normal request.
 */
const SESSION_TIMEOUT_MS = Number(process.env.PANTHEON_V1_CANARY_SESSION_TIMEOUT_MS ?? 150_000)
const ACCEPTED_VERSIONS = process.env.PANTHEON_V1_CANARY_ACCEPTED_VERSIONS ?? '1.19.*'

/** Inherited config the host must never see. */
const HOST_ENV_STRIPPED = [
  'OPENCODE_PASSWORD',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG_CONTENT',
]

const HOST_ENV_REDIRECTED = [
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
]

const VERSION = (() => {
  try {
    const result = spawnSync(BIN, ['--version'], { encoding: 'utf8' })
    if (result.status !== 0) return ''
    return (result.stdout ?? '').trim()
  } catch {
    return ''
  }
})()

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Glob match with `*` only — the V1 gate is deliberately tiny and separate from V2's. */
function versionMatches(version, patterns) {
  return patterns
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .some((pattern) => {
      const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`)
      return regex.test(version)
    })
}

const skipped = !VERSION
  ? `opencode binary not found or not runnable (${BIN})`
  : versionMatches(VERSION, ACCEPTED_VERSIONS)
    ? false
    : `host version ${VERSION} is outside the V1 gate [${ACCEPTED_VERSIONS}]`

// ─── sandbox ─────────────────────────────────────────────────────────────

function makeSandbox(label) {
  const root = mkdtempSync(join(tmpdir(), `pantheon-v1-${label}-`))
  const sandbox = {
    root,
    projectDir: root,
    home: join(root, 'home'),
    configHome: join(root, 'xdg-config'),
    dataHome: join(root, 'xdg-data'),
    stateHome: join(root, 'xdg-state'),
    cacheHome: join(root, 'xdg-cache'),
    targetFile: join(root, 'target.txt'),
    probePath: join(root, 'probe.ts'),
    proofFile: join(root, 'proof.jsonl'),
    shellRan: join(root, 'shell-ran.txt'),
    writeRan: join(root, 'write-ran.txt'),
  }
  for (const dir of [
    sandbox.home,
    sandbox.configHome,
    sandbox.dataHome,
    sandbox.stateHome,
    sandbox.cacheHome,
  ]) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(sandbox.targetFile, 'V1-CANARY-ALPHA-LINE\nV1-CANARY-BETA-LINE\n')
  return sandbox
}

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

/** Recursive snapshot: relative path → `size:mtimeMs`. */
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
        // A file that vanished mid-walk belongs to another writer, not this canary.
      }
    }
  }
  walk(root, '')
  return out
}

function realConfigRoots() {
  const home = process.env.HOME ?? ''
  const configHome = process.env.XDG_CONFIG_HOME ?? ''
  return [join(configHome, 'opencode'), join(home, '.config', 'opencode')].filter((path) =>
    isAbsolute(path),
  )
}

function snapshotRealConfigRoots() {
  const out = new Map()
  for (const root of realConfigRoots()) {
    for (const [key, value] of snapshotTree(root)) out.set(`${root}::${key}`, value)
  }
  return out
}

function treeDiff(before, after) {
  const changes = []
  for (const [key, value] of after) {
    if (!before.has(key)) changes.push(`created ${key}`)
    else if (before.get(key) !== value) changes.push(`modified ${key}`)
  }
  for (const key of before.keys()) if (!after.has(key)) changes.push(`deleted ${key}`)
  return changes
}

// ─── mock model ──────────────────────────────────────────────────────────

/**
 * Minimal `@ai-sdk/openai-compatible` SSE endpoint.
 *
 * The script is chosen from the LAST user message (each prompt is labelled
 * `[v1-canary-<index>]`), not from turn parity: a denied tool may add a model
 * call, and turn counting would then shift every later script. When the last
 * message is a tool result the endpoint closes the turn with plain text, so each
 * prompt produces exactly one native tool call.
 */
async function startMockModel(scripts) {
  let turns = 0
  const seen = []
  const server = createModelServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += String(chunk)
    })
    req.on('end', () => {
      turns += 1
      let request = {}
      try {
        request = JSON.parse(body)
      } catch {
        request = {}
      }
      const messages = Array.isArray(request.messages) ? request.messages : []
      const last = messages.at(-1)
      const lastContent = last?.content
      const isToolResult =
        last?.role === 'tool' ||
        (Array.isArray(lastContent) &&
          lastContent.some((part) => /tool[-_]result/.test(String(part?.type ?? ''))))
      const textPart = Array.isArray(lastContent)
        ? lastContent.filter((part) => part?.type === 'text').at(-1)?.text
        : typeof lastContent === 'string'
          ? lastContent
          : ''
      const marker = /\[v1-canary-(\d+)\]/.exec(String(textPart ?? ''))
      const index = marker ? Number(marker[1]) : -1
      const script = !isToolResult && index >= 0 ? scripts[index] : undefined
      seen.push({ index, isToolResult, role: last?.role, hasScript: Boolean(script) })
      const base = {
        id: `chatcmpl-v1-canary-${turns}`,
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: 'canary-model',
      }
      const chunks = script
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
                        id: `call_v1_canary_${turns}`,
                        type: 'function',
                        function: {
                          name: script.name,
                          arguments: JSON.stringify(script.arguments),
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
                  delta: { role: 'assistant', content: 'V1-CANARY-DONE' },
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
    turns: () => turns,
    requests: () => seen,
    close: () => server.close(),
  }
}

// ─── V1 plugin probe ─────────────────────────────────────────────────────

/**
 * The probe plugin, written as TypeScript so the host loads it exactly like the
 * shipped `src/plugin.ts`: `export default async () => ({ ...hooks })`.
 *
 * `permission.ask` records the full input (keys + values) before touching
 * `output`, then applies `PANTHEON_V1_CANARY_DECISION`. Other hooks are recorded
 * too, so an absent `permission.ask` is attributable to that hook and not to a
 * plugin that never loaded.
 */
function writeProbe(sandbox) {
  writeFileSync(
    sandbox.probePath,
    `import { appendFileSync } from 'node:fs'
const proof = process.env.PANTHEON_V1_CANARY_PROOF
const decision = process.env.PANTHEON_V1_CANARY_DECISION ?? 'deny'
const rec = (entry) => { if (proof) appendFileSync(proof, JSON.stringify(entry) + '\\n') }
rec({ hook: 'plugin.factory' })
export default async () => ({
  "permission.ask": async (input, output) => {
    rec({
      hook: 'permission.ask',
      inputKeys: Object.keys(input ?? {}),
      input,
      outputKeys: Object.keys(output ?? {}),
      statusBefore: output?.status,
    })
    if (output) output.status = decision
    rec({ hook: 'permission.ask.after', status: output?.status })
  },
  "tool.execute.before": async (input, output) => {
    rec({ hook: 'tool.execute.before', tool: input?.tool, callID: input?.callID, args: output?.args })
  },
  "tool.execute.after": async (input, output) => {
    rec({ hook: 'tool.execute.after', tool: input?.tool, callID: input?.callID, title: output?.title })
  },
  event: async (input) => {
    const type = input?.event?.type
    if (typeof type === 'string' && type.startsWith('permission.')) {
      rec({ hook: 'event', type, properties: input?.event?.properties })
    }
  },
})
`,
  )
}

function writeConfig(sandbox, modelBaseURL, permission) {
  writeFileSync(
    join(sandbox.projectDir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        model: 'canary/canary-model',
        provider: {
          canary: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Pantheon V1 canary',
            options: { baseURL: modelBaseURL, apiKey: 'canary-key' },
            models: { 'canary-model': { name: 'Canary Model', tool_call: true } },
          },
        },
        plugin: [sandbox.probePath],
        permission,
      },
      null,
      2,
    ),
  )
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
    await new Promise((done) => setTimeout(done, 100))
  }
}

/** Start `opencode serve` on 1.19.x and return a small HTTP client. */
async function startHost(sandbox, { decision }) {
  const port = await freePort()
  const server = spawn(
    BIN,
    [
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
      '--print-logs',
      '--log-level',
      'INFO',
    ],
    {
      cwd: sandbox.projectDir,
      env: hostEnv(sandbox, {
        PANTHEON_V1_CANARY_PROOF: sandbox.proofFile,
        PANTHEON_V1_CANARY_DECISION: decision,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
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
      `stdout=${JSON.stringify(stdout.slice(-500))}`,
      `stderr=${JSON.stringify(stderr.slice(-800))}`,
    ].join('; ')

  /** One HTTP round-trip. Resolves `{ status, body }`; rejects only on transport errors. */
  const request = (method, path, body, timeoutMs = TIMEOUT_MS) =>
    new Promise((resolveRequest, rejectRequest) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          timeout: timeoutMs,
          headers: payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {},
        },
        (res) => {
          let text = ''
          res.on('data', (chunk) => {
            text += chunk
          })
          res.on('end', () => {
            let parsed
            try {
              parsed = text === '' ? undefined : JSON.parse(text)
            } catch {
              parsed = { unparsed: text.slice(0, 400) }
            }
            resolveRequest({ status: res.statusCode, body: parsed })
          })
        },
      )
      req.on('timeout', () => req.destroy(new Error(`HTTP timeout ${method} ${path}`)))
      req.on('error', rejectRequest)
      if (payload) req.write(payload)
      req.end()
    })

  const json = async (method, path, body) => {
    const response = await request(method, path, body)
    if (response.status >= 400) {
      throw new Error(
        `${method} ${path} -> HTTP ${response.status}: ${JSON.stringify(response.body)}`,
      )
    }
    return response.body
  }

  // Any startup failure must kill the child: a leaked `serve` holds the stdio
  // pipes open and turns a normal test failure into a hung run.
  let session
  try {
    await waitFor(
      async () => {
        if (exit) throw new Error(`host died during startup: ${diagnose()}`)
        try {
          const response = await request('GET', '/app', undefined, 2000)
          return response.status === 200
        } catch {
          return false
        }
      },
      HOST_START_MS,
      `opencode serve to answer GET /app (${diagnose()})`,
    )

    session = await request(
      'POST',
      '/session',
      { title: 'pantheon-v1-canary' },
      SESSION_TIMEOUT_MS,
    ).then((response) => {
      if (response.status >= 400) {
        throw new Error(
          `POST /session -> HTTP ${response.status}: ${JSON.stringify(response.body)}`,
        )
      }
      return response.body
    })
  } catch (error) {
    server.kill('SIGKILL')
    throw error
  }

  return {
    port,
    sessionID: session.id,
    diagnose,
    hostLog: () => `${stdout}\n${stderr}`,
    async prompt(text) {
      const created = await request('POST', `/session/${session.id}/prompt_async`, {
        model: { providerID: 'canary', modelID: 'canary-model' },
        parts: [{ type: 'text', text }],
      })
      if (created.status >= 400) {
        throw new Error(`prompt_async -> HTTP ${created.status}: ${JSON.stringify(created.body)}`)
      }
    },
    async messages() {
      return (await json('GET', `/session/${session.id}/message`)) ?? []
    },
    /** Pending (classic) permission requests, across sessions. */
    async pendingPermissions() {
      return (await json('GET', '/permission')) ?? []
    },
    async replyPermission(id, reply) {
      return json('POST', `/permission/${id}/reply`, { reply })
    },
    stop() {
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM')
    },
  }
}

// ─── scenario driver ─────────────────────────────────────────────────────

function readProof(sandbox) {
  if (!existsSync(sandbox.proofFile)) return []
  return readFileSync(sandbox.proofFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { hook: 'unparsed', line: line.slice(0, 200) }
      }
    })
}

/** Assistant message is done when the host stamped a completion or an error. */
function assistantDone(messages) {
  const assistant = messages.filter((row) => row?.info?.role === 'assistant').at(-1)
  if (!assistant) return false
  return Boolean(assistant.info?.time?.completed || assistant.info?.error)
}

function toolParts(messages) {
  return messages
    .flatMap((row) => (Array.isArray(row?.parts) ? row.parts : []))
    .filter((part) => part?.type === 'tool')
}

function toolResultText(part) {
  const state = part?.state ?? {}
  const output = state.output ?? state.metadata?.output ?? ''
  return typeof output === 'string' ? output : JSON.stringify(output)
}

/**
 * Run one scenario: one sandbox, one host, one permission config, N scripted
 * native calls.
 *
 * A pending ask is recorded and then resolved with `reject` — the harness must
 * never leave the host blocked, and "the host asked the client" is the fact that
 * makes an absent `permission.ask` attributable.
 */
async function runScenario({ name, permission, decision, scripts: buildScripts }) {
  const sandbox = makeSandbox(name)
  const scripts = buildScripts(sandbox)
  const model = await startMockModel(scripts)
  writeProbe(sandbox)
  writeConfig(sandbox, model.baseURL, permission)
  const observation = { name, permission, decision, sandbox, prompts: [], pendingAsks: [] }
  const host = await startHost(sandbox, { decision })
  try {
    for (const [index, script] of scripts.entries()) {
      await host.prompt(`[v1-canary-${index}] v1 permission canary ${name}`)
      const asks = []
      let messages = []
      const deadline = Date.now() + TIMEOUT_MS
      while (Date.now() < deadline) {
        asks.push(...(await host.pendingPermissions()))
        messages = await host.messages()
        if (assistantDone(messages)) break
        await new Promise((done) => setTimeout(done, 150))
      }
      const uniqueAsks = [...new Map(asks.map((ask) => [ask.id, ask])).values()]
      for (const ask of uniqueAsks) {
        observation.pendingAsks.push({ ...ask, resolvedWith: 'reject', script: script.name })
        await host.replyPermission(ask.id, 'reject').catch(() => {})
      }
      if (!assistantDone(messages)) {
        const settle = Date.now() + 10_000
        while (Date.now() < settle) {
          messages = await host.messages()
          if (assistantDone(messages)) break
          await new Promise((done) => setTimeout(done, 150))
        }
      }
      observation.prompts.push({
        script,
        messages,
        tools: toolParts(messages).map((part) => ({
          tool: part.tool,
          status: part.state?.status,
          input: part.state?.input,
          output: toolResultText(part).slice(0, 500),
          error: part.state?.error?.message ?? part.state?.error,
        })),
        asks: uniqueAsks,
      })
    }

    observation.hostLog = host.hostLog()
    observation.modelRequests = model.requests()
    observation.sideEffects = {
      shell: existsSync(sandbox.shellRan),
      write: existsSync(sandbox.writeRan),
    }
    observation.proof = readProof(sandbox)
    observation.hookFired = observation.proof.some((entry) => entry.hook === 'permission.ask')
    observation.hookEvents = observation.proof.filter((entry) =>
      String(entry.hook).startsWith('permission.ask'),
    )
    observation.toolHookEvents = observation.proof.filter((entry) =>
      String(entry.hook).startsWith('tool.execute'),
    )
    observation.permissionEvents = observation.proof.filter(
      (entry) => entry.hook === 'event' && String(entry.type ?? '').startsWith('permission.'),
    )
    observation.dataRootPopulated = existsSync(join(sandbox.dataHome, 'opencode'))
  } finally {
    host.stop()
    model.close()
  }
  return observation
}

/** Secret-free, reportable view of one scenario. */
function summarize(observation) {
  return {
    scenario: observation.name,
    permission: observation.permission,
    hookDecision: observation.decision,
    hookFired: observation.hookFired,
    hookInput:
      observation.hookEvents.find((entry) => entry.hook === 'permission.ask')?.input ?? null,
    pendingAsks: observation.pendingAsks.map((ask) => ({
      permission: ask.permission,
      patterns: ask.patterns,
      always: ask.always,
      metadata: ask.metadata,
      tool: ask.tool,
      reply: ask.resolvedWith,
    })),
    permissionEvents: observation.permissionEvents.map((entry) => entry.type),
    // A denied tool on 1.19.4 disappears from the model's tool list; the host
    // records the attempt as `tool: "invalid"` with the reason. That is the
    // observed enforcement point and belongs in the evidence verbatim.
    unavailable: [
      ...new Set(
        observation.prompts
          .flatMap((prompt) => prompt.tools)
          .filter((tool) => tool.tool === 'invalid' && tool.input?.tool)
          .map((tool) => `${tool.input.tool}: ${tool.input.error}`),
      ),
    ],
    tools: observation.prompts.flatMap((prompt) =>
      prompt.tools.map((tool) => ({
        tool: tool.tool,
        status: tool.status,
        input: tool.input,
        output: tool.output,
        error: tool.error,
      })),
    ),
    toolHooks: observation.toolHookEvents.map((entry) => entry.hook),
    sideEffects: observation.sideEffects,
    dataRootPopulated: observation.dataRootPopulated,
  }
}

// ─── state ───────────────────────────────────────────────────────────────

let rootsBefore = null
let scenarios = null

before(
  async () => {
    rootsBefore = snapshotRealConfigRoots()
    if (skipped) return
    scenarios = {}
    // 1. The hook's own path: the host is configured to ask, the hook says deny.
    scenarios.askTools = await runScenario({
      name: 'ask-tools',
      permission: { bash: 'ask', write: 'ask', edit: 'ask' },
      decision: 'deny',
      scripts: (sandbox) => [
        {
          name: 'bash',
          arguments: {
            command: `echo V1-CANARY-SHELL > ${sandbox.shellRan}`,
            description: 'V1 permission canary shell',
          },
        },
        {
          name: 'write',
          arguments: { filePath: sandbox.writeRan, content: 'V1-CANARY-WRITE' },
        },
      ],
    })
    // 2. Veto control: the host allows the call, the hook says deny. If the call
    //    still runs, the hook is not on the decision path at all.
    scenarios.allowBash = await runScenario({
      name: 'allow-bash',
      permission: { bash: 'allow' },
      decision: 'deny',
      scripts: (sandbox) => [
        {
          name: 'bash',
          arguments: {
            command: `echo V1-CANARY-SHELL > ${sandbox.shellRan}`,
            description: 'V1 permission canary shell',
          },
        },
      ],
    })
    // 4. The repo's declared read-only profile, expressed in V1 keys.
    scenarios.readOnly = await runScenario({
      name: 'read-only',
      permission: { bash: 'deny', write: 'deny', edit: 'deny', read: 'allow' },
      decision: 'deny',
      scripts: (sandbox) => [
        {
          name: 'bash',
          arguments: {
            command: `echo V1-CANARY-SHELL > ${sandbox.shellRan}`,
            description: 'read-only canary shell',
          },
        },
        {
          name: 'write',
          arguments: { filePath: sandbox.writeRan, content: 'V1-CANARY-WRITE' },
        },
        { name: 'read', arguments: { filePath: sandbox.targetFile } },
      ],
    })
  },
  { timeout: 600_000 },
)

after(() => {
  for (const observation of Object.values(scenarios ?? {})) {
    if (observation?.sandbox) rmSync(observation.sandbox.root, { recursive: true, force: true })
  }
})

// ─── tests ───────────────────────────────────────────────────────────────

test('the V1 gate refuses hosts outside 1.19.x', () => {
  // Documents the gate itself: this canary is V1-only, and silently running it
  // against a V2 host would measure a different mechanism — which is exactly the
  // mistake the "not applicable" verdict exists to prevent.
  assert.equal(versionMatches('1.19.4', '1.19.*'), true)
  assert.equal(versionMatches('2.0.30', '1.19.*'), false)
  assert.equal(versionMatches('1.19.4', '1.18.*,1.19.*'), true)
})

test('the host environment is redirected into the sandbox', () => {
  const sandbox = makeSandbox('env')
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

test('the probe plugin loads on the V1 host', { skip: skipped }, () => {
  const factory = scenarios.askTools.proof.some((entry) => entry.hook === 'plugin.factory')
  assert.ok(
    factory,
    `the V1 plugin did not load, so no hook result is attributable: ${scenarios.askTools.hostLog.slice(-1200)}`,
  )
})

test('permission.ask fires on the V1 host for a bash call', { skip: skipped }, (t) => {
  const scenario = scenarios.askTools
  const tool = scenario.prompts[0].tools.find((entry) => entry.tool === 'bash')
  const asks = scenario.pendingAsks.filter((ask) => ask.script === 'bash')
  if (!scenario.hookFired) {
    // Mechanism absence is the result. The host still asked the CLIENT (pending
    // /permission entry), which is recorded as the alternative path.
    assert.ok(
      asks.length > 0 || tool?.status === 'error',
      `no permission.ask and no client ask: the bash call was neither asked nor blocked (tool=${JSON.stringify(tool)})`,
    )
    assert.equal(scenario.sideEffects.shell, false, 'the shell side effect exists with no decision')
    t.skip(
      `NOT_APPLICABLE: ${VERSION} never invoked permission.ask; the host asked the client instead (${asks[0]?.permission ?? 'no ask'})`,
    )
    return
  }
  // The hook exists: a deny that executes anyway is a lie and must fail.
  assert.equal(
    scenario.sideEffects.shell,
    false,
    `permission.ask set "deny" but the shell still ran (tool=${JSON.stringify(tool)})`,
  )
  assert.notEqual(
    tool?.status,
    'completed',
    `a denied bash call completed: ${JSON.stringify(tool)}`,
  )
})

test('permission.ask deny cannot be proved as a veto when the hook is absent', {
  skip: skipped,
}, (t) => {
  const scenario = scenarios.allowBash
  const tool = scenario.prompts[0].tools.find((entry) => entry.tool === 'bash')
  if (!scenario.hookFired) {
    // Recorded, not asserted: the host ignores the hook entirely, so "allow" and
    // "deny" produce the same result and neither proves a veto.
    assert.equal(
      scenario.sideEffects.shell,
      true,
      'host allowed the call but no side effect appeared',
    )
    assert.notEqual(tool?.status, 'error', 'host allowed the call but the tool errored')
    t.skip(
      `NOT_APPLICABLE: ${VERSION} never invoked permission.ask, so its deny cannot veto an allowed call`,
    )
    return
  }
  assert.equal(
    scenario.sideEffects.shell,
    false,
    `permission.ask set "deny" over an allowed bash call but the shell ran (tool=${JSON.stringify(tool)})`,
  )
})

test('permission.ask fires on the V1 host for a write call', { skip: skipped }, (t) => {
  const scenario = scenarios.askTools
  const tool = scenario.prompts[1].tools.find((entry) => entry.tool === 'write')
  const asks = scenario.pendingAsks.filter((ask) => ask.script === 'write')
  if (!scenario.hookFired) {
    assert.ok(
      asks.length > 0 || tool?.status === 'error',
      `no permission.ask and no client ask for write (tool=${JSON.stringify(tool)})`,
    )
    assert.equal(scenario.sideEffects.write, false, 'a write side effect exists with no decision')
    t.skip(
      `NOT_APPLICABLE: ${VERSION} never invoked permission.ask; the host asked the client under "${asks[0]?.permission ?? 'no ask'}"`,
    )
    return
  }
  assert.equal(
    scenario.sideEffects.write,
    false,
    `permission.ask set "deny" but the file was written (tool=${JSON.stringify(tool)})`,
  )
})

test('V1 read-only profile: bash and write blocked, read allowed', { skip: skipped }, () => {
  const scenario = scenarios.readOnly
  assert.equal(
    scenario.sideEffects.shell,
    false,
    `a read-only V1 profile still ran shell (tools=${JSON.stringify(scenario.prompts[0].tools)})`,
  )
  assert.equal(
    scenario.sideEffects.write,
    false,
    `a read-only V1 profile still wrote a file (tools=${JSON.stringify(scenario.prompts[1].tools)})`,
  )
  for (const [index, name] of [
    [0, 'bash'],
    [1, 'write'],
  ]) {
    const tool = scenario.prompts[index].tools.find((entry) => entry.tool === name)
    if (tool) {
      assert.notEqual(
        tool.status,
        'completed',
        `a denied ${name} call completed: ${JSON.stringify(tool)}`,
      )
      continue
    }
    // 1.19.4 enforces the deny by removing the tool from the model's list; the
    // attempt is recorded as `tool: "invalid"` naming the unavailable tool.
    const blocked = scenario.prompts[index].tools.find(
      (entry) => entry.tool === 'invalid' && entry.input?.tool === name,
    )
    assert.ok(
      blocked,
      `neither a blocked ${name} call nor an unavailability record was found: ${JSON.stringify(scenario.prompts[index].tools)}`,
    )
    assert.match(
      String(blocked.input?.error ?? ''),
      new RegExp(`unavailable tool '${name}'`),
      `the ${name} block did not come from the permission policy: ${JSON.stringify(blocked)}`,
    )
  }
  // Positive control: the same profile explicitly allows read.
  const readText = scenario.prompts[2].tools.map((tool) => tool.output).join('\n')
  assert.match(
    readText,
    /V1-CANARY-ALPHA-LINE/,
    `read was not allowed under the read-only profile: ${JSON.stringify(readText)}`,
  )
})

test('the run leaves the real OpenCode config roots untouched', { skip: skipped }, () => {
  const afterTree = snapshotRealConfigRoots()
  const changes = treeDiff(rootsBefore, afterTree)
  assert.deepEqual(changes, [], `the canary mutated real config roots: ${changes.join(', ')}`)
})

test('the host state landed inside the sandbox data root', { skip: skipped }, () => {
  for (const observation of Object.values(scenarios)) {
    assert.equal(
      observation.dataRootPopulated,
      true,
      `the host wrote no state under ${observation.sandbox.dataHome}/opencode — isolation is unproven`,
    )
  }
})

test('V1 permission evidence is reported', { skip: skipped }, () => {
  const report = {
    host: { bin: BIN, version: VERSION },
    mechanism: scenarios.askTools.hookFired ? 'present' : 'absent',
    permissionKeyObserved: Object.fromEntries(
      ['bash', 'write'].map((tool) => [
        tool,
        scenarios.askTools.pendingAsks
          .filter((ask) => ask.script === tool)
          .map((ask) => ask.permission),
      ]),
    ),
    scenarios: Object.values(scenarios).map(summarize),
  }
  console.log(`V1 permission evidence: ${JSON.stringify(report)}`)
  assert.ok(report.scenarios.length >= 3, 'the report lost a scenario')
})
