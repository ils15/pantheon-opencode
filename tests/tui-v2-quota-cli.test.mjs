import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const cliPath = join(process.cwd(), 'src/plugins/tui/dist/quota-cli.js')
const adaptersPath = join(process.cwd(), 'src/plugins/tui/dist/quota-adapters.js')
const { parseAlibabaTokenPlanPercentage, queryAlibabaTokenPlanUsage } = await import(
  pathToFileURL(cliPath).href
)
const { QUOTA_PROVIDER_CATALOG, runQuotaAdapter } = await import(pathToFileURL(adaptersPath).href)
const SECRET_SENTINEL = 'quota-cli-secret-sentinel'
const TRUSTED_EXECUTABLE_ENV = 'PANTHEON_TRUSTED_BL_EXECUTABLE'

async function createTrustedCliFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pantheon-trusted-bl-'))
  const binDirectory = join(root, 'bin')
  await mkdir(binDirectory)
  const executable = join(binDirectory, 'bl')
  await writeFile(executable, '')
  await chmod(executable, 0o555)
  await chmod(binDirectory, 0o555)
  await chmod(root, 0o555)
  t.after(async () => {
    await chmod(root, 0o755)
    await chmod(binDirectory, 0o755)
    await rm(root, { recursive: true, force: true })
  })
  return { root, binDirectory, executable }
}

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killedWith = []
  child.kill = (signal) => {
    child.killedWith.push(signal)
    queueMicrotask(() => child.emit('close', null, signal))
    return true
  }
  return child
}

test('Alibaba Token Plan CLI accepts only the documented monthly fraction', () => {
  assert.equal(parseAlibabaTokenPlanPercentage('{"per1MonthPercentage":0.25}'), 0.25)
  for (const output of [
    '{}',
    '{"per1MonthPercentage":1.01}',
    '{"per1MonthPercentage":-0.01}',
    '{"per1MonthPercentage":"0.25"}',
    '{"per1MonthPercentage":0.25,"accessToken":"secret"}',
    '{not-json}',
  ]) {
    assert.equal(parseAlibabaTokenPlanPercentage(output), undefined)
  }
})

test('Alibaba Token Plan uses only its CLI source and keeps quota as a percentage', async (t) => {
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('local CLI adapter must not make a direct request')
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const provider = QUOTA_PROVIDER_CATALOG['alibaba-token-plan']
  assert.equal(provider.source, 'local-cli')
  assert.deepEqual(provider.methods, ['cli'])
  const result = await runQuotaAdapter(
    'alibaba-token-plan',
    undefined,
    new AbortController().signal,
    async () => ({ percentage: 0.4 }),
  )
  assert.deepEqual(result, {
    state: 'available',
    metrics: [
      {
        kind: 'provider_quota',
        used: 40,
        remaining: 60,
        unit: '%',
        label: 'Monthly token-plan quota',
        period: 'month',
      },
    ],
  })
  assert.equal(fetchCalls, 0)
})

test('Alibaba CLI execution is fixed, bounded, and strips credential-like environment values', async (t) => {
  const fixture = await createTrustedCliFixture(t)
  let invocation
  const child = fakeChild()
  const resultPromise = queryAlibabaTokenPlanUsage(
    new AbortController().signal,
    (command, args, options) => {
      invocation = { command, args, options }
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('{"per1MonthPercentage":0.75}'))
        child.stderr.emit('data', Buffer.from(SECRET_SENTINEL))
        child.emit('close', 0, null)
      })
      return child
    },
    {
      HOME: '/tmp/quota-cli-home',
      LANG: 'en_US.UTF-8',
      PATH: '/untrusted/bin',
      [TRUSTED_EXECUTABLE_ENV]: fixture.executable,
      BAILIAN_ACCESS_TOKEN: SECRET_SENTINEL,
      ANTHROPIC_API_KEY: SECRET_SENTINEL,
    },
  )

  const result = await resultPromise
  assert.deepEqual(result, { percentage: 0.75 })
  assert.equal(invocation.command, fixture.executable)
  assert.deepEqual(invocation.args, ['usage', 'token-plan', '--output', 'json'])
  assert.equal(invocation.options.shell, false)
  assert.equal(invocation.options.cwd, '/tmp/quota-cli-home')
  assert.deepEqual(invocation.options.env, {
    HOME: '/tmp/quota-cli-home',
    LANG: 'en_US.UTF-8',
  })
  assert.equal(JSON.stringify(result).includes(SECRET_SENTINEL), false)
})

test('Alibaba CLI fails closed without a trusted absolute executable path', async (t) => {
  const fixture = await createTrustedCliFixture(t)
  for (const environment of [
    { PATH: '/untrusted/bin', HOME: '/tmp/quota-cli-home' },
    {
      PATH: '/untrusted/bin',
      HOME: '/tmp/quota-cli-home',
      PANTHEON_TRUSTED_BL_EXECUTABLE: 'bl',
    },
    {
      PATH: '/untrusted/bin',
      HOME: '/tmp/quota-cli-home',
      [TRUSTED_EXECUTABLE_ENV]: '/opt/bailian/bin/not-bl',
    },
    {
      PATH: '/untrusted/bin',
      HOME: '/tmp/quota-cli-home',
      [TRUSTED_EXECUTABLE_ENV]: join(fixture.root, 'missing', 'bl'),
    },
  ]) {
    let spawnCount = 0
    const result = await queryAlibabaTokenPlanUsage(
      new AbortController().signal,
      () => {
        spawnCount += 1
        throw new Error('must not spawn without trusted setup')
      },
      environment,
    )
    assert.deepEqual(result, { reason: 'cli_identity_unavailable' })
    assert.equal(spawnCount, 0)
  }
})

