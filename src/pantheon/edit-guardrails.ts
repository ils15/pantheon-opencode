/**
 * Deterministic Per-Edit Rule/Linter & Escape-Hatch Guardrails (`edit-guardrails.ts`).
 *
 * Inspired by per-edit hook feedback loops (`PostToolUse` / `tool.execute.after`):
 *   1. `evaluateEditGuardrail` (runs in `tool.execute.before`): blocks silent
 *      suppression shortcuts (`eslint-disable`, `biome-ignore`, `@ts-expect-error`,
 *      `# noqa`, etc.) and edits to linter/typechecker configs unless the user
 *      explicitly approves via `question` (`guardrail-approval-<hash12>`).
 *   2. `runPostEditLint` (runs in `tool.execute.after`): runs the project's fast
 *      single-file linter (`biome`, `eslint`, `ruff`, `gofmt`, plus JSON syntax
 *      fallback), scopes diagnostics strictly to lines changed vs `HEAD` so
 *      pre-existing debt never creates noise, and surfaces violations inline in
 *      the tool output so the agent fixes them on its very next step.
 *
 * @module pantheon/edit-guardrails
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { approvalInputHash } from './j1-approvals.ts'

const execFileAsync = promisify(execFile)

const MUTATING_EDIT_TOOLS = new Set(['edit', 'write', 'hashline_edit', 'patch'])

const PROTECTED_LINT_CONFIG_BASENAMES = new Set([
  'biome.json',
  'biome.jsonc',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.mjs',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
  'eslint.config.js',
  'eslint.config.cjs',
  'eslint.config.mjs',
  'eslint.config.ts',
  'ruff.toml',
  '.ruff.toml',
  '.prettierrc',
  '.prettierrc.json',
  'tsconfig.json',
])

const SUPPRESSION_PATTERNS: ReadonlyArray<{ readonly label: string; readonly re: RegExp }> = [
  { label: 'biome-ignore', re: /\bbiome-ignore\b/i },
  { label: 'eslint-disable', re: /\beslint-disable(?:-next-line|-line)?\b/i },
  { label: '@ts-ignore', re: /@ts-ignore\b/i },
  { label: '@ts-nocheck', re: /@ts-nocheck\b/i },
  { label: '@ts-expect-error', re: /@ts-expect-error\b/i },
  { label: '# noqa', re: /#\s*noqa\b/i },
  { label: '# type: ignore', re: /#\s*type:\s*ignore\b/i },
  { label: '//nolint', re: /\/\/\s*nolint\b/i },
  { label: '#[allow(...)]', re: /#\[allow\([^\]]+\)\]/i },
]

export interface EditGuardrailVerdict {
  readonly allowed: boolean
  readonly kind?: 'lint-config' | 'suppression'
  readonly pattern?: string
  readonly targetPath?: string
  readonly approvalMarker?: string
  readonly approvalHash?: string
  readonly message?: string
}

export interface LintDiagnostic {
  readonly line: number
  readonly rule?: string
  readonly message: string
}

export type ExecRunner = (
  cmd: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>

export interface PostEditLintOptions {
  readonly cwd?: string
  readonly runner?: ExecRunner
  readonly diffLinesOverride?: Set<number> | null
}

export function guardrailApprovalMarker(hash12: string): string {
  return `guardrail-approval-${hash12}`
}

function extractTargetPath(args: Record<string, unknown>): string {
  const raw = args.filePath ?? args.file_path ?? args.file ?? args.path ?? ''
  return typeof raw === 'string' ? raw.trim() : ''
}

function isProtectedLintConfig(filePath: string): boolean {
  if (!filePath) return false
  const normalized = filePath.replace(/\\/g, '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
  if (PROTECTED_LINT_CONFIG_BASENAMES.has(base)) return true
  return /^tsconfig\..+\.json$/i.test(base)
}

function extractAddedText(tool: string, args: Record<string, unknown>): string {
  const chunks: string[] = []
  for (const key of ['newString', 'new_string', 'newText', 'new_text', 'content', 'text']) {
    if (typeof args[key] === 'string') chunks.push(args[key])
  }
  if (tool === 'hashline_edit' && Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (!edit || typeof edit !== 'object') continue
      const rec = edit as Record<string, unknown>
      if (typeof rec.lines === 'string') chunks.push(rec.lines)
      else if (Array.isArray(rec.lines)) chunks.push(rec.lines.map(String).join('\n'))
      else if (typeof rec.content === 'string') chunks.push(rec.content)
      else if (typeof rec.new_text === 'string') chunks.push(rec.new_text)
    }
  }
  return chunks.join('\n')
}

function extractPreviousText(args: Record<string, unknown>): string {
  const chunks: string[] = []
  for (const key of ['oldString', 'old_string', 'oldText', 'old_text']) {
    if (typeof args[key] === 'string') chunks.push(args[key])
  }
  return chunks.join('\n')
}

function countPatternMatches(text: string, re: RegExp): number {
  const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
  return text.match(globalRe)?.length ?? 0
}

/**
 * Evaluate whether a mutating edit tool call attempts an escape hatch:
 * editing lint/tsconfig configs or introducing new suppression directives.
 */
