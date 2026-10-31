/**
 * Wiring audit — "declared in the registry" is not "constructed by the plugin".
 *
 * The defect this file exists for: nine of eleven points were described as
 * running in shadow while no production file imported them. Prose did not catch
 * it and a second hand-maintained list would reproduce it, so the truth is
 * derived from the source:
 *
 *   1. the adapter module for a point is found by its `p<number>-` file name;
 *   2. the exported handler names are read from that adapter's own source;
 *   3. the point is wired only when a file reachable from `src/plugin-v2.ts`
 *      imports one of those names and calls it.
 *
 * Nothing here re-lists which point is wired: changing the plugin changes the
 * answer, and the registry entry has to follow.
 *
 * Run with: npx tsx tests/pantheon/v2-decision-wiring.test.ts
 */
import { strict as assert } from 'node:assert'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DECISION_POINT_REGISTRY,
  type DecisionPoint,
} from '../../src/pantheon/v2-decision-registry.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PRODUCTION_ENTRY = join(ROOT, 'src/plugin-v2.ts')
const ADAPTER_DIR = join(ROOT, 'src/pantheon/v2-decision-points')

let checks = 0
const check = (name: string, fn: () => void): void => {
  fn()
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

interface WiringViolation {
  readonly pointId: string
  readonly claimed: boolean
  readonly constructed: boolean
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

check('every registry entry declares wired as a boolean', () => {
  for (const point of DECISION_POINT_REGISTRY) {
    assert.equal(typeof point.wired, 'boolean', `${point.id} must declare wired`)
  }
})

const productionFiles = productionImportGraph(PRODUCTION_ENTRY)
const derived = new Map(
  DECISION_POINT_REGISTRY.map((point) => [point.id, isConstructed(point.id, productionFiles)]),
)
const constructed = (pointId: string): boolean => derived.get(pointId) === true

check('wired matches what the production import graph actually constructs', () => {
  const violations = findWiringViolations(DECISION_POINT_REGISTRY, constructed)
  assert.deepEqual(
    violations,
    [],
    `registry claims and source disagree: ${JSON.stringify(violations)}`,
  )
})

check('the audit fails when a point claims wired without a construction site', () => {
  const lying = DECISION_POINT_REGISTRY.map((point) =>
    point.id === 'P1' ? { ...point, wired: true } : point,
  )
  assert.deepEqual(findWiringViolations(lying, constructed), [
    { pointId: 'P1', claimed: true, constructed: false },
  ])
})

check('the audit fails when a wired point claims it is not', () => {
  const understated = DECISION_POINT_REGISTRY.map((point) =>
    point.id === 'P7' ? { ...point, wired: false } : point,
  )
  assert.deepEqual(findWiringViolations(understated, constructed), [
    { pointId: 'P7', claimed: false, constructed: true },
  ])
})

console.log(`V2 decision wiring: ${checks} groups passed`)
