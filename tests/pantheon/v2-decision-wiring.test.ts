/**
 * Wiring audit — "declared in the registry" is not "constructed by the plugin",
 * and "constructed somewhere" is not "constructed at the declared surface".
 *
 * The defect this file exists for: nine of eleven points were described as
 * running in shadow while no production file imported them. Prose did not catch
 * it and a second hand-maintained list would reproduce it, so the truth is
 * derived from the source:
 *
 *   1. the adapter module for a point is found by its `p<number>-` file name;
 *   2. the exported handler names are read from that adapter's own source;
 *   3. the point is wired only when a file reachable from `src/plugin-v2.ts`
 *      imports one of those names and calls it;
 *   4. the host surface is derived from the host registration that encloses —
 *      or contains — the enclosing function of that call (a `session.hook`
 *      name, `permission.hook('evaluate')`, `event.subscribe`, or the execute
 *      of a tool definition registered through `ctx.tool.transform`).
 *
 * Nothing here re-lists which point is wired or where: changing the plugin
 * changes the answer, and the registry entry has to follow. This closes the
 * gap that let P3 declare `tool.invoke` while being constructed at the prompt
 * hook: the old audit only asked whether *some* handler was called.
 *
 * Run with: npx tsx tests/pantheon/v2-decision-wiring.test.ts
 */
import { strict as assert } from 'node:assert'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createV2LocalDecisionDefinition } from '../../src/pantheon/local-decision-tool.ts'
import {
  observePromptSurface,
  PROMPT_SURFACE_MODE,
  PROMPT_SURFACE_POINT_IDS,
} from '../../src/pantheon/v2-decision-prompt-surface.ts'
import {
  DECISION_POINT_REGISTRY,
  type DecisionHostSurface,
  type DecisionPoint,
} from '../../src/pantheon/v2-decision-registry.ts'
import { createTelemetrySink } from '../../src/pantheon/v2-decision-telemetry.ts'
import { HOST_PROMPT_PAYLOAD_F08 } from './v2-decision-fixtures.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PRODUCTION_ENTRY = join(ROOT, 'src/plugin-v2.ts')
const ADAPTER_DIR = join(ROOT, 'src/pantheon/v2-decision-points')

let checks = 0
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn()
  checks += 1
  void name
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier)
  const candidates = [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, join(base, 'index.ts')]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/** Every local module the production entry can reach through static imports. */
function productionImportGraph(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift() as string
    if (seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = resolveSpecifier(file, match[1] as string)
      if (target !== null) queue.push(target)
    }
    for (const match of source.matchAll(/import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const target = resolveSpecifier(file, match[1] as string)
      if (target !== null) queue.push(target)
    }
  }
  return [...seen].sort()
}

/** The adapter module is discovered by point number, never by a maintained map. */
function adapterFileFor(pointId: string): string {
  const prefix = `p${Number(pointId.slice(1))}-`
  const matches = readdirSync(ADAPTER_DIR).filter(
    (name) => name.startsWith(prefix) && name.endsWith('.ts'),
  )
  assert.equal(matches.length, 1, `expected exactly one adapter module for ${pointId}`)
  return join(ADAPTER_DIR, matches[0] as string)
}

/** Exported constructor names, read from the adapter's own declarations. */
function handlerSymbols(adapterFile: string): readonly string[] {
  const source = readFileSync(adapterFile, 'utf8')
  return [...source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g)]
    .map((match) => match[1] as string)
    .filter((name) => /^(evaluate|create)[A-Za-z0-9]*$/.test(name))
}

/** A point is wired only when a reachable file imports AND calls its handler. */
function isConstructed(pointId: string, productionFiles: readonly string[]): boolean {
  const adapterFile = adapterFileFor(pointId)
  const handlers = new Set(handlerSymbols(adapterFile))
  if (handlers.size === 0) return false
  for (const file of productionFiles) {
    if (file === adapterFile) continue
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(
      /import\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+['"]([^'"]+)['"]/g,
    )) {
      if (resolveSpecifier(file, match[2] as string) !== adapterFile) continue
      const names = (match[1] as string)
        .split(',')
        .map((entry) => entry.trim().replace(/^type\s+/, ''))
        .map((entry) => entry.split(/\s+as\s+/).pop() as string)
      for (const name of names) {
        if (handlers.has(name) && new RegExp(`\\b${name}\\s*\\(`).test(source)) return true
      }
    }
  }
  return false
}

