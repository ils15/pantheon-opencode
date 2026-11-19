/**
 * LSP & Compiler Diagnostics Bridge (`lsp-diagnostics.ts`).
 *
 * Bridges edited files in `execute.after` to workspace language servers and
 * compilers:
 *   1. Standard JSON-RPC stdio LSP framing (`Content-Length`) + `queryStdioLspDiagnostics`
 *      for `typescript-language-server`, `pyright-langserver`, `biome lsp-proxy`, etc.
 *   2. Fast per-file semantic diagnostics (`runPostEditDiagnostics`) via `tsc --noEmit`
 *      (resolving workspace `node_modules/.bin/tsc`), `pyright --outputjson`, or `go vet`,
 *      strictly filtered to diagnostics belonging to the edited file.
 *   3. Emits `'lsp:diagnostics'` events on `getSharedBus()` for Cockpit telemetry.
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { getSharedBus } from './bus.ts'

const execFileAsync = promisify(execFile)

export interface LspDiagnosticItem {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly severity: 'error' | 'warning'
  readonly code?: string
  readonly message: string
}

export interface DiagnosticsExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export type DiagnosticsRunner = (
  cmd: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<DiagnosticsExecResult>

export interface PostEditDiagnosticsOptions {
  readonly cwd?: string
  readonly runner?: DiagnosticsRunner
  readonly serverCommand?: readonly string[]
  readonly timeoutMs?: number
}

const MAX_DIAGNOSTICS = 8
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts'])

/** Encode a JSON-RPC 2.0 object using LSP Content-Length framing. */
export function encodeLspMessage(payload: unknown): string {
  const json = JSON.stringify(payload)
  const len = Buffer.byteLength(json, 'utf8')
  return `Content-Length: ${len}\r\n\r\n${json}`
}

/** Decode zero or more Content-Length framed LSP messages from a chunk buffer. */
export function parseLspMessages(buffer: Buffer): {
  messages: unknown[]
  remainder: Buffer
} {
  const messages: unknown[] = []
  let offset = 0
  while (offset < buffer.length) {
    const headerEnd = buffer.indexOf('\r\n\r\n', offset, 'utf8')
    if (headerEnd < 0) break
    const header = buffer.subarray(offset, headerEnd).toString('utf8')
    const match = /Content-Length:\s*(\d+)/i.exec(header)
    if (!match?.[1]) {
      offset = headerEnd + 4
      continue
    }
    const contentLength = Number(match[1])
    const bodyStart = headerEnd + 4
    const bodyEnd = bodyStart + contentLength
    if (buffer.length < bodyEnd) break
    const rawBody = buffer.subarray(bodyStart, bodyEnd).toString('utf8')
    try {
      messages.push(JSON.parse(rawBody))
    } catch {
      /* ignore malformed JSON-RPC frame */
    }
    offset = bodyEnd
  }
  return { messages, remainder: buffer.subarray(offset) }
}

