/**
 * Dynamic Context Pruning (DCP) for the OpenCode V2 runtime.
 *
 * The V2 host hands an in-place mutable `messages` array to
 * `session.hook('compaction', …)` right before it is sent to the summarization
 * model. Pruning that array is safe: it changes only what feeds the summary,
 * never the persisted session. The same engine is exposed behind an explicit
 * opt-in on the per-request `context` hook, where it also invalidates the
 * provider prompt cache — hence `context_pruner.enabled` defaults to `false`.
 *
 * Message shape measured on `opencode v2.1.2` (see CHANGELOG):
 *
 *   user/assistant text  { id?, role, content: [{ type: 'text', text }], metadata? }
 *   assistant tool call  { id?, role: 'assistant',
 *                          content: [{ type: 'tool-call', id, name, input, providerExecuted }] }
 *   tool result          { role: 'tool',
 *                          content: [{ type: 'tool-result', id, name,
 *                                      result: { type: 'text'|'error', value },
 *                                      providerExecuted }] }
 *
 * There is no `parts` field and tool messages carry no `id`/`metadata`. This
 * module never deletes a message, never reorders, never changes a role, and
 * never touches `system`. Every rule only rewrites a part's `result` or
 * `input`, which is why the provider serializer keeps working.
 *
 * Rules (v1, deliberately small):
 *   1. dedup  — identical (tool name, normalized input) invocations keep the
 *               MOST RECENT result verbatim; earlier result bodies become a
 *               short marker placeholder;
 *   2. purge  — arguments of tool calls that failed are blanked after N turns,
 *               leaving the error message itself visible;
 *   3. window — the last K turns are never touched (default 4);
 *   4. guard  — configured tool names (default: delegation + skill loads) are
 *               never touched;
 *   5. idem   — placeholders carry `[pantheon-prune:v1 …]`; a second pass over
 *               an already-pruned array finds nothing to do;
 *   6. floor  — below ~200 estimated tokens saved, nothing is mutated, so a
 *               provider prompt cache is not invalidated for nothing.
 *
 * Pure: no host imports, no I/O, no LLM, no tokenizer. Characters/4 is the
 * estimate. Never throws — every unexpected shape fails open (no mutation).
 *
 * @module context-pruner
 */

/** Stable prefix carried by every placeholder this module writes. */
export const PRUNE_MARKER = '[pantheon-prune:v1'

/** Which hook asked for the prune — echoed in the one-line log entry. */
export type PruneSite = 'compaction' | 'context'

/** Why a pass made no change (`null` when it did prune). */
export type PruneSkipReason = 'not-array' | 'malformed' | 'below-threshold' | 'no-candidates'

export interface ContextPrunerConfig {
  /**
   * Per-request (`context` hook) opt-in. The compaction site always applies
   * the rules; this flag only gates the cache-invalidating per-request site.
   */
  enabled: boolean
  /** Number of trailing turns left untouched. */
  keepTurns: number
  /** Minimum turns between a failed call and its argument purge. */
  purgeAfterTurns: number
  /** Tool names no rule may touch. */
  protectedTools: string[]
  /** Estimated-token floor below which nothing is mutated. */
  minSavingsTokens: number
  /** Characters-per-token heuristic divisor. */
  charsPerToken: number
}

export interface PruneStats {
  site: PruneSite
  changed: boolean
  /** Distinct messages whose parts were rewritten. */
  messagesTouched: number
  /** Parts rewritten (a message may contain several). */
  partsPruned: number
  estimatedCharsSaved: number
  /** `ceil(charsSaved / charsPerToken)`. */
  estimatedTokensSaved: number
  skipReason: PruneSkipReason | null
}

/** Defaults. `enabled:false` is the documented cache-safety decision. */
export const DEFAULT_CONTEXT_PRUNER_CONFIG: ContextPrunerConfig = {
  enabled: false,
  keepTurns: 4,
  purgeAfterTurns: 2,
  protectedTools: ['subagent', 'task', 'skill'],
  minSavingsTokens: 200,
  charsPerToken: 4,
}

