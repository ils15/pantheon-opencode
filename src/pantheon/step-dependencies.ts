/**
 * Step dependency graph (`step-dependencies.ts`).
 *
 * Pure functions only — no I/O, no bus, no ledger import. This module answers
 * the four scheduling questions the Step Ledger needs when steps declare
 * prerequisites via `dependsOn`:
 *
 * 1. which declarations are valid (`normalizeDependencies` + `validateDependencies`),
 * 2. which waves of independent steps may launch in parallel (`computeWaves`),
 * 3. which `pending` steps are currently launchable (`readyStepKeys`),
 * 4. what to invalidate when a completed/rolled-back step changes (`cascadeBlock`).
 *
 * Cycle detection is re-implemented here (canonical rotation + dedupe) rather
 * than imported from `swarm-watchdog.ts`: the watchdog's wait graph is agent
 * ordering state, not step scheduling state, and coupling them would make
 * either module's tests depend on the other's globals.
 *
 * @module pantheon/step-dependencies
 */

export type StepStateLike = 'pending' | 'in_progress' | 'done' | 'blocked' | 'rolled_back'

/** Minimal node shape shared by ledger entries and test fixtures. */
export interface DependencyNode {
  readonly stepKey: string
  readonly state?: string
  readonly dependsOn?: readonly string[]
}

/** Validation outcomes. Each issue is mechanical and names the offending keys. */
export type DependencyIssueCode = 'dependency_not_found' | 'self_dependency' | 'cycle_detected'

export interface DependencyValidationIssue {
  readonly code: DependencyIssueCode
  readonly message: string
  /** Offending dependency keys (unknown keys, or the step itself). */
  readonly dependencies?: readonly string[]
  /** Canonical cycle path (`a -> c -> b -> a`) for `cycle_detected`. */
  readonly path?: readonly string[]
}

export interface DependencyValidationResult {
  readonly ok: boolean
  /** Normalized + deduped declarations (authoritative when `ok`). */
  readonly dependencies: string[]
  readonly unknown: string[]
  readonly selfDependency: boolean
  readonly cycles: string[][]
  readonly issues: DependencyValidationIssue[]
}

export interface WavePlan {
  /** Topologically sorted launch levels; every key in a level is independent. */
  readonly waves: string[][]
  /** Canonical cycles found in the declaration graph. */
  readonly cycles: string[][]
  /**
   * Known steps that can never be scheduled: members of a cycle, or steps with
   * a dangling (deleted/never-initialized) dependency.
   */
  readonly unplaced: string[]
}

export interface DanglingDependency {
  readonly stepKey: string
  readonly missing: string[]
}

export interface DependencyGraph {
  readonly waves: string[][]
  readonly cycles: string[][]
  readonly ready: string[]
  readonly unmet: Record<string, string[]>
  readonly dangling: DanglingDependency[]
  /** Steps that will never launch (cyclic or dangling dependencies). */
  readonly unplaced: string[]
}

export interface CascadeBlockTarget {
  readonly stepKey: string
  readonly blockedBy: string[]
  readonly cascadeReason: string
  readonly previousState?: string
}

/** Keys that would corrupt `Object`/`Map` semantics if used as step ids. */
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

