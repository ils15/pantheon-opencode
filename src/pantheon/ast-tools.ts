/**
 * Structural AST Search & Rewrite Tools (`ast_search`, `ast_rewrite`).
 *
 * Zero external runtime dependencies: tokenizes TS/JS/Python/Go/Rust files
 * ignoring comments so metavariable patterns (`$NAME`, `$$$ARGS`) match
 * real syntax structures rather than raw regex text.
 *
 * Security & guardrails:
 *   - Confined to the active workspace root (`resolveSafeToolPath`).
 *   - `ast_rewrite` validates replacements with `evaluateEditGuardrail` so
 *     suppression shortcuts (`ts-ignore`, `eslint-disable`, etc.) are blocked.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { evaluateEditGuardrail } from './edit-guardrails.ts'
import { resolveSafeToolPath, resolveToolCwd } from './tool-context.ts'
import type { PantheonToolDef, PantheonToolResult } from './tools.ts'

interface Token {
  readonly kind: 'ident' | 'number' | 'string' | 'punct' | 'meta'
  readonly text: string
  readonly start: number
  readonly end: number
  readonly line: number
  readonly column: number
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.pantheon', '.venv', 'dist', 'build'])
const SUPPORTED_EXTS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
])

const OPEN_DELIMS: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
const CLOSE_DELIMS = new Set([')', ']', '}'])

function computeLineIndex(source: string): number[] {
  const starts = [0]
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

function locateOffset(
  lineStarts: readonly number[],
  offset: number,
): { line: number; column: number } {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((lineStarts[mid] ?? 0) <= offset) lo = mid + 1
    else hi = mid - 1
  }
  const lineIdx = Math.max(0, hi)
  return { line: lineIdx + 1, column: offset - (lineStarts[lineIdx] ?? 0) + 1 }
}

function tokenizeCode(source: string, isPattern = false): Token[] {
  const tokens: Token[] = []
  const lineStarts = computeLineIndex(source)
  const n = source.length
  let i = 0

  const push = (kind: Token['kind'], start: number, end: number) => {
    const pos = locateOffset(lineStarts, start)
    tokens.push({ kind, text: source.slice(start, end), start, end, ...pos })
  }

  while (i < n) {
    const ch = source[i] ?? ''
    const next = source[i + 1] ?? ''

    if (/\s/.test(ch)) {
      i += 1
      continue
    }

    // Comments (always skipped so patterns never hit comments)
    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', i + 2)
      i = nl < 0 ? n : nl + 1
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
      continue
    }
    if (ch === '#' && !source.slice(i).startsWith('#[')) {
      const nl = source.indexOf('\n', i + 1)
      i = nl < 0 ? n : nl + 1
      continue
    }

    // Quoted strings & backticks
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      const start = i
      i += 1
      while (i < n) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === quote) {
          i += 1
          break
        }
        i += 1
      }
      push('string', start, i)
      continue
    }

    // Metavariables in patterns ($VAR or $$$ARGS)
    if (isPattern && ch === '$') {
      const start = i
      const rest = source.slice(i)
      const metaMatch = /^(\${1,3}[A-Za-z_][A-Za-z0-9_]*)/.exec(rest)
      if (metaMatch?.[1]) {
        i += metaMatch[1].length
        push('meta', start, i)
        continue
      }
    }

    // Identifiers
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i
      i += 1
      while (i < n && /[A-Za-z0-9_$]/.test(source[i] ?? '')) i += 1
      push('ident', start, i)
      continue
    }

    // Numbers
    if (/[0-9]/.test(ch)) {
      const start = i
      i += 1
      while (i < n && /[0-9A-Za-z_.]/.test(source[i] ?? '')) i += 1
      push('number', start, i)
      continue
    }

    // Multi-char operators or single punctuation
    const two = source.slice(i, i + 2)
    const three = source.slice(i, i + 3)
    if (three === '===' || three === '!==' || three === '...') {
      push('punct', i, i + 3)
      i += 3
      continue
    }
    if (['==', '!=', '<=', '>=', '=>', '&&', '||', '::', '->'].includes(two)) {
      push('punct', i, i + 2)
      i += 2
      continue
    }
    push('punct', i, i + 1)
    i += 1
  }

  return tokens
}

function matchTokensAt(
  code: string,
  codeTokens: readonly Token[],
  startIdx: number,
  patTokens: readonly Token[],
): { endIdx: number; captures: Record<string, string> } | null {
  const captures: Record<string, string> = {}

  const step = (ci: number, pi: number): number | null => {
    if (pi >= patTokens.length) return ci
    const pat = patTokens[pi]
    if (!pat) return null

    if (pat.kind === 'meta') {
      const isMulti = pat.text.startsWith('$$$')
      const varName = pat.text

      if (isMulti) {
        const stopTok = patTokens[pi + 1]
        let depth = 0
        let scan = ci
        const startOffset = codeTokens[ci]?.start
        while (scan <= codeTokens.length) {
          if (depth === 0) {
            const matchedAfter = step(scan, pi + 1)
            if (matchedAfter !== null) {
              const endOffset = scan > ci ? codeTokens[scan - 1]?.end : startOffset
              const raw =
                startOffset !== undefined && endOffset !== undefined
                  ? code.slice(startOffset, endOffset)
                  : ''
              if (!(varName in captures) || captures[varName] === raw) {
                captures[varName] = raw
                return matchedAfter
              }
            }
          }
          const cur = codeTokens[scan]
          if (!cur) break
          if (cur.text in OPEN_DELIMS) depth += 1
          else if (CLOSE_DELIMS.has(cur.text)) {
            if (depth === 0) break
            depth -= 1
          } else if (stopTok && depth === 0 && cur.text === stopTok.text && scan > ci) {
            // Let next iteration try closing before stopTok
          }
          scan += 1
        }
        return null
      }

      // Single metavariable $X: match single token or balanced call/member chain
      const cur = codeTokens[ci]
      if (!cur || CLOSE_DELIMS.has(cur.text)) return null
      let endTokenIdx = ci + 1
      if (cur.text in OPEN_DELIMS) {
        let depth = 1
        while (endTokenIdx < codeTokens.length && depth > 0) {
          const t = codeTokens[endTokenIdx]
          if (!t) break
          if (t.text in OPEN_DELIMS) depth += 1
          else if (CLOSE_DELIMS.has(t.text)) depth -= 1
          endTokenIdx += 1
        }
        if (depth !== 0) return null
      } else {
        while (
          endTokenIdx < codeTokens.length &&
          (codeTokens[endTokenIdx]?.text === '.' || codeTokens[endTokenIdx]?.text === '(')
        ) {
          if (codeTokens[endTokenIdx]?.text === '.') {
            if (endTokenIdx + 1 >= codeTokens.length) break
            endTokenIdx += 2
          } else {
            let depth = 1
            endTokenIdx += 1
            while (endTokenIdx < codeTokens.length && depth > 0) {
              const t = codeTokens[endTokenIdx]
              if (!t) break
              if (t.text in OPEN_DELIMS) depth += 1
              else if (CLOSE_DELIMS.has(t.text)) depth -= 1
              endTokenIdx += 1
            }
          }
        }
      }

      const raw = code.slice(cur.start, codeTokens[endTokenIdx - 1]?.end ?? cur.end)
      const prev = captures[varName]
      if (prev !== undefined && prev !== raw) return null
      captures[varName] = raw
      const res = step(endTokenIdx, pi + 1)
      if (res === null && prev === undefined) delete captures[varName]
      return res
    }

    const cur = codeTokens[ci]
    if (!cur || cur.text !== pat.text) return null
    return step(ci + 1, pi + 1)
  }

  const endIdx = step(startIdx, 0)
  return endIdx !== null ? { endIdx, captures } : null
}

function collectFiles(targetPath: string): string[] {
  const out: string[] = []
  const st = statSync(targetPath)
  if (st.isFile()) return [targetPath]
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && SUPPORTED_EXTS.has(extname(entry.name).toLowerCase())) {
        out.push(full)
      }
    }
  }
  walk(targetPath)
  return out
}

interface AstMatchSpan {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly startOffset: number
  readonly endOffset: number
  readonly match: string
  readonly captures: Record<string, string>
}

function findAstMatchesInFile(absFile: string, relFile: string, pattern: string): AstMatchSpan[] {
  const source = readFileSync(absFile, 'utf8')
  const patTokens = tokenizeCode(pattern, true)
  if (patTokens.length === 0) return []
  const codeTokens = tokenizeCode(source, false)
  const matches: AstMatchSpan[] = []

  let idx = 0
  while (idx < codeTokens.length) {
    const firstPat = patTokens[0]
    const cur = codeTokens[idx]
    if (!firstPat || !cur) break
    if (firstPat.kind !== 'meta' && cur.text !== firstPat.text) {
      idx += 1
      continue
    }
    const found = matchTokensAt(source, codeTokens, idx, patTokens)
    if (!found) {
      idx += 1
      continue
    }
    const firstTok = codeTokens[idx]
    const lastTok = codeTokens[found.endIdx - 1] ?? firstTok
    if (firstTok && lastTok && found.endIdx > idx) {
      matches.push({
        file: relFile,
        line: firstTok.line,
        column: firstTok.column,
        startOffset: firstTok.start,
        endOffset: lastTok.end,
        match: source.slice(firstTok.start, lastTok.end),
        captures: found.captures,
      })
      idx = found.endIdx
    } else {
      idx += 1
    }
  }
  return matches
}

function substituteCaptures(template: string, captures: Record<string, string>): string {
  return template.replace(/\${1,3}[A-Za-z_][A-Za-z0-9_]*/g, (token) => captures[token] ?? token)
}