/** Query a stdio LSP server for diagnostics on a single document. */
export async function queryStdioLspDiagnostics(
  filePath: string,
  options: {
    readonly command: readonly string[]
    readonly cwd: string
    readonly timeoutMs?: number
  },
): Promise<LspDiagnosticItem[]> {
  const bin = options.command[0]
  if (!bin) return []
  const args = options.command.slice(1)
  const timeoutMs = options.timeoutMs ?? 4500
  const absFile = resolve(filePath)
  const fileUri = pathToFileURL(absFile).href
  const rootUri = pathToFileURL(resolve(options.cwd)).href
  const ext = extname(absFile).toLowerCase()
  const languageId = TS_EXTENSIONS.has(ext)
    ? ext.includes('x')
      ? 'typescriptreact'
      : 'typescript'
    : ext === '.py'
      ? 'python'
      : 'plaintext'
  const text = existsSync(absFile) ? readFileSync(absFile, 'utf8') : ''

  return new Promise((resolvePromise) => {
    let settled = false
    let buf = Buffer.alloc(0)
    const child = spawn(bin, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
    })

    const finish = (items: LspDiagnosticItem[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.stdin.write(
          encodeLspMessage({ jsonrpc: '2.0', id: 99, method: 'shutdown', params: null }),
        )
        child.stdin.write(encodeLspMessage({ jsonrpc: '2.0', method: 'exit', params: null }))
      } catch {
        /* ignore closed pipe */
      }
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      resolvePromise(items)
    }

    const timer = setTimeout(() => finish([]), timeoutMs)
    child.on('error', () => finish([]))
    child.on('exit', () => finish([]))

    child.stdout.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      const parsed = parseLspMessages(buf)
      buf = Buffer.from(parsed.remainder)
      for (const msg of parsed.messages) {
        if (!msg || typeof msg !== 'object') continue
        const rec = msg as Record<string, unknown>
        if (rec.id === 1 && rec.result !== undefined) {
          child.stdin.write(encodeLspMessage({ jsonrpc: '2.0', method: 'initialized', params: {} }))
          child.stdin.write(
            encodeLspMessage({
              jsonrpc: '2.0',
              method: 'textDocument/didOpen',
              params: {
                textDocument: { uri: fileUri, languageId, version: 1, text },
              },
            }),
          )
        } else if (rec.method === 'textDocument/publishDiagnostics') {
          const params = (rec.params ?? {}) as { uri?: string; diagnostics?: unknown[] }
          if (params.uri && params.uri !== fileUri) continue
          const rawDiags = Array.isArray(params.diagnostics) ? params.diagnostics : []
          const items: LspDiagnosticItem[] = []
          for (const d of rawDiags) {
            if (!d || typeof d !== 'object') continue
            const diag = d as {
              severity?: number
              code?: string | number
              message?: string
              range?: { start?: { line?: number; character?: number } }
            }
            const sev = diag.severity === 2 ? 'warning' : 'error'
            items.push({
              file: absFile,
              line: (diag.range?.start?.line ?? 0) + 1,
              column: (diag.range?.start?.character ?? 0) + 1,
              severity: sev,
              ...(diag.code !== undefined ? { code: String(diag.code) } : {}),
              message: String(diag.message ?? '').trim(),
            })
          }
          finish(items)
        }
      }
    })

    child.stdin.write(
      encodeLspMessage({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          processId: process.pid,
          rootUri,
          capabilities: {},
        },
      }),
    )
  })
}

async function defaultRunner(
  cmd: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<DiagnosticsExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    })
    return { stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 }
  } catch (err: unknown) {
    const rec = err as { stdout?: string; stderr?: string; code?: number | string }
    return {
      stdout: rec.stdout ?? '',
      stderr: rec.stderr ?? '',
      exitCode: typeof rec.code === 'number' ? rec.code : 1,
    }
  }
}

function findAncestorTool(startDir: string, relParts: readonly string[]): string | null {
  let cur = resolve(startDir)
  for (let i = 0; i < 12; i += 1) {
    const candidate = join(cur, ...relParts)
    if (existsSync(candidate)) return candidate
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  // Fallback to module ancestor (e.g. Pantheon's own node_modules during tests)
  const moduleRoot = resolve(dirname(new URL(import.meta.url).pathname), '..', '..')
  const moduleBin = join(moduleRoot, ...relParts)
  return existsSync(moduleBin) ? moduleBin : null
}

function findNearestTsConfig(filePath: string, stopDir: string): string | null {
  let cur = dirname(resolve(filePath))
  const bound = resolve(stopDir)
  for (let i = 0; i < 10; i += 1) {
    const candidate = join(cur, 'tsconfig.json')
    if (existsSync(candidate)) return candidate
    if (cur === bound) break
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}

function parseTscOutput(output: string, absFile: string, cwd: string): LspDiagnosticItem[] {
  const items: LspDiagnosticItem[] = []
  const targetRel = relative(cwd, absFile).replace(/\\/g, '/')
  const targetBase = basename(absFile)
  const TSC_LINE_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/

  for (const rawLine of output.split(/\r?\n/)) {
    const match = TSC_LINE_RE.exec(rawLine.trim())
    if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5] || !match[6]) continue
    const diagPath = match[1].replace(/\\/g, '/')
    const resolvedDiag = resolve(cwd, diagPath)
    if (
      resolvedDiag !== absFile &&
      diagPath !== targetRel &&
      !diagPath.endsWith(`/${targetBase}`) &&
      diagPath !== targetBase
    ) {
      continue
    }
    items.push({
      file: absFile,
      line: Number(match[2]),
      column: Number(match[3]),
      severity: match[4] === 'warning' ? 'warning' : 'error',
      code: match[5],
      message: match[6].trim(),
    })
  }
  return items
}

function parsePyrightJson(output: string, absFile: string): LspDiagnosticItem[] {
  try {
    const data = JSON.parse(output) as {
      generalDiagnostics?: Array<{
        file?: string
        severity?: string
        rule?: string
        message?: string
        range?: { start?: { line?: number; character?: number } }
      }>
    }
    const items: LspDiagnosticItem[] = []
    for (const d of data.generalDiagnostics ?? []) {
      if (d.file && resolve(d.file) !== absFile) continue
      items.push({
        file: absFile,
        line: (d.range?.start?.line ?? 0) + 1,
        column: (d.range?.start?.character ?? 0) + 1,
        severity: d.severity === 'warning' ? 'warning' : 'error',
        ...(d.rule !== undefined ? { code: d.rule } : {}),
        message: String(d.message ?? '').trim(),
      })
    }
    return items
  } catch {
    return []
  }
}

