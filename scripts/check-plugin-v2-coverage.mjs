import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REQUIRED_NODE_VERSION = 'v24.15.0'
export const LINE_THRESHOLD_NUMERATOR = 4
export const LINE_THRESHOLD_DENOMINATOR = 5

function integerField(value, name, minimum) {
  const label = minimum === 0 ? 'non-negative' : 'positive'
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a ${label} integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be a ${label} integer`)
  }
  return parsed
}

function normalizeSourcePath(source, repoRoot) {
  const path = source.startsWith('file:') ? fileURLToPath(source) : source
  return resolve(repoRoot, path)
}

function exactlyOneField(lines, name) {
  const values = lines.filter((line) => line.startsWith(`${name}:`))
  if (values.length !== 1) {
    throw new Error(`target LCOV record must contain exactly one ${name} field`)
  }
  return values[0].slice(name.length + 1)
}

function optionalPair(lines, foundName, hitName) {
  const foundFields = lines.filter((line) => line.startsWith(`${foundName}:`))
  const hitFields = lines.filter((line) => line.startsWith(`${hitName}:`))
  if (foundFields.length === 0 && hitFields.length === 0) return null
  if (foundFields.length !== 1 || hitFields.length !== 1) {
    throw new Error(`target LCOV record must contain one ${foundName}/${hitName} pair`)
  }

  const found = integerField(foundFields[0].slice(foundName.length + 1), foundName, 0)
  const hit = integerField(hitFields[0].slice(hitName.length + 1), hitName, 0)
  if (hit > found) throw new Error(`${hitName} ${hit} exceeds ${foundName} ${found}`)
  return { hit, found }
}

/** Parse and validate the single LCOV record for the exact target source. */
export function parseTargetLcov(report, repoRoot, targetPath) {
  if (typeof report !== 'string' || report.trim() === '') {
    throw new Error('LCOV report is empty')
  }
  const normalizedRoot = resolve(repoRoot)
  const normalizedTarget = resolve(targetPath)
  const records = []
  let current = []
  for (const line of report.split(/\r?\n/)) {
    if (line === 'end_of_record') {
      if (current.length > 0) records.push(current)
      current = []
    } else if (line.trim() !== '') {
      current.push(line)
    }
  }
  if (current.length > 0) records.push(current)

  const targetRecords = []
  for (const lines of records) {
    const sourceFields = lines.filter((line) => line.startsWith('SF:'))
    const matchingSources = sourceFields.filter(
      (line) => normalizeSourcePath(line.slice(3), normalizedRoot) === normalizedTarget,
    )
    if (matchingSources.length === 0) continue
    if (sourceFields.length !== 1 || matchingSources.length !== 1) {
      throw new Error('target LCOV record must contain exactly one SF entry')
    }
    targetRecords.push(lines)
  }

  if (targetRecords.length !== 1) {
    throw new Error(
      `expected exactly one LCOV record for ${normalizedTarget}; found ${targetRecords.length} LCOV records`,
    )
  }

  const lines = targetRecords[0]
  const lineRecords = new Map()
  for (const entry of lines.filter((line) => line.startsWith('DA:'))) {
    const fields = entry.slice(3).split(',')
    if (fields.length < 2 || fields.length > 3) {
      throw new Error('DA entry must contain a line number and execution count')
    }
    const lineNumber = integerField(fields[0], 'DA line number', 1)
    const count = integerField(fields[1], 'DA count', 0)
    if (lineRecords.has(lineNumber)) {
      throw new Error(`duplicate DA line number ${lineNumber}`)
    }
    lineRecords.set(lineNumber, count)
  }

  const found = integerField(exactlyOneField(lines, 'LF'), 'LF', 1)
  const hit = integerField(exactlyOneField(lines, 'LH'), 'LH', 0)
  if (hit > found) throw new Error(`LH ${hit} exceeds LF ${found}`)
  if (found !== lineRecords.size) {
    throw new Error(`LF ${found} does not equal ${lineRecords.size} unique DA entries`)
  }

  const coveredRecords = [...lineRecords.values()].filter((count) => count > 0).length
  if (hit !== coveredRecords) {
    throw new Error(`LH ${hit} does not equal ${coveredRecords} covered DA entries`)
  }

  return {
    sourcePath: normalizedTarget,
    lines: { hit, found },
    branches: optionalPair(lines, 'BRF', 'BRH'),
    functions: optionalPair(lines, 'FNF', 'FNH'),
  }
}

/** Compare using integer arithmetic so the 80% boundary cannot round down. */
export function passesLineThreshold(coverage) {
  return (
    BigInt(coverage.lines.hit) * BigInt(LINE_THRESHOLD_DENOMINATOR) >=
    BigInt(coverage.lines.found) * BigInt(LINE_THRESHOLD_NUMERATOR)
  )
}

function formatMetric(metric) {
  if (metric == null || metric.found === 0) return 'not reported'
  return `${metric.hit}/${metric.found} (${((metric.hit / metric.found) * 100).toFixed(2)}%)`
}

function listTypeScriptTests(repoRoot) {
  const directory = join(repoRoot, 'tests', 'pantheon')
  return readdirSync(directory)
    .filter((file) => file.endsWith('.test.ts'))
    .sort()
    .map((file) => join(directory, file))
}

function runCoverage() {
  if (process.version !== REQUIRED_NODE_VERSION) {
    throw new Error(
      `plugin-v2 coverage requires Node ${REQUIRED_NODE_VERSION}; got ${process.version}`,
    )
  }

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const targetPath = resolve(repoRoot, 'src', 'plugin-v2.ts')
  const testFiles = listTypeScriptTests(repoRoot)
  if (testFiles.length === 0) throw new Error('no tests/pantheon/*.test.ts files found')

  const tempRoot = mkdtempSync(join(tmpdir(), 'pantheon-plugin-v2-coverage-'))
  try {
    const lcovPath = join(tempRoot, 'coverage.lcov')
    const nodeOptions = [process.env.NODE_OPTIONS, '--conditions=import'].filter(Boolean).join(' ')
    const args = [
      '--experimental-test-coverage',
      '--enable-source-maps',
      '--import',
      'tsx',
      '--test',
      '--test-concurrency=1',
      '--test-reporter=spec',
      '--test-reporter=lcov',
      '--test-reporter-destination=stdout',
      `--test-reporter-destination=${lcovPath}`,
      ...testFiles,
    ]
    const result = spawnSync(process.execPath, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
      maxBuffer: 32 * 1024 * 1024,
    })
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.error) throw new Error(`TypeScript test command failed: ${result.error.message}`)
    if (result.status !== 0) {
      throw new Error(`TypeScript test command exited ${result.status ?? 'without a status'}`)
    }

    let report
    try {
      report = readFileSync(lcovPath, 'utf8')
    } catch (error) {
      throw new Error(`LCOV report was not generated: ${error.message}`)
    }
    const coverage = parseTargetLcov(report, repoRoot, targetPath)
    console.log(`Coverage source: ${coverage.sourcePath}`)
    console.log(`Lines: ${formatMetric(coverage.lines)}`)
    console.log(`Branches (informational): ${formatMetric(coverage.branches)}`)
    console.log(`Functions (informational): ${formatMetric(coverage.functions)}`)
    if (!passesLineThreshold(coverage)) {
      throw new Error('src/plugin-v2.ts line coverage is below the required 80%')
    }
    console.log('src/plugin-v2.ts line coverage: PASS (>= 80%)')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    runCoverage()
  } catch (error) {
    console.error(`Plugin V2 coverage gate: ${error.message}`)
    process.exitCode = 1
  }
}