function jsonResult(payload: unknown): PantheonToolResult {
  return { output: JSON.stringify(payload) }
}

export function createAstTools(fallbackDir?: string): PantheonToolDef[] {
  const astSearch: PantheonToolDef = {
    name: 'ast_search',
    description:
      'Search code using structural AST token patterns with metavariables ($VAR, $$$ARGS). ' +
      'Ignores comments and whitespace/formatting differences while staying confined to the workspace.',
    input: {
      type: 'object',
      additionalProperties: false,
      required: ['pattern'],
      properties: {
        pattern: {
          type: 'string',
          description: 'Structural code pattern, e.g. "console.log($$$ARGS)" or "if ($COND)"',
        },
        path: {
          type: 'string',
          description: 'Relative file or directory inside the workspace (default: ".")',
        },
        limit: {
          type: 'number',
          description: 'Maximum matches to return (default: 50, max: 200)',
        },
      },
    },
    output: {},
    execute: async (input, context) => {
      try {
        const pattern = typeof input.pattern === 'string' ? input.pattern.trim() : ''
        if (!pattern) return jsonResult({ ok: false, error: 'pattern is required' })
        const cwd = resolveToolCwd(context, fallbackDir)
        const rawPath =
          typeof input.path === 'string' && input.path.trim() ? input.path.trim() : '.'
        const targetAbs = resolveSafeToolPath(cwd, rawPath)
        const limit =
          typeof input.limit === 'number' && input.limit > 0
            ? Math.min(200, Math.floor(input.limit))
            : 50

        const files = collectFiles(targetAbs)
        const results: Array<{
          file: string
          line: number
          column: number
          match: string
          captures: Record<string, string>
        }> = []

        for (const f of files) {
          const rel = relative(resolve(cwd), f).replace(/\\/g, '/') || f
          for (const m of findAstMatchesInFile(f, rel, pattern)) {
            results.push({
              file: m.file,
              line: m.line,
              column: m.column,
              match: m.match,
              captures: m.captures,
            })
            if (results.length >= limit) break
          }
          if (results.length >= limit) break
        }

        return jsonResult({
          ok: true,
          pattern,
          scannedFiles: files.length,
          total: results.length,
          matches: results,
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return jsonResult({ ok: false, error: message })
      }
    },
  }

  const astRewrite: PantheonToolDef = {
    name: 'ast_rewrite',
    description:
      'Structurally rewrite code matching an AST pattern ($VAR, $$$ARGS) to a replacement template. ' +
      'Supports dryRun preview, preserves surrounding code, and enforces Pantheon edit guardrails.',
    input: {
      type: 'object',
      additionalProperties: false,
      required: ['pattern', 'replacement'],
      properties: {
        pattern: { type: 'string', description: 'Structural AST pattern to match' },
        replacement: {
          type: 'string',
          description: 'Replacement template substituting captured metavariables',
        },
        path: {
          type: 'string',
          description: 'Relative file or directory inside the workspace (default: ".")',
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview changes without writing files (default: false)',
        },
      },
    },
    output: {},
    execute: async (input, context) => {
      try {
        const pattern = typeof input.pattern === 'string' ? input.pattern.trim() : ''
        const replacement = typeof input.replacement === 'string' ? input.replacement : ''
        if (!pattern) return jsonResult({ ok: false, error: 'pattern is required' })
        if (!replacement) return jsonResult({ ok: false, error: 'replacement is required' })

        const cwd = resolveToolCwd(context, fallbackDir)
        const rawPath =
          typeof input.path === 'string' && input.path.trim() ? input.path.trim() : '.'
        const targetAbs = resolveSafeToolPath(cwd, rawPath)
        const dryRun = input.dryRun === true

        const guardrail = evaluateEditGuardrail('ast_rewrite', {
          filePath: targetAbs,
          newString: replacement,
        })
        if (!guardrail.allowed) {
          return jsonResult({
            ok: false,
            error: guardrail.message ?? 'Edit blocked by Pantheon guardrail',
          })
        }

        const files = collectFiles(targetAbs)
        const filesModified: string[] = []
        const previews: Array<{ file: string; line: number; before: string; after: string }> = []
        let totalReplacements = 0

        for (const f of files) {
          const rel = relative(resolve(cwd), f).replace(/\\/g, '/') || f
          const spans = findAstMatchesInFile(f, rel, pattern)
          if (spans.length === 0) continue

          const original = readFileSync(f, 'utf8')
          let updated = ''
          let cursor = 0
          for (const span of spans) {
            const after = substituteCaptures(replacement, span.captures)
            updated += original.slice(cursor, span.startOffset) + after
            cursor = span.endOffset
            totalReplacements += 1
            if (previews.length < 30) {
              previews.push({ file: rel, line: span.line, before: span.match, after })
            }
          }
          updated += original.slice(cursor)

          if (!dryRun && updated !== original) {
            writeFileSync(f, updated, 'utf8')
          }
          if (updated !== original) filesModified.push(rel)
        }

        return jsonResult({
          ok: true,
          dryRun,
          pattern,
          replacements: totalReplacements,
          filesModified,
          previews,
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return jsonResult({ ok: false, error: message })
      }
    },
  }

  return [astSearch, astRewrite]
}
