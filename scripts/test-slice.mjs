#!/usr/bin/env node
/**
 * Test Slice Engine — Observable & Diff-Aware Slice Selector.
 *
 * Implements Issue #437:
 * 1. Prefer repository-level focused selectors (e.g. `test:quick`, `test:fast`) over path guessing.
 * 2. Map modified source files directly to narrow test slices (<10s).
 * 3. Report mapping gaps with a bounded static/lint fallback instead of escalating to full suites.
 * 4. Support failure/fix loops with `--failed-only <pattern>`.
 * 5. Emit formatted task receipts: command, target count, duration, selection rationale.
 *
 * @module scripts/test-slice
 */

import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'

/**
 * Known repo-level fast slice script names in package.json, ordered by preference.
 */
const REPO_SLICE_SCRIPTS = [
  'test:quick',
  'test:fast',
  'test:slice',
  'test:local',
  'test:unit',
  'test-local',
  'precheck',
]

/**
 * Extensions representing source files that need test coverage.
 */
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
])

/**
 * Extensions representing test files.
 */
const TEST_EXTENSIONS = new Set([
  '.test.ts',
  '.test.tsx',
  '.test.js',
  '.test.jsx',
  '.test.mjs',
  '.spec.ts',
  '.spec.js',
])

/**
 * Inspect package.json in directory for an existing focused slice script.
 */
export function findRepoSliceScript(cwd = process.cwd()) {
  const pkgPath = join(cwd, 'package.json')
  if (!existsSync(pkgPath)) return null

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const scripts = pkg.scripts || {}
    for (const name of REPO_SLICE_SCRIPTS) {
      if (scripts[name]) {
        return { name, command: `npm run ${name}` }
      }
    }
  } catch {
    // Ignore invalid json
  }
  return null
}

/**
 * Get changed files in git working tree.
 */
export function getChangedFiles(cwd = process.cwd()) {
  try {
    const stdout = execSync('git status --porcelain', { cwd, encoding: 'utf8' })
    const files = []
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      // Format: XY path or XY orig -> path
      const parts = trimmed.substring(2).trim().split(' -> ')
      const filePath = parts[parts.length - 1]
      if (filePath && !files.includes(filePath)) {
        files.push(filePath)
      }
    }
    return files
  } catch {
    return []
  }
}

/**
 * Map a single source or test file to its narrow test slice command.
 */
export function mapFileToSlice(filePath, cwd = process.cwd()) {
  const normalized = filePath.replace(/\\/g, '/')
  const ext = extname(normalized)
  const base = basename(normalized)

  // 1. If already a test file, run it directly
  if (
    TEST_EXTENSIONS.has(ext) ||
    normalized.includes('.test.') ||
    normalized.includes('.spec.') ||
    base.startsWith('test_')
  ) {
    if (ext === '.py') {
      return {
        command: `pytest ${normalized} -q --tb=short`,
        testFile: normalized,
        type: 'python-test',
        selection: `direct test file: ${normalized}`,
      }
    }
    if (ext === '.ts' || ext === '.tsx') {
      return {
        command: `npx tsx ${normalized}`,
        testFile: normalized,
        type: 'ts-test',
        selection: `direct test file: ${normalized}`,
      }
    }
    return {
      command: `node --test ${normalized}`,
      testFile: normalized,
      type: 'node-test',
      selection: `direct test file: ${normalized}`,
    }
  }

  // 2. Map source file to candidate test locations
  const stem = base.replace(/\.(ts|tsx|js|jsx|mjs|cjs|py)$/, '')
  const dir = dirname(normalized)

  const candidatePaths = [
    // Same directory
    join(dir, `${stem}.test${ext}`).replace(/\\/g, '/'),
    join(dir, `${stem}.spec${ext}`).replace(/\\/g, '/'),
    // tests/ directory mirroring
    join('tests', `${stem}.test.mjs`).replace(/\\/g, '/'),
    join('tests', `${stem}.test.ts`).replace(/\\/g, '/'),
    join('tests', 'pantheon', `${stem}.test.ts`).replace(/\\/g, '/'),
    join('tests', `test_${stem}.py`).replace(/\\/g, '/'),
    join('tests', `${stem}.test.js`).replace(/\\/g, '/'),
  ]

  for (const candidate of candidatePaths) {
    if (existsSync(join(cwd, candidate))) {
      const candExt = extname(candidate)
      if (candExt === '.py') {
        return {
          command: `pytest ${candidate} -q --tb=short`,
          testFile: candidate,
          type: 'python-slice',
          selection: `slice for ${normalized} -> ${candidate}`,
        }
      }
      if (candExt === '.ts' || candExt === '.tsx') {
        return {
          command: `npx tsx ${candidate}`,
          testFile: candidate,
          type: 'ts-slice',
          selection: `slice for ${normalized} -> ${candidate}`,
        }
      }
      return {
        command: `node --test ${candidate}`,
        testFile: candidate,
        type: 'node-slice',
        selection: `slice for ${normalized} -> ${candidate}`,
      }
    }
  }

  // 3. Mapping gap: no direct test file found
  return {
    command: null,
    testFile: null,
    type: 'mapping-gap',
    fallback: `npx biome check ${normalized}`,
    selection: `mapping gap for ${normalized}: no direct test file found; use static check fallback`,
  }
}