/** Security: `__proto__`/`prototype`/`constructor` must never be step ids. */
export function isReservedStepKey(key: unknown): boolean {
  return typeof key === 'string' && RESERVED_KEYS.has(key)
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Trim, drop non-strings/empties/reserved keys, and dedupe preserving declared
 * order. Never drops a *valid* dangling key — that is `validateDependencies`.
 */
export function normalizeDependencies(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const key = item.trim()
    if (!key || RESERVED_KEYS.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

function indexNodes(nodes: readonly DependencyNode[]): Map<string, DependencyNode> {
  const byKey = new Map<string, DependencyNode>()
  for (const node of nodes) {
    if (typeof node?.stepKey === 'string' && node.stepKey.length > 0) {
      byKey.set(node.stepKey, node)
    }
  }
  return byKey
}

function declaredDependencies(node: DependencyNode | undefined): string[] {
  return normalizeDependencies(node?.dependsOn)
}

/** Adjacency restricted to declared deps that exist as nodes (self edges kept). */
function knownAdjacency(nodes: readonly DependencyNode[]): Map<string, string[]> {
  const byKey = indexNodes(nodes)
  const adjacency = new Map<string, string[]>()
  for (const [key, node] of byKey) {
    adjacency.set(
      key,
      declaredDependencies(node)
        .filter((dep) => byKey.has(dep))
        .sort(compareKeys),
    )
  }
  return adjacency
}

/** Breadth-first shortest path `from -> … -> to` (inclusive), or `undefined`. */
function shortestPath(
  adjacency: ReadonlyMap<string, readonly string[]>,
  from: string,
  to: string,
): string[] | undefined {
  const previous = new Map<string, string>()
  const seen = new Set<string>([from])
  const queue: string[] = [from]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    for (const next of adjacency.get(current) ?? []) {
      if (next === current) continue
      if (seen.has(next)) continue
      seen.add(next)
      previous.set(next, current)
      if (next === to) {
        const path = [to]
        let cursor = to
        while (cursor !== from) {
          const parent = previous.get(cursor)
          if (parent === undefined) break
          path.unshift(parent)
          cursor = parent
        }
        return path
      }
      queue.push(next)
    }
  }
  return undefined
}

/** Canonical form of a cycle: rotate so the smallest key is first, then close it. */
function canonicalizeCycle(nodes: readonly string[]): string[] {
  if (nodes.length === 0) return []
  let minIdx = 0
  for (let i = 1; i < nodes.length; i += 1) {
    if (compareKeys(nodes[i] ?? '', nodes[minIdx] ?? '') < 0) minIdx = i
  }
  const rotated = [...nodes.slice(minIdx), ...nodes.slice(0, minIdx)]
  const first = rotated[0]
  return first !== undefined ? [...rotated, first] : rotated
}

function dedupeCycles(cycles: string[][]): string[][] {
  const seen = new Set<string>()
  const out: string[][] = []
  for (const cycle of cycles) {
    const signature = cycle.join('>')
    if (seen.has(signature)) continue
    seen.add(signature)
    out.push(cycle)
  }
  return out.sort((a, b) => compareKeys(a.join('>'), b.join('>')))
}

/**
 * Every cycle **that passes through `stepKey`**, reported with its canonical
 * path. Order-independent: it is a reachability check `candidate -> … ->
 * candidate` over each declared edge, so an overlapping SCC elsewhere can no
 * longer mask the candidate's own cycle (the DFS-pruning false negative).
 */
function cyclesThroughStep(nodes: readonly DependencyNode[], stepKey: string): string[][] {
  const adjacency = knownAdjacency(nodes)
  const deps = adjacency.get(stepKey)
  if (!deps || deps.length === 0) return []
  const cycles: string[][] = []
  for (const dep of deps) {
    if (dep === stepKey) continue
    const path = shortestPath(adjacency, dep, stepKey)
    if (!path) continue
    // `path` already ends at `stepKey`; drop that tail so `canonicalizeCycle`
    // owns the single closing repetition.
    cycles.push(canonicalizeCycle([stepKey, ...path.slice(0, -1)]))
  }
  return dedupeCycles(cycles)
}

/**
 * Strongly connected components (Tarjan). Complete coverage without the
 * "already visited" pruning that hides cycles sharing a node.
 */
function stronglyConnectedComponents(
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const index = new Map<string, number>()
  const lowLink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let nextIndex = 0

  const strongConnect = (node: string): void => {
    index.set(node, nextIndex)
    lowLink.set(node, nextIndex)
    nextIndex += 1
    stack.push(node)
    onStack.add(node)

    for (const next of adjacency.get(node) ?? []) {
      if (!index.has(next)) {
        strongConnect(next)
        lowLink.set(node, Math.min(lowLink.get(node) ?? 0, lowLink.get(next) ?? 0))
      } else if (onStack.has(next)) {
        lowLink.set(node, Math.min(lowLink.get(node) ?? 0, index.get(next) ?? 0))
      }
    }

    if ((lowLink.get(node) ?? 0) === (index.get(node) ?? 0)) {
      const component: string[] = []
      for (;;) {
        const member = stack.pop()
        if (member === undefined) break
        onStack.delete(member)
        component.push(member)
        if (member === node) break
      }
      components.push(component.sort(compareKeys))
    }
  }

  for (const node of [...adjacency.keys()].sort(compareKeys)) {
    if (!index.has(node)) strongConnect(node)
  }
  return components
}

/**
 * Canonical cycle per cyclic region. A region is reported once, starting from
 * its smallest key; membership is available via `stronglyConnectedComponents`
 * semantics (every node in the region is cyclic), which is what validation uses.
 */
export function detectDependencyCycles(nodes: readonly DependencyNode[]): string[][] {
  const adjacency = knownAdjacency(nodes)
  const cycles: string[][] = []
  for (const component of stronglyConnectedComponents(adjacency)) {
    const [only] = component
    if (component.length === 1 && only !== undefined) {
      if ((adjacency.get(only) ?? []).includes(only)) cycles.push([only, only])
      continue
    }
    if (component.length === 0 || only === undefined) continue
    const members = new Set(component)
    const restricted = new Map<string, string[]>()
    for (const member of component) {
      restricted.set(
        member,
        (adjacency.get(member) ?? []).filter((dep) => members.has(dep)),
      )
    }
    const candidates: string[][] = []
    for (const dep of restricted.get(only) ?? []) {
      if (dep === only) {
        candidates.push([only, only])
        continue
      }
      const path = shortestPath(restricted, dep, only)
      if (path) candidates.push([only, ...path])
    }
    if (candidates.length === 0) continue
    candidates.sort((a, b) => a.length - b.length || compareKeys(a.join('>'), b.join('>')))
    const [shortest] = candidates
    if (!shortest) continue
    cycles.push(canonicalizeCycle(shortest.slice(0, -1)))
  }
  return dedupeCycles(cycles)
}

/**
 * Validate a candidate declaration for `stepKey`. The candidate's own
 * `dependsOn` overrides whatever the graph currently holds for that key, so the
 * same function validates a fresh `init_step` and a re-init.
 */
export function validateDependencies(
  stepKey: string,
  rawDependsOn: unknown,
  nodes: readonly DependencyNode[],
): DependencyValidationResult {
  const byKey = indexNodes(nodes)
  const dependencies = normalizeDependencies(rawDependsOn)
  const selfDependency = dependencies.includes(stepKey)
  const candidateDeps = dependencies.filter((dep) => dep !== stepKey)
  const unknown = candidateDeps.filter((dep) => !byKey.has(dep))

  const candidateNodes: DependencyNode[] = [
    ...nodes.filter((node) => node.stepKey !== stepKey),
    { stepKey, dependsOn: candidateDeps },
  ]
  // Reachability-based: a cycle through the candidate is found regardless of
  // any overlapping region elsewhere (order-independent, no DFS pruning).
  const cycles = cyclesThroughStep(candidateNodes, stepKey)

  const issues: DependencyValidationIssue[] = []
  if (selfDependency) {
    issues.push({
      code: 'self_dependency',
      message: `Step "${stepKey}" cannot depend on itself`,
      dependencies: [stepKey],
    })
  }
  if (unknown.length > 0) {
    issues.push({
      code: 'dependency_not_found',
      message: `Unknown dependency step(s) for "${stepKey}": ${unknown.join(', ')}`,
      dependencies: unknown,
    })
  }
  if (cycles.length > 0) {
    const [firstCycle] = cycles
    issues.push({
      code: 'cycle_detected',
      message: `Dependency cycle detected for "${stepKey}": ${cycles
        .map((cycle) => cycle.join(' -> '))
        .join('; ')}`,
      ...(firstCycle ? { path: firstCycle } : {}),
    })
  }

  return {
    ok: issues.length === 0,
    dependencies,
    unknown,
    selfDependency,
    cycles,
    issues,
  }
}

/**
 * Level-by-level topological sort. A step enters the first wave whose members
 * it does not depend on. A step with a **dangling** dependency can never be
 * scheduled (it would contradict `readyStepKeys`/`unmet`), so it is reported in
 * `unplaced` alongside cyclic steps.
 */
export function computeWaves(nodes: readonly DependencyNode[]): WavePlan {
  const byKey = indexNodes(nodes)
  const depsOf = (key: string): string[] =>
    declaredDependencies(byKey.get(key)).filter((dep) => dep !== key)

  const placed = new Set<string>()
  const waves: string[][] = []
  let remaining = [...byKey.keys()].sort(compareKeys)

  while (remaining.length > 0) {
    const level = remaining.filter((key) =>
      depsOf(key).every((dep) => byKey.has(dep) && placed.has(dep)),
    )
    if (level.length === 0) break
    for (const key of level) placed.add(key)
    waves.push(level)
    remaining = remaining.filter((key) => !placed.has(key))
  }

  return { waves, cycles: detectDependencyCycles(nodes), unplaced: remaining }
}

/**
 * `ready(k) = state(k)==='pending' && dependsOn(k).length>0 && every dep done`.
 * Returns keys in deterministic order.
 */
export function readyStepKeys(nodes: readonly DependencyNode[]): string[] {
  const byKey = indexNodes(nodes)
  const ready: string[] = []
  for (const [key, node] of byKey) {
    if (node.state !== 'pending') continue
    const deps = declaredDependencies(node)
    if (deps.length === 0) continue
    if (deps.every((dep) => byKey.get(dep)?.state === 'done')) ready.push(key)
  }
  return ready.sort(compareKeys)
}

/** Declared dependencies that are missing or not `done`, per step. */
export function unmetDependencies(nodes: readonly DependencyNode[]): Record<string, string[]> {
  const byKey = indexNodes(nodes)
  const unmet: Record<string, string[]> = {}
  for (const key of [...byKey.keys()].sort(compareKeys)) {
    const missing = declaredDependencies(byKey.get(key)).filter(
      (dep) => byKey.get(dep)?.state !== 'done',
    )
    if (missing.length > 0) unmet[key] = missing
  }
  return unmet
}

/** Declared dependencies that do not exist in the ledger at all. */
export function danglingDependencies(nodes: readonly DependencyNode[]): DanglingDependency[] {
  const byKey = indexNodes(nodes)
  const dangling: DanglingDependency[] = []
  for (const key of [...byKey.keys()].sort(compareKeys)) {
    const missing = declaredDependencies(byKey.get(key)).filter((dep) => !byKey.has(dep))
    if (missing.length > 0) dangling.push({ stepKey: key, missing })
  }
  return dangling
}

/** The `status.graph` payload: waves, cycles, ready, unmet, dangling, unplaced. */
export function buildDependencyGraph(nodes: readonly DependencyNode[]): DependencyGraph {
  const { waves, cycles, unplaced } = computeWaves(nodes)
  return {
    waves,
    cycles,
    ready: readyStepKeys(nodes),
    unmet: unmetDependencies(nodes),
    dangling: danglingDependencies(nodes),
    unplaced,
  }
}

/**
 * Transitive dependents of `rootStepKey`, each with the immediate prerequisites
 * that justify blocking it. Parents are returned before children (BFS order).
 *
 * `blockedBy` lists every declared dependency that is either on the invalidated
 * chain or itself not `done`, so the reason is mechanical rather than narrated.
 */
export function cascadeBlock(
  nodes: readonly DependencyNode[],
  rootStepKey: string,
  reason: string,
): CascadeBlockTarget[] {
  const byKey = indexNodes(nodes)
  if (!byKey.has(rootStepKey)) return []

  const dependentsIndex = new Map<string, string[]>()
  for (const key of [...byKey.keys()].sort(compareKeys)) {
    for (const dep of declaredDependencies(byKey.get(key))) {
      if (dep === key) continue
      const list = dependentsIndex.get(dep)
      if (list) list.push(key)
      else dependentsIndex.set(dep, [key])
    }
  }

  const affected: string[] = []
  const affectedSet = new Set<string>([rootStepKey])
  const queue = [rootStepKey]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    for (const dependent of dependentsIndex.get(current) ?? []) {
      if (affectedSet.has(dependent)) continue
      affectedSet.add(dependent)
      affected.push(dependent)
      queue.push(dependent)
    }
  }

  return affected.map((key) => {
    const blockedBy = declaredDependencies(byKey.get(key)).filter(
      (dep) => affectedSet.has(dep) || byKey.get(dep)?.state !== 'done',
    )
    const previousState = byKey.get(key)?.state
    return {
      stepKey: key,
      blockedBy,
      cascadeReason: reason,
      ...(previousState !== undefined ? { previousState } : {}),
    }
  })
}