// ─── Surface derivation ─────────────────────────────────────────────────
//
// A closure-like scan of the production source. We only need two things: the
// block that encloses a handler call, and the host registration that owns that
// block. No compiler API is available (the installed `typescript` is the
// native preview with no `createSourceFile`), so this is a small brace scanner
// that skips comments and strings.

interface FunctionBlock {
  readonly file: string
  readonly name: string | null
  readonly start: number
  readonly end: number
  readonly kind: 'named' | 'arrow' | 'execute'
}

interface HostRegistration {
  readonly file: string
  readonly start: number
  readonly end: number
  readonly surface: DecisionHostSurface
}

const HOOK_SURFACES: Readonly<Record<string, DecisionHostSurface>> = Object.freeze({
  prompt: 'session.hook.prompt',
  context: 'session.hook.context',
  compaction: 'session.hook.compaction',
  'execute.after': 'session.hook.execute.after',
})

function skipQuoted(source: string, start: number): number {
  const quote = source[start]
  let index = start + 1
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2
      continue
    }
    if (source[index] === quote) return index
    index += 1
  }
  return source.length - 1
}

function matchingDelimiter(source: string, open: number, opener: string, closer: string): number {
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index)
      if (newline === -1) return -1
      index = newline
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2)
      if (close === -1) return -1
      index = close + 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      index = skipQuoted(source, index)
      continue
    }
    if (char === opener) depth += 1
    else if (char === closer) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** First `{` after a parameter list — the body, not a return-type literal. */
function bodyBrace(source: string, from: number): number {
  for (let index = from; index < source.length; index += 1) {
    const char = source[index]
    if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index)
      if (newline === -1) return -1
      index = newline
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2)
      if (close === -1) return -1
      index = close + 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      index = skipQuoted(source, index)
      continue
    }
    if (char === '{') return index
    if (char === ';') return -1
  }
  return -1
}

