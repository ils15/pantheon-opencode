/**
 * V2 tool surface — the Pantheon tools that are self-sufficient on the
 * OpenCode V2 host, declared for `ctx.tool.transform`'s `draft.add`.
 *
 * ## Why four unconditional tools
 *
 * A V2 tool can only be served here when it needs no V1 infrastructure. The
 * three goal tools (`pantheon_goal_create`, `pantheon_goal_get`,
 * `pantheon_goal_update`) are NOT: `GoalLoopDeps` requires a `GoalStore`, a
 * `GoalLoopClient` and a `BackgroundJobBoard`, none of which exist on the V2
 * `PluginContext`, and `getV2BridgeFromContext` resolves to `null` outside V1.
 * They are therefore absent from this surface rather than registered as
 * placeholders that resolve to a message — a placeholder still fails the host's
 * output contract on every call, so it buys nothing. See
 * `V2_UNSUPPORTED_FEATURES` in `../plugin.ts` (marker `goal-tools`).
 *
 * `hashline_edit` (pure filesystem), `pantheon_cost` (reads `opencode.db`),
 * `pantheon_model` (reads/writes `active-preset.json`), and the local-only
 * `pantheon_local_decision` selector need none of that. Its execution rejects
 * any host context that does not identify Zeus.
 *
 * ## Four unconditional tools, up to two host-dependent ones
 *
 * The four above are always built. Two more exist on the V2 host and are
 * conditional: `vision_describe` is added here when the caller supplies a
 * vision runtime (the host model catalog), and `pantheon_bounded_read` is
 * appended by the plugin when the host exposes its permission and session APIs
 * (root Zeus sessions only). The effective count is therefore 4 unconditional
 * plus up to 2 host-dependent.
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
 * @module pantheon/tools
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { createCostCommand } from './cost-command.ts'
import type { ShadowSink } from './decision-shadow.ts'
import { createDeepworkTool } from './deepwork/deepwork-tool.ts'
import { createHashlineEditTool, type HashlineToolResult } from './hashline/tool.ts'
import { createV2JevDecisionDefinition, type V2JevDecisionRuntime } from './jev-decision-tool.ts'
import { createV2LocalDecisionDefinition } from './local-decision-tool.ts'
import { createModelCommand } from './model-command.ts'
import { createV2VisionTool, type V2VisionRuntime } from './native-vision.ts'
import { createV2SkillSearchDefinition } from './skill-search-tool.ts'
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
    session: {
      type: 'string',
      minLength: 1,
      description:
        'Root session id. The report is scoped to that session plus every descendant session in its subtree.',
    },
    refreshPricing: {
      type: 'boolean',
      description:
        'Await a models.dev price refresh (bounded by a short timeout) instead of using the cached catalog. This is the only path that waits on the network.',
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

/** Validate `session` exactly as the V1 zod schema does; absent means no scope. */
function coerceSession(
  value: unknown,
): { ok: true; session?: string } | { ok: false; error: string } {
  if (value === undefined) return { ok: true }
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: 'pantheon_cost: "session" must be a non-empty string' }
  }
  return { ok: true, session: value }
}

/** Validate `refreshPricing` exactly as the V1 zod schema does; absent means cached. */
function coerceRefreshPricing(
  value: unknown,
): { ok: true; refreshPricing?: boolean } | { ok: false; error: string } {
  if (value === undefined) return { ok: true }
  if (typeof value !== 'boolean') {
    return { ok: false, error: 'pantheon_cost: "refreshPricing" must be a boolean' }
  }
  return { ok: true, refreshPricing: value }
}

const costCommand = createCostCommand()

/**
 * Executes the `pantheon_cost` tool: generates token usage and cost report in USD
 * per agent/phase, model, and session over the last N days, reading opencode.db (read-only).
 */