export function evaluateEditGuardrail(
  toolName: unknown,
  rawArgs: unknown,
  options: { enabled?: boolean } = {},
): EditGuardrailVerdict {
  if (options.enabled === false || process.env.PANTHEON_EDIT_GUARDRAILS === 'off') {
    return { allowed: true }
  }
  const tool = typeof toolName === 'string' ? toolName.trim().toLowerCase() : ''
  if (!MUTATING_EDIT_TOOLS.has(tool)) return { allowed: true }
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return { allowed: true }
  }
  const args = rawArgs as Record<string, unknown>
  const targetPath = extractTargetPath(args)
  const hash12 = approvalInputHash({ tool, targetPath, args })
  const marker = guardrailApprovalMarker(hash12)

  if (isProtectedLintConfig(targetPath)) {
    return {
      allowed: false,
      kind: 'lint-config',
      pattern: targetPath,
      targetPath,
      approvalHash: hash12,
      approvalMarker: marker,
      message:
        `[Edit-Guardrail] Modification of linter/typecheck config "${targetPath}" is gated. ` +
        `Fix the rule violation in application code instead, OR ask the user via \`question\` ` +
        `including "${marker}" to explicitly approve modifying "${targetPath}".`,
    }
  }

  const addedText = extractAddedText(tool, args)
  if (!addedText) return { allowed: true }
  const previousText = extractPreviousText(args)

  for (const { label, re } of SUPPRESSION_PATTERNS) {
    const addedCount = countPatternMatches(addedText, re)
    if (addedCount === 0) continue
    const prevCount = previousText ? countPatternMatches(previousText, re) : 0
    if (addedCount > prevCount) {
      return {
        allowed: false,
        kind: 'suppression',
        pattern: label,
        targetPath,
        approvalHash: hash12,
        approvalMarker: marker,
        message:
          `[Edit-Guardrail] Adding lint/type suppression "${label}" in "${targetPath || 'file'}" is blocked. ` +
          `Resolve the underlying violation cleanly, OR ask the user via \`question\` ` +
          `including "${marker}" if a suppression is genuinely required.`,
      }
    }
  }

  return { allowed: true }
}

const defaultExecRunner: ExecRunner = async (cmd, args, { cwd, timeoutMs }) => {
  try {
    const res = await execFileAsync(cmd, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 512 * 1024,
    })
    return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', exitCode: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number }
    return {
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : '',
      exitCode: typeof e.code === 'number' ? e.code : 1,
    }
  }
}