/**
 * Read `options.context_pruner` (the V2 config copy, mirroring how
 * `context_sandbox` is read). Malformed input yields the defaults — config
 * parsing must never take the hook down.
 */
export function resolveContextPrunerConfig(options: unknown): ContextPrunerConfig {
  try {
    const raw = (options as { context_pruner?: unknown } | null | undefined)?.context_pruner
    if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        ...DEFAULT_CONTEXT_PRUNER_CONFIG,
        protectedTools: [...DEFAULT_CONTEXT_PRUNER_CONFIG.protectedTools],
      }
    }
    const obj = raw as Record<string, unknown>
    const num = (value: unknown, fallback: number, min: number): number => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
      return Math.max(min, Math.floor(value))
    }
    let protectedTools = [...DEFAULT_CONTEXT_PRUNER_CONFIG.protectedTools]
    if (Array.isArray(obj.protectedTools)) {
      const names = obj.protectedTools
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
      protectedTools = [...new Set(names)]
    }
    return {
      enabled: typeof obj.enabled === 'boolean' ? obj.enabled : false,
      keepTurns: num(obj.keepTurns, DEFAULT_CONTEXT_PRUNER_CONFIG.keepTurns, 0),
      purgeAfterTurns: num(obj.purgeAfterTurns, DEFAULT_CONTEXT_PRUNER_CONFIG.purgeAfterTurns, 0),
      protectedTools,
      minSavingsTokens: num(
        obj.minSavingsTokens,
        DEFAULT_CONTEXT_PRUNER_CONFIG.minSavingsTokens,
        0,
      ),
      charsPerToken: num(obj.charsPerToken, DEFAULT_CONTEXT_PRUNER_CONFIG.charsPerToken, 1),
    }
  } catch {
    return {
      ...DEFAULT_CONTEXT_PRUNER_CONFIG,
      protectedTools: [...DEFAULT_CONTEXT_PRUNER_CONFIG.protectedTools],
    }
  }
}

/** The keys `resolveContextPrunerConfig` understands, in documented order. */
export const CONTEXT_PRUNER_CONFIG_KEYS = [
  'enabled',
  'keepTurns',
  'purgeAfterTurns',
  'protectedTools',
  'minSavingsTokens',
  'charsPerToken',
] as const

/**
 * Describe why a `context_pruner` block would be partially ignored, without
 * changing the fail-open resolution. An empty array means "absent or fully
 * valid". Unknown keys are reported because a silent typo (`keepTurn` instead
 * of `keepTurns`) is otherwise invisible: the engine keeps its default and the
 * operator believes the setting took effect.
 */
export function describeContextPrunerConfigIssues(options: unknown): string[] {
  try {
    const raw = (options as { context_pruner?: unknown } | null | undefined)?.context_pruner
    if (raw === undefined || raw === null) return []
    if (typeof raw !== 'object' || Array.isArray(raw)) return ['context_pruner is not an object']
    const obj = raw as Record<string, unknown>
    const issues: string[] = []
    const accepted = CONTEXT_PRUNER_CONFIG_KEYS as readonly string[]
    for (const key of Object.keys(obj)) {
      if (!accepted.includes(key)) issues.push(`unknown key "${key}"`)
    }
    const numberField = (key: string, min: number): void => {
      if (!(key in obj)) return
      const value = obj[key]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push(`"${key}" must be a number`)
        return
      }
      if (value < min) issues.push(`"${key}" must be >= ${min}`)
    }
    if ('enabled' in obj && typeof obj.enabled !== 'boolean') {
      issues.push('"enabled" must be a boolean')
    }
    numberField('keepTurns', 0)
    numberField('purgeAfterTurns', 0)
    numberField('minSavingsTokens', 0)
    numberField('charsPerToken', 1)
    if ('protectedTools' in obj) {
      const tools = obj.protectedTools
      if (!Array.isArray(tools) || tools.some((entry) => typeof entry !== 'string')) {
        issues.push('"protectedTools" must be an array of strings')
      }
    }
    return issues
  } catch {
    return ['context_pruner could not be inspected']
  }
}