function collectBlocks(file: string, source: string): FunctionBlock[] {
  const blocks: FunctionBlock[] = []

  for (const match of source.matchAll(
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g,
  )) {
    const openParen = match.index + match[0].length - 1
    const closeParen = matchingDelimiter(source, openParen, '(', ')')
    if (closeParen === -1) continue
    const openBrace = bodyBrace(source, closeParen + 1)
    if (openBrace === -1) continue
    const end = matchingDelimiter(source, openBrace, '{', '}')
    if (end === -1) continue
    blocks.push({ file, name: match[1] as string, start: openBrace, end, kind: 'named' })
  }

  for (const match of source.matchAll(/=>\s*\{/g)) {
    const openBrace = match.index + match[0].length - 1
    const end = matchingDelimiter(source, openBrace, '{', '}')
    if (end === -1) continue
    const before = source.slice(Math.max(0, match.index - 160), match.index)
    const execute = /\bexecute:\s*(?:async\s+)?(?:\([^()]*\)|[A-Za-z0-9_]+)\s*$/.test(before)
    blocks.push({
      file,
      name: null,
      start: openBrace,
      end,
      kind: execute ? 'execute' : 'arrow',
    })
  }

  return blocks
}

function collectHostRegistrations(file: string, source: string): HostRegistration[] {
  const registrations: HostRegistration[] = []
  for (const match of source.matchAll(/\.hook\(\s*(['"])([^'"]+)\1/g)) {
    const openParen = match.index + match[0].indexOf('(')
    const end = matchingDelimiter(source, openParen, '(', ')')
    if (end === -1) continue
    const name = match[2] as string
    const surface = name === 'evaluate' ? 'permission.evaluate' : HOOK_SURFACES[name]
    if (surface === undefined) continue
    registrations.push({ file, start: match.index, end, surface })
  }
  for (const match of source.matchAll(/\.subscribe\s*(?:<[^>]*>)?[!?]?\s*\(/g)) {
    const openParen = match.index + match[0].lastIndexOf('(')
    const end = matchingDelimiter(source, openParen, '(', ')')
    if (end === -1) continue
    registrations.push({ file, start: match.index, end, surface: 'event.channel' })
  }
  return registrations
}

interface Analysis {
  readonly blocks: readonly FunctionBlock[]
  readonly registrations: readonly HostRegistration[]
  readonly sources: ReadonlyMap<string, string>
}

function analyse(files: readonly string[]): Analysis {
  const blocks: FunctionBlock[] = []
  const registrations: HostRegistration[] = []
  const sources = new Map<string, string>()
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    sources.set(file, source)
    blocks.push(...collectBlocks(file, source))
    registrations.push(...collectHostRegistrations(file, source))
  }
  return { blocks, registrations, sources }
}

function containing(
  blocks: readonly FunctionBlock[],
  file: string,
  offset: number,
): FunctionBlock | null {
  let best: FunctionBlock | null = null
  for (const block of blocks) {
    if (block.file !== file) continue
    if (offset < block.start || offset > block.end) continue
    if (best === null || block.end - block.start < best.end - best.start) best = block
  }
  return best
}

function outerBlock(analysis: Analysis, block: FunctionBlock): FunctionBlock | null {
  let best: FunctionBlock | null = null
  for (const candidate of analysis.blocks) {
    if (candidate.file !== block.file) continue
    if (candidate.start > block.start || candidate.end < block.end) continue
    if (candidate.start === block.start && candidate.end === block.end) continue
    if (best === null || candidate.end - candidate.start < best.end - best.start) best = candidate
  }
  return best
}

function bodyOf(analysis: Analysis, block: FunctionBlock): string {
  return (analysis.sources.get(block.file) ?? '').slice(block.start, block.end)
}

function namedBlock(analysis: Analysis, name: string): FunctionBlock | null {
  return analysis.blocks.find((block) => block.kind === 'named' && block.name === name) ?? null
}

/**
 * A tool definition's `execute` is invoked by the host at `tool.invoke`, not at
 * `tool.transform`. Only treat an `execute:` block that way when the function
 * producing it is called by `createV2ToolDefinitions`, and those definitions are
 * actually handed to `draft.add` inside `ctx.tool.transform`.
 */
function isRegisteredToolExecute(analysis: Analysis, block: FunctionBlock): boolean {
  const builder = outerBlock(analysis, block)
  if (builder === null || builder.name === null) return false
  const toolSet = namedBlock(analysis, 'createV2ToolDefinitions')
  const registrar = namedBlock(analysis, 'registerV2Tools')
  if (toolSet === null || registrar === null) return false
  if (!new RegExp(`\\b${builder.name}\\s*\\(`).test(bodyOf(analysis, toolSet))) return false
  const registration = bodyOf(analysis, registrar)
  return registration.includes('draft.add(') && registration.includes('createV2ToolDefinitions(')
}

function callSites(analysis: Analysis, name: string): Array<{ file: string; offset: number }> {
  const pattern = new RegExp(`\\b${name}\\s*\\(`, 'g')
  const sites: Array<{ file: string; offset: number }> = []
  for (const [file, source] of analysis.sources) {
    for (const match of source.matchAll(pattern)) {
      sites.push({ file, offset: match.index })
    }
  }
  return sites
}

function surfaceOfBlock(
  analysis: Analysis,
  block: FunctionBlock,
  seen: Set<string>,
): DecisionHostSurface | null {
  if (block.kind === 'execute' && isRegisteredToolExecute(analysis, block)) return 'tool.invoke'

  const containingRegistrations = analysis.registrations
    .filter(
      (registration) =>
        registration.file === block.file &&
        registration.start >= block.start &&
        registration.start < block.end,
    )
    .sort((left, right) => left.end - left.start - (right.end - right.start))
  if (containingRegistrations.length > 0) return containingRegistrations[0]?.surface ?? null

  const enclosingRegistrations = analysis.registrations
    .filter(
      (registration) =>
        registration.file === block.file &&
        registration.start < block.start &&
        registration.end > block.end,
    )
    .sort((left, right) => left.end - left.start - (right.end - right.start))
  if (enclosingRegistrations.length > 0) return enclosingRegistrations[0]?.surface ?? null

  if (block.name === null) {
    const outer = outerBlock(analysis, block)
    return outer === null ? null : surfaceOfBlock(analysis, outer, seen)
  }

  const key = `${block.file}:${block.name}`
  if (seen.has(key)) return null
  seen.add(key)
  for (const site of callSites(analysis, block.name)) {
    const inner = containing(analysis.blocks, site.file, site.offset)
    if (inner === null) continue
    const surface = surfaceOfBlock(analysis, inner, seen)
    if (surface !== null) return surface
  }
  const outer = outerBlock(analysis, block)
  return outer === null ? null : surfaceOfBlock(analysis, outer, seen)
}

/** Derive, per point, the host surface that actually constructs its handler. */
function deriveSurfaces(
  points: readonly DecisionPoint[],
  analysis: Analysis,
  files: readonly string[],
): Map<string, DecisionHostSurface | null> {
  const surfaces = new Map<string, DecisionHostSurface | null>()
  for (const point of points) {
    const adapterFile = adapterFileFor(point.id)
    const handlers = handlerSymbols(adapterFile)
    let derived: DecisionHostSurface | null = null
    for (const file of files) {
      if (file === adapterFile) continue
      const source = analysis.sources.get(file) ?? ''
      for (const handler of handlers) {
        const pattern = new RegExp(`\\b${handler}\\s*\\(`, 'g')
        for (const match of source.matchAll(pattern)) {
          const block = containing(analysis.blocks, file, match.index + handler.length)
          if (block === null) continue
          derived = surfaceOfBlock(analysis, block, new Set())
          if (derived !== null) {
            break
          }
        }
        if (derived !== null) break
      }
      if (derived !== null) break
    }
    surfaces.set(point.id, derived)
  }
  return surfaces
}

interface WiringViolation {
  readonly pointId: string
  readonly claimed: boolean
  readonly constructed: boolean
}

interface SurfaceViolation {
  readonly pointId: string
  readonly declared: DecisionHostSurface
  readonly constructed: DecisionHostSurface | null
}

/** Pure rule so the negative control can prove it fails on a lie. */
function findWiringViolations(
  points: readonly DecisionPoint[],
  constructed: (pointId: string) => boolean,
): readonly WiringViolation[] {
  return points
    .filter((point) => point.wired !== constructed(point.id))
    .map((point) => ({
      pointId: point.id,
      claimed: point.wired,
      constructed: constructed(point.id),
    }))
}

/** A wired point must be constructed at exactly the surface it declares. */
function findSurfaceViolations(
  points: readonly DecisionPoint[],
  surfaceOf: (pointId: string) => DecisionHostSurface | null,
): readonly SurfaceViolation[] {
  return points
    .filter((point) => point.wired)
    .filter((point) => surfaceOf(point.id) !== point.hostSurface)
    .map((point) => ({
      pointId: point.id,
      declared: point.hostSurface,
      constructed: surfaceOf(point.id),
    }))
}

await check('every registry entry declares wired as a boolean', () => {
  for (const point of DECISION_POINT_REGISTRY) {
    assert.equal(typeof point.wired, 'boolean', `${point.id} must declare wired`)
  }
})

const productionFiles = productionImportGraph(PRODUCTION_ENTRY)
const constructed = (pointId: string): boolean => isConstructed(pointId, productionFiles)

await check('wired matches what the production import graph actually constructs', () => {
  const violations = findWiringViolations(DECISION_POINT_REGISTRY, constructed)
  assert.deepEqual(
    violations,
    [],
    `registry claims and source disagree: ${JSON.stringify(violations)}`,
  )
})

await check('the audit fails when a point claims wired without a construction site', () => {
  const lying = DECISION_POINT_REGISTRY.map((point) =>
    point.id === 'P4' ? { ...point, wired: true } : point,
  )
  assert.deepEqual(findWiringViolations(lying, constructed), [
    { pointId: 'P4', claimed: true, constructed: false },
  ])
})

await check('the audit fails when a wired point claims it is not', () => {
  const understated = DECISION_POINT_REGISTRY.map((point) =>
    point.id === 'P7' ? { ...point, wired: false } : point,
  )
  assert.deepEqual(findWiringViolations(understated, constructed), [
    { pointId: 'P7', claimed: false, constructed: true },
  ])
})

const analysis = analyse(productionFiles)
const derivedSurfaces = deriveSurfaces(DECISION_POINT_REGISTRY, analysis, productionFiles)
const declaredSurfaceOf = (pointId: string): DecisionHostSurface | null =>
  derivedSurfaces.get(pointId) ?? null

await check('wired points are constructed at their declared host surface', () => {
  const violations = findSurfaceViolations(DECISION_POINT_REGISTRY, declaredSurfaceOf)
  assert.deepEqual(
    violations,
    [],
    `declared and constructed surfaces disagree: ${JSON.stringify(violations)}`,
  )
})

await check('the surface audit rejects a hook point constructed at a tool surface', () => {
  // P1 declares session.hook.prompt; moving its construction to tool.invoke
  // must fail even though a handler is still called somewhere.
  const moved = (pointId: string): DecisionHostSurface | null =>
    pointId === 'P1' ? 'tool.invoke' : declaredSurfaceOf(pointId)
  assert.deepEqual(findSurfaceViolations(DECISION_POINT_REGISTRY, moved), [
    { pointId: 'P1', declared: 'session.hook.prompt', constructed: 'tool.invoke' },
  ])
})

await check('the surface audit rejects a tool point constructed at a hook', () => {
  // The defect F-35 exposed: P3 declared tool.invoke while built at the prompt
  // hook. The old audit accepted it; this direction must fail.
  const moved = (pointId: string): DecisionHostSurface | null =>
    pointId === 'P3' ? 'session.hook.prompt' : declaredSurfaceOf(pointId)
  assert.deepEqual(findSurfaceViolations(DECISION_POINT_REGISTRY, moved), [
    { pointId: 'P3', declared: 'tool.invoke', constructed: 'session.hook.prompt' },
  ])
})

await check('the surface audit rejects a wired point with no construction surface', () => {
  const missing = (pointId: string): DecisionHostSurface | null =>
    pointId === 'P3' ? null : declaredSurfaceOf(pointId)
  assert.deepEqual(findSurfaceViolations(DECISION_POINT_REGISTRY, missing), [
    { pointId: 'P3', declared: 'tool.invoke', constructed: null },
  ])
})

await check('the derivation reads P3 at tool.invoke and P1/P2 at the prompt hook', () => {
  assert.equal(declaredSurfaceOf('P3'), 'tool.invoke')
  assert.equal(declaredSurfaceOf('P1'), 'session.hook.prompt')
  assert.equal(declaredSurfaceOf('P2'), 'session.hook.prompt')
})

await check('the prompt hook hosts only the points whose input it can carry', () => {
  assert.deepEqual([...PROMPT_SURFACE_POINT_IDS], ['P1', 'P2'])
  for (const id of PROMPT_SURFACE_POINT_IDS) {
    const point = DECISION_POINT_REGISTRY.find((entry) => entry.id === id)
    assert.ok(point, `missing point ${id}`)
    assert.equal(point.wired, true, `${id} must be wired`)
    assert.equal(point.mode, PROMPT_SURFACE_MODE, `${id} must declare shadow`)
    assert.equal(point.hostSurface, 'session.hook.prompt', `${id} must declare the prompt hook`)
  }
})

await check('P6 and P10 are unwired because no measured surface carries their input', () => {
  for (const id of ['P6', 'P10']) {
    const point = DECISION_POINT_REGISTRY.find((entry) => entry.id === id)
    assert.ok(point, `missing point ${id}`)
    assert.equal(point.wired, false, `${id} must not be wired where its input cannot arrive`)
    assert.equal(declaredSurfaceOf(id), null, `${id} must have no construction site`)
  }
})

await check('P4 and P5 are unwired because their required input is absent', () => {
  // P4 ranks a candidate array (`id`/`score`/`justification`); the measured
  // context payload carries `system` TEXT parts and no candidates. P5 verifies
  // a declared `{ requirements, responses }` pair; the `execute.after` event
  // carries neither. Wiring either would record a permanent refusal.
  for (const id of ['P4', 'P5']) {
    const point = DECISION_POINT_REGISTRY.find((entry) => entry.id === id)
    assert.ok(point, `missing point ${id}`)
    assert.equal(point.wired, false, `${id} must not be wired where its input cannot arrive`)
    assert.equal(declaredSurfaceOf(id), null, `${id} must have no construction site`)
  }
})

await check('P9 is constructed on the compaction carrier it declares', () => {
  assert.equal(declaredSurfaceOf('P9'), 'session.hook.compaction')
  const point = DECISION_POINT_REGISTRY.find((entry) => entry.id === 'P9')
  assert.ok(point, 'missing point P9')
  assert.equal(point.wired, true, 'P9 must be wired')
  assert.equal(point.mode, 'shadow', 'P9 stays shadow')
})

await check('shadow on the measured host shape mutates nothing and records no content', () => {
  const admission = structuredClone(HOST_PROMPT_PAYLOAD_F08)
  const before = structuredClone(admission)
  const observed: unknown[] = []

  const result = observePromptSurface(admission, (record) => {
    observed.push(record)
  })

  assert.deepEqual(admission, before, 'shadow must not mutate the admission payload')
  assert.equal(admission.prompt.skills, 'undefined', 'P2 must not narrow a sentinel skills field')
  assert.deepEqual(
    result.records.map((record) => record.point),
    [...PROMPT_SURFACE_POINT_IDS],
  )
  assert.deepEqual(observed, result.records, 'the sink sees every record')
  for (const record of result.records) {
    assert.equal(record.effect, 'none')
  }
  assert.equal(
    JSON.stringify(result.records).includes('synthetic fixture prompt'),
    false,
    'prompt text must never reach a record',
  )
  assert.equal(result.skills.skillsSource, 'none')
  assert.equal(result.skills.reason, 'skills.source.absent')
})

await check('adapters without an input on this surface record a refusal, not a decision', () => {
  const { records } = observePromptSurface(structuredClone(HOST_PROMPT_PAYLOAD_F08))
  const reasonOf = (id: string): string | undefined =>
    records.find((record) => record.point === id)?.reason
  assert.equal(reasonOf('P1'), 'no.candidates')
})

await check(
  'P3 at tool.invoke classifies from the payload the tool actually receives',
  async () => {
    const sink = createTelemetrySink()
    const definition = createV2LocalDecisionDefinition({
      sink: (record) => {
        sink.emit({ ...record, mode: 'shadow' })
      },
    })
    const input = {
      schemaVersion: 1,
      candidateAgents: ['hermes'],
      domain: null,
      candidateSkillIds: [],
      candidateResourceIds: [],
      memorySearchRelevant: false,
      gateStatus: 'none',
      complexity: {
        boundedness: 0,
        reversibility: 0,
        dependencies: 0,
        uncertainty: 0,
        verification: 2,
      },
    }
    const result = await definition.execute(input, { agent: 'apollo' })
    assert.equal(typeof result.output, 'string')
    assert.equal(sink.size(), 1)
    const [event] = sink.events()
    assert.equal(event?.point, 'P3')
    assert.equal(event?.decision, 'score.high')
    assert.notEqual(event?.reason, 'complexity.invalid')
  },
)

await check('a throwing sink is contained and every record is telemetry-compatible', () => {
  const admission = structuredClone(HOST_PROMPT_PAYLOAD_F08)
  assert.doesNotThrow(() => {
    observePromptSurface(admission, () => {
      throw new Error('observer failure')
    })
  })

  const sink = createTelemetrySink()
  const result = observePromptSurface(admission, (record) => {
    sink.emit({ ...record, mode: PROMPT_SURFACE_MODE })
  })
  assert.equal(sink.size(), result.records.length)
  assert.equal(sink.size(), PROMPT_SURFACE_POINT_IDS.length)
})

console.log(`V2 decision wiring: ${checks} groups passed`)
