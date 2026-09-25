import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const WORKFLOWS_DIR = fileURLToPath(new URL('../.github/workflows/', import.meta.url))

const workflow = readFileSync(
  fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)),
  'utf8',
)

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
)

const packageLock = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package-lock.json', import.meta.url)), 'utf8'),
)

const TUI_WORKSPACE = 'src/plugins/tui'

test('CI dependency installation and required gates are fail-closed', () => {
  assert.doesNotMatch(workflow, /npm ci[^\n]*\|\|[^\n]*npm install/)
  assert.doesNotMatch(workflow, /(?:pytest|npm audit)[^\n]*\|\|/)
  for (const command of ['npm run lint', 'npm run typecheck', 'npm test', 'npm run audit']) {
    assert.ok(workflow.includes(command), `CI must run ${command}`)
  }
  // `npm test` delegates to `test:all`; the unified runner must still cover
  // pytest, node, and ts so the single CI step cannot silently drop a suite.
  const testAll = packageJson.scripts['test:all']
  for (const step of ['npm run test:ci', 'npm run test:node', 'npm run test:ts']) {
    assert.ok(testAll.includes(step), `test:all must include ${step}`)
  }
})

test('CI package evidence verification preserves failures and remains blocking', () => {
  const match = workflow.match(/- name: Verify package\n\s+run: ([^\n]+)/)
  assert.ok(match, 'CI must define a package verification step')
  const command = match[1].trim()
  // The former standalone `version-check` job was folded into `validate`, so
  // the step is now bounded by the next job key or by end of file.
  const packageStep = workflow.match(
    /- name: Verify package\n[\s\S]*?(?=\n {2}[a-z][a-z0-9-]*:|\n*$)/,
  )
  assert.ok(packageStep, 'CI package verification step must be present in the validate job')
  assert.ok(
    workflow.indexOf('- name: Verify package') > workflow.indexOf('validate:'),
    'CI package verification step must live inside the validate job',
  )

  assert.match(command, /^npm run package:evidence -- /)
  assert.match(command, /--target-sha="\$\(git rev-parse HEAD\)"/)
  assert.doesNotMatch(
    command,
    /\|(?:\s|$)/,
    'package evidence must not be piped to a masking command',
  )
  assert.doesNotMatch(
    command,
    /\|\|/,
    'package evidence must not have a fallback that masks failure',
  )
  assert.doesNotMatch(packageStep[0], /continue-on-error:\s*true/)

  const binDir = mkdtempSync(join(tmpdir(), 'ci-pack-contract-'))
  const fakeNpm = join(binDir, 'npm')
  writeFileSync(fakeNpm, '#!/bin/sh\nexit 37\n')
  chmodSync(fakeNpm, 0o755)

  try {
    const result = spawnSync('bash', ['-c', command], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    })
    assert.equal(result.status, 37, 'package evidence failure must fail the workflow step')
  } finally {
    rmSync(binDir, { recursive: true, force: true })
  }
})