/**
 * Determine the optimal focused test slice for a set of changed files.
 */
export function resolveTestSlice(files = [], options = {}) {
  const cwd = options.cwd || process.cwd()
  const failedOnly = options.failedOnly

  // Filter for relevant source or test files
  const relevantFiles = files.filter((f) => {
    const ext = extname(f)
    return SOURCE_EXTENSIONS.has(ext) || TEST_EXTENSIONS.has(ext) || f.includes('.test.')
  })

  // 1. If repo has a predefined focused script and multiple files changed, prefer it
  const repoScript = findRepoSliceScript(cwd)
  if (repoScript && (relevantFiles.length === 0 || relevantFiles.length > 2)) {
    return {
      command: repoScript.command,
      type: 'repo-selector',
      selection: `repo selector: ${repoScript.name}`,
      files: relevantFiles,
    }
  }

  // 2. If 1 or 2 specific files changed, map to the direct slice
  if (relevantFiles.length > 0) {
    const primaryFile = relevantFiles[0]
    const slice = mapFileToSlice(primaryFile, cwd)

    if (slice.command) {
      let finalCommand = slice.command
      if (failedOnly) {
        if (slice.type.startsWith('python')) {
          finalCommand = `pytest ${slice.testFile} -k "${failedOnly}" -q --tb=short`
        } else if (slice.type.startsWith('node')) {
          finalCommand = `node --test --test-name-pattern="${failedOnly}" ${slice.testFile}`
        }
      }
      return {
        command: finalCommand,
        type: slice.type,
        testFile: slice.testFile,
        selection: slice.selection,
        files: relevantFiles,
      }
    }

    // Mapping gap: fallback to repo selector if present
    if (repoScript) {
      return {
        command: repoScript.command,
        type: 'repo-selector-fallback',
        selection: `mapping gap for ${primaryFile}; fallback to repo selector ${repoScript.name}`,
        files: relevantFiles,
      }
    }

    return {
      command: slice.fallback,
      type: 'mapping-gap',
      selection: slice.selection,
      files: relevantFiles,
    }
  }

  // 3. Fallback to repo selector if available
  if (repoScript) {
    return {
      command: repoScript.command,
      type: 'repo-selector',
      selection: `repo selector: ${repoScript.name}`,
      files: [],
    }
  }

  return {
    command: 'git status',
    type: 'none',
    selection: 'no changed source files detected',
    files: [],
  }
}

/**
 * Execute the slice and produce an observable summary receipt.
 */
export function executeTestSlice(slicePlan, options = {}) {
  const cwd = options.cwd || process.cwd()
  const startTime = Date.now()

  const result = spawnSync(slicePlan.command, {
    cwd,
    shell: true,
    encoding: 'utf8',
  })

  const durationMs = Date.now() - startTime
  const durationSec = (durationMs / 1000).toFixed(2)
  const isPass = result.status === 0

  // Count tests from output lines
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  const passLines = output.split('\n').filter((line) => /✔|PASS|passed/i.test(line))
  const targets = Math.max(1, passLines.length)

  const receipt = {
    status: isPass ? 'PASS' : 'FAIL',
    command: slicePlan.command,
    targets,
    durationSec,
    durationMs,
    selection: slicePlan.selection,
    exitCode: result.status,
    output: isPass ? output.trim().split('\n').slice(-5).join('\n') : output,
  }

  const summaryLine = `**tests:** [${receipt.status}] \`${receipt.command}\` (targets: ${receipt.targets}, duration: ${receipt.durationSec}s, selection: ${receipt.selection})`

  return { ...receipt, summaryLine }
}

// ─── CLI Entrypoint ──────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  const args = process.argv.slice(2)
  const jsonMode = args.includes('--json')
  const runMode = args.includes('--run')
  const failedIdx = args.indexOf('--failed-only')
  const failedOnly = failedIdx !== -1 ? args[failedIdx + 1] : undefined

  const explicitFiles = args.filter((a) => !a.startsWith('--') && a !== failedOnly)
  const files = explicitFiles.length > 0 ? explicitFiles : getChangedFiles()

  const plan = resolveTestSlice(files, { failedOnly })

  if (runMode) {
    const receipt = executeTestSlice(plan)
    if (jsonMode) {
      console.log(JSON.stringify(receipt, null, 2))
    } else {
      console.log(receipt.summaryLine)
      if (receipt.exitCode !== 0) {
        console.error(receipt.output)
        process.exit(receipt.exitCode)
      }
    }
  } else {
    if (jsonMode) {
      console.log(JSON.stringify(plan, null, 2))
    } else {
      console.log(`[Test Slice] Command: ${plan.command}`)
      console.log(`[Test Slice] Selection: ${plan.selection}`)
      console.log(`[Test Slice] Files: ${plan.files.join(', ') || 'none'}`)
    }
  }
}
