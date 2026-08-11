/**
 * Hashline edit tool (Wave 2, PR #46) — structural `hashline_edit` tool that
 * anchors edits to stable sha256 content tags instead of fragile line numbers.
 *
 * Tool shape matches the delegation tools (`{description, args, execute}`,
 * zod-validated — same import pattern as delegation.ts).
 *
 * Safety model (council-approved):
 *   1. ALL refs are validated against the ORIGINAL file snapshot BEFORE any
 *      write — a mismatch returns an error-as-text with a re-tagged excerpt,
 *      `>>>` marker, and a Did-you-mean suggestion. NO partial write ever.
 *   2. Edits are applied BOTTOM-UP (highest line first) so every ref resolves
 *      against the original numbering, even for adjacent edits.
 *
 * Ops:
 *   - replace: `ref` (or `ref`..`endRef` range) → replace with `lines`
 *   - append:  insert `content` AFTER the anchor `ref` line
 *   - prepend: insert `content` BEFORE the anchor `ref` line
 *   - delete:  remove the `ref` line (or `ref`..`endRef` range); no `lines`
 *
 * @module hashline/tool
 */

import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { z } from 'zod'

import { buildMismatchError, HASHLINE_REF_RE } from './core.ts'
import { hashTag } from './xxhash.ts'

// ─── Types ─────────────────────────────────────────────────────────────

/** Structural tool context (subset of the opencode ToolContext). */
export interface HashlineEditContext {
  sessionID: string
  directory?: string
  worktree?: string
  agent?: string
}

/** One hashline edit operation. */
export interface HashlineEditOp {
  op: 'replace' | 'append' | 'prepend' | 'delete'
  /** Anchor ref "LINE#TAG" against the ORIGINAL snapshot. */
  ref: string
  /** Optional range end for replace/delete ("LINE#TAG"). */
  endRef?: string
  /** Replacement lines (replace). */
  lines?: string[]
  /** Text to insert (append/prepend; split on newlines). */
  content?: string
}

/** Tool result — string (error-as-text) or success with metadata. */
export type HashlineToolResult =
  | string
  | { title?: string; output: string; metadata: { firstChangedLine: number; changedCount: number } }

// ─── Args schema ───────────────────────────────────────────────────────

const hashlineEditOpArgs = {
  op: z.enum(['replace', 'append', 'prepend', 'delete']),
  ref: z.string().min(1),
  endRef: z.string().optional(),
  lines: z.array(z.string()).optional(),
  content: z.string().optional(),
} satisfies z.ZodRawShape

const hashlineEditArgs = {
  file: z.string().min(1),
  edits: z.array(z.object(hashlineEditOpArgs)).min(1),
} satisfies z.ZodRawShape

/** A ref validated against the original snapshot. */
interface ResolvedRef {
  line: number
  tag: string
  /** Ref string as given (for error messages). */
  raw: string
}

/** A fully validated edit, ready to apply bottom-up. */
interface ResolvedEdit {
  op: HashlineEditOp['op']
  line: number
  endLine: number
  insert: string[]
}

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Resolve the edit file to an absolute path, with a containment guard.
 *
 * Relative paths must stay inside `base` (worktree → directory → cwd):
 * `../` traversal (`../../etc/passwd`) is rejected as error-as-text, so no
 * read/write ever happens outside the worktree. Absolute paths are trusted
 * as-is — hashline_edit carries the same privilege as edit/write/bash, so
 * this is cheap defense-in-depth, not a security boundary.
 */
function resolveFile(
  file: string,
  ctx: HashlineEditContext,
): { ok: true; file: string } | { ok: false; error: string } {
  if (isAbsolute(file)) return { ok: true, file: resolve(file) }
  const base = resolve(ctx.worktree ?? ctx.directory ?? process.cwd())
  const resolved = resolve(base, file)
  // Prefix check with a path.sep boundary: `/tmp/x` must not match `/tmp2/x`.
  if (resolved !== base && !resolved.startsWith(base + sep)) {
    return {
      ok: false,
      error: `hashline_edit: file "${file}" escapes the worktree (resolved to "${resolved}") — path containment denied`,
    }
  }
  return { ok: true, file: resolved }
}

/** Parse + validate a ref string against the ORIGINAL snapshot lines. */
function resolveRef(raw: string, file: string, lines: readonly string[]): ResolvedRef | string {
  const m = HASHLINE_REF_RE.exec(raw)
  if (!m) {
    return `hashline_edit: invalid ref "${raw}" — expected "LINE#TAG" (e.g. "12#XJ")`
  }
  const line = Number(m[1])
  const tag = m[2]
  if (line < 1 || line > lines.length) {
    return `hashline_edit: ref "${raw}" line ${line} out of range — file has ${lines.length} line(s)`
  }
  const actual = hashTag(lines[line - 1] ?? '', line)
  if (actual !== tag) {
    return buildMismatchError(file, raw, { line, tag: actual, content: lines[line - 1] }, lines)
  }
  return { line, tag, raw }
}