test('CI validates YAML and installs locked dependencies only', () => {
  assert.match(workflow, /python3 scripts\/ci-validate-yaml\.py/)
  assert.match(workflow, /npm ci --ignore-scripts/)
  // The TUI plugin used to need its own `npm ci --prefix src/plugins/tui`
  // step. It is removed because it is now REDUNDANT, not because `--prefix`
  // is invalid — that step does operate in the given directory. Under
  // `workspaces` the single root `npm ci` above already installs the TUI from
  // the committed root lockfile.
  //
  // That step was, however, an accidental validator: `npm ci` refuses to run
  // when a manifest and lock disagree, so it would have caught drift in the
  // nested TUI lock. That role is now filled explicitly by
  // tests/tui-workspace-lock.test.mjs, which compares
  // src/plugins/tui/package.json against
  // src/plugins/tui/package-lock.json's packages[""] — the lock users
  // actually install from, which no npm command validates under a workspace
  // parent. What must stay locked is that the root lock actually resolves the
  // workspace; otherwise a root-only install would silently leave solid-js
  // unresolvable and test:ts would fail late.
  assert.ok(
    packageJson.workspaces?.includes(TUI_WORKSPACE),
    `package.json must declare the TUI plugin as a workspace (${TUI_WORKSPACE}) so a single root npm ci installs it`,
  )
  assert.equal(
    packageLock.packages?.['node_modules/pantheon-tui']?.link,
    true,
    'root package-lock.json must link node_modules/pantheon-tui to the TUI workspace',
  )
  assert.equal(
    packageLock.packages?.[TUI_WORKSPACE]?.name,
    'pantheon-tui',
    'root package-lock.json must carry a package entry for the TUI workspace itself',
  )
  assert.match(
    workflow,
    /pip install[^\n]*pytest-asyncio==\d+\.\d+\.\d+/,
    'CI must install locked pytest-asyncio before pytest so asyncio_mode=auto resolves async tests',
  )
  assert.match(
    workflow,
    /pip install[^\n]*-r src\/mcp\/requirements-vision\.txt/,
    'CI must install locked vision deps before pytest so httpx imports resolve',
  )
  assert.match(
    workflow,
    /pip install[^\n]*sqlite-vec==[\d.]+/,
    'CI must install the locked sqlite-vec wheel before pytest so memory_mcp_server imports resolve',
  )
  // fastembed (~180MB wheel) is deliberately NOT installed in CI: only
  // memory_mcp_server needs it, at runtime, and its tests skip gracefully via
  // pytest.importorskip (issue #94). Removing the top-level import is tracked
  // by issue #159. This guard keeps that intent fail-closed — if fastembed
  // ever creeps back into the install step, CI wall-clock and disk regress.
  assert.doesNotMatch(
    workflow,
    /pip install[^\n]*fastembed/,
    'CI must not install fastembed; tests needing it skip via pytest.importorskip (issue #94)',
  )
  assert.doesNotMatch(workflow, /pip install[^\n]*\|\|/)
  const testGate = workflow.indexOf('npm test')
  assert.ok(testGate >= 0, 'CI must run the unified test gate (npm test)')
  assert.ok(
    workflow.indexOf('pytest-asyncio==') < testGate,
    'Locked pytest-asyncio pip install must run BEFORE the pytest gate',
  )
  assert.ok(
    workflow.indexOf('sqlite-vec==') < testGate,
    'Locked sqlite-vec pip install must run BEFORE the pytest gate',
  )
  assert.ok(
    workflow.indexOf('requirements-vision.txt') < testGate,
    'Locked vision pip install must run BEFORE the pytest gate',
  )
  assert.doesNotMatch(workflow, /npm install(?!.*--dry-run)/)
  assert.doesNotMatch(workflow, /\|\| true/)
  assert.doesNotMatch(workflow, /echo ["']?(?:test|audit) warnings/i)
})

test('no workflow installs the TUI plugin separately from the root lockfile', () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  assert.ok(files.length > 0, 'expected at least one workflow to scan')

  const offenders = []
  for (const f of files) {
    const src = readFileSync(join(WORKFLOWS_DIR, f), 'utf8')
    for (const [i, line] of src.split('\n').entries()) {
      // Install verbs only. `npm run build --prefix src/plugins/tui` is the
      // TUI dist-freshness gate and legitimately stays prefix-scoped — a
      // blanket "no --prefix" rule would be wrong and would delete that gate.
      if (!/\bnpm\s+(?:ci|install)\b/.test(line)) continue
      if (!line.includes(TUI_WORKSPACE)) continue
      offenders.push(`${f}:${i + 1}: ${line.trim()}`)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'The TUI plugin is a root workspace (package.json "workspaces" + a linked\n' +
      'entry in the root lockfile), so the root `npm ci` already installs its\n' +
      'dependencies from the committed root lock. A second, prefix-scoped\n' +
      'install would bypass that single source of truth and re-introduce the\n' +
      'dual-lock drift the workspace move removed. Offending lines:\n  - ' +
      offenders.join('\n  - '),
  )

  // Guard the other direction: the dist-freshness build is NOT an install and
  // must survive, or the "stale TUI bundle" check would silently disappear.
  assert.match(
    workflow,
    /npm run build --prefix src\/plugins\/tui/,
    'the TUI dist-freshness build step must remain; it is a build, not an install',
  )
})
