import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { createAstTools } from '../../src/pantheon/ast-tools.ts'
import { createV2ExecuteAfter } from '../../src/pantheon/execute-after.ts'
import {
  encodeLspMessage,
  getLspTcpPoolSize,
  parseLspMessages,
  parseLspTcpEndpoints,
  queryTcpLspDiagnostics,
  runPostEditDiagnostics,
  shutdownLspTcpPool,
} from '../../src/pantheon/lsp-diagnostics.ts'
import { createV2ToolDefinitions } from '../../src/pantheon/tools.ts'

test('LSP JSON-RPC framing encodes and decodes multiple Content-Length payloads', () => {
  const m1 = encodeLspMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  const m2 = encodeLspMessage({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: { diagnostics: [] },
  })
  const combined = Buffer.concat([Buffer.from(m1), Buffer.from(m2)])
  const decoded = parseLspMessages(combined)
  assert.equal(decoded.messages.length, 2)
  assert.equal((decoded.messages[0] as { id: number }).id, 1)
  assert.equal(
    (decoded.messages[1] as { method: string }).method,
    'textDocument/publishDiagnostics',
  )
  assert.equal(decoded.remainder.length, 0)
})

test('runPostEditDiagnostics surfaces TypeScript type diagnostics for edited files and skips clean ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-lsp-'))
  try {
    mkdirSync(join(dir, 'src'), { recursive: true })
    const broken = join(dir, 'src', 'broken.ts')
    writeFileSync(
      broken,
      ['export function add(a: number, b: number): number {', '  return a + "bad"', '}'].join('\n'),
    )
    const diag = await runPostEditDiagnostics(broken, { cwd: dir })
    assert.ok(diag, 'expected TS semantic diagnostic output')
    assert.match(diag, /\[LSP-Diagnostics\]/)
    assert.match(diag, /broken\.ts:2:/)

    const clean = join(dir, 'src', 'clean.ts')
    writeFileSync(clean, 'export function add(a: number, b: number): number { return a + b }\n')
    const cleanDiag = await runPostEditDiagnostics(clean, { cwd: dir })
    assert.equal(cleanDiag, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('execute.after wires LSP diagnostics after edits alongside editLint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-exec-after-lsp-'))
  try {
    const file = join(dir, 'sample.ts')
    writeFileSync(file, 'const x: number = "oops"\nexport default x\n')
    const after = createV2ExecuteAfter({ editLint: false })
    const event = {
      tool: 'write',
      sessionID: 'ses_test',
      id: 'call_1',
      status: 'completed',
      input: { filePath: file },
      result: { output: 'Wrote file.' },
    }
    await after(event)
    assert.match(event.result.output, /\[LSP-Diagnostics\]/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ast_search finds structural matches with metavariables and ast_rewrite rewrites cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-ast-'))
  try {
    mkdirSync(join(dir, 'src'), { recursive: true })
    const target = join(dir, 'src', 'legacy.ts')
    writeFileSync(
      target,
      [
        'export function loadUser(id: string) {',
        '  // console.log("ignored in comment")',
        '  console.log("loading", id)',
        '  console.log("done", id)',
        '}',
      ].join('\n'),
    )

    const tools = new Map(createAstTools(dir).map((t) => [t.name, t]))
    const search = tools.get('ast_search')
    const rewrite = tools.get('ast_rewrite')
    assert.ok(search && rewrite)

    const found = JSON.parse(
      (await search.execute({ pattern: 'console.log($$$ARGS)', path: 'src' }, { directory: dir }))
        .output,
    ) as {
      ok: boolean
      total: number
      matches: Array<{ line: number; captures: Record<string, string> }>
    }
    assert.equal(found.ok, true)
    assert.equal(found.total, 2, 'comments must not count as AST call matches')
    assert.equal(found.matches[0]?.line, 3)

    const preview = JSON.parse(
      (
        await rewrite.execute(
          {
            pattern: 'console.log($$$ARGS)',
            replacement: 'logger.debug($$$ARGS)',
            path: 'src',
            dryRun: true,
          },
          { directory: dir },
        )
      ).output,
    ) as { ok: boolean; replacements: number; dryRun: boolean }
    assert.equal(preview.ok, true)
    assert.equal(preview.replacements, 2)
    assert.equal(preview.dryRun, true)
    assert.match(readFileSync(target, 'utf8'), /console\.log\("loading"/)

    const applied = JSON.parse(
      (
        await rewrite.execute(
          {
            pattern: 'console.log($$$ARGS)',
            replacement: 'logger.debug($$$ARGS)',
            path: 'src',
            dryRun: false,
          },
          { directory: dir },
        )
      ).output,
    ) as { ok: boolean; replacements: number; filesModified: string[] }
    assert.equal(applied.ok, true)
    assert.equal(applied.replacements, 2)
    assert.equal(applied.filesModified.length, 1)
    const afterText = readFileSync(target, 'utf8')
    assert.match(afterText, /logger\.debug\("loading", id\)/)
    assert.match(afterText, /\/\/ console\.log\("ignored in comment"\)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ast_search and ast_rewrite are exposed via createV2ToolDefinitions', () => {
  const names = new Set(createV2ToolDefinitions().map((t) => t.name))
  assert.ok(names.has('ast_search'))
  assert.ok(names.has('ast_rewrite'))
})

test('multi-IDE TCP LSP proxy pool parses endpoints and reuses initialized socket across queries', async () => {
  const parsed = parseLspTcpEndpoints('typescript=127.0.0.1:4101,python=localhost:4102')
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0]?.language, 'typescript')
  assert.equal(parsed[1]?.port, 4102)

  let connections = 0
  let didOpenCount = 0
  let didChangeCount = 0
  const server = createServer((socket) => {
    connections += 1
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const decoded = parseLspMessages(buf)
      buf = Buffer.from(decoded.remainder)
      for (const raw of decoded.messages) {
        const msg = raw as {
          id?: number
          method?: string
          params?: { textDocument?: { uri?: string } }
        }
        if (msg.method === 'initialize') {
          socket.write(
            encodeLspMessage({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } }),
          )
        } else if (
          msg.method === 'textDocument/didOpen' ||
          msg.method === 'textDocument/didChange'
        ) {
          if (msg.method === 'textDocument/didOpen') didOpenCount += 1
          else didChangeCount += 1
          socket.write(
            encodeLspMessage({
              jsonrpc: '2.0',
              method: 'textDocument/publishDiagnostics',
              params: {
                uri: msg.params?.textDocument?.uri,
                diagnostics: [
                  {
                    severity: 1,
                    code: 'LSP99',
                    message: 'Pooled proxy type mismatch',
                    range: { start: { line: 0, character: 2 } },
                  },
                ],
              },
            }),
          )
        }
      }
    })
  })

  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
  const addr = server.address() as { port: number }
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-lsp-tcp-'))
  try {
    const file = join(dir, 'sample.ts')
    writeFileSync(file, 'const x: number = "bad"\n')

    const first = await queryTcpLspDiagnostics(file, {
      host: '127.0.0.1',
      port: addr.port,
      cwd: dir,
      timeoutMs: 2000,
    })
    assert.equal(first.length, 1)
    assert.equal(first[0]?.code, 'LSP99')
    assert.equal(getLspTcpPoolSize(), 1)

    const second = await runPostEditDiagnostics(file, {
      cwd: dir,
      tcpEndpoint: { host: '127.0.0.1', port: addr.port },
      timeoutMs: 2000,
    })
    assert.match(second ?? '', /Pooled proxy type mismatch/)
    assert.equal(connections, 1, 'pooled TCP LSP client must reuse the single initialized socket')
    assert.equal(didOpenCount, 1)
    assert.equal(didChangeCount, 1)
    assert.equal(pathToFileURL(file).href.startsWith('file://'), true)
  } finally {
    shutdownLspTcpPool()
    await new Promise<void>((res) => server.close(() => res()))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('execute.after resolves relative paths and ast_rewrite filesModified against options.cwd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-exec-after-cwd-'))
  try {
    mkdirSync(join(dir, 'src'), { recursive: true })
    const file = join(dir, 'src', 'broken.ts')
    writeFileSync(file, 'export const bad: number = "still_broken"\n')

    const handler = createV2ExecuteAfter({
      cwd: dir,
      editLint: false,
      editLsp: true,
    })

    const rewriteEvent = {
      tool: 'ast_rewrite',
      sessionID: 'ses_after',
      status: 'completed',
      input: { path: 'src', pattern: 'foo', replacement: 'bar' },
      result: {
        output: JSON.stringify({
          ok: true,
          filesModified: ['src/broken.ts'],
        }),
      },
    }
    await handler(rewriteEvent)
    assert.match(rewriteEvent.result.output, /\[LSP-Diagnostics\]/)

    const hashlineEvent = {
      tool: 'hashline_edit',
      sessionID: 'ses_after',
      status: 'completed',
      input: { file: 'src/broken.ts', edits: [] },
      result: { output: 'Applied 1 edit.' },
    }
    await handler(hashlineEvent)
    assert.match(hashlineEvent.result.output, /\[LSP-Diagnostics\]/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
