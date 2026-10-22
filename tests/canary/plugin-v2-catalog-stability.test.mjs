/**
 * P0-4 harness — is the tool catalog stable across turns of ONE session?
 *
 * ## What this measures (three independent surfaces, per turn)
 *
 *   1. MODEL-FACING `request.tools` — the exact tool names the host advertises
 *      to the model on each chat request. This is the catalog an agent can
 *      actually call; a name that disappears here is a real "tool existed and
 *      then was absent" event.
 *   2. REGISTRY `ctx.tool.list()` — captured from inside the host by a probe
 *      plugin on every `execute.after`. Names + count + a stable hash.
 *   3. CODE MODE — `Object.keys(tools)` and a `search()` probe executed inside
 *      the Code Mode sandbox, which is how plugin/MCP tools are reached.
 *
 * Every surface is recorded per turn, in order, with a hash, so an oscillation
 * is a list of hashes that change without a config change — not an impression.
 *
 * ## Measured on 2.0.29 / 2.0.30 / 2.1.0 / 2.1.2 / 2.1.3 (2026-10-22)
 *
 *   1. The registry is PARTIAL inside `setup()`: 21 tools. By the first
 *      `execute.before` it is 71, and it stays 71 (one hash) for every later
 *      turn and for every NEW session in the same host. The single transition
 *      is the lazy plugin/built-in-tool registration landing inside the first
 *      turn, not an oscillation.
 *   2. The model-facing list is 12 built-ins and never changes.
 *   3. With an MCP server configured, `/api/mcp` can report `connected` while
 *      the server's tool is still absent from the registry at the first
 *      `execute.before`; it appears by `execute.after`. On a rerun of the same
 *      scenario it was already present at `execute.before` — the first-turn
 *      snapshot is RACY. This is why "tool X works" stops being reproducible.
 *   4. Killing an MCP server removes its tools permanently (72 -> 71) and the
 *      host does NOT reconnect — not even when a supervisor restarts the
 *      server process. Only an explicit reload would restore them.
 *   5. Touching a plugin file reloads it (a new module instance runs `setup`),
 *      but the registry names do not change. Touching the config file does not
 *      reload MCP.
 *   6. The host loads every directory under `.opencode/plugins/` IN ADDITION to
 *      the `plugins` config array (two "loading plugin" log lines per entry).
 *      The same entrypoint path is deduped (one `setup`), so a same-path double
 *      entry is harmless; a distinct-path double load (npm package + repo
 *      source) is NOT exercised here and would run `setup` twice — the V2
 *      plugin has no `pantheonPluginOnce` guard (only `src/plugin.ts`,
 *      `pantheon-hooks.ts` and the TUI do).
 *
 * Exit code: 1 when a non-MCP-death scenario changes its registry after the
 * first turn or its model-facing list at any turn. Set
 * `PANTHEON_CATALOG_ASSERT_SCENARIOS=mcp-kill` to prove the gate fires.
 *
 * ## What is real / what is mocked
 *
 * Real: the host binary, its plugin loader, config parsing, MCP client, tool
 * registry, Code Mode, and request construction.
 * Mocked: ONLY the model — a local SSE endpoint replaying scripted `execute`
 * calls. No credential, no external network.
 *
 * ## Usage
 *
 *   PANTHEON_TOOL_CANARY_BIN=<opencode2> node tests/canary/plugin-v2-catalog-stability.test.mjs
 *
 * Optional env:
 *   PANTHEON_CATALOG_TURNS=10     turns per scenario (default 8)
 *   PANTHEON_CATALOG_SCENARIO=all|baseline|mcp|double-load
 *   PANTHEON_CATALOG_OUT=<dir>    where the JSON report + JSONL land
 *                                (default /tmp/opencode/p04-catalog)
 *
 * Isolation: private `HOME`/`XDG_*`, throwaway project dir, own port. The
 * developer's config roots are snapshotted before and after.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const REAL_PLUGIN_SRC = join(REPO_ROOT, 'src', 'plugin-v2.ts')
const BIN = process.env.PANTHEON_TOOL_CANARY_BIN ?? 'opencode'
const TIMEOUT_MS = Number(process.env.PANTHEON_TOOL_CANARY_TIMEOUT_MS ?? 60000)
const TURNS = Number(process.env.PANTHEON_CATALOG_TURNS ?? 8)
const ONLY = process.env.PANTHEON_CATALOG_SCENARIO ?? 'all'
const OUT_DIR = process.env.PANTHEON_CATALOG_OUT ?? '/tmp/opencode/p04-catalog'

// ─── helpers ─────────────────────────────────────────────────────────────

const sha = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 12)
const canonical = (names) => [...names].sort()
const hashNames = (names) => sha(canonical(names).join('\n'))

function makeSandbox(tag) {
  const root = mkdtempSync(join(tmpdir(), `pantheon-catalog-${tag}-`))
  const sandbox = {
    root,
    projectDir: root,
    home: join(root, 'home'),
    configHome: join(root, 'xdg-config'),
    dataHome: join(root, 'xdg-data'),
    stateHome: join(root, 'xdg-state'),
    cacheHome: join(root, 'xdg-cache'),
    targetFile: join(root, 'target.txt'),
    catalogFile: join(root, 'catalog-turns.jsonl'),
    mcpServerFile: join(root, 'canary-mcp-server.cjs'),
    mcpLogFile: join(root, 'canary-mcp-server.log'),
    mcpPidFile: join(root, 'canary-mcp-server.pid'),
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

function hostEnv(sandbox, extra = {}) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('OPENCODE')) delete env[key]
  }
  env.HOME = sandbox.home
  env.XDG_RUNTIME_DIR = join(sandbox.root, 'xdg-runtime')
  env.XDG_CONFIG_HOME = sandbox.configHome
  env.XDG_DATA_HOME = sandbox.dataHome
  env.XDG_STATE_HOME = sandbox.stateHome
  env.XDG_CACHE_HOME = sandbox.cacheHome
  // Never let a repo-local shim resolution reach outside this sandbox.
  env.PATH = [dirname(BIN), env.PATH ?? ''].filter(Boolean).join(delimiter)
  return { ...env, ...extra }
}

function realConfigRoots() {
  const home = process.env.HOME ?? ''
  const configHome = process.env.XDG_CONFIG_HOME ?? ''
  return [join(configHome, 'opencode'), join(home, '.config', 'opencode')].filter((p) =>
    isAbsolute(p),
  )
}

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
      } catch {}
    }
  }
  walk(root, '')
  return out
}

function snapshotRealConfig() {
  const out = new Map()
  for (const root of realConfigRoots()) {
    for (const [key, value] of snapshotTree(root)) out.set(`${root}::${key}`, value)
  }
  return out
}

function diffSnapshots(before, after) {
  const changes = []
  for (const [key, value] of after) {
    if (!before.has(key)) changes.push(`created ${key}`)
    else if (before.get(key) !== value) changes.push(`modified ${key}`)
  }
  for (const key of before.keys()) if (!after.has(key)) changes.push(`deleted ${key}`)
  return changes
}

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

// ─── mock model ──────────────────────────────────────────────────────────

/**
 * Scripted SSE endpoint. Every request's `tools` array is recorded verbatim
 * (names only) before answering, so the model-facing catalog has one row per
 * host->model request, not one row per test assertion.
 */
