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
  const server = createServer((req, res) => {
    // Drain the request. Without this the socket stalls and the host's first
    // model call never completes — which surfaces as a 15 s timeout in
    // `before` with no other symptom.
    req.resume()
    req.on('end', () => {
      turn += 1
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
      const scripted = turn % 2 === 1 && index < scripts.length
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
                          name: 'execute',
                          arguments: JSON.stringify({ code: scripts[index] }),
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
    env: hostEnv(sandbox, { PANTHEON_TOOL_CANARY_PROOF: sandbox.proofFile }),
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
    async prompt(text) {
      await request('POST', `/api/session/${created.data.id}/prompt`, {
        text,
        model: { providerID: 'canary', id: 'canary-model' },
      })
      await request('POST', `/api/experimental/session/${created.data.id}/wait`)
    },
    async transcript() {
      return JSON.stringify(await request('GET', `/api/session/${created.data.id}/message`))
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
function writePlugins(sandbox, pluginSource) {
  writeFileSync(join(sandbox.projectDir, '.opencode', 'plugins', 'real', 'index.ts'), pluginSource)
  writeFileSync(
    join(sandbox.projectDir, '.opencode', 'plugins', 'probe', 'index.ts'),
    [
      "import { writeFileSync } from 'node:fs'",
      'export default {',
      "  id: 'pantheon-tool-canary-probe',",
      '  async setup(ctx) {',
      '    const proof = process.env.PANTHEON_TOOL_CANARY_PROOF',
      '    if (!proof) return',
      '    const kind = (value) => (value === undefined ? "absent" : typeof value)',
      '    const domains = {',
      '      contextKeys: Object.keys(ctx).sort(),',
      '      tool: {',
      '        transform: kind(ctx.tool && ctx.tool.transform),',
      '        hook: kind(ctx.tool && ctx.tool.hook),',
      '        list: kind(ctx.tool && ctx.tool.list),',
      '      },',
      '      event: { subscribe: kind(ctx.event && ctx.event.subscribe) },',
      '      permission: { hook: kind(ctx.permission && ctx.permission.hook) },',
      '      session: { hook: kind(ctx.session && ctx.session.hook) },',
      '      catalog: kind(ctx.catalog),',
      '    }',
      "    await ctx.tool.hook('execute.after', async () => {",
      '      let toolList',
      '      try {',
      '        toolList = await ctx.tool.list()',
      '      } catch (err) {',
      '        writeFileSync(proof, JSON.stringify({ domains, listError: String(err) }, null, 2))',
      '        return',
      '      }',
      '      writeFileSync(',
      '        proof,',
      '        JSON.stringify(',
      '          {',
      '            domains,',
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

function writeProjectConfig(sandbox, modelBaseURL) {
  writeFileSync(
    join(sandbox.projectDir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        // Each entry must be a DIRECTORY holding a real index.ts on 2.0.22.
        plugins: ['./.opencode/plugins/real', './.opencode/plugins/probe'],
        provider: {
          canary: {
            npm: '@ai-sdk/openai-compatible',
            name: 'canary',
            id: 'canary',
            options: { baseURL: modelBaseURL, apiKey: 'canary-key' },
            models: { 'canary-model': { name: 'canary-model', tool_call: true } },
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
 * Run the whole canary against one plugin source and return the observations.
 *
 * Three chat turns on one session — catalog, rejected call, accepted call — so
 * the target file can be observed between the two calls.
 */
async function runCanary(pluginSource) {
  const sandbox = makeSandbox()
  writeFileSync(sandbox.targetFile, TARGET_BODY)
  const scripts = [
    CATALOG_SCRIPT,
    badRefScript(sandbox.targetFile),
    goodRefScript(sandbox.targetFile),
  ]
  const model = await startMockModel(scripts)
  writePlugins(sandbox, pluginSource)
  writeProjectConfig(sandbox, model.baseURL)

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

    observation.transcript = await host.transcript()
    observation.turns = model.turns()
    observation.observation = existsSync(sandbox.proofFile)
      ? JSON.parse(readFileSync(sandbox.proofFile, 'utf8'))
      : null
  } finally {
    host.stop()
    model.close()
  }
  return observation
}

// ─── state ───────────────────────────────────────────────────────────────

let live = null
let mutant = null
let rootsBefore = null

before(async () => {
  rootsBefore = snapshotRealConfigRoots()
  if (skipped) return
  live = await runCanary(realPluginShim())
})

after(() => {
  for (const observation of [live, mutant]) {
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
  // One `execute` tool call plus one closing message per chat turn.
  assert.equal(live.turns, 6, `the mock model served ${live.turns} turns, expected 6`)
  assert.equal(
    executeTexts(live.transcript).length,
    3,
    'the transcript is not the 3 scripted calls',
  )
})

test('the host context exposes the four domains the plugin casts to reach', {
  skip: skipped,
}, () => {
  assert.ok(live.observation, `no probe dump was written: ${live.diagnose()}`)
  const { domains } = live.observation
  for (const key of ['tool', 'event', 'permission', 'session']) {
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
  assert.equal(domains.session.hook, 'function')
  // And the one the plugin has always claimed is host-absent really is absent.
  assert.equal(domains.catalog, 'absent')
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