async function executeCost(
  input: Record<string, unknown>,
  context: unknown,
): Promise<V2ToolResult> {
  const days = coerceDays(input.days)
  if (!days.ok) return { output: days.error }
  const session = coerceSession(input.session)
  if (!session.ok) return { output: session.error }
  const refreshPricing = coerceRefreshPricing(input.refreshPricing)
  if (!refreshPricing.ok) return { output: refreshPricing.error }
  // Every accepted option is forwarded: a schema the host validates but the
  // wrapper drops would be a tool that silently ignores its own arguments.
  // The V1 tool already wraps its whole body and reports failures as text.
  const output = await costCommand.pantheon_cost.execute(
    {
      ...(days.days === undefined ? {} : { days: days.days }),
      ...(session.session === undefined ? {} : { session: session.session }),
      ...(refreshPricing.refreshPricing === undefined
        ? {}
        : { refreshPricing: refreshPricing.refreshPricing }),
    },
    toolContext(context),
  )
  return { output }
}

// ─── pantheon_model ─────────────────────────────────────────────────────

/** JSON Schema for V2 `pantheon_model`; global scope is intentionally absent. */
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
      enum: ['project'],
      description: 'Project scope only; global overrides are not supported in V2.',
    },
  },
}

const modelCommand = createModelCommand({ v2Mode: true })

async function executeModel(
  input: Record<string, unknown>,
  context: unknown,
): Promise<V2ToolResult> {
  if (input.scope !== undefined && input.scope !== 'project') {
    return { output: 'Error: V2 pantheon_model is project-only; global scope is not supported.' }
  }
  if (Object.hasOwn(input, 'confirm') || Object.hasOwn(input, 'authorize_global')) {
    return {
      output:
        'Error: V2 pantheon_model does not accept authorization flags; global authorization is not supported by this tool.',
    }
  }
  // The V1 tool validates its own args (zod) and reports failures as text.
  const output = await modelCommand.pantheon_model.execute(
    input as Parameters<typeof modelCommand.pantheon_model.execute>[0],
    toolContext(context),
  )
  return { output }
}

// ─── Tool set ───────────────────────────────────────────────────────────

/**
 * Optional shadow sinks wired at tool registration.
 *
 * `complexity` belongs to P3, whose declared host surface is `tool.invoke`: the
 * local selector's own input carries the complexity vector and gate status, so
 * the observation is constructed where the payload can actually feed it.
 */
export interface V2ToolShadowOptions {
  readonly complexitySink?: ShadowSink
}

/**
 * Build the V2 tool definitions.
 *
 * Every entry declares `output`. An empty object is the host's own marker for
 * "declared, unconstrained" (its MCP bridge uses `output: g.outputSchema ??
 * {}`), so it satisfies the declaration without adding a second way for a tool
 * to fail validation. The protection against forgetting the field is the
 * required `output` on `V2ToolDef`, not the emptiness of this schema.
 *
 * The existing tool instances (`hashlineEdit`, `costCommand`, `modelCommand`)
 * are module-level consts created once at import. The local selector is a
 * per-call definition with no construction-time I/O. A fresh descriptor array
 * prevents callers from mutating another registration's definitions.
 */
/** JSON Schema for `todowrite` — the TUI todo panel's feed (full replace). */
const TODOWRITE_INPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['todos'],
  properties: {
    todos: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['content', 'status'],
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 500 },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
        },
      },
    },
  },
} as const

let latestSessionTodos: unknown[] = []

export function getLatestSessionTodos(): unknown[] {
  return latestSessionTodos
}

export function setLatestSessionTodos(todos: unknown[]): void {
  latestSessionTodos = todos
}

/** A V2 pass-through `todowrite`: the host stores the tool part in the
 * transcript, and the TUI todo panel renders the newest completed write. The
 * tool itself is stateless — the transcript IS the store. */
const todowriteTool: V2ToolDef = {
  name: 'todowrite',
  description:
    'Write the session task checklist (full replace). The TUI todo panel renders the ' +
    'newest list; mark each item in_progress/completed as soon as its state changes.',
  input: TODOWRITE_INPUT,
  output: {},
  execute: async (input) => {
    const rawTodos = (input as Record<string, unknown>).todos
    const todos: unknown[] = Array.isArray(rawTodos) ? (rawTodos as unknown[]) : []
    latestSessionTodos = todos
    return { ok: true, todos, output: JSON.stringify({ todos }) }
  },
}

const TODOREAD_INPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: {
      type: 'string',
      description: 'Optional filter by task status (pending, in_progress, completed, cancelled)',
    },
  },
} as const