async function startMockModel(scripts, { onRequest } = {}) {
  let turn = 0
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += String(chunk)
    })
    req.on('end', () => {
      let parsed = {}
      try {
        parsed = JSON.parse(body)
      } catch {}
      const toolNames = (Array.isArray(parsed.tools) ? parsed.tools : [])
        .map((tool) => (typeof tool?.function?.name === 'string' ? tool.function.name : undefined))
        .filter(Boolean)
      turn += 1
      const row = {
        request: turn,
        model: parsed.model,
        messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
        bodyChars: body.length,
        toolCount: toolNames.length,
        toolHash: hashNames(toolNames),
        toolNames: canonical(toolNames),
        systemHash: sha(
          (Array.isArray(parsed.messages) ? parsed.messages : [])
            .filter((m) => m?.role === 'system')
            .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
            .join('\n'),
        ),
      }
      requests.push(row)
      onRequest?.(row)

      const base = {
        id: `chatcmpl-catalog-${turn}`,
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: 'canary-model',
      }
      const index = (turn - 1) / 2
      const scripted = turn % 2 === 1 && index < scripts.length
      const step = scripted ? scripts[index] : undefined
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
                        id: `call_catalog_${turn}`,
                        type: 'function',
                        function: {
                          name: typeof step === 'string' ? 'execute' : step.name,
                          arguments: JSON.stringify(
                            typeof step === 'string' ? { code: step } : step.arguments,
                          ),
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
                  delta: { role: 'assistant', content: 'CATALOG-DONE' },
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
    requests: () => requests,
    close: () => server.close(),
  }
}

// ─── plugin tree ─────────────────────────────────────────────────────────

const PROBE_SOURCE = `
import { appendFileSync } from 'node:fs'
const MODULE_ID = Math.random().toString(36).slice(2, 10)
let setupCalls = 0
export default {
  id: 'pantheon-catalog-probe',
  async setup(ctx) {
    setupCalls += 1
    const file = process.env.PANTHEON_CATALOG_PROOF
    const record = (entry) => {
      if (!file) return
      try {
        appendFileSync(file, JSON.stringify({ moduleId: MODULE_ID, setupCalls, ...entry }) + '\\n')
      } catch {}
    }
    const snapshot = async (event, hookEvent) => {
      let names = null
      try {
        const list = await ctx.tool.list()
        names = (Array.isArray(list) ? list : []).map((tool) => tool.name)
      } catch (err) {
        names = String(err && err.message ? err.message : err)
      }
      record({
        event,
        names,
        sessionID: hookEvent && hookEvent.sessionID,
        // A second setup of a DIFFERENT module instance is what a real
        // double-load (npm path + repo path) looks like; same-module reloads
        // keep moduleId and bump setupCalls.
        setupCalls,
      })
    }
    // Registering our own tool proves the list is this process's registry: a
    // remote catalog could not contain a name only this module knows.
    await ctx.tool.transform((draft) => {
      draft.add({
        name: 'p04_probe_marker',
        description: 'P0-4 catalog probe marker',
        input: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          type: 'object',
          properties: { output: { type: 'string' } },
          required: ['output'],
          additionalProperties: false,
        },
        async execute() {
          return { output: 'P04-PROBE-MARKER' }
        },
      })
    })
    await snapshot('setup.list', null)
    await ctx.tool.hook('execute.before', async (event) => snapshot('execute.before', event))
    await ctx.tool.hook('execute.after', async (event) => snapshot('execute.after', event))
  },
}
`

const MCP_SOURCE = `'use strict'
const readline = require('node:readline')
const fs = require('node:fs')
const logPath = process.argv[2]
const pidPath = process.argv[3]
if (pidPath) { try { fs.writeFileSync(pidPath, String(process.pid)) } catch {} }
const log = (line) => { if (!logPath) return; try { fs.appendFileSync(logPath, line + '\\n') } catch {} }
const send = (message) => { const line = JSON.stringify(message); log('OUT ' + line); process.stdout.write(line + '\\n') }
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  log('IN ' + line)
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.id === undefined) return
  const id = message.id
  switch (message.method) {
    case 'initialize':
      reply(id, { protocolVersion: (message.params && message.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'canary-mcp', version: '1.0.0' } })
      break
    case 'ping': reply(id, {}); break
    case 'tools/list':
      reply(id, { tools: [ { name: 'echo', description: 'Return the text it receives', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } } ] })
      break
    case 'tools/call':
      reply(id, { content: [ { type: 'text', text: 'CANARY-MCP-ECHO:' + String((message.params && message.params.arguments && message.params.arguments.text) || '') } ] })
      break
    case 'resources/list': reply(id, { resources: [] }); break
    default: send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unsupported method ' + String(message.method) } })
  }
})
`

function writePluginTree(sandbox, { extraLoaders = [] } = {}) {
  writeFileSync(
    join(sandbox.projectDir, '.opencode', 'plugins', 'real', 'index.ts'),
    `export { default } from ${JSON.stringify(REAL_PLUGIN_SRC)}\n`,
  )
  writeFileSync(join(sandbox.projectDir, '.opencode', 'plugins', 'probe', 'index.ts'), PROBE_SOURCE)
  for (const [index] of extraLoaders.entries()) {
    const dir = join(sandbox.projectDir, '.opencode', `double-${index}`)
    mkdirSync(dir, { recursive: true })
    // Same absolute module target from a DIFFERENT plugin directory: this is the
    // npm-package + repo-source double-load shape, reduced to its loader
    // boundary (the host resolves two plugin entries to the same plugin).
    writeFileSync(
      join(dir, 'index.ts'),
      `export { default } from ${JSON.stringify(REAL_PLUGIN_SRC)}\n`,
    )
  }
}

function providerConfig(baseURL) {
  return {
    provider: {
      canary: {
        npm: '@ai-sdk/openai-compatible',
        name: 'canary',
        id: 'canary',
        options: { baseURL, apiKey: 'canary-key' },
        models: {
          'canary-model': {
            name: 'canary-model',
            tool_call: true,
            modalities: { input: ['text'], output: ['text'] },
            // A deliberately large ceiling: this run must NOT compact. Context
            // pressure is a separate scenario; changing it here would make a
            // catalog change unattributable.
            limit: { context: 128000, output: 8192 },
          },
        },
      },
    },
    model: 'canary/canary-model',
  }
}

function writeConfig(sandbox, baseURL, { pluginDirs, mcp }) {
  writeFileSync(
    join(sandbox.projectDir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        plugins: pluginDirs,
        ...providerConfig(baseURL),
        ...(mcp ? { mcp } : {}),
      },
      null,
      2,
    ),
  )
}