function findProjectRoot(filePath: string, fallbackCwd: string): string {
  let dir = dirname(resolve(filePath))
  for (let i = 0; i < 12; i += 1) {
    if (
      existsSync(`${dir}/package.json`) ||
      existsSync(`${dir}/biome.json`) ||
      existsSync(`${dir}/biome.jsonc`) ||
      existsSync(`${dir}/pyproject.toml`) ||
      existsSync(`${dir}/ruff.toml`) ||
      existsSync(`${dir}/.git`)
    ) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return fallbackCwd
}

export function parseGitDiffChangedLines(diffText: string): Set<number> {
  const changed = new Set<number>()
  for (const line of diffText.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (!m) continue
    const start = Number(m[1])
    const count = m[2] === undefined ? 1 : Number(m[2])
    if (count <= 0) continue
    for (let ln = start; ln < start + count; ln += 1) {
      changed.add(ln)
    }
  }
  return changed
}

async function resolveChangedLinesVsHead(
  projectRoot: string,
  absFile: string,
  runner: ExecRunner,
): Promise<Set<number> | null> {
  const rel = relative(projectRoot, absFile)
  if (!rel || rel.startsWith('..')) return null

  const tracked = await runner('git', ['ls-files', '--error-unmatch', rel], {
    cwd: projectRoot,
    timeoutMs: 800,
  })
  // Untracked/new files or non-git repos: all lines in the new file are subject to lint.
  if (tracked.exitCode !== 0) return null

  const diff = await runner('git', ['diff', '--unified=0', 'HEAD', '--', rel], {
    cwd: projectRoot,
    timeoutMs: 800,
  })
  if (diff.exitCode !== 0 || !diff.stdout.trim()) return null
  const lines = parseGitDiffChangedLines(diff.stdout)
  return lines.size > 0 ? lines : null
}

function lineFromOffset(text: string, offset: number): number {
  let line = 1
  const capped = Math.min(Math.max(0, offset), text.length)
  for (let i = 0; i < capped; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

function parseBiomeJsonOutput(stdout: string, fileText: string): LintDiagnostic[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed) as {
      diagnostics?: Array<{
        category?: string
        severity?: string
        description?: string
        message?: Array<{ content?: string }> | string
        location?: { span?: [number, number] | { start?: number } }
      }>
    }
    const list = Array.isArray(parsed.diagnostics) ? parsed.diagnostics : []
    const out: LintDiagnostic[] = []
    for (const d of list) {
      if (d.severity !== 'error' && d.severity !== 'fatal' && d.severity !== 'warning') continue
      let line = 1
      const span = d.location?.span
      if (Array.isArray(span) && typeof span[0] === 'number') {
        line = lineFromOffset(fileText, span[0])
      } else if (span && !Array.isArray(span) && typeof span.start === 'number') {
        line = lineFromOffset(fileText, span.start)
      }
      const msg =
        typeof d.description === 'string' && d.description
          ? d.description
          : Array.isArray(d.message)
            ? d.message.map((m) => m.content ?? '').join('')
            : typeof d.message === 'string'
              ? d.message
              : 'Lint error'
      const entry: LintDiagnostic = {
        line,
        message: msg.trim().slice(0, 220),
        ...(typeof d.category === 'string' && d.category ? { rule: d.category } : {}),
      }
      out.push(entry)
    }
    return out
  } catch {
    return []
  }
}

function parseEslintJsonOutput(stdout: string): LintDiagnostic[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed) as Array<{
      messages?: Array<{
        line?: number
        ruleId?: string | null
        message?: string
        severity?: number
      }>
    }>
    const first = Array.isArray(parsed) ? parsed[0] : undefined
    const msgs = Array.isArray(first?.messages) ? first.messages : []
    return msgs
      .filter((m) => (m.severity ?? 0) >= 1 && m.message)
      .map((m) => ({
        line: typeof m.line === 'number' && m.line > 0 ? m.line : 1,
        message: String(m.message).trim().slice(0, 220),
        ...(typeof m.ruleId === 'string' && m.ruleId ? { rule: m.ruleId } : {}),
      }))
  } catch {
    return []
  }
}

function parseRuffJsonOutput(stdout: string): LintDiagnostic[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed) as Array<{
      code?: string | null
      message?: string
      location?: { row?: number }
    }>
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item) => item.message)
      .map((item) => ({
        line:
          typeof item.location?.row === 'number' && item.location.row > 0 ? item.location.row : 1,
        message: String(item.message).trim().slice(0, 220),
        ...(typeof item.code === 'string' && item.code ? { rule: item.code } : {}),
      }))
  } catch {
    return []
  }
}

const JS_TS_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.json',
  '.jsonc',
])

/**
 * Run a fast, single-file linter on `filePath` and return a concise diagnostic
 * block filtered to lines modified since `HEAD` (silent `null` when clean).
 */