/**
 * Validate ALL edits against the original snapshot; returns the resolved
 * edit list or the error-as-text for the first failure.
 */
function validateEdits(
  args: z.infer<z.ZodObject<typeof hashlineEditArgs>>,
  file: string,
  lines: readonly string[],
): ResolvedEdit[] | string {
  const resolved: ResolvedEdit[] = []
  for (const [i, e] of args.edits.entries()) {
    const pos = resolveRef(e.ref, file, lines)
    if (typeof pos === 'string') return pos
    const edit: ResolvedEdit = { op: e.op, line: pos.line, endLine: pos.line, insert: [] }

    if (e.op === 'delete' && e.lines) {
      return `hashline_edit: delete edit (index ${i}) must not provide "lines"`
    }
    if (e.op === 'replace' && (!e.lines || e.lines.length === 0)) {
      return `hashline_edit: replace edit (index ${i}) requires non-empty "lines"`
    }
    if ((e.op === 'append' || e.op === 'prepend') && typeof e.content !== 'string') {
      return `hashline_edit: ${e.op} edit (index ${i}) requires "content"`
    }

    if (e.endRef) {
      const end = resolveRef(e.endRef, file, lines)
      if (typeof end === 'string') return end
      if (end.line < edit.line) {
        return `hashline_edit: endRef "${e.endRef}" is before ref "${e.ref}"`
      }
      edit.endLine = end.line
    }

    if (e.op === 'replace') {
      edit.insert = e.lines ?? []
    } else if (e.op === 'append' || e.op === 'prepend') {
      edit.insert = (e.content ?? '').split('\n')
    }
    resolved.push(edit)
  }
  return resolved
}

// ─── Tool factory ──────────────────────────────────────────────────────

/**
 * Build the structural `hashline_edit` tool. execute() returns error-as-text
 * on any validation failure (never throws for user errors, never writes
 * partially); on success returns the summary with `{firstChangedLine,
 * changedCount}` metadata.
 */
export function createHashlineEditTool() {
  return {
    description:
      'Edit a file anchored by hashline refs (LINE#TAG) instead of raw line numbers. ' +
      'Ops: replace (ref..endRef or single ref → lines), append/prepend (anchor ref → content), ' +
      'delete (ref..endRef). ALL refs must be validated against the ORIGINAL file before ' +
      'anything is written; on mismatch the tool returns an error with a re-tagged excerpt ' +
      'and a Did-you-mean suggestion, and nothing is modified.',
    args: hashlineEditArgs,
    execute: async (
      args: z.infer<z.ZodObject<typeof hashlineEditArgs>>,
      ctx: HashlineEditContext,
    ): Promise<HashlineToolResult> => {
      const resolved = resolveFile(args.file, ctx)
      if (!resolved.ok) return resolved.error
      const file = resolved.file

      let original: string
      try {
        original = await readFile(file, 'utf8')
      } catch {
        return `hashline_edit: cannot read "${file}" — check the path and try again`
      }

      const hadTrailingNewline = original.endsWith('\n')
      const lines = original.split('\n')

      // Phase 1: validate every ref against the ORIGINAL snapshot — no writes.
      const edits = validateEdits(args, file, lines)
      if (typeof edits === 'string') return edits

      // Phase 2: apply bottom-up (highest line first; ties: later edit first).
      edits.sort((a, b) => b.line - a.line || b.endLine - a.endLine)
      const working = [...lines]
      for (const e of edits) {
        const deleteCount = e.endLine - e.line + 1
        if (e.op === 'replace') {
          working.splice(e.line - 1, deleteCount, ...e.insert)
        } else if (e.op === 'delete') {
          working.splice(e.line - 1, deleteCount)
        } else if (e.op === 'append') {
          working.splice(e.line, 0, ...e.insert)
        } else {
          // prepend: insert before the anchor line.
          working.splice(e.line - 1, 0, ...e.insert)
        }
      }

      let out = working.join('\n')
      if (hadTrailingNewline && !out.endsWith('\n')) out += '\n'
      // Atomic write (tmp + rename — same pattern as file-persistence.ts
      // writeState / background-job-board.ts writeSignal): a mid-write crash
      // leaves at most a `.tmp-<pid>` file, never partial target content.
      // The tmp file is best-effort cleaned up if the write or rename fails.
      const tmpPath = `${file}.tmp-${process.pid}`
      try {
        await writeFile(tmpPath, out, 'utf8')
        await rename(tmpPath, file)
      } catch {
        await rm(tmpPath, { force: true }).catch(() => {})
        return `hashline_edit: cannot write "${file}" — check permissions and try again`
      }

      const firstChangedLine = Math.min(...edits.map((e) => e.line))
      return {
        title: 'hashline_edit',
        output: `Updated ${file}: ${edits.length} edit(s) applied, first changed line ${firstChangedLine}.`,
        metadata: { firstChangedLine, changedCount: edits.length },
      }
    },
  }
}