/** A V2 `todoread`: returns the newest task list written via `todowrite`. */
const todoreadTool: V2ToolDef = {
  name: 'todoread',
  description:
    'Read the active session task checklist. Returns the newest list of tasks written via todowrite.',
  input: TODOREAD_INPUT,
  output: {},
  execute: async (input) => {
    const statusFilter = (input as Record<string, unknown>)?.status
    let todos = latestSessionTodos
    if (typeof statusFilter === 'string' && statusFilter.trim() !== '') {
      todos = todos.filter(
        (t) =>
          typeof t === 'object' &&
          t !== null &&
          (t as Record<string, unknown>).status === statusFilter,
      )
    }
    return {
      ok: true,
      todos,
      output: JSON.stringify({ todos }),
    }
  },
}

const execAsync = promisify(exec)

const SHELL_INPUT = {
  type: 'object',
  required: ['command'],
  properties: {
    command: {
      type: 'string',
      description: 'The shell command to execute in the workspace directory',
    },
  },
} as const

/**
 * A V2 fallback shell tool alias. OpenCode registers `bash`, but models frequently
 * attempt to invoke `shell` because of agent permission YAML conventions.
 * This alias ensures terminal commands execute seamlessly without tool-not-found errors.
 */
const shellTool: V2ToolDef = {
  name: 'shell',
  description: 'Execute a shell command in the workspace directory. Alias for bash execution.',
  input: SHELL_INPUT,
  output: {},
  execute: async (input, context) => {
    const command = String((input as Record<string, unknown>).command ?? '')
    if (!command.trim()) {
      return { output: '', ok: false, error: 'Command cannot be empty' }
    }
    const toolCtx = toolContext(context)
    const cwd = toolCtx.directory || process.cwd()
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        shell: '/bin/bash',
      })
      const output = [stdout, stderr].filter(Boolean).join('\n')
      return { output, ok: true }
    } catch (err: unknown) {
      const execError = err as { stdout?: string; stderr?: string; message?: string }
      const output = [execError.stdout, execError.stderr, execError.message]
        .filter(Boolean)
        .join('\n')
      return { output, ok: false, error: output }
    }
  },
}

export function createV2ToolDefinitions(
  visionRuntime?: V2VisionRuntime,
  shadow: V2ToolShadowOptions = {},
  jevRuntime?: V2JevDecisionRuntime,
): V2ToolDef[] {
  const definitions: V2ToolDef[] = [
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
        'Report token usage and USD cost by agent and phase, by model, and by session, over the ' +
        'last N days from opencode.db (read-only). Costs come from the models.dev catalog cached ' +
        'on disk: a call reads that cache and never waits on the network unless refreshPricing is ' +
        'set, a stale cache is refreshed in the background and the report says so, and an unpriced ' +
        'model reads — and is excluded from the totals, which then say partial. Pass session=<root ' +
        'session id> to aggregate that session plus its descendant sessions. Phase may be unknown ' +
        'on V2; costs are catalog list prices, not an invoice.',
      input: COST_INPUT,
      output: {},
      execute: executeCost,
    },
    {
      name: 'pantheon_model',
      description:
        'Show, set, or reset explicit per-agent project-scoped model overrides in active-preset.json. ' +
        'V2 ignores static preset names and PANTHEON_MODEL_PRESET; no wizard or implicit model ' +
        'selection. Global overrides are not read or written in V2; future global support requires ' +
        'separate explicit authorization. Pass action="status" to read project-scoped overrides. ' +
        'Never writes .env or top-level model/small_model.',
      input: MODEL_INPUT,
      output: {},
      execute: executeModel,
    },
  ]
  definitions.push(
    createV2LocalDecisionDefinition({
      ...(shadow.complexitySink === undefined ? {} : { sink: shadow.complexitySink }),
    }),
  )
  definitions.push(todowriteTool)
  definitions.push(todoreadTool)
  definitions.push(shellTool)
  definitions.push(createV2SkillSearchDefinition())
  definitions.push(createDeepworkTool())
  if (visionRuntime) definitions.push(createV2VisionTool(visionRuntime))
  if (jevRuntime) definitions.push(createV2JevDecisionDefinition(jevRuntime))
  return definitions
}
