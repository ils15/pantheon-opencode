/**
 * V2 `execute.after` parity adapter — reproduces the V1 post-tool chain on the
 * V2 tool-event surface.
 *
 * V1 (`src/plugin.ts`) wires a single `tool.execute.after` handler that runs,
 * in order:
 *   1. task-result-guard — an empty native `task()` result becomes an explicit
 *      error so the parent LLM cannot read silence as success;
 *   2. context-sandbox   — oversized read/grep/glob/webfetch output is truncated
 *      with a marker + metadata;
 *   3. read-enhancer     — a `read` result gains per-line hashline tags
 *      (`N#TAG|content`) so `hashline_edit` refs resolve.
 *
 * On a V2-only install (`opencode.json` `plugins` declares only `plugin-v2`),
 * `src/plugin.ts` is NOT loaded, so that chain does not exist. `plugin-v2.ts`
 * registered an `execute.after` hook but with an empty body, so the chain was
 * dead on V2. This module rebuilds it against the REAL V2 event shape.
 *
 * The V2 event (opencode 2.0.x `ToolHooks["execute.after"]`) is ONE object:
 *
 *   { tool, sessionID, agent, messageID, id, input } & (
 *       { status: 'completed'; result: Tool.Result } |
 *       { status: 'error'; error: Tool.Error } )
 *
 * where `Tool.Result = { output?, content?, metadata? }`. This adapter only
 * acts on `status === 'completed'`; an ERROR event is left untouched — V1's own
 * behaviour on a tool error was never verified, so this module does not claim
 * after-on-error semantics.
 *
 * Fail-safe: every path is wrapped so an unexpected shape can never break the
 * tool result the host is about to surface.
 *
 * @module pantheon/v2-execute-after
 */

import {
  type ContextSandboxConfig,
  createContextSandbox,
  resolveSandboxConfig,
  DEFAULT_CONFIG as SANDBOX_DEFAULT_CONFIG,
} from './context-sandbox.ts'
import { createReadEnhancer } from './hashline/read-enhancer.ts'
import { createTaskResultGuard } from './task-result-guard.ts'

/** The `Tool.Result` fields this adapter reads and writes back. */
export interface V2ToolResult {
  output?: unknown
  content?: unknown
  metadata?: unknown
}

/** The completed, non-error `execute.after` event as the 2.0.x host dispatches it. */
export interface V2ExecuteAfterEvent {
  tool?: unknown
  sessionID?: unknown
  id?: unknown
  input?: unknown
  status?: unknown
  result?: unknown
}

/** Options for {@link createV2ExecuteAfter}. */
export interface V2ExecuteAfterOptions {
  /**
   * Sandbox config, normally derived from `ctx.options.context_sandbox` via
   * {@link resolveSandboxConfig}. Defaults to the shared defaults.
   */
  sandbox?: ContextSandboxConfig
}

/** Which `Tool.Result` field carries the (mutable) text this adapter enhances. */
type TextField = 'output' | 'content' | 'content-array'

/**
 * Extract the mutable text from a `Tool.Result`.
 *
 * Preference order mirrors what a session renders: a declared string `output`
 * first, then a string `content`, then the concatenation of `content` text
 * parts. A `content` array containing non-text (file) parts is deliberately NOT
 * enhanced — replacing it would corrupt the structured payload, so it is
 * reported as unextractable and the whole event becomes a no-op.
 *
 * @returns `{ text, field }` or `null` when there is nothing to enhance.
 */
function extractText(result: V2ToolResult): { text: string; field: TextField } | null {
  if (typeof result.output === 'string') return { text: result.output, field: 'output' }
  if (typeof result.content === 'string') return { text: result.content, field: 'content' }
  if (Array.isArray(result.content)) {
    const parts = result.content
    const allText = parts.every(
      (part) => typeof part === 'string' || (part as { type?: unknown })?.type === 'text',
    )
    if (!allText || parts.length === 0) return null
    const text = parts
      .map((part) => (typeof part === 'string' ? part : ((part as { text?: string }).text ?? '')))
      .join('\n')
    return { text, field: 'content-array' }
  }
  return null
}

/**
 * Write enhanced text back into the SAME field it came from, preserving the
 * result's other fields.
 */
function writeText(result: V2ToolResult, field: TextField, text: string): void {
  if (field === 'output') {
    result.output = text
  } else if (field === 'content') {
    result.content = text
  } else {
    result.content = [{ type: 'text', text }]
  }
}

/**
 * Build the V2 `execute.after` handler that runs the V1 parity chain.
 *
 * @param options - see {@link V2ExecuteAfterOptions}
 * @returns a handler suitable for `ctx.tool.hook('execute.after', …)`
 */
export function createV2ExecuteAfter(
  options: V2ExecuteAfterOptions = {},
): (event: unknown) => Promise<void> {
  const taskResultGuard = createTaskResultGuard()
  const sandbox = createContextSandbox(options.sandbox ?? SANDBOX_DEFAULT_CONFIG)
  const readEnhancer = createReadEnhancer()

  return async function v2ExecuteAfter(event: unknown): Promise<void> {
    try {
      if (event === null || typeof event !== 'object' || Array.isArray(event)) return
      const payload = event as V2ExecuteAfterEvent
      // Only a completed result has a result to augment; an error event is left
      // untouched (no after-on-error semantics are claimed).
      if (payload.status !== 'completed') return

      const result = payload.result
      if (result === null || typeof result !== 'object' || Array.isArray(result)) return

      const tool = typeof payload.tool === 'string' ? payload.tool : ''
      const sessionID = typeof payload.sessionID === 'string' ? payload.sessionID : ''
      const callID = typeof payload.id === 'string' ? payload.id : ''

      const extracted = extractText(result as V2ToolResult)
      // A `task` result may carry no text at all — that IS the empty-result
      // failure the guard exists to surface, so synthesize an empty string and
      // let the guard replace it. Other tools with no text are a no-op.
      if (extracted === null && tool !== 'task') return
      const original = extracted === null ? { text: '', field: 'output' as TextField } : extracted

      const input = { tool, sessionID, callID, args: payload.input }
      const output: {
        output: string
        metadata?: Record<string, unknown>
      } = { output: original.text }

      await taskResultGuard(input, output)
      await sandbox(input, output)
      await readEnhancer(input, output)

      if (output.output !== original.text) {
        writeText(result as V2ToolResult, original.field, output.output)
      }
      // Surface sandbox metadata onto the result (merge, never replace). It is
      // only present when the sandbox actually truncated something.
      if (output.metadata && Object.keys(output.metadata).length > 0) {
        ;(result as V2ToolResult).metadata = {
          ...((result as V2ToolResult).metadata as Record<string, unknown> | undefined),
          ...output.metadata,
        }
      }
    } catch {
      // Fail-safe: an unexpected shape must never break the tool result.
    }
  }
}

/**
 * Resolve a sandbox config from a V2 plugin's `ctx.options.context_sandbox`.
 * Exposed so `plugin-v2.ts` resolves it the SAME way V1's config hook does,
 * rather than silently constructing defaults.
 */
export function resolveV2SandboxConfig(options: unknown): ContextSandboxConfig {
  const raw = (options as { context_sandbox?: unknown } | null | undefined)?.context_sandbox
  return resolveSandboxConfig(raw)
}