// ─── Internal shapes ────────────────────────────────────────────────────
type JsonObject = Record<string, unknown>

interface ToolCallRef {
  messageIndex: number
  part: JsonObject
  id: string
  name: string
}

interface PlannedEdit {
  messageIndex: number
  partIndex: number
  part: JsonObject
  field: 'input' | 'result'
  next: unknown
  charsSaved: number
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** JSON length used only for the savings estimate; 0 when unserializable. */
function jsonLength(value: unknown): number {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text.length : 0
  } catch {
    return 0
  }
}

/** Deterministic key for an input object: sorted keys, arrays in order. */
function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableKey(entry)).join(',')}]`
  if (isObject(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableKey(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null) ?? 'undefined'
}

function markersMatch(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(PRUNE_MARKER)
}

function isPrunedResult(part: JsonObject): boolean {
  const result = part.result
  return isObject(result) && markersMatch(result.value)
}

/** A failed tool result — never a redundant copy, never a valid survivor body. */
function isErrorResult(part: JsonObject): boolean {
  return isObject(part.result) && part.result.type === 'error'
}

function isPurgedInput(input: unknown): boolean {
  return isObject(input) && typeof input[PRUNE_MARKER] === 'string'
}

function supersededText(name: string): string {
  return `${PRUNE_MARKER} superseded tool=${name}] Earlier invocation with identical arguments was superseded by a later call; its output was removed.`
}

function purgedInput(name: string, id: string): JsonObject {
  return { [PRUNE_MARKER]: 'args-purged', tool: name, call: id }
}

/**
 * Assign a turn index to every message.
 *
 * A turn is one user input or one assistant step, whichever comes first; tool
 * results belong to the step that requested them. The trailing `keepTurns`
 * turns are protected. `system` messages (preamble) get `-1` and are never
 * candidates because no rule touches them. When the array opens with tool or
 * assistant messages, turn 0 covers that prefix.
 */
function assignTurns(roles: string[]): { turnOf: number[]; totalTurns: number } {
  const turnOf = new Array<number>(roles.length).fill(0)
  let turn = -1
  let previousWasUser = false
  for (let i = 0; i < roles.length; i++) {
    const role = roles[i]
    if (role === 'system') {
      turnOf[i] = -1
      continue
    }
    if (role === 'user') {
      if (!previousWasUser) turn += 1
      previousWasUser = true
    } else if (role === 'assistant') {
      turn += 1
      previousWasUser = false
    } else {
      previousWasUser = false
      if (turn < 0) turn = 0
    }
    turnOf[i] = turn
  }
  return { turnOf, totalTurns: turn + 1 }
}

/** Every `tool-call` part that may participate in dedup. */
function collectCalls(
  messages: unknown[],
  roles: string[],
  protectedTools: Set<string>,
): ToolCallRef[] {
  const calls: ToolCallRef[] = []
  for (let i = 0; i < messages.length; i++) {
    if (roles[i] !== 'assistant') continue
    const content = (messages[i] as JsonObject).content
    if (!Array.isArray(content)) continue
    for (const raw of content) {
      if (!isObject(raw) || raw.type !== 'tool-call') continue
      const id = raw.id
      const name = raw.name
      if (typeof id !== 'string' || id === '' || typeof name !== 'string' || name === '') continue
      if (protectedTools.has(name)) continue
      if (!isObject(raw.input) || isPurgedInput(raw.input)) continue
      calls.push({ messageIndex: i, part: raw, id, name })
    }
  }
  return calls
}

/** First `tool-result` part carrying the given call id, scanning forward. */
function findResult(
  messages: unknown[],
  fromIndex: number,
  id: string,
): { messageIndex: number; partIndex: number; part: JsonObject } | null {
  for (let i = Math.max(0, fromIndex); i < messages.length; i++) {
    const message = messages[i]
    if (!isObject(message) || message.role !== 'tool' || !Array.isArray(message.content)) continue
    for (let p = 0; p < message.content.length; p++) {
      const raw = message.content[p]
      if (!isObject(raw) || raw.type !== 'tool-result') continue
      if (raw.id !== id) continue
      return { messageIndex: i, partIndex: p, part: raw }
    }
  }
  return null
}

/** Locate the `tool-call` part for a result id (used by the purge rule). */
function findCallById(
  messages: unknown[],
  id: string,
): { messageIndex: number; partIndex: number; part: JsonObject } | null {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (!isObject(message) || !Array.isArray(message.content)) continue
    for (let p = 0; p < message.content.length; p++) {
      const raw = message.content[p]
      if (!isObject(raw) || raw.type !== 'tool-call') continue
      if (raw.id !== id) continue
      return { messageIndex: i, partIndex: p, part: raw }
    }
  }
  return null
}

function emptyStats(site: PruneSite, skipReason: PruneSkipReason | null): PruneStats {
  return {
    site,
    changed: false,
    messagesTouched: 0,
    partsPruned: 0,
    estimatedCharsSaved: 0,
    estimatedTokensSaved: 0,
    skipReason,
  }
}

// ─── Engine ─────────────────────────────────────────────────────────────

/**
 * Apply the v1 pruning rules to an in-place mutable provider-bound array.
 *
 * Returns statistics; the array is mutated only when the estimated savings
 * reach `minSavingsTokens`. Any unexpected shape returns `changed:false` with
 * the array untouched — this function NEVER throws and never partially
 * applies a pass.
 */
export function pruneMessages(
  messages: unknown,
  config: ContextPrunerConfig,
  site: PruneSite,
): PruneStats {
  try {
    if (!Array.isArray(messages)) return emptyStats(site, 'not-array')
    if (messages.length === 0) return emptyStats(site, 'no-candidates')

    const roles: string[] = []
    for (const message of messages) {
      if (!isObject(message) || !Array.isArray(message.content)) {
        return emptyStats(site, 'malformed')
      }
      roles.push(typeof message.role === 'string' ? message.role : '')
    }

    const { turnOf, totalTurns } = assignTurns(roles)
    const protectedTools = new Set(config.protectedTools)
    const isProtectedTurn = (index: number): boolean =>
      turnOf[index] === -1 || (turnOf[index] as number) >= totalTurns - config.keepTurns

    const edits: PlannedEdit[] = []
    const seen = new Set<string>()
    const plan = (edit: PlannedEdit): void => {
      const key = `${edit.messageIndex}:${edit.partIndex}:${edit.field}`
      if (seen.has(key)) return
      seen.add(key)
      edits.push(edit)
    }

    // Rule 1 — dedup identical invocations, keep the most recent result.
    const groups = new Map<string, ToolCallRef[]>()
    for (const call of collectCalls(messages, roles, protectedTools)) {
      let key: string
      try {
        key = `${call.name}\u0000${stableKey(call.part.input)}`
      } catch {
        continue
      }
      const group = groups.get(key)
      if (group === undefined) groups.set(key, [call])
      else group.push(call)
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue
      // The survivor is the MOST RECENT invocation, and it must carry a real
      // SUCCESSFUL result before any older copy is discarded. An interrupted or
      // aborted call (`call c2` with no `tool-result` yet) or a later failure
      // (`read X` succeeded, the identical retry errored) would otherwise
      // destroy the only body in the group while both sides claim to be
      // "superseded". A placeholder survivor is likewise not a survivor: the
      // real body is already gone, so pruning again only loses more.
      const survivor = group[group.length - 1]
      if (survivor === undefined) continue
      const survivorResult = findResult(messages, survivor.messageIndex + 1, survivor.id)
      if (survivorResult === null) continue
      if (isPrunedResult(survivorResult.part)) continue
      if (isErrorResult(survivorResult.part)) continue

      for (let i = 0; i < group.length - 1; i++) {
        const call = group[i]
        if (call === undefined) continue
        const result = findResult(messages, call.messageIndex + 1, call.id)
        if (result === null) continue
        if (isProtectedTurn(result.messageIndex)) continue
        if (isPrunedResult(result.part)) continue
        // An error is never a redundant copy: its text is the diagnostic the
        // caller needs. Only successful output bodies are deduped; the
        // errored-arguments rule below still blanks the call arguments.
        if (isErrorResult(result.part)) continue
        const next = { type: 'text', value: supersededText(call.name) }
        const saved = jsonLength(result.part.result) - jsonLength(next)
        if (saved <= 0) continue
        plan({
          messageIndex: result.messageIndex,
          partIndex: result.partIndex,
          part: result.part,
          field: 'result',
          next,
          charsSaved: saved,
        })
      }
    }

    // Rule 2 — blank the arguments of failed calls after N turns.
    for (let i = 0; i < messages.length; i++) {
      if (roles[i] !== 'tool') continue
      const content = (messages[i] as JsonObject).content
      if (!Array.isArray(content)) continue
      for (const raw of content) {
        if (!isObject(raw) || raw.type !== 'tool-result') continue
        if (!isObject(raw.result) || raw.result.type !== 'error') continue
        const id = raw.id
        if (typeof id !== 'string' || id === '') continue
        const call = findCallById(messages, id)
        if (call === null) continue
        const name = typeof call.part.name === 'string' ? call.part.name : ''
        if (protectedTools.has(name)) continue
        if (isProtectedTurn(call.messageIndex)) continue
        const turnsAfter = totalTurns - 1 - (turnOf[call.messageIndex] as number)
        if (turnsAfter < config.purgeAfterTurns) continue
        if (!isObject(call.part.input) || isPurgedInput(call.part.input)) continue
        const next = purgedInput(name, id)
        const saved = jsonLength(call.part.input) - jsonLength(next)
        if (saved <= 0) continue
        plan({
          messageIndex: call.messageIndex,
          partIndex: call.partIndex,
          part: call.part,
          field: 'input',
          next,
          charsSaved: saved,
        })
      }
    }

    if (edits.length === 0) return emptyStats(site, 'no-candidates')

    const charsSaved = edits.reduce((sum, edit) => sum + edit.charsSaved, 0)
    const tokensSaved = Math.ceil(charsSaved / config.charsPerToken)
    if (tokensSaved < config.minSavingsTokens) return emptyStats(site, 'below-threshold')

    const touched = new Set<number>()
    const applied: { part: JsonObject; field: 'input' | 'result'; previous: unknown }[] = []
    try {
      for (const edit of edits) {
        applied.push({ part: edit.part, field: edit.field, previous: edit.part[edit.field] })
        edit.part[edit.field] = edit.next
        touched.add(edit.messageIndex)
      }
    } catch {
      // A frozen/exotic part is an unexpected shape: roll back every write so
      // the pass stays atomic and the host never sees a half-pruned array.
      for (const write of applied.reverse()) {
        try {
          write.part[write.field] = write.previous
        } catch {
          // Nothing else can be done; the fields are not writable at all.
        }
      }
      return emptyStats(site, 'malformed')
    }

    return {
      site,
      changed: true,
      messagesTouched: touched.size,
      partsPruned: edits.length,
      estimatedCharsSaved: charsSaved,
      estimatedTokensSaved: tokensSaved,
      skipReason: null,
    }
  } catch {
    return emptyStats(site, 'malformed')
  }
}
