/**
 * WS3 Token-Opt (PR #94) — measurable net token reduction, quality floor.
 *
 * Five levers, each with before/after metering and a NET delta (gross
 * saving minus retrieval/measurement overhead). A lever with net <= 0 is
 * DISABLED by flag (never removed) via `applyGate()`.
 *
 *   1. C9 pre-retrieval Mode-1 — top-k (default 3) per category BEFORE
 *      task()/delegate, relevance cutoff (default 0.3) per category; only
 *      auditable chunks (id + score + text) are injected; injection cost
 *      is debited in `injectedTokens`.
 *   2. 4 meta-tools ceiling + lazy — `memory_search`, `kv_search`,
 *      `code_query` (codemap) and `pantheon://resources` are always on
 *      (real repo names verified); everything else resolves on demand via
 *      pantheon-code-mode `execute_code_script` (search-first discovery).
 *   3. Response filtering + truncation — keep only used MCP fields;
 *      per-turn cap preserving summary (first) + tail (last).
 *   4. TOON encoding — see `toon-codec.ts` (board signals, checkpoints,
 *      KV payloads; per-class savings ~11% content-dominated board records
 *      up to ~49% large tabular checkpoints — see
 *      `docs/ws3-token-opt-measurements.md` — JSON fallback).
 *   5. Schema compression — slim MCP tool descriptions for familiar
 *      tools, full detail on demand.
 *
 * Constraints (PLAN GATE 1): tokens-only accounting (NO monetary layer —
 * this extends WS0 `pantheon_cost`/cost-tracker WITHOUT touching the
 * legacy USD ledger); deterministic metering (NO LLM calls, NO external
 * gateway, NO generative embedding). `estimateTokens` is a fixed
 * chars/4 ceiling so before/after numbers are directly comparable.
 *
 * Kill-switch: `PANTHEON_TOKEN_OPT=off` (see `isTokenOptEnabled`).
 *
 * @module token-opt
 */

import type { ToonValue } from './toon-codec.ts'

// ─── Deterministic token estimator (WS0 extension, tokens-only) ──────────

/** Nominal chars-per-token ratio (fixed so measurements are comparable). */
export const CHARS_PER_TOKEN = 4

