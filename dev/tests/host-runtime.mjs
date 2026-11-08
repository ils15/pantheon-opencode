import { fakeCompletionServer } from './shared/fake-completion-server.mjs'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runOfflineDecision } from './offline-decision.mjs'

const TEST_ROOT = dirname(fileURLToPath(import.meta.url))
const HOST_TIMEOUT_MS = 20_000
const FIXTURE_RESOURCE_URI = 'pickleball://fixture/serve-and-rally'

function fail(message) {
  process.stderr.write(`pickleball host harness: ${message}\n`)
  process.exitCode = 1
}

function parseEvidence(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}



async function closeServer(server) {
  if (!server.listening) return
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()))
  })
}

function waitForChild(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolveWait, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000)
      killTimer.unref?.()
      reject(new Error('host command timed out'))
    }, timeoutMs)
    timer.unref?.()
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolveWait({ code, signal })
    })
  })
}

function freePort() {
  const probe = createNetServer()
  return new Promise((resolvePort, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close((error) => (error ? reject(error) : resolvePort(port)))
    })
  })
}

async function startHost(bin, sandbox, evidencePath, mcpAuditPath, hostVersion) {
  const port = await freePort()
  const child = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: sandbox.project,
    env: privateHostEnvironment(sandbox, evidencePath, mcpAuditPath, hostVersion),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let password = ''
  let serverUrl = ''
  const observe = (chunk) => {
    output = `${output}${String(chunk)}`.slice(-16_000)
    password ||= /server password (\S+)/.exec(output)?.[1] ?? ''
    serverUrl ||= /server listening on (https?:\/\/\S+)/.exec(output)?.[1] ?? ''
  }
  child.stdout.on('data', observe)
  child.stderr.on('data', observe)

  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('host server startup timed out')), 10_000)
    timer.unref?.()
    const check = () => {
      if (password && serverUrl) {
        clearTimeout(timer)
        resolveReady()
      }
    }
    child.stdout.on('data', check)
    child.stderr.on('data', check)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', () => {
      clearTimeout(timer)
      reject(new Error('host server exited during startup'))
    })
    check()
  }).catch(async (error) => {
    child.kill('SIGKILL')
    await waitForChild(child, 1_000).catch(() => undefined)
    throw error
  })
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
  const request = async (method, path, body) => {
    const response = await fetch(new URL(path, serverUrl), {
      method,
      headers: {
        authorization,
        'x-opencode-directory': encodeURIComponent(sandbox.project),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`host API returned HTTP ${response.status}`)
    }
    const text = await response.text()
    return text ? JSON.parse(text) : undefined
  }

  return { child, request, serverUrl, port }
}

function privateHostEnvironment(sandbox, evidencePath, mcpAuditPath, hostVersion) {
  const pathValue = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'
  return {
    PATH: pathValue,
    HOME: sandbox.home,
    XDG_CONFIG_HOME: sandbox.configHome,
    XDG_DATA_HOME: sandbox.dataHome,
    XDG_STATE_HOME: sandbox.stateHome,
    XDG_CACHE_HOME: sandbox.cacheHome,
    TMPDIR: sandbox.root,
    PICKLEBALL_EVIDENCE_PATH: evidencePath,
    PICKLEBALL_MCP_AUDIT_PATH: mcpAuditPath,
    PICKLEBALL_SKILL_PATH: sandbox.skillPath,
    PICKLEBALL_HOST_VERSION: hostVersion,
  }
}

