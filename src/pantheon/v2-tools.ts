/**
 * V2 tool surface — the Pantheon tools that are self-sufficient on the
 * OpenCode V2 host, declared for `ctx.tool.transform`'s `draft.add`.
 *
 * ## Why only three tools
 *
 * A V2 tool can only be served here when it needs no V1 infrastructure. The
 * three goal tools (`pantheon_goal_create`, `pantheon_goal_get`,
 * `pantheon_goal_update`) are NOT: `GoalLoopDeps` requires a `GoalStore`, a
 * `GoalLoopClient` and a `BackgroundJobBoard`, none of which exist on the V2
 * `PluginContext`, and `getV2BridgeFromContext` resolves to `null` outside V1.
 * They are therefore absent from this surface rather than registered as
 * placeholders that resolve to a message — a placeholder still fails the host's
 * output contract on every call, so it buys nothing. See
 * `V2_UNSUPPORTED_FEATURES` in `../plugin-v2.ts` (marker `goal-tools`).
 *
 * `hashline_edit` (pure filesystem), `pantheon_cost` (reads `opencode.db`) and
 * `pantheon_model` (reads/writes `active-preset.json`) need none of that, so
 * they are wired to their real V1 implementations.
 *
 * ## The output declaration is mandatory
 *
 * The host enforces a biconditional between a tool's declared `output` and the
 * value its `execute` resolves to (opencode 2.0.22):
 *
 *   `def.output === undefined` and `'output' in result`   -> throws
 *     "Tool result declared output without an output schema"
 *   `def.output !== undefined` and `!('output' in result)` -> throws
 *     "Tool did not return its declared output"
 *
 * Declaring `output` and returning it are therefore one decision, not two. The
 * first branch is the historical Pantheon defect; the second is why the two
 * must move together. `V2ToolDef` makes the field required so TypeScript
 * rejects a tool that forgets it.
 *
 * @module pantheon/v2-tools
 */

import { createCostCommand } from './cost-command.ts'
import { createHashlineEditTool, type HashlineToolResult } from './hashline/tool.ts'
import { createModelCommand } from './model-command.ts'
import type { ToolContextLike } from './tool-context.ts'

// ─── Contract types ─────────────────────────────────────────────────────

/**
 * V2 tool result shape.
 *
 * The V1 SDK types `ToolResult` as `string | { output: string, ... }`, but the
 * V2 beta host reads a field off the resolved value and throws when a tool
 * resolves to a bare string. Always resolve to the object shape — it satisfies
 * both the SDK union and the beta host.
 *
 * `title` and `metadata` are part of the shape because `hashline_edit` returns
 * them on success (see `HashlineToolResult`); the host spreads `metadata`
 * through when present, so they are carried rather than dropped.
 */
export interface V2ToolResult {
  output: string
  title?: string
  metadata?: Record<string, unknown>
}

/**
 * A V2 tool definition ready for registration.
 *
 * `output` is REQUIRED, not optional: an omitted declaration is precisely the
 * condition the host rejects at runtime, so making it optional would let the
 * defect return silently.
 */
export interface V2ToolDef {
  name: string
  description: string
  input: Record<string, unknown>
  output: Record<string, unknown>
  execute: (input: Record<string, unknown>, context: unknown) => Promise<V2ToolResult>
}

// ─── Context adapter ────────────────────────────────────────────────────

/**
 * Project the host's V2 tool context onto the structural `ToolContextLike`.
 *
 * The host may omit `directory`/`worktree`; `hashline_edit` then falls back to
 * `process.cwd()` through its own `resolveFile` containment guard, so an absent
 * field degrades safely rather than throwing.
 */
function toolContext(context: unknown): ToolContextLike {
  const ctx = (context ?? {}) as Partial<ToolContextLike>
  return {
    sessionID: typeof ctx.sessionID === 'string' ? ctx.sessionID : 'v2-unknown',
    // Spread rather than assign `undefined`: the project compiles with
    // exactOptionalPropertyTypes, so an explicit undefined is not assignable.
    ...(typeof ctx.directory === 'string' ? { directory: ctx.directory } : {}),
    ...(typeof ctx.worktree === 'string' ? { worktree: ctx.worktree } : {}),
    ...(typeof ctx.agent === 'string' ? { agent: ctx.agent } : {}),
  }
}

/** Error text for an unexpected throw, without leaking a stack trace. */
function errorText(prefix: string, err: unknown): string {
  return `${prefix}: ${err instanceof Error ? err.message : String(err)}`
}

// ─── hashline_edit ──────────────────────────────────────────────────────