function charsToTokens(chars: number): number {
  if (chars <= 0) return 0
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/**
 * Deterministic token estimate for a text (no LLM, no I/O).
 * Pure function of length: `ceil(len / 4)`, `0` for empty.
 */
export function estimateTokens(text: string): number {
  return charsToTokens(text.length)
}

// ─── Lever names + feature flags ─────────────────────────────────────────

/** The five WS3 levers. */
export type LeverName = 'c9' | 'tools-ceiling' | 'filter-truncate' | 'toon' | 'schema'

/** Per-lever measurement with NET delta (gross minus overhead). */
export interface LeverMeasurement {
  name: LeverName
  before: number
  after: number
  overhead: number
  gross: number
  net: number
  enabled: boolean
  /** Itemized overhead (present when measured via `measureLeverFull`). */
  overheadBreakdown?: OverheadBreakdown
}

/** Default flags: every lever enabled until measurement gates it. */
export const DEFAULT_FLAGS: Record<LeverName, boolean> = {
  c9: true,
  'tools-ceiling': true,
  'filter-truncate': true,
  toon: true,
  schema: true,
}

/** Measure one lever in tokens from char counts (deterministic).
 * `enabled` is `net > 0` — the caller persists the verdict via flags.
 * `overheadChars` here is the TOTAL overhead (retrieval + discovery +
 * detail-on-demand + markers); use `measureLeverFull` with an explicit
 * `OverheadBreakdown` so no component is silently omitted.
 */
export function measureLever(
  name: LeverName,
  beforeChars: number,
  afterChars: number,
  overheadChars: number,
): LeverMeasurement {
  return measureLeverFull(name, beforeChars, afterChars, {
    ...EMPTY_OVERHEAD,
    retrievalChars: overheadChars,
  })
}

/** Overhead components debited against a lever's gross saving (chars). */
export interface OverheadBreakdown {
  /** Pre-retrieval injection cost (C9 context chars actually injected). */
  retrievalChars: number
  /** Search-first discovery probes for lazy tools (`discoveryOverheadChars`). */
  discoveryChars: number
  /** Full detail fetched on demand (`fullDetailChars`). */
  detailChars: number
  /** Truncation markers kept in the output (`TruncateResult.markerChars`). */
  markerChars: number
}

/** Zero overhead (a lever that replaces bytes in place, e.g. TOON). */
export const EMPTY_OVERHEAD: OverheadBreakdown = {
  retrievalChars: 0,
  discoveryChars: 0,
  detailChars: 0,
  markerChars: 0,
}

/** Sum of all overhead components (chars). */
export function totalOverheadChars(breakdown: OverheadBreakdown): number {
  return (
    breakdown.retrievalChars +
    breakdown.discoveryChars +
    breakdown.detailChars +
    breakdown.markerChars
  )
}

/**
 * Measure one lever with an explicit TOTAL overhead breakdown.
 * Net = gross − (retrieval + discovery + detail + markers); net <= 0
 * disables the lever via `applyGate` (flag kept, never removed).
 */
export function measureLeverFull(
  name: LeverName,
  beforeChars: number,
  afterChars: number,
  breakdown: OverheadBreakdown,
): LeverMeasurement {
  const before = charsToTokens(beforeChars)
  const after = charsToTokens(afterChars)
  const overheadChars = totalOverheadChars(breakdown)
  const overhead = charsToTokens(overheadChars)
  const gross = before - after
  const net = gross - overhead
  return {
    name,
    before,
    after,
    overhead,
    gross,
    net,
    enabled: net > 0,
    overheadBreakdown: breakdown,
  }
}

/**
 * Gate flags by measurement: a lever with net <= 0 is DISABLED (set to
 * false) but KEPT (never removed) so it can be re-enabled later.
 */
export function applyGate(
  flags: Record<LeverName, boolean>,
  measurements: LeverMeasurement[],
): Record<LeverName, boolean> {
  const gated: Record<LeverName, boolean> = { ...flags }
  for (const m of measurements) {
    if (m.net <= 0) gated[m.name] = false
  }
  return gated
}

/** Kill-switch: `PANTHEON_TOKEN_OPT=off` disables the whole WS3 layer. */
export function isTokenOptEnabled(env: Record<string, string | undefined> = {}): boolean {
  return env.PANTHEON_TOKEN_OPT !== 'off'
}

// ─── Lever 1: C9 pre-retrieval Mode-1 ────────────────────────────────────

/** Default top-k per category (before task()/delegate). */
export const C9_DEFAULT_TOP_K = 3

/** Default relevance cutoff per category (chunks below are dropped). */
export const C9_DEFAULT_CUTOFF = 0.3

/** One scored retrieval candidate (auditable: id + category + score). */
export interface C9Chunk {
  id: string
  category: string
  score: number
  text: string
}

/** Per-category override of top-k / cutoff. */
export interface C9CategoryConfig {
  topK?: number
  cutoff?: number
}

/** Result of C9 filtering with debited injection cost. */
export interface C9FilterResult {
  selected: C9Chunk[]
  dropped: C9Chunk[]
  injectedChars: number
  injectedTokens: number
  /**
   * Quality-floor signal (never silent on empty):
   * - `ok` — at least one chunk selected;
   * - `empty-input` — no chunks retrieved at all (fallback: proceed without
   *   injected context, caller should log `notice`);
   * - `all-dropped` — chunks existed but none survived cutoff/top-k
   *   (fallback: relax cutoff/top-k or proceed without context).
   */
  signal: 'ok' | 'empty-input' | 'all-dropped'
  /** Human-readable alert for the non-`ok` signals (null when `ok`). */
  notice: string | null
  /**
   * Recall over cutoff-eligible chunks: selected-eligible / eligible.
   * Top-k overflow lowers recall honestly (e.g. 3 kept of 5 eligible = 0.6).
   * 1 when nothing was eligible (vacuous — read with `signal`).
   * Precision is N/A by construction: the cutoff IS the relevance proxy,
   * so every selected chunk is eligible by definition.
   */
  recall: number
}

/**
 * Filter scored chunks per category: drop below cutoff, keep top-k by
 * score desc. The injected context cost is debited (`injectedTokens`).
 */
export function c9Filter(
  chunks: C9Chunk[],
  perCategory?: Record<string, C9CategoryConfig>,
): C9FilterResult {
  const byCategory = new Map<string, C9Chunk[]>()
  for (const chunk of chunks) {
    const group = byCategory.get(chunk.category)
    if (group !== undefined) group.push(chunk)
    else byCategory.set(chunk.category, [chunk])
  }
  const selected: C9Chunk[] = []
  const dropped: C9Chunk[] = []
  let eligibleTotal = 0
  let eligibleSelected = 0
  for (const [category, group] of byCategory) {
    const config = perCategory?.[category]
    const topK = config?.topK ?? C9_DEFAULT_TOP_K
    const cutoff = config?.cutoff ?? C9_DEFAULT_CUTOFF
    const eligible = group.filter((c) => c.score >= cutoff).sort((a, b) => b.score - a.score)
    const kept = eligible.slice(0, topK)
    eligibleTotal += eligible.length
    eligibleSelected += kept.length
    selected.push(...kept)
    dropped.push(...group.filter((c) => c.score < cutoff))
    dropped.push(...eligible.slice(topK))
  }
  const context = buildC9Context(selected)
  const signal: C9FilterResult['signal'] =
    chunks.length === 0 ? 'empty-input' : selected.length === 0 ? 'all-dropped' : 'ok'
  const notice =
    signal === 'empty-input'
      ? 'C9: empty input — no chunks retrieved; fallback: proceed without injected context'
      : signal === 'all-dropped'
        ? 'C9: all chunks dropped by cutoff/top-k; fallback: relax cutoff/top-k or proceed without context'
        : null
  return {
    selected,
    dropped,
    injectedChars: context.length,
    injectedTokens: estimateTokens(context),
    signal,
    notice,
    recall: eligibleTotal === 0 ? 1 : eligibleSelected / eligibleTotal,
  }
}

/** Build the injected context: only auditable chunks (id + score + text). */
export function buildC9Context(selected: C9Chunk[]): string {
  return selected.map((c) => `[${c.category}:${c.id}|${c.score}] ${c.text}`).join('\n')
}

// ─── Lever 2: 4 meta-tools ceiling + lazy ────────────────────────────────

/**
 * Always-on meta-tools (real repo names, verified):
 * - `memory_search` (memory server: hybrid FTS5 + vector),
 * - `kv_search` (persistence server: FTS5),
 * - `code_query` (codemap: FTS5 code entities),
 * - `pantheon://resources` (resources server URI scheme).
 */
export const ALWAYS_ON_TOOLS: readonly string[] = [
  'memory_search',
  'kv_search',
  'code_query',
  'pantheon://resources',
]

/** Lazy route for non-ceiling tools (on demand, search-first). */
export interface LazyRoute {
  via: 'execute_code_script'
  tool: string
}

/** Classify a tool: ceiling (always on) or lazy (via pantheon-code-mode). */
export function classifyTool(name: string): 'always-on' | 'lazy' {
  return (ALWAYS_ON_TOOLS as readonly string[]).includes(name) ? 'always-on' : 'lazy'
}

/**
 * Resolve a non-ceiling tool to its on-demand code-mode route.
 * Verifies the tool EXISTS first (known description or ceiling entry) —
 * unknown names throw instead of being silently misrouted.
 */
export function lazyRoute(name: string): LazyRoute {
  if (!isKnownTool(name)) {
    throw new Error(
      `lazyRoute: unknown tool ${JSON.stringify(name)} — register it in descriptions/ALWAYS_ON_TOOLS before routing`,
    )
  }
  return { via: 'execute_code_script', tool: name }
}

/** Whether a tool name is known (has a description or is always-on). */
export function isKnownTool(name: string): boolean {
  return name in FULL_DESCRIPTIONS || (ALWAYS_ON_TOOLS as readonly string[]).includes(name)
}

// ─── Lever 3: response filtering + truncation ────────────────────────────

/**
 * Keep only the MCP fields the caller actually uses (drops embeddings,
 * result_info and other unused payload weight).
 * `required` names fields that MUST be present — missing ones throw
 * instead of being silently dropped (quality floor).
 */
export function filterFields(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = [],
): Record<string, unknown> {
  const missing = required.filter((key) => !(key in raw))
  if (missing.length > 0) {
    throw new Error(`filterFields: missing required fields: ${missing.join(', ')}`)
  }
  const out: Record<string, unknown> = {}
  for (const key of allowed) {
    if (key in raw) out[key] = raw[key]
  }
  return out
}

/** Result of per-turn truncation. */
export interface TruncateResult {
  blocks: string[]
  truncated: boolean
  /** Chars of the truncation marker kept in the output (0 when untruncated — debit via `OverheadBreakdown.markerChars`). */
  markerChars: number
}

/** Fit text into a char budget, slicing with `…` when over (hard cap). */
function fitBudget(text: string, budget: number): string {
  if (text.length <= budget) return text
  if (budget <= 0) return ''
  if (budget === 1) return '…'
  return `${text.slice(0, budget - 1)}…`
}

/**
 * Cap a turn's blocks to `maxChars` preserving summary (first) + tail
 * (last); middle blocks are replaced by a bounded marker.
 *
 * HARD CAP (margin 0): the joined output NEVER exceeds `maxChars` — head
 * and tail are sliced with `…` when over budget. The marker itself counts
 * toward the cap and its length is reported in `markerChars` for overhead
 * debiting. When `maxChars` is smaller than the marker, the marker alone
 * (sliced) is returned.
 */
export function truncateTurn(blocks: readonly string[], maxChars: number): TruncateResult {
  const joined = blocks.join('\n')
  if (joined.length <= maxChars) return { blocks: [...blocks], truncated: false, markerChars: 0 }
  const head = blocks[0] ?? ''
  const tail = blocks.length > 1 ? (blocks[blocks.length - 1] as string) : ''
  if (blocks.length === 1) {
    return { blocks: [fitBudget(head, maxChars)], truncated: true, markerChars: 0 }
  }
  if (blocks.length === 2) {
    const tailOut = fitBudget(tail, maxChars)
    const headOut = fitBudget(head, Math.max(0, maxChars - tailOut.length - 1))
    return { blocks: [headOut, tailOut], truncated: true, markerChars: 0 }
  }
  const marker = `…[+${blocks.length - 2} truncated]…`
  const budget = maxChars - marker.length - 2
  if (budget < 0) {
    return { blocks: [fitBudget(marker, maxChars)], truncated: true, markerChars: marker.length }
  }
  const headOut = fitBudget(head, budget)
  const tailOut = fitBudget(tail, budget - headOut.length)
  return { blocks: [headOut, marker, tailOut], truncated: true, markerChars: marker.length }
}

// ─── Lever 5: schema compression ─────────────────────────────────────────

/** Full descriptions for familiar tools (detail on demand). */
const FULL_DESCRIPTIONS: Record<string, string> = {
  memory_search:
    'memory_search: hybrid semantic search across memories. Combines vector cosine ' +
    'similarity and FTS5 BM25 keyword search via Reciprocal Rank Fusion (RRF). ' +
    'Optional decay_days applies a freshness half-life so recent entries rank higher.',
  kv_search:
    'kv_search: full-text search across keys and values using FTS5. ' +
    'Optionally filter by namespace. Returns matching entries with rank order.',
  code_query:
    'code_query: search code entities via FTS5 (with LIKE fallback) and optional ' +
    'type filter. Returns entity id, file path, signature and docstring.',
  'pantheon://resources':
    'pantheon://resources: MCP resource URI scheme (agents, skills, routing, ' +
    'deepwork plans, memory-bank files, code-mode scripts). Read-only discovery.',
  kv_get: 'kv_get: retrieve a value by namespace and key. Returns None if not found or expired.',
  kv_store:
    'kv_store: store a key-value pair in a namespace with optional TTL (seconds). ' +
    'INSERT OR REPLACE on duplicate (namespace, key).',
  context_save:
    'context_save: save a context checkpoint for a session/phase. Stores structured ' +
    'JSON in persistence KV with auto-TTL of 4h. Also updates the "latest" pointer.',
  context_get:
    'context_get: retrieve a context checkpoint by session slug and key. ' +
    'Returns the raw content string or null if expired/not found.',
  memory_recall:
    'memory_recall: recall a specific memory entry by its key within a namespace. ' +
    'Returns the full entry including parsed metadata.',
  memory_list:
    'memory_list: list memory entries chronologically with optional namespace ' +
    'and key-prefix filters.',
  code_neighbors:
    'code_neighbors: get neighbors of a code entity via relations graph (BFS depth 1-3).',
  execute_code_script:
    'execute_code_script: run a .sh/.py script from .pantheon/code-mode/ with ' +
    'optional args. On-demand route for non-ceiling tools.',
}

/** Slim descriptions for familiar tools (default; saves >= 40% chars). */
const SLIM_DESCRIPTIONS: Record<string, string> = {
  memory_search: 'memory_search: hybrid memory search (vector + FTS5).',
  kv_search: 'kv_search: text search over KV keys/values.',
  code_query: 'code_query: FTS5 code-entity search.',
  'pantheon://resources': 'pantheon://resources: read-only discovery URIs.',
  kv_get: 'kv_get: read one KV entry.',
  kv_store: 'kv_store: write one KV entry (upsert).',
  context_save: 'context_save: save a session checkpoint.',
  context_get: 'context_get: read a session checkpoint.',
  memory_recall: 'memory_recall: recall one memory by key.',
  memory_list: 'memory_list: list memories.',
  code_neighbors: 'code_neighbors: code graph neighbors.',
  execute_code_script: 'execute_code_script: on-demand lazy-tool route.',
}

/**
 * Describe a tool: slim by default, full detail on demand.
 * Unknown tools fall back to their own name (never throws).
 */
export function describeTool(name: string, detail = false): string {
  if (detail) return FULL_DESCRIPTIONS[name] ?? SLIM_DESCRIPTIONS[name] ?? name
  return SLIM_DESCRIPTIONS[name] ?? FULL_DESCRIPTIONS[name] ?? name
}

/**
 * Detail-on-demand overhead for a tool (chars): fetching the full
 * description costs `fullDetailChars(name)` — debit via
 * `OverheadBreakdown.detailChars`. 0 for unknown tools (nothing to fetch).
 */
export function fullDetailChars(name: string): number {
  return FULL_DESCRIPTIONS[name]?.length ?? 0
}

/**
 * Nominal search-first discovery probe for one lazy tool
 * (`code_query <tool>` + resource read). `discoveryOverheadChars` is its
 * char length — debit once per lazily-resolved tool via
 * `OverheadBreakdown.discoveryChars`.
 */
export function discoveryProbe(tool: string): string {
  return `code_query ${tool} + read pantheon://resources`
}

/** Discovery overhead for one lazily-resolved tool (chars). */
export function discoveryOverheadChars(tool: string): number {
  return discoveryProbe(tool).length
}

// ─── Tokens-only metering (WS0 extension, NO monetary layer) ─────────────

/** Token totals for one phase (input/output only — never USD). */
export interface PhaseTokens {
  input: number
  output: number
}

/**
 * Deterministic per-phase/per-agent token ledger (no LLM, no I/O).
 * Extends WS0 `pantheon_cost`/cost-tracker with phase accounting while
 * keeping the tokens-only mandate (no `costUsd` field anywhere).
 */
export class TokenMeter {
  private readonly chars = new Map<string, { input: number; output: number }>()

  /** Record one delegation's char counts under a phase + agent. */
  record(phase: string, agent: string, inputChars: number, outputChars: number): void {
    const key = `${phase}\0${agent}`
    const entry = this.chars.get(key) ?? { input: 0, output: 0 }
    entry.input += Math.max(0, inputChars)
    entry.output += Math.max(0, outputChars)
    this.chars.set(key, entry)
  }

  /** Totals for one phase across agents (tokens, converted once). */
  phaseTotals(phase: string): PhaseTokens {
    const chars = this.phaseChars(phase)
    return { input: charsToTokens(chars.inputChars), output: charsToTokens(chars.outputChars) }
  }

  /** Totals across all phases. */
  totals(): PhaseTokens {
    const chars = this.charsTotals()
    return { input: charsToTokens(chars.inputChars), output: charsToTokens(chars.outputChars) }
  }

  /** Raw char counts for one phase (honest basis behind the token totals). */
  phaseChars(phase: string): { inputChars: number; outputChars: number } {
    let inputChars = 0
    let outputChars = 0
    for (const [key, entry] of this.chars) {
      if (key.startsWith(`${phase}\0`)) {
        inputChars += entry.input
        outputChars += entry.output
      }
    }
    return { inputChars, outputChars }
  }

  /** Raw char counts across all phases. */
  charsTotals(): { inputChars: number; outputChars: number } {
    let inputChars = 0
    let outputChars = 0
    for (const entry of this.chars.values()) {
      inputChars += entry.input
      outputChars += entry.output
    }
    return { inputChars, outputChars }
  }
}

/** Re-export for callers that thread TOON payloads through metering. */
export type { ToonValue }