function writeProject(sandbox, modelUrl) {
  const pluginDir = join(sandbox.project, '.opencode', 'plugins', 'pickleball-harness')
  const skillDir = join(sandbox.project, '.opencode', 'skills', 'pickleball-basics')
  mkdirSync(pluginDir, { recursive: true })
  mkdirSync(skillDir, { recursive: true })
  copyFileSync(join(TEST_ROOT, 'plugin', 'index.ts'), join(pluginDir, 'index.ts'))
  copyFileSync(join(TEST_ROOT, 'mcp-fixture.mjs'), join(sandbox.root, 'mcp-fixture.mjs'))
  sandbox.skillPath = join(skillDir, 'SKILL.md')
  writeFileSync(
    sandbox.skillPath,
    [
      '---',
      'name: pickleball-basics',
      'description: Synthetic local pickleball practice skill for host testing.',
      '---',
      '',
      'Synthetic practice note: serve deep and recover to a ready position.',
      '',
    ].join('\n'),
    { mode: 0o600 },
  )

  const config = {
    plugins: ['./.opencode/plugins/pickleball-harness'],
    mcp: {
      pickleball_fixture: {
        type: 'local',
        command: [process.execPath, join(sandbox.root, 'mcp-fixture.mjs')],
        enabled: true,
      },
    },
    provider: {
      'pickleball-stub': {
        npm: '@ai-sdk/openai-compatible',
        id: 'pickleball-stub',
        name: 'Local-only pickleball fixture model',
        options: { baseURL: modelUrl, apiKey: 'fixture-only-not-a-credential' },
        models: {
          'pickleball-local': {
            name: 'pickleball-local',
            tool_call: false,
            modalities: { input: ['text'], output: ['text'] },
          },
        },
      },
    },
    model: 'pickleball-stub/pickleball-local',
  }
  writeFileSync(join(sandbox.project, 'opencode.json'), JSON.stringify(config, null, 2), {
    mode: 0o600,
  })
}