// ─── host ────────────────────────────────────────────────────────────────

async function startHost(sandbox) {
  const port = await freePort()
  const server = spawn(BIN, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: sandbox.projectDir,
    env: hostEnv(sandbox, { PANTHEON_CATALOG_PROOF: sandbox.catalogFile }),
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
      exit ?? `host pid ${server.pid} running`,
      `stdout=${JSON.stringify(stdout.slice(0, 300))}`,
      `stderr=${JSON.stringify(stderr.slice(0, 300))}`,
    ].join('; ')

  const password = await waitFor(
    async () => /server password (\S+)/.exec(stdout)?.[1],
    TIMEOUT_MS,
    `opencode serve password (${diagnose()})`,
  )
  const headers = {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
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
    if (!response.ok)
      throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 300)}`)
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
    `host ready (${diagnose()})`,
  )
  const created = await request('POST', '/api/session', {
    title: 'pantheon-catalog-stability',
    model: { providerID: 'canary', id: 'canary-model' },
  })
  const sessionID = created.data.id
  return {
    port,
    sessionID,
    request,
    stdout: () => stdout,
    stderr: () => stderr,
    async prompt(text) {
      await this.promptOn(sessionID, text)
    },
    async promptOn(id, text) {
      await request('POST', `/api/session/${id}/prompt`, {
        text,
        model: { providerID: 'canary', id: 'canary-model' },
      })
      await request('POST', `/api/experimental/session/${id}/wait`)
    },
    async newSession(title) {
      const createdSession = await request('POST', '/api/session', {
        title,
        model: { providerID: 'canary', id: 'canary-model' },
      })
      return createdSession.data.id
    },
    async mcpStatus() {
      return request('GET', '/api/mcp').catch((error) => ({ error: String(error) }))
    },
    async transcript() {
      return request('GET', `/api/session/${sessionID}/message`)
    },
    stop() {
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM')
    },
  }
}

// ─── catalog probe script (Code Mode, inside the host) ───────────────────

const CATALOG_SCRIPT = [
  'const out = {};',
  'try {',
  '  const keys = Object.keys(tools ?? {});',
  '  out.namespaces = keys.sort();',
  '  out.total = keys.length;',
  '} catch (error) {',
  '  out.keysError = String(error && error.message ? error.message : error);',
  '}',
  'try {',
  '  const found = search({ query: "" });',
  '  out.searchCount = Array.isArray(found.items) ? found.items.length : null;',
  '  out.searchPaths = Array.isArray(found.items) ? found.items.map((i) => i.path) : null;',
  '  out.searchRemaining = found.remaining ?? null;',
  '  const probe = (input) => {',
  '    try {',
  '      const result = search(input);',
  '      return { count: Array.isArray(result.items) ? result.items.length : null, remaining: result.remaining ?? null, paths: Array.isArray(result.items) ? result.items.map((i) => i.path) : null };',
  '    } catch (error) {',
  '      return { error: String(error && error.message ? error.message : error) };',
  '    }',
  '  };',
  '  out.searchLimit50 = probe({ query: "", limit: 50 });',
  '  out.searchOffset10 = probe({ query: "", offset: 10 });',
  '  out.searchNamespaceBrowser = probe({ query: "", namespace: "browser" });',
  '} catch (error) {',
  '  out.searchError = String(error && error.message ? error.message : error);',
  '}',
  'return JSON.stringify(out);',
].join('\n')

const READ_SCRIPT = (sandbox) => ({
  name: 'read',
  arguments: { path: sandbox.targetFile },
})

/** Last Code Mode `execute` result, parsed as the JSON the script returned. */
function lastCodeModeResult(transcript) {
  try {
    const parsed = typeof transcript === 'string' ? JSON.parse(transcript) : transcript
    const messages = (Array.isArray(parsed) ? parsed : (parsed?.data ?? [])).slice()
    const parts = messages.flatMap((message) => message?.parts ?? message?.content ?? [])
    const executes = parts.filter(
      (part) => part?.type === 'tool' && (part.tool ?? part.name) === 'execute',
    )
    const last = executes.at(-1)
    if (!last) return null
    const state = last.state ?? {}
    let output = state.output ?? state.result?.output ?? state.content ?? state.result?.content
    if (Array.isArray(output)) {
      output = output
        .map((item) => (typeof item === 'string' ? item : (item?.text ?? '')))
        .join('\n')
    }
    if (typeof output !== 'string') output = JSON.stringify(output)
    const line = String(output).trim().split('\n').filter(Boolean).at(-1) ?? ''
    return JSON.parse(line)
  } catch (error) {
    return { parseError: String(error?.message ?? error) }
  }
}

// ─── one scenario ────────────────────────────────────────────────────────

function readCatalogRows(sandbox) {
  if (!existsSync(sandbox.catalogFile)) return []
  return readFileSync(sandbox.catalogFile, 'utf8')
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
}

async function runScenario(
  name,
  {
    turns = TURNS,
    mcp = false,
    doubleLoad = false,
    killMcpAtTurn,
    restartMcpAtTurn,
    touchPluginAtTurn,
    touchConfigAtTurn,
    multiSession = false,
    probeOnly = false,
  } = {},
) {
  const sandbox = makeSandbox(name)
  writeFileSync(sandbox.targetFile, 'P0-4 CATALOG TARGET\n')
  if (mcp) writeFileSync(sandbox.mcpServerFile, MCP_SOURCE)

  const scripts = []
  for (let turn = 0; turn < turns; turn += 1) {
    scripts.push(CATALOG_SCRIPT)
    scripts.push(READ_SCRIPT(sandbox))
  }
  const model = await startMockModel(scripts)
  const pluginDirs = probeOnly
    ? ['./.opencode/plugins/probe']
    : ['./.opencode/plugins/real', './.opencode/plugins/probe']
  if (doubleLoad) pluginDirs.push('./.opencode/double-0')
  writePluginTree(sandbox, { extraLoaders: doubleLoad ? [0] : [] })
  writeConfig(sandbox, model.baseURL, {
    pluginDirs,
    mcp: mcp
      ? {
          canary: {
            type: 'local',
            command: [
              process.execPath,
              sandbox.mcpServerFile,
              sandbox.mcpLogFile,
              sandbox.mcpPidFile,
            ],
            enabled: true,
          },
        }
      : undefined,
  })

  const host = await startHost(sandbox)
  const observation = {
    scenario: name,
    host: spawnSync(BIN, ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? '',
    turns,
    mcp,
    doubleLoad,
    mcpStatus: [],
    turnsEvidence: [],
    codeMode: [],
    errors: [],
  }
  try {
    observation.hostConfig = await host
      .request('GET', '/api/config')
      .catch((error) => ({ error: String(error) }))
    observation.mcpAtStart = await host.mcpStatus()
    if (mcp) {
      observation.mcpStatus.push(
        await waitFor(
          async () => {
            const status = await host.mcpStatus()
            const rows = Array.isArray(status?.data) ? status.data : []
            return rows.length > 0 && rows.every((row) => row?.status?.status !== 'pending')
              ? status
              : null
          },
          20000,
          'MCP server to settle',
        ).catch((error) => ({ error: String(error) })),
      )
    }

    if (multiSession) {
      // Root session: two turns.
      const capture = async (label) =>
        observation.codeMode.push({ label, result: lastCodeModeResult(await host.transcript()) })
      await host.prompt('root turn 1')
      await capture('root1')
      await host.prompt('root turn 2')
      await capture('root2')
      // A second session in the SAME host: its first turn is a first turn too.
      const sessionB = await host.newSession('catalog-session-b')
      await host.promptOn(sessionB, 'session B turn 1')
      await capture('b1')
      await host.promptOn(sessionB, 'session B turn 2')
      await capture('b2')
      const sessionC = await host.newSession('catalog-session-c')
      await host.promptOn(sessionC, 'session C turn 1')
      await capture('c1')
      await host.prompt('root turn 3')
      await capture('root3')
      observation.errors.push({ event: 'multi-session', sessionB, sessionC })
    } else {
      for (let turn = 0; turn < turns; turn += 1) {
        if (killMcpAtTurn !== undefined && turn === killMcpAtTurn) {
          const pidText = existsSync(sandbox.mcpPidFile)
            ? readFileSync(sandbox.mcpPidFile, 'utf8').trim()
            : ''
          const killed = pidText
            ? spawnSync('kill', ['-9', pidText], { encoding: 'utf8' })
            : { status: 'no-pid' }
          observation.errors.push({
            event: 'mcp-kill',
            turn,
            pidText,
            status: killed.status ?? null,
            stderr: killed.stderr,
          })
        }
        if (restartMcpAtTurn !== undefined && turn === restartMcpAtTurn) {
          // A supervisor restarting a crashed MCP server: same argv, new process.
          const child = spawn(
            process.execPath,
            [sandbox.mcpServerFile, sandbox.mcpLogFile, sandbox.mcpPidFile],
            {
              stdio: 'ignore',
              detached: false,
            },
          )
          observation.errors.push({ event: 'mcp-restart', turn, pid: child.pid })
        }
        if (touchConfigAtTurn !== undefined && turn === touchConfigAtTurn) {
          // Same bytes, new mtime: this is a config-file write with no semantic
          // change, the shape a concurrent installer/agent would produce.
          const path = join(sandbox.projectDir, 'opencode.json')
          const bytes = readFileSync(path, 'utf8')
          writeFileSync(path, bytes)
          observation.errors.push({ event: 'config-touch', turn })
        }
        if (touchPluginAtTurn !== undefined && turn === touchPluginAtTurn) {
          // The host watches plugin files and reloads on change. Appending a
          // comment is the smallest possible change that triggers the watcher.
          appendFileSync(
            join(sandbox.projectDir, '.opencode', 'plugins', 'probe', 'index.ts'),
            '\n// touch\n',
          )
          observation.errors.push({ event: 'plugin-touch', turn })
        }
        await host.prompt(`catalog turn ${turn + 1}`)
        observation.codeMode.push({
          turn: turn + 1,
          result: lastCodeModeResult(await host.transcript()),
        })
        if (mcp) {
          observation.mcpStatus.push(await host.mcpStatus())
        }
      }
    }
  } catch (error) {
    observation.errors.push({
      event: 'run',
      error: String(error?.message ?? error),
      stderr: host.stderr().slice(-1200),
    })
  } finally {
    // Read the registry rows before the host dies.
    observation.registryRows = readCatalogRows(sandbox)
    try {
      observation.transcript = await host.transcript()
    } catch {}
    host.stop()
    model.close()
  }

  observation.modelRequests = model.requests()
  // Group host->model requests into turns: every prompt produces a tool-call
  // request plus a closing request. Report the catalog per request in order.
  const mcpRows = observation.mcpStatus.map((row) => {
    const rows = Array.isArray(row?.data) ? row.data : []
    return rows.map((server) => ({
      name: server?.name ?? server?.id,
      status: server?.status?.status ?? server?.status,
      toolCount: Array.isArray(server?.tools) ? server.tools.length : undefined,
      keys: Object.keys(server ?? {}).sort(),
    }))
  })
  observation.mcpCatalog = mcpRows
  observation.sandboxRoot = sandbox.root
  return observation
}

/** Turn-level catalog matrix: one row per host->model request + registry row. */
function summarize(observation) {
  const requests = observation.modelRequests.map((row, index) => ({
    request: index + 1,
    turn: Math.floor(index / 2) + 1,
    phase: index % 2 === 0 ? 'tool-call' : 'closing',
    count: row.toolCount,
    hash: row.toolHash,
    messageCount: row.messageCount,
    names: row.toolNames,
  }))
  const registry = (observation.registryRows ?? [])
    .filter((row) => row.event === 'execute.before' || row.event === 'execute.after')
    .map((row, index) => ({
      sample: index + 1,
      phase: row.event === 'execute.before' ? 'before' : 'after',
      moduleId: row.moduleId,
      setupCalls: row.setupCalls,
      count: Array.isArray(row.names) ? row.names.length : null,
      hash: Array.isArray(row.names) ? hashNames(row.names) : null,
      names: Array.isArray(row.names) ? canonical(row.names) : null,
      error: typeof row.names === 'string' ? row.names : null,
    }))
  const setupListRows = (observation.registryRows ?? []).filter((row) => row.event === 'setup.list')
  const setupListCount = Array.isArray(setupListRows[0]?.names)
    ? setupListRows[0].names.length
    : null
  const setups = (observation.registryRows ?? [])
    .filter((row) => row.event === 'setup.list')
    .map((row) => ({ moduleId: row.moduleId, setupCalls: row.setupCalls }))
  const codeMode = (observation.codeMode ?? []).map((row) => ({
    label: row.label ?? `turn ${row.turn}`,
    namespaceCount: Array.isArray(row.result?.namespaces) ? row.result.namespaces.length : null,
    namespaces: row.result?.namespaces ?? null,
    searchCount: row.result?.searchCount ?? null,
    searchRemaining: row.result?.searchRemaining ?? null,
    searchHash: Array.isArray(row.result?.searchPaths) ? hashNames(row.result.searchPaths) : null,
    // The COMPLETE Code Mode catalog: the default `search()` is capped at 10
    // items with `remaining`, which is the "partial" reading P0-4 must not
    // mistake for a lost tool. `limit: 50` returns all 14 with `remaining: 0`.
    fullCatalogCount: row.result?.searchLimit50?.count ?? null,
    fullCatalogHash: Array.isArray(row.result?.searchLimit50?.paths)
      ? hashNames(row.result.searchLimit50.paths)
      : null,
    defaultLimitCount: row.result?.searchCount ?? null,
    defaultLimitRemaining: row.result?.searchRemaining ?? null,
    error: row.result?.searchError ?? row.result?.keysError ?? row.result?.parseError ?? null,
  }))
  const distinctModelHashes = [...new Set(requests.map((row) => row.hash))]
  const distinctRegistryHashes = [...new Set(registry.map((row) => row.hash))]
  // The known first-turn artifact, measured separately from oscillation: the
  // registry grows once, inside the first turn, and must not change afterwards.
  const turnOneTransition =
    setupListCount !== null && registry[0]?.count != null
      ? registry[0].count - setupListCount
      : null
  const postFirstTurnHashes = [...new Set(registry.slice(1).map((row) => row.hash))]
  const distinctFullCatalogHashes = [...new Set(codeMode.map((row) => row.fullCatalogHash))]
  return {
    scenario: observation.scenario,
    host: observation.host,
    turns: observation.turns,
    setups,
    distinctModelHashes,
    distinctRegistryHashes,
    setupListCount,
    turnOneTransition,
    postFirstTurnHashes,
    stableAfterFirstTurn: postFirstTurnHashes.length <= 1,
    stableModelCatalog: distinctModelHashes.length <= 1,
    distinctFullCatalogHashes,
    stableFullCatalog: distinctFullCatalogHashes.length <= 1,
    codeMode,
    transitions: distinctModelHashes.length - 1,
    requests,
    registry,
    mcpCatalog: observation.mcpCatalog,
    errors: observation.errors,
  }
}

// ─── main ────────────────────────────────────────────────────────────────

const scenarios = []
if (ONLY === 'all' || ONLY === 'baseline') scenarios.push(['baseline', {}])
if (ONLY === 'probe-only')
  scenarios.push(['probe-only', { probeOnly: true, turns: Math.max(TURNS, 2) }])
if (ONLY === 'all' || ONLY === 'mcp')
  scenarios.push(['mcp', { mcp: true, turns: Math.max(TURNS, 6) }])
if (ONLY === 'all' || ONLY === 'mcp-kill')
  scenarios.push(['mcp-kill', { mcp: true, turns: Math.max(TURNS, 8), killMcpAtTurn: 3 }])
if (ONLY === 'mcp-restart')
  scenarios.push([
    'mcp-restart',
    { mcp: true, turns: Math.max(TURNS, 8), killMcpAtTurn: 2, restartMcpAtTurn: 4 },
  ])
if (ONLY === 'config-touch')
  scenarios.push(['config-touch', { mcp: true, turns: Math.max(TURNS, 8), touchConfigAtTurn: 3 }])
if (ONLY === 'multi-session') scenarios.push(['multi-session', { multiSession: true, turns: 6 }])
if (ONLY === 'plugin-touch')
  scenarios.push(['plugin-touch', { turns: Math.max(TURNS, 8), touchPluginAtTurn: 3 }])
if (ONLY === 'all' || ONLY === 'double-load')
  scenarios.push(['double-load', { doubleLoad: true, turns: Math.max(TURNS, 6) }])

if (spawnSync(BIN, ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.error(`opencode binary not found: ${BIN}`)
  process.exit(2)
}
mkdirSync(OUT_DIR, { recursive: true })
const before = snapshotRealConfig()
const report = { generatedAt: new Date().toISOString(), bin: BIN, turns: TURNS, results: [] }

for (const [name, options] of scenarios) {
  process.stderr.write(`\n=== scenario ${name} ===\n`)
  const observation = await runScenario(name, options)
  const summary = summarize(observation)
  report.results.push({ summary, sandbox: observation.sandboxRoot })
  writeFileSync(
    join(OUT_DIR, `${name}.json`),
    JSON.stringify({ summary, observation: { ...observation, transcript: undefined } }, null, 2),
  )
  process.stderr.write(
    `model hashes: ${JSON.stringify(summary.distinctModelHashes)} transitions=${summary.transitions}\n`,
  )
  process.stderr.write(
    `registry hashes: ${JSON.stringify(summary.distinctRegistryHashes)} setups=${JSON.stringify(summary.setups)}\n`,
  )
  process.stderr.write(
    `rows: ${JSON.stringify(summary.requests.map((r) => [r.request, r.count, r.hash]))}\n`,
  )
}

const after = snapshotRealConfig()
report.realConfigDiff = diffSnapshots(before, after)

// The regression gate. `mcp-kill` / `mcp-restart` deliberately shrink the
// catalog and are evidence, not failures; every other scenario must hold one
// registry hash after the first turn and one model-facing hash throughout.
const forcedAsserts = new Set(
  (process.env.PANTHEON_CATALOG_ASSERT_SCENARIOS ?? '').split(',').filter(Boolean),
)
const regressions = []
for (const { summary } of report.results) {
  if (
    (summary.scenario === 'mcp-kill' || summary.scenario === 'mcp-restart') &&
    !forcedAsserts.has(summary.scenario)
  ) {
    continue
  }
  if (!summary.stableAfterFirstTurn) {
    regressions.push(
      `${summary.scenario}: registry catalog changed after the first turn (${summary.postFirstTurnHashes.join(', ')})`,
    )
  }
  if (!summary.stableModelCatalog) {
    regressions.push(
      `${summary.scenario}: model-facing tool list changed across turns (${summary.distinctModelHashes.join(', ')})`,
    )
  }
  if (!summary.stableFullCatalog) {
    regressions.push(
      `${summary.scenario}: complete Code Mode catalog changed across turns (${summary.distinctFullCatalogHashes.join(', ')})`,
    )
  }
}
report.regressions = regressions
writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2))
console.log(
  JSON.stringify({
    out: OUT_DIR,
    scenarios: report.results.map((r) => r.summary.scenario),
    regressions,
    realConfigDiff: report.realConfigDiff,
  }),
)
if (regressions.length > 0) {
  console.error(regressions.join('\n'))
  process.exitCode = 1
}
