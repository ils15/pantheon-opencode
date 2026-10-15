import { strict as assert } from 'node:assert'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BOUNDED_READ_MAX_BYTES,
  BOUNDED_READ_MAX_CALLS,
  BOUNDED_READ_MAX_FILES,
  BOUNDED_READ_MAX_LINES,
  BOUNDED_READ_TOOL,
  createV2BoundedReadTool,
} from '../../src/pantheon/v2-bounded-read.ts'

interface Scope {
  root: string
  project: string
  realProject: string
  tool: ReturnType<typeof createV2BoundedReadTool>
  requests: Array<Record<string, unknown>>
  permissionAllowed: boolean
  sessionResult: Record<string, unknown>
  scans: string[]
}

function makeScope(): Scope {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-v2-bounded-read-'))
  const project = join(root, 'project')
  mkdirSync(project)
  const requests: Array<Record<string, unknown>> = []
  const scans: string[] = []
  const scope = {
    root,
    project,
    realProject: realpathSync(project),
    requests,
    permissionAllowed: true,
    sessionResult: { id: 'ses_root', projectID: 'project-1' },
    scans,
    tool: undefined as unknown as Scope['tool'],
  }
  scope.tool = createV2BoundedReadTool({
    rootDirectory: scope.realProject,
    projectID: 'project-1',
    async getSession(sessionID) {
      return { ...scope.sessionResult, id: sessionID }
    },
    async assertPermission(request) {
      requests.push(request)
      if (!scope.permissionAllowed) throw new Error('permission denied')
    },
    async scanContent({ content }) {
      scans.push(content)
      return 'allow'
    },
  })
  return scope
}

function invoke(
  scope: Scope,
  name: string,
  args: Record<string, unknown>,
  identity: Record<string, unknown> = {},
) {
  const toolContext = {
    sessionID: 'ses_root',
    messageID: 'msg-1',
    id: `call-${name}`,
    agent: 'zeus',
    ...identity,
  }
  scope.tool.origins.capture({
    tool: BOUNDED_READ_TOOL,
    sessionID: toolContext.sessionID,
    messageID: toolContext.messageID,
    id: toolContext.id,
    agent: toolContext.agent,
    input: args,
  })
  return scope.tool.definition.execute(args, toolContext)
}

function readResult(result: { output: string }) {
  return JSON.parse(result.output) as {
    path: string
    offset: number
    linesRead: number
    bytes: number
    status: 'empty' | 'ok'
    content: string
  }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`✓ ${name}`)
  } catch (error) {
    console.error(`✗ ${name}: ${error instanceof Error ? error.stack : String(error)}`)
    process.exitCode = 1
  }
}