async function main() {
  if (process.env.PICKLEBALL_EGRESS_ISOLATED !== '1') {
    fail('refusing host execution without the run-host-runtime.sh network-isolation wrapper')
    return
  }

  const bin = process.env.PICKLEBALL_OPENCODE_BIN
  if (!bin || !existsSync(bin)) {
    process.stdout.write(
      'SKIP host-runtime: OpenCode binary unavailable; offline tests remain separate.\n',
    )
    return
  }

  const versionProbe = spawnSync(bin, ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? tmpdir(),
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? tmpdir(),
      XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? tmpdir(),
      XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? tmpdir(),
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? tmpdir(),
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
    },
  })
  if (versionProbe.status !== 0) {
    fail(`could not read OpenCode host version (status=${versionProbe.status ?? 'unknown'})`)
    return
  }
  const hostVersion = `${versionProbe.stdout ?? ''}${versionProbe.stderr ?? ''}`.trim()

  const sandboxRoot = mkdtempSync(join(tmpdir(), 'pickleball-host-harness-'))
  const sandbox = {
    root: sandboxRoot,
    project: join(sandboxRoot, 'project'),
    home: join(sandboxRoot, 'home'),
    configHome: join(sandboxRoot, 'xdg-config'),
    dataHome: join(sandboxRoot, 'xdg-data'),
    stateHome: join(sandboxRoot, 'xdg-state'),
    cacheHome: join(sandboxRoot, 'xdg-cache'),
  }
  for (const directory of [
    sandbox.project,
    sandbox.home,
    sandbox.configHome,
    sandbox.dataHome,
    sandbox.stateHome,
    sandbox.cacheHome,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }

  const evidencePath = join(sandboxRoot, 'host-evidence.jsonl')
  const mcpAuditPath = join(sandboxRoot, 'mcp-methods.log')
  const model = await fakeCompletionServer()
  const address = model.address()
  assert.ok(address && typeof address === 'object')
  const modelUrl = `http://127.0.0.1:${address.port}/v1`

  let host
  try {
    writeProject(sandbox, modelUrl)
    host = await startHost(bin, sandbox, evidencePath, mcpAuditPath, hostVersion)
    const createStarted = process.hrtime.bigint()
    const session = await host.request('POST', '/api/session', {
      title: 'pickleball-host-harness',
      model: { providerID: 'pickleball-stub', id: 'pickleball-local' },
    })
    const createEvidence = {
      hostVersion,
      operation: 'session.create',
      mode: 'host',
      durationMs: Number(process.hrtime.bigint() - createStarted) / 1_000_000,
      status: 'pass',
    }
    const sessionID = session?.data?.id
    if (typeof sessionID !== 'string') throw new Error('host did not create a session')
    const promptStarted = process.hrtime.bigint()
    await host.request('POST', `/api/session/${encodeURIComponent(sessionID)}/prompt`, {
      text: 'Use the local development fixture and reply READY only.',
    })
    await host.request(
      'POST',
      `/api/experimental/session/${encodeURIComponent(sessionID)}/wait`,
      {},
    )
    const promptEvidence = {
      hostVersion,
      operation: 'session.prompt',
      mode: 'stub/offline',
      durationMs: Number(process.hrtime.bigint() - promptStarted) / 1_000_000,
      status: model.requestCount() > 0 ? 'pass' : 'blocked',
      localStubRequests: model.requestCount(),
    }

    const mcpStarted = process.hrtime.bigint()
    let mcpEvidence
    try {
      const catalog = await host.request('GET', '/api/mcp/resource')
      const resources = Array.isArray(catalog?.data?.resources) ? catalog.data.resources : []
      const fixtureFound = resources.some((resource) => resource?.uri === FIXTURE_RESOURCE_URI)
      mcpEvidence = {
        hostVersion,
        operation: 'mcp.resources.catalog',
        mode: 'host',
        durationMs: Number(process.hrtime.bigint() - mcpStarted) / 1_000_000,
        status: fixtureFound ? 'pass' : 'blocked',
        fixtureFound,
        resourceCount: resources.length,
      }
    } catch (error) {
      mcpEvidence = {
        hostVersion,
        operation: 'mcp.resources.catalog',
        mode: 'host',
        durationMs: Number(process.hrtime.bigint() - mcpStarted) / 1_000_000,
        status: 'blocked',
        errorKind: error instanceof Error ? error.name : 'UnknownError',
      }
    }

    const evidence = parseEvidence(evidencePath)
    const methods = existsSync(mcpAuditPath)
      ? readFileSync(mcpAuditPath, 'utf8').split('\n').filter(Boolean)
      : []
    const offline = await runOfflineDecision(hostVersion)
    const allEvidence = [...evidence, createEvidence, promptEvidence, mcpEvidence, offline]

    process.stdout.write(
      `${JSON.stringify(
        {
          hostVersion,
          evidence: allEvidence,
          mcpMethods: methods,
          mcpResourceRead:
            'not exercised; supported host API exposes a resource catalog, not content reads',
        },
        null,
        2,
      )}\n`,
    )

    const skill = evidence.find((entry) => entry.operation === 'skills.list')
    const skillSeed = evidence.find((entry) => entry.operation === 'skills.registry.seed')
    const decisions = evidence.find((entry) => entry.operation === 'decisions.capability')
    if (skillSeed?.status !== 'pass' || skill?.status !== 'pass' || skill.fixtureFound !== true) {
      fail('real host ctx.skill.list did not find the synthetic skill')
    }
    if (mcpEvidence.status !== 'pass' || mcpEvidence.fixtureFound !== true) {
      fail('real host MCP resource listing did not find the synthetic fixture')
    }
    if (promptEvidence.status !== 'pass') {
      fail('host prompt did not use the configured local-only model stub')
    }
    if (!methods.includes('resources/list')) {
      fail('fixture MCP did not receive a resources/list request from the host')
    }
    if (decisions?.status === 'available' && decisions.invoked !== false) {
      fail('decision capability probe unexpectedly invoked native Jev')
    }
    if (offline.status !== 'pass' || offline.mode !== 'stub/offline') {
      fail('offline typed-decision fixture failed')
    }
  } finally {
    if (host?.child && host.child.exitCode === null && host.child.signalCode === null) {
      host.child.kill('SIGTERM')
      try {
        await waitForChild(host.child, 2_000)
      } catch {
        host.child.kill('SIGKILL')
        await new Promise((resolveExit) => host.child.once('exit', resolveExit))
      }
    }
    await closeServer(model)
    rmSync(sandboxRoot, { recursive: true, force: true })
  }
}

await main().catch((error) => {
  // Do not print host output or operation payloads: diagnostics stay metadata-only.
  fail(error instanceof Error ? `${error.name}: harness setup or cleanup failed` : 'harness failed')
})
