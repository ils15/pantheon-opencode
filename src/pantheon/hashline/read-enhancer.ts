/**
 * Read enhancer (Wave 2, PR #46) — augments the `read` tool output with
 * per-line hashline tags so the model can anchor hashline_edit refs.
 *
 * Wired as the plugin's `tool.execute.after` hook (purely additive — the
 * plugin has no `tool.execute.after` yet; pantheon-hooks.ts is a SEPARATE
 * plugin instance, so no key collision). Only `input.tool === 'read'` is
 * touched; every other tool passes through byte-for-byte.
 *
 * Transform: lines matching `^\s*(\d+): ?(.*)$` or `^\s*(\d+)\| ?(.*)$` are
 * rewritten as `{line}#{tag}|{content}`. Already-tagged lines are skipped
 * (idempotent — safe across multiple hook invocations). Lines that do not
 * carry a line-number prefix (truncation markers like `... 500 more lines`,
 * bare text) are left untouched.
 *
 * @module hashline/read-enhancer
 */

import { isTaggedLine } from './core.ts'
import { hashTag } from './xxhash.ts'

/** Input shape of the opencode `tool.execute.after` hook. */
export interface ToolExecuteAfterInput {
  tool: string
  sessionID: string
  callID: string
  args: unknown
}

/** Output shape of the opencode `tool.execute.after` hook (mutable). */
export interface ToolExecuteAfterOutput {
  title?: string
  output: string
  metadata?: Record<string, unknown>
}

/** The `tool.execute.after` handler shape. */
export type ToolExecuteAfterHandler = (
  input: ToolExecuteAfterInput,
  output: ToolExecuteAfterOutput,
) => Promise<void>

/** Read-output line prefixes: `N: content`, `N| content`, `N|content`. */
const LINE_PREFIX_RE = /^\s*([0-9]+): ?(.*)$|^\s*([0-9]+)\| ?(.*)$/

/**
 * Build the read enhancer handler. Throws nothing — any unexpected state is
 * a no-op so the hook can never break the tool result.
 */
export function createReadEnhancer(): ToolExecuteAfterHandler {
  return async (input: ToolExecuteAfterInput, output: ToolExecuteAfterOutput): Promise<void> => {
    if (input.tool !== 'read') return
    if (typeof output.output !== 'string') return

    const tagged = output.output.split('\n').map((line: string) => {
      if (isTaggedLine(line)) return line
      const m = LINE_PREFIX_RE.exec(line)
      if (!m) return line
      const lineNo = Number(m[1] ?? m[3])
      const content = m[2] ?? m[4] ?? ''
      return `${lineNo}#${hashTag(content, lineNo)}|${content}`
    })

    output.output = tagged.join('\n')
  }
}