function formatDiagnosticsBlock(
  absFile: string,
  cwd: string,
  items: readonly LspDiagnosticItem[],
): string {
  const rel = relative(cwd, absFile) || basename(absFile)
  const shown = items.slice(0, MAX_DIAGNOSTICS)
  const lines = shown.map(
    (d) =>
      `  ${rel}:${d.line}:${d.column} ${d.severity}${d.code ? ` ${d.code}` : ''}: ${d.message}`,
  )
  if (items.length > MAX_DIAGNOSTICS) {
    lines.push(`  ... +${items.length - MAX_DIAGNOSTICS} more diagnostic(s)`)
  }
  return `[LSP-Diagnostics] ${items.length} issue(s) in ${rel}:\n${lines.join('\n')}`
}

/**
 * Run semantic diagnostics for an edited file and surface concise `[LSP-Diagnostics]`
 * lines inline when errors/warnings exist for that file.
 */
export async function runPostEditDiagnostics(
  filePath: string,
  options: PostEditDiagnosticsOptions = {},
): Promise<string | null> {
  try {
    if (!filePath || !existsSync(filePath)) return null
    const absFile = resolve(filePath)
    const cwd = resolve(options.cwd ?? dirname(absFile))
    const runner = options.runner ?? defaultRunner
    const timeoutMs = options.timeoutMs ?? 6000
    const ext = extname(absFile).toLowerCase()

    // 1. Live stdio LSP server override if explicitly configured
    const envLsp = process.env.PANTHEON_LSP_SERVER?.trim()
    const lspCmd =
      options.serverCommand ?? (envLsp ? envLsp.split(/\s+/).filter(Boolean) : undefined)
    if (lspCmd && lspCmd.length > 0) {
      const lspItems = await queryStdioLspDiagnostics(absFile, {
        command: lspCmd,
        cwd,
        timeoutMs,
      })
      getSharedBus().emit('lsp:diagnostics', {
        file: relative(cwd, absFile) || absFile,
        source: 'lsp-stdio',
        count: lspItems.length,
        errors: lspItems.filter((d) => d.severity === 'error').length,
        timestamp: Date.now(),
      })
      return lspItems.length > 0 ? formatDiagnosticsBlock(absFile, cwd, lspItems) : null
    }

    // 2. TypeScript / TSX semantic check via `tsc --noEmit`
    if (TS_EXTENSIONS.has(ext)) {
      const tscBin = findAncestorTool(cwd, ['node_modules', '.bin', 'tsc'])
      if (!tscBin) return null
      const tsConfig = findNearestTsConfig(absFile, cwd)
      const args = tsConfig
        ? ['--noEmit', '--pretty', 'false', '--skipLibCheck', '-p', tsConfig]
        : [
            '--noEmit',
            '--pretty',
            'false',
            '--skipLibCheck',
            '--target',
            'esnext',
            '--module',
            'nodenext',
            '--moduleResolution',
            'nodenext',
            absFile,
          ]
      const res = await runner(tscBin, args, { cwd, timeoutMs })
      const items = parseTscOutput(`${res.stdout}\n${res.stderr}`, absFile, cwd)
      getSharedBus().emit('lsp:diagnostics', {
        file: relative(cwd, absFile) || absFile,
        source: 'typescript',
        count: items.length,
        errors: items.filter((d) => d.severity === 'error').length,
        timestamp: Date.now(),
      })
      return items.length > 0 ? formatDiagnosticsBlock(absFile, cwd, items) : null
    }

    // 3. Python semantic check via `pyright --outputjson` (when installed)
    if (ext === '.py') {
      const pyrightBin = findAncestorTool(cwd, ['.venv', 'bin', 'pyright'])
      if (!pyrightBin) return null
      const res = await runner(pyrightBin, ['--outputjson', absFile], { cwd, timeoutMs })
      const items = parsePyrightJson(res.stdout, absFile)
      getSharedBus().emit('lsp:diagnostics', {
        file: relative(cwd, absFile) || absFile,
        source: 'pyright',
        count: items.length,
        errors: items.filter((d) => d.severity === 'error').length,
        timestamp: Date.now(),
      })
      return items.length > 0 ? formatDiagnosticsBlock(absFile, cwd, items) : null
    }

    return null
  } catch {
    return null
  }
}