async function main(): Promise<void> {
  assert.equal(BOUNDED_READ_MAX_CALLS, 2)
  assert.equal(BOUNDED_READ_MAX_FILES, 2)
  assert.equal(BOUNDED_READ_MAX_LINES, 400)
  assert.equal(BOUNDED_READ_MAX_BYTES, 32 * 1024)

  await testAsync('returns only the requested lines after native permission approval', async () => {
    const scope = makeScope()
    try {
      writeFileSync(join(scope.project, 'notes.md'), 'one\ntwo\nthree\nfour\n')
      const result = await invoke(scope, 'window', { path: 'notes.md', offset: 2, limit: 2 })
      const parsed = readResult(result)
      assert.equal(parsed.content, 'two\nthree\n')
      assert.equal(parsed.linesRead, 2)
      assert.equal(parsed.bytes, Buffer.byteLength(parsed.content))
      assert.equal(parsed.status, 'ok')
      assert.equal(scope.requests.length, 1)
      assert.equal(scope.requests[0]?.action, 'read')
      assert.deepEqual(scope.requests[0]?.resources, [join(scope.realProject, 'notes.md')])
      assert.deepEqual(scope.requests[0]?.save, [])
      assert.deepEqual(scope.requests[0]?.source, {
        type: 'tool',
        messageID: 'msg-1',
        id: 'call-window',
      })
      assert.deepEqual(scope.scans, ['two\nthree\n'])
    } finally {
      rmSync(scope.root, { recursive: true, force: true })
    }
  })

  await testAsync(
    'an empty file is reported as empty rather than as an output-limit result',
    async () => {
      const scope = makeScope()
      try {
        writeFileSync(join(scope.project, 'empty.txt'), '')
        const result = await invoke(scope, 'empty', { path: 'empty.txt', offset: 1, limit: 20 })
        assert.deepEqual(readResult(result), {
          path: 'empty.txt',
          offset: 1,
          linesRead: 0,
          bytes: 0,
          status: 'empty',
          content: '',
        })
      } finally {
        rmSync(scope.root, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'requires a fresh host origin and an authoritative root Zeus session',
    async () => {
      const scope = makeScope()
      try {
        writeFileSync(join(scope.project, 'notes.md'), 'safe\n')
        const noOrigin = await scope.tool.definition.execute(
          { path: 'notes.md', offset: 1, limit: 1 },
          { sessionID: 'ses_root', messageID: 'msg-1', id: 'missing', agent: 'zeus' },
        )
        assert.equal(noOrigin.output, 'BOUND_READ_UNAUTHORIZED')
        assert.equal(scope.requests.length, 0)

        scope.sessionResult = { id: 'ses_root', projectID: 'project-1', parentID: null }
        const childOrigin = await invoke(scope, 'child', { path: 'notes.md', offset: 1, limit: 1 })
        assert.equal(childOrigin.output, 'BOUND_READ_UNAUTHORIZED')
        assert.equal(scope.requests.length, 0)

        scope.sessionResult = { id: 'ses_root', projectID: 'other-project' }
        const wrongProject = await invoke(scope, 'project', {
          path: 'notes.md',
          offset: 1,
          limit: 1,
        })
        assert.equal(wrongProject.output, 'BOUND_READ_UNAUTHORIZED')
        assert.equal(scope.requests.length, 0)
      } finally {
        rmSync(scope.root, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'rejects wrong agent and mismatched invocation path before permission or file access',
    async () => {
      const scope = makeScope()
      try {
        writeFileSync(join(scope.project, 'notes.md'), 'safe\n')
        const wrongAgent = await invoke(
          scope,
          'wrong-agent',
          { path: 'notes.md', offset: 1, limit: 1 },
          { agent: 'talos' },
        )
        assert.equal(wrongAgent.output, 'BOUND_READ_UNAUTHORIZED')
        assert.equal(scope.requests.length, 0)

        scope.tool.origins.capture({
          tool: BOUNDED_READ_TOOL,
          sessionID: 'ses_root',
          messageID: 'msg-1',
          id: 'mismatch',
          agent: 'zeus',
          input: { path: 'notes.md', offset: 1, limit: 1 },
        })
        const mismatch = await scope.tool.definition.execute(
          { path: 'other.md', offset: 1, limit: 1 },
          { sessionID: 'ses_root', messageID: 'msg-1', id: 'mismatch', agent: 'zeus' },
        )
        assert.equal(mismatch.output, 'BOUND_READ_UNAUTHORIZED')
        assert.equal(scope.requests.length, 0)
      } finally {
        rmSync(scope.root, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'rejects absolute, traversal, URI, wildcard, malformed, and extra arguments',
    async () => {
      const scope = makeScope()
      try {
        for (const filePath of [
          '/etc/passwd',
          '../outside.md',
          'a/../outside.md',
          'file:///etc/passwd',
          'folder/*.md',
          'folder\\secret.md',
          'C:/outside.md',
          'folder//file.md',
        ]) {
          const result = await invoke(scope, filePath, { path: filePath, offset: 1, limit: 1 })
          assert.equal(result.output, 'ARGUMENT_INVALID', filePath)
        }
        assert.equal(
          (await invoke(scope, 'bad-offset', { path: 'ok.md', offset: 0, limit: 1 })).output,
          'ARGUMENT_INVALID',
        )
        assert.equal(
          (await invoke(scope, 'bad-limit', { path: 'ok.md', offset: 1, limit: 401 })).output,
          'ARGUMENT_INVALID',
        )
        assert.equal(
          (
            await invoke(scope, 'extra', {
              path: 'ok.md',
              offset: 1,
              limit: 1,
              encoding: 'base64',
            })
          ).output,
          'ARGUMENT_INVALID',
        )
        assert.equal(scope.requests.length, 0)
      } finally {
        rmSync(scope.root, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'denies symlinks, directories, sensitive paths, images, PDFs, and binary content',
    async () => {
      const scope = makeScope()
      try {
        writeFileSync(join(scope.project, 'notes.md'), 'safe\n')
        writeFileSync(join(scope.project, 'image.png'), 'not actually an image')
        writeFileSync(join(scope.project, 'private.env.local'), 'hidden')
        writeFileSync(join(scope.project, 'binary.txt'), Buffer.from([0x61, 0x00, 0x62]))
        mkdirSync(join(scope.project, 'folder'))
        symlinkSync(join(scope.project, 'notes.md'), join(scope.project, 'linked.md'))
        assert.equal(lstatSync(join(scope.project, 'linked.md')).isSymbolicLink(), true)
        for (const filePath of [
          'folder',
          'linked.md',
          'private.env.local',
          'image.png',
          'manual.pdf',
          'binary.txt',
          '.git/config',
        ]) {
          const result = await invoke(scope, filePath, { path: filePath, offset: 1, limit: 1 })
          assert.ok(
            ['PATH_DENIED', 'TOOL_DENIED'].includes(result.output),
            `${filePath}: ${result.output}`,
          )
          assert.equal(result.output.includes('hidden'), false)
          scope.tool.clearSession('ses_root')
        }
      } finally {
        rmSync(scope.root, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'denies auth, data, schema, database, migration, and global scopes before permission or I/O',
    async () => {
      const scope = makeScope()
      try {
        const paths = [
          'auth/session.md',
          'src/auth-client.ts',
          'data/prod.csv',
          'dataset/export.json',
          'database/seed.md',
          'schema/models.md',
          'migrations/001.sql',
          'global/AGENTS.md',
          'runtime-global-config.md',
          'app.wasm',
        ]
        for (const filePath of paths) {
          const result = await invoke(scope, filePath, {
            path: filePath,
            offset: 1,
            limit: 1,
          })
          assert.equal(result.output, 'PATH_DENIED', filePath)
          assert.equal(scope.requests.length, 0, filePath)
          scope.tool.clearSession('ses_root')
        }
      } finally {
        rmSync(scope.root, { recursive: true, force: true })
      }
    },
  )

  await testAsync('rejects malformed UTF-8 before the selected line window', async () => {
    const scope = makeScope()
    try {
      writeFileSync(
        join(scope.project, 'binary-prefix.txt'),
        Buffer.from([0xff, 0x0a, 0x73, 0x61, 0x66, 0x65]),
      )
      const result = await invoke(scope, 'binary-prefix', {
        path: 'binary-prefix.txt',
        offset: 2,
        limit: 1,
      })
      assert.equal(result.output, 'PATH_DENIED')
      assert.equal(scope.scans.length, 0)
    } finally {
      rmSync(scope.root, { recursive: true, force: true })
    }
  })

  await testAsync(
    'permission denial consumes its reservation and returns no file content',
    async () => {
      const scope = makeScope()
      try {
        writeFileSync(join(scope.project, 'notes.md'), 'private line\n')
        scope.permissionAllowed = false
        const denied = await invoke(scope, 'denied', { path: 'notes.md', offset: 1, limit: 1 })
        assert.equal(denied.output, 'TOOL_DENIED')
        assert.deepEqual(scope.scans, [])
        assert.equal(scope.requests.length, 1)
        scope.permissionAllowed = true
        const retry = await invoke(scope, 'retry', { path: 'notes.md', offset: 1, limit: 1 })
        assert.equal(retry.output, 'SCOPE_DENIED')
        assert.equal(scope.requests.length, 1)
      } finally {
        rmSync(scope.root, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'a line window larger than its byte reservation is rejected without partial output',
    async () => {
      const scope = makeScope()
      try {
        writeFileSync(
          join(scope.project, 'large-line.txt'),
          `${'x'.repeat(BOUNDED_READ_MAX_BYTES)}\n`,
        )
        const result = await invoke(scope, 'large-line', {
          path: 'large-line.txt',
          offset: 1,
          limit: 1,
        })
        assert.equal(result.output, 'BUDGET_EXCEEDED')
        assert.equal(scope.scans.length, 0)
        assert.equal(scope.requests.length, 1)
      } finally {
        rmSync(scope.root, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'enforces two distinct files, two calls, 400 reserved lines, and 32 KiB before further reads',
    async () => {
      const scope = makeScope()
      try {
        writeFileSync(join(scope.project, 'one.md'), 'one\n')
        writeFileSync(join(scope.project, 'two.md'), 'two\n')
        writeFileSync(join(scope.project, 'three.md'), 'three\n')
        assert.equal(
          readResult(await invoke(scope, 'first', { path: 'one.md', offset: 1, limit: 250 }))
            .content,
          'one\n',
        )
        assert.equal(
          readResult(await invoke(scope, 'second', { path: 'two.md', offset: 1, limit: 150 }))
            .content,
          'two\n',
        )
        assert.equal(
          (await invoke(scope, 'third', { path: 'three.md', offset: 1, limit: 1 })).output,
          'BUDGET_EXCEEDED',
        )
        assert.equal(scope.requests.length, 2)
        assert.equal(scope.scans.length, 2)
        assert.equal(
          readResult(
            await invoke(
              scope,
              'fresh-turn',
              { path: 'three.md', offset: 1, limit: 1 },
              { messageID: 'msg-next' },
            ),
          ).content,
          'three\n',
        )
      } finally {
        rmSync(scope.root, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'reserves quotas synchronously under concurrent calls and forbids re-reading one file',
    async () => {
      const scope = makeScope()
      try {
        writeFileSync(join(scope.project, 'one.md'), 'one\n')
        writeFileSync(join(scope.project, 'two.md'), 'two\n')
        const [one, two] = await Promise.all([
          invoke(scope, 'concurrent-one', { path: 'one.md', offset: 1, limit: 201 }),
          invoke(scope, 'concurrent-two', { path: 'two.md', offset: 1, limit: 200 }),
        ])
        assert.ok(one.output.includes('BUDGET_EXCEEDED') || two.output.includes('BUDGET_EXCEEDED'))
        assert.equal(scope.requests.length, 1)

        scope.tool.clearSession('ses_root')
        const first = await invoke(scope, 'repeat-one', { path: 'one.md', offset: 1, limit: 1 })
        assert.equal(readResult(first).content, 'one\n')
        const repeat = await invoke(scope, 'repeat-two', { path: 'one.md', offset: 1, limit: 1 })
        assert.equal(repeat.output, 'SCOPE_DENIED')
      } finally {
        rmSync(scope.root, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'withholds scanner matches and scanner infrastructure failures fail closed',
    async () => {
      const scope = makeScope()
      try {
        writeFileSync(join(scope.project, 'notes.md'), 'line with a secret marker\n')
        scope.tool = createV2BoundedReadTool({
          rootDirectory: scope.realProject,
          projectID: 'project-1',
          async getSession(sessionID) {
            return { id: sessionID, projectID: 'project-1' }
          },
          async assertPermission() {},
          async scanContent({ content }) {
            scope.scans.push(content)
            return 'deny'
          },
        })
        const result = await invoke(scope, 'scanner-deny', {
          path: 'notes.md',
          offset: 1,
          limit: 1,
        })
        assert.equal(result.output, 'SCOPE_DENIED')
        assert.equal(result.output.includes('secret marker'), false)

        scope.tool = createV2BoundedReadTool({
          rootDirectory: scope.realProject,
          projectID: 'project-1',
          async getSession(sessionID) {
            return { id: sessionID, projectID: 'project-1' }
          },
          async assertPermission() {},
          async scanContent() {
            return 'unavailable'
          },
        })
        const unavailable = await invoke(scope, 'scanner-down', {
          path: 'notes.md',
          offset: 1,
          limit: 1,
        })
        assert.equal(unavailable.output, 'UNAVAILABLE')
      } finally {
        rmSync(scope.root, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'origin entries are one-shot, expire, and clear on session deletion',
    async () => {
      const scope = makeScope()
      try {
        const event = {
          tool: BOUNDED_READ_TOOL,
          sessionID: 'ses_root',
          messageID: 'msg-1',
          id: 'origin-1',
          agent: 'zeus',
          input: { path: 'notes.md' },
        }
        assert.ok(scope.tool.origins.capture(event, 100))
        assert.ok(
          scope.tool.origins.consume(
            {
              sessionID: 'ses_root',
              messageID: 'msg-1',
              callID: 'origin-1',
              agent: 'zeus',
              relativePath: 'notes.md',
            },
            101,
          ),
        )
        assert.equal(
          scope.tool.origins.consume(
            {
              sessionID: 'ses_root',
              messageID: 'msg-1',
              callID: 'origin-1',
              agent: 'zeus',
              relativePath: 'notes.md',
            },
            102,
          ),
          undefined,
        )
        assert.ok(scope.tool.origins.capture({ ...event, id: 'origin-2' }, 100))
        assert.equal(
          scope.tool.origins.consume(
            {
              sessionID: 'ses_root',
              messageID: 'msg-1',
              callID: 'origin-2',
              agent: 'zeus',
              relativePath: 'notes.md',
            },
            60_101,
          ),
          undefined,
        )
        assert.ok(scope.tool.origins.capture({ ...event, id: 'origin-3' }, 70_000))
        scope.tool.clearSession('ses_root')
        assert.equal(
          scope.tool.origins.consume(
            {
              sessionID: 'ses_root',
              messageID: 'msg-1',
              callID: 'origin-3',
              agent: 'zeus',
              relativePath: 'notes.md',
            },
            70_001,
          ),
          undefined,
        )
      } finally {
        rmSync(scope.root, { recursive: true, force: true })
      }
    },
  )
}

void main()