export async function runPostEditLint(
  filePath: string,
  options: PostEditLintOptions = {},
): Promise<string | null> {
  if (process.env.PANTHEON_DISABLE_EDIT_LINT === '1') return null
  if (!filePath || !existsSync(filePath)) return null

  const absFile = resolve(filePath)
  const ext = extname(absFile).toLowerCase()
  const projectRoot = findProjectRoot(absFile, options.cwd ?? process.cwd())
  const runner = options.runner ?? defaultExecRunner
  const rel = relative(projectRoot, absFile) || absFile

  let linterName = ''
  let diagnostics: LintDiagnostic[] = []

  if (JS_TS_EXTS.has(ext)) {
    const localBiome = `${projectRoot}/node_modules/.bin/biome`
    const hasBiomeCfg =
      existsSync(`${projectRoot}/biome.json`) || existsSync(`${projectRoot}/biome.jsonc`)
    const localEslint = `${projectRoot}/node_modules/.bin/eslint`

    if (existsSync(localBiome) && hasBiomeCfg) {
      linterName = 'biome'
      const res = await runner(localBiome, ['check', '--reporter=json', absFile], {
        cwd: projectRoot,
        timeoutMs: 1500,
      })
      if (res.exitCode !== 0 || res.stdout.includes('"severity":"error"')) {
        const fileText = readFileSync(absFile, 'utf8')
        diagnostics = parseBiomeJsonOutput(res.stdout, fileText)
      }
    } else if (existsSync(localEslint)) {
      linterName = 'eslint'
      const res = await runner(localEslint, ['--format=json', absFile], {
        cwd: projectRoot,
        timeoutMs: 1500,
      })
      if (res.exitCode !== 0) {
        diagnostics = parseEslintJsonOutput(res.stdout)
      }
    } else if (ext === '.json') {
      try {
        JSON.parse(readFileSync(absFile, 'utf8'))
      } catch (jsonErr) {
        return `[Pantheon Diagnostic] JSON syntax error in ${filePath}: ${
          jsonErr instanceof Error ? jsonErr.message : String(jsonErr)
        }`
      }
    }
    if (ext === '.json' && diagnostics.length === 0) {
      try {
        JSON.parse(readFileSync(absFile, 'utf8'))
      } catch (jsonErr) {
        return `[Pantheon Diagnostic] JSON syntax error in ${filePath}: ${
          jsonErr instanceof Error ? jsonErr.message : String(jsonErr)
        }`
      }
    }
  } else if (ext === '.py') {
    const venvRuff = `${projectRoot}/.venv/bin/ruff`
    const ruffCmd = existsSync(venvRuff) ? venvRuff : 'ruff'
    linterName = 'ruff'
    const res = await runner(ruffCmd, ['check', '--output-format=json', absFile], {
      cwd: projectRoot,
      timeoutMs: 1500,
    })
    if (res.exitCode !== 0 && res.stdout.trim().startsWith('[')) {
      diagnostics = parseRuffJsonOutput(res.stdout)
    }
  } else if (ext === '.go') {
    linterName = 'gofmt'
    const res = await runner('gofmt', ['-l', absFile], { cwd: projectRoot, timeoutMs: 1500 })
    if (res.stdout.trim()) {
      diagnostics = [{ line: 1, rule: 'gofmt', message: 'File is not gofmt-formatted' }]
    }
  }

  if (diagnostics.length === 0) return null

  const changedLines =
    options.diffLinesOverride !== undefined
      ? options.diffLinesOverride
      : await resolveChangedLinesVsHead(projectRoot, absFile, runner)

  const relevant =
    changedLines !== null && changedLines.size > 0
      ? diagnostics.filter(
          (d) => changedLines.has(d.line) || d.rule?.startsWith('parse') || d.line < 1,
        )
      : diagnostics

  if (relevant.length === 0) return null

  const capped = relevant.slice(0, 8)
  const lines = capped.map((d) => `  - L${d.line}: ${d.message}${d.rule ? ` [${d.rule}]` : ''}`)
  const overflow =
    relevant.length > capped.length ? `\n  ... +${relevant.length - capped.length} more` : ''
  return `[Pantheon Edit-Lint] ${rel} (${linterName}):\n${lines.join('\n')}${overflow}\nFix these issues on the edited lines before moving on.`
}