test('Alibaba CLI rejects symlinks and writable executable or parent paths before spawning', async (t) => {
  const fixture = await createTrustedCliFixture(t)
  await chmod(fixture.root, 0o755)
  await chmod(fixture.binDirectory, 0o755)
  const realExecutable = join(fixture.binDirectory, 'bl-real')
  await rename(fixture.executable, realExecutable)
  await symlink(realExecutable, fixture.executable)
  await chmod(fixture.binDirectory, 0o555)
  await chmod(fixture.root, 0o555)

  const cases = [
    { path: fixture.executable, prepare: async () => {} },
    {
      path: fixture.executable,
      prepare: async () => chmod(fixture.executable, 0o755),
    },
    {
      path: fixture.executable,
      prepare: async () => chmod(fixture.executable, 0o444),
    },
    {
      path: fixture.executable,
      prepare: async () => chmod(fixture.binDirectory, 0o755),
    },
  ]
  for (const [index, { path, prepare }] of cases.entries()) {
    await prepare()
    let spawnCount = 0
    const result = await queryAlibabaTokenPlanUsage(
      new AbortController().signal,
      () => {
        spawnCount += 1
        throw new Error('must not spawn an untrusted executable')
      },
      {
        HOME: '/tmp/quota-cli-home',
        PATH: '/untrusted/bin',
        [TRUSTED_EXECUTABLE_ENV]: path,
      },
    )
    assert.deepEqual(result, { reason: 'cli_identity_unavailable' })
    assert.equal(spawnCount, 0)
    if (index === 0) {
      // Restore the regular fixture after the symlink case for the mode checks.
      await chmod(fixture.root, 0o755)
      await chmod(fixture.binDirectory, 0o755)
      await unlink(fixture.executable)
      await rename(realExecutable, fixture.executable)
      await chmod(fixture.binDirectory, 0o555)
      await chmod(fixture.root, 0o555)
    }
    await chmod(fixture.executable, 0o555)
    await chmod(fixture.binDirectory, 0o555)
  }

  await chmod(fixture.root, 0o755)
  await chmod(fixture.binDirectory, 0o755)
  await unlink(fixture.executable)
  await mkdir(fixture.executable, { mode: 0o555 })
  await chmod(fixture.executable, 0o555)
  await chmod(fixture.binDirectory, 0o555)
  await chmod(fixture.root, 0o555)
  let spawnCount = 0
  const directoryResult = await queryAlibabaTokenPlanUsage(
    new AbortController().signal,
    () => {
      spawnCount += 1
      throw new Error('must not spawn a directory as an executable')
    },
    {
      HOME: '/tmp/quota-cli-home',
      PATH: '/untrusted/bin',
      [TRUSTED_EXECUTABLE_ENV]: fixture.executable,
    },
  )
  assert.deepEqual(directoryResult, { reason: 'cli_identity_unavailable' })
  assert.equal(spawnCount, 0)
})

test('Alibaba CLI does not spawn if aborted while validating its pinned executable', async (t) => {
  const fixture = await createTrustedCliFixture(t)
  const controller = new AbortController()
  let spawnCount = 0
  const pending = queryAlibabaTokenPlanUsage(
    controller.signal,
    () => {
      spawnCount += 1
      throw new Error('must not spawn after abort')
    },
    {
      HOME: '/tmp/quota-cli-home',
      PATH: '/untrusted/bin',
      [TRUSTED_EXECUTABLE_ENV]: fixture.executable,
    },
  )
  controller.abort()
  assert.deepEqual(await pending, { reason: 'provider_error' })
  assert.equal(spawnCount, 0)
})

test('Alibaba CLI failure does not expose output and abort terminates the child', async (t) => {
  const fixture = await createTrustedCliFixture(t)
  const missing = await queryAlibabaTokenPlanUsage(
    new AbortController().signal,
    () => {
      const child = fakeChild()
      queueMicrotask(() =>
        child.emit('error', Object.assign(new Error(SECRET_SENTINEL), { code: 'ENOENT' })),
      )
      return child
    },
    {
      PATH: '/safe/bin',
      HOME: '/tmp/quota-cli-home',
      [TRUSTED_EXECUTABLE_ENV]: fixture.executable,
    },
  )
  assert.deepEqual(missing, { reason: 'cli_identity_unavailable' })
  assert.equal(JSON.stringify(missing).includes(SECRET_SENTINEL), false)

  const controller = new AbortController()
  const child = fakeChild()
  let resolveSpawned
  const spawned = new Promise((resolve) => {
    resolveSpawned = resolve
  })
  const pending = queryAlibabaTokenPlanUsage(
    controller.signal,
    () => {
      resolveSpawned()
      return child
    },
    {
      PATH: '/safe/bin',
      HOME: '/tmp/quota-cli-home',
      [TRUSTED_EXECUTABLE_ENV]: fixture.executable,
    },
  )
  await spawned
  controller.abort()
  const aborted = await pending
  assert.deepEqual(aborted, { reason: 'provider_error' })
  assert.deepEqual(child.killedWith, ['SIGTERM'])

  const oversizedChild = fakeChild()
  const oversized = await queryAlibabaTokenPlanUsage(
    new AbortController().signal,
    () => {
      queueMicrotask(() => oversizedChild.stdout.emit('data', Buffer.alloc(16 * 1024 + 1)))
      return oversizedChild
    },
    {
      PATH: '/safe/bin',
      HOME: '/tmp/quota-cli-home',
      [TRUSTED_EXECUTABLE_ENV]: fixture.executable,
    },
  )
  assert.deepEqual(oversized, { reason: 'provider_error' })
  assert.deepEqual(oversizedChild.killedWith, ['SIGTERM'])
})