/** JSON Schema for `hashline_edit`, mirroring the V1 zod args exactly. */
const HASHLINE_EDIT_INPUT: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'edits'],
  properties: {
    file: {
      type: 'string',
      minLength: 1,
      description: 'File to edit. Absolute, or relative to the worktree.',
    },
    edits: {
      type: 'array',
      minItems: 1,
      description:
        'Edits to apply. All refs are validated against the ORIGINAL file before anything is written.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op', 'ref'],
        properties: {
          op: { type: 'string', enum: ['replace', 'append', 'prepend', 'delete'] },
          ref: {
            type: 'string',
            minLength: 1,
            description: 'Anchor ref "LINE#TAG" against the ORIGINAL snapshot.',
          },
          endRef: {
            type: 'string',
            minLength: 1,
            description: 'Optional range end for replace/delete, as "LINE#TAG".',
          },
          lines: {
            type: 'array',
            items: { type: 'string' },
            description: 'Replacement lines (replace only).',
          },
          content: {
            type: 'string',
            description: 'Text to insert (append/prepend); split on newlines.',
          },
        },
      },
    },
  },
}

/** Coerced `hashline_edit` args, structurally equal to the V1 zod inference. */
interface HashlineEditArgs {
  file: string
  edits: Array<{
    op: 'replace' | 'append' | 'prepend' | 'delete'
    ref: string
    endRef?: string
    lines?: string[]
    content?: string
  }>
}

const HASHLINE_OPS = new Set(['replace', 'append', 'prepend', 'delete'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Re-validate the host-provided input against the declared JSON Schema.
 *
 * The host validates `input` before `execute`, but this wrapper is also the
 * direct programmatic entry point (tests, embedded callers), so it must not
 * assume a pre-validated shape. Failures are returned as error-as-text, the
 * same contract the V1 tool uses for user errors.
 */
function coerceHashlineEditArgs(input: Record<string, unknown>):
  | {
      ok: true
      args: HashlineEditArgs
    }
  | { ok: false; error: string } {
  const file = input.file
  if (typeof file !== 'string' || file.length === 0) {
    return { ok: false, error: 'hashline_edit: "file" must be a non-empty string' }
  }
  const rawEdits = input.edits
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
    return { ok: false, error: 'hashline_edit: "edits" must be a non-empty array' }
  }
  const edits: HashlineEditArgs['edits'] = []
  for (const [i, raw] of rawEdits.entries()) {
    if (!isRecord(raw)) {
      return { ok: false, error: `hashline_edit: edit (index ${i}) must be an object` }
    }
    const op = raw.op
    if (typeof op !== 'string' || !HASHLINE_OPS.has(op)) {
      return {
        ok: false,
        error: `hashline_edit: edit (index ${i}) "op" must be one of replace, append, prepend, delete`,
      }
    }
    const ref = raw.ref
    if (typeof ref !== 'string' || ref.length === 0) {
      return {
        ok: false,
        error: `hashline_edit: edit (index ${i}) "ref" must be a non-empty string`,
      }
    }
    let lines: string[] | undefined
    if (raw.lines !== undefined) {
      if (!Array.isArray(raw.lines) || raw.lines.some((l) => typeof l !== 'string')) {
        return {
          ok: false,
          error: `hashline_edit: edit (index ${i}) "lines" must be a string array`,
        }
      }
      lines = raw.lines as string[]
    }
    if (raw.content !== undefined && typeof raw.content !== 'string') {
      return { ok: false, error: `hashline_edit: edit (index ${i}) "content" must be a string` }
    }
    if (raw.endRef !== undefined && typeof raw.endRef !== 'string') {
      return { ok: false, error: `hashline_edit: edit (index ${i}) "endRef" must be a string` }
    }
    edits.push({
      op: op as HashlineEditArgs['edits'][number]['op'],
      ref,
      // Conditional spread: exactOptionalPropertyTypes forbids `prop: undefined`.
      ...(typeof raw.endRef === 'string' ? { endRef: raw.endRef } : {}),
      ...(lines === undefined ? {} : { lines }),
      ...(typeof raw.content === 'string' ? { content: raw.content } : {}),
    })
  }
  return { ok: true, args: { file, edits } }
}

const hashlineEdit = createHashlineEditTool()

/**
 * Wrap the V1 `hashline_edit` tool for the V2 surface.
 *
 * The V1 tool returns error-as-text for user errors and the success object
 * `{ title, output, metadata }`. Both are carried: the `output` string always
 * satisfies the host's declaration, and `title`/`metadata` survive because the
 * host spreads metadata through.
 */
async function executeHashlineEdit(
  input: Record<string, unknown>,
  context: unknown,
): Promise<V2ToolResult> {
  const coerced = coerceHashlineEditArgs(input)
  if (!coerced.ok) return { output: coerced.error }
  let result: HashlineToolResult
  try {
    result = await hashlineEdit.execute(coerced.args, toolContext(context))
  } catch (err: unknown) {
    // The V1 tool does not throw for user errors; this is defence in depth so
    // an unexpected throw surfaces as text instead of an absent tool result.
    return { output: errorText('hashline_edit failed', err) }
  }
  if (typeof result === 'string') return { output: result }
  return {
    output: result.output,
    ...(result.title === undefined ? {} : { title: result.title }),
    ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
  }
}

// ─── pantheon_cost ──────────────────────────────────────────────────────

/** JSON Schema for `pantheon_cost`, mirroring the V1 zod args. */
const COST_INPUT: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    days: {
      type: 'integer',
      minimum: 1,
      maximum: 365,
      description: 'Reporting window in days (default 7).',
    },
  },
}

