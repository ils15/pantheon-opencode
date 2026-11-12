/**
 * Prompt Prefix Cache Hierarchy Optimizer — Late-2026 KV-Cache Alignment.
 *
 * Enforces deterministic hierarchical ordering for agent prompts to maximize
 * prefix cache hit rates across LLM providers (Anthropic Claude 3.5/3.7,
 * Gemini 2.0/Flash, OpenAI GPT-5/o3/Luna):
 *
 *   [Tier 1: Static Identity & Invariants] ->
 *   [Tier 2: Tool Schemas & Governance]    ->
 *   [Tier 3: Repository Standards & Gates] ->
 *   [Tier 4: Ephemeral Session History]   ->
 *   [Tier 5: Current Turn & Scratchpad]
 *
 * Pure TypeScript — zero external dependencies.
 *
 * @module prompt-cache-order
 */

export interface PromptLayers {
  readonly identity: string
  readonly tools?: readonly string[] | undefined
  readonly conventions?: readonly string[] | undefined
  readonly history?: readonly string[] | undefined
  readonly currentTurn: string
}

export interface CachedPromptResult {
  readonly prompt: string
  /** The byte/character offset separating invariant prefix from volatile turns */
  readonly prefixBoundaryIndex: number
  /** Estimated token length (heuristic ~4 chars/token) */
  readonly estimatedTokens: number
  /** Whether the prefix meets typical provider minimum threshold (e.g. 1024 tokens) */
  readonly cacheEligible: boolean
}

/** Standard token threshold for provider-level prompt caching (Anthropic=1024, OpenAI=1024) */
export const DEFAULT_CACHE_MIN_TOKENS = 1024

/**
 * Assemble agent prompt with strict invariant-prefix ordering to maximize KV cache hit rate.
 */
export function buildPrefixCachedPrompt(
  layers: PromptLayers,
  minCacheTokens = DEFAULT_CACHE_MIN_TOKENS,
): CachedPromptResult {
  const invariantParts: string[] = []

  // 1. Identity & Core System Instructions
  invariantParts.push(layers.identity.trim())

  // 2. Tools & Permissions Schemas
  if (layers.tools && layers.tools.length > 0) {
    invariantParts.push(`## Tool Specifications\n${layers.tools.map((t) => t.trim()).join('\n\n')}`)
  }

  // 3. Project Conventions & Architecture Gates
  if (layers.conventions && layers.conventions.length > 0) {
    invariantParts.push(
      `## Project Standards & Gates\n${layers.conventions.map((c) => c.trim()).join('\n\n')}`,
    )
  }

  const prefix = invariantParts.join('\n\n')
  const prefixBoundaryIndex = prefix.length

  const volatileParts: string[] = []

  // 4. Conversation History (if any)
  if (layers.history && layers.history.length > 0) {
    volatileParts.push(
      `## Conversation History\n${layers.history.map((h) => h.trim()).join('\n\n')}`,
    )
  }

  // 5. Current Turn Payload
  volatileParts.push(layers.currentTurn.trim())

  const fullPrompt = [prefix, volatileParts.join('\n\n')].join('\n\n')
  const estimatedTokens = Math.ceil(fullPrompt.length / 4)
  const estimatedPrefixTokens = Math.ceil(prefix.length / 4)

  return {
    prompt: fullPrompt,
    prefixBoundaryIndex,
    estimatedTokens,
    cacheEligible: estimatedPrefixTokens >= minCacheTokens,
  }
}