/** Validate `days` exactly as the V1 zod schema does; absent means default. */
function coerceDays(value: unknown): { ok: true; days?: number } | { ok: false; error: string } {
  if (value === undefined) return { ok: true }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 365) {
    return { ok: false, error: 'pantheon_cost: "days" must be an integer between 1 and 365' }
  }
  return { ok: true, days: value }
}

const costCommand = createCostCommand()

async function executeCost(
  input: Record<string, unknown>,
  context: unknown,
): Promise<V2ToolResult> {
  const days = coerceDays(input.days)
  if (!days.ok) return { output: days.error }
  // The V1 tool already wraps its whole body and reports failures as text.
  const output = await costCommand.pantheon_cost.execute({ days: days.days }, toolContext(context))
  return { output }
}

// ─── pantheon_model ─────────────────────────────────────────────────────

/** JSON Schema for `pantheon_model`, mirroring the V1 zod args. */
const MODEL_INPUT: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'show', 'set', 'reset'],
      description: 'Operation to perform. Defaults to status when agent/model are absent.',
    },
    agent: { type: 'string', description: 'Agent name (one of the 14 canonical agents).' },
    model: { type: 'string', description: 'Model in provider/model-id format; used by set.' },
    effort: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: 'Reasoning effort (variant), clamped to model capability.',
    },
    scope: {
      type: 'string',
      enum: ['project', 'global'],
      description: 'Scope for active-preset.json (default project).',
    },
    confirm: {
      type: 'boolean',
      description: 'Explicit confirmation for a mutating operation; required for global changes.',
    },
    authorize_global: {
      type: 'boolean',
      description: 'Separate authorization for global configuration; not implied by confirm.',
    },
  },
}

const WIZARD_UNAVAILABLE =
  'the interactive wizard has no user in the V2 tool surface — pass action="status" to read ' +
  'the current overrides, or pass agent and model explicitly for action="set"'

/**
 * The V1 command falls back to an interactive readline prompt when invoked
 * with no arguments. A tool call has no user at the terminal, so that fallback
 * would block the call until it timed out. `ask` is injected to refuse
 * deterministically instead, which routes through the command's own
 * `wizard canceled` error path rather than forking its logic.
 */
const modelCommand = createModelCommand({
  ask: () => Promise.reject(new Error(WIZARD_UNAVAILABLE)),
})

async function executeModel(
  input: Record<string, unknown>,
  context: unknown,
): Promise<V2ToolResult> {
  // The V1 tool validates its own args (zod) and reports failures as text.
  const output = await modelCommand.pantheon_model.execute(
    input as Parameters<typeof modelCommand.pantheon_model.execute>[0],
    toolContext(context),
  )
  return { output }
}

// ─── Tool set ───────────────────────────────────────────────────────────

/**
 * Build the V2 tool definitions.
 *
 * Every entry declares `output`. An empty object is the host's own marker for
 * "declared, unconstrained" (its MCP bridge uses `output: g.outputSchema ??
 * {}`), so it satisfies the declaration without adding a second way for a tool
 * to fail validation. The protection against forgetting the field is the
 * required `output` on `V2ToolDef`, not the emptiness of this schema.
 *
 * The three tool instances (`hashlineEdit`, `costCommand`, `modelCommand`) are
 * module-level consts created once at import, not per call. What matters for
 * this function is only that it allocates a fresh descriptor array each call,
 * so a caller cannot mutate another's definitions. None of the three factories
 * performs filesystem or database work at construction, so importing this
 * module stays side-effect free.
 */
export function createV2ToolDefinitions(): V2ToolDef[] {
  return [
    {
      name: 'hashline_edit',
      description:
        'Edit a file anchored by hashline refs (LINE#TAG) instead of raw line numbers. ' +
        'Ops: replace (ref..endRef or single ref → lines), append/prepend (anchor ref → content), ' +
        'delete (ref..endRef). ALL refs must be validated against the ORIGINAL file before ' +
        'anything is written; on mismatch the tool returns an error with a re-tagged excerpt ' +
        'and a Did-you-mean suggestion, and nothing is modified.',
      input: HASHLINE_EDIT_INPUT,
      output: {},
      execute: executeHashlineEdit,
    },
    {
      name: 'pantheon_cost',
      description:
        'Report input, output, and total token usage by agent and phase over the last N days, ' +
        'read from opencode.db (read-only, no monetary values).',
      input: COST_INPUT,
      output: {},
      execute: executeCost,
    },
    {
      name: 'pantheon_model',
      description:
        'Show, set, or reset per-agent model overrides in active-preset.json (project or global). ' +
        'Overrides win over preset; env preset wins over file. Never writes .env or top-level ' +
        'model/small_model. Pass action="status" to read the current overrides; unlike the V1 ' +
        'command there is no interactive wizard on this surface.',
      input: MODEL_INPUT,
      output: {},
      execute: executeModel,
    },
  ]
}
