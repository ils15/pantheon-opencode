import assert from 'node:assert/strict'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { snapshot } from '../scripts/install/plan.mjs'
import {
  createPlanArtifact,
  findPlanDrift,
  loadPlanArtifact,
  savePlanArtifact,
  sourceFingerprint,
  validatePlanArtifact,
} from '../scripts/install/plan-artifact.mjs'

const require = createRequire(import.meta.url)
const fs = require('node:fs')

test('plan artifact saves atomically with restrictive permissions and no file contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-plan-artifact-'))
  try {
    const target = join(root, 'target')
    mkdirSync(target)
    const destination = join(target, 'managed.md')
    writeFileSync(destination, 'secret user content')
    const artifact = createPlanArtifact({
      target,
      packageRoot: root,
      packageVersion: '1.6.0-beta.12',
      plannedAt: new Date().toISOString(),
      options: { components: ['agents'] },
      files: [
        { path: destination, action: 'update', bytes: 20, outputFingerprint: 'a'.repeat(64) },
      ],
      snapshots: [
        { path: destination, exists: true, sha256: 'b'.repeat(64), size: 19, mode: 0o100644 },
      ],
    })
    const planPath = join(root, 'nested-plans', 'reviewed-plan.json')
    savePlanArtifact(planPath, artifact)
    const raw = readFileSync(planPath, 'utf8')
    assert.equal(raw.includes('secret user content'), false)
    assert.equal(statSync(planPath).mode & 0o777, 0o600)
    assert.deepEqual(loadPlanArtifact(planPath), artifact)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('plan artifact refuses to replace an existing regular destination', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-plan-existing-'))
  try {
    const target = join(root, 'target')
    mkdirSync(target)
    const artifact = createPlanArtifact({
      target,
      packageRoot: root,
      packageVersion: '1.6.0-beta.12',
      plannedAt: new Date().toISOString(),
      options: {},
      files: [],
      snapshots: [],
    })
    const destination = join(root, 'existing-plan.json')
    writeFileSync(destination, 'preserve this file')

    assert.throws(() => savePlanArtifact(destination, artifact), /already exists/i)
    assert.equal(readFileSync(destination, 'utf8'), 'preserve this file')
    assert.deepEqual(readdirSync(root).sort(), ['existing-plan.json', 'target'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('plan artifact refuses a symlink destination without touching its target', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-plan-symlink-dest-'))
  try {
    const target = join(root, 'target')
    mkdirSync(target)
    const artifact = createPlanArtifact({
      target,
      packageRoot: root,
      packageVersion: '1.6.0-beta.12',
      plannedAt: new Date().toISOString(),
      options: {},
      files: [],
      snapshots: [],
    })
    const sentinel = join(root, 'sentinel.txt')
    const destination = join(root, 'linked-plan.json')
    writeFileSync(sentinel, 'preserve symlink target')
    symlinkSync(sentinel, destination)

    assert.throws(() => savePlanArtifact(destination, artifact), /symlink/i)
    assert.equal(readFileSync(sentinel, 'utf8'), 'preserve symlink target')
    assert.equal(lstatSync(destination).isSymbolicLink(), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('plan artifact fails closed if its parent is replaced before opening the temporary file', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-plan-parent-race-'))
  const parent = join(root, 'plans')
  const movedParent = join(root, 'plans-original')
  const outside = join(root, 'outside')
  mkdirSync(parent)
  mkdirSync(outside)
  const target = join(root, 'target')
  const packageRoot = join(root, 'package')
  mkdirSync(target)
  mkdirSync(packageRoot)
  const artifact = createPlanArtifact({
    target,
    packageRoot,
    packageVersion: '1.6.0-beta.12',
    plannedAt: new Date().toISOString(),
    options: {},
    files: [],
    snapshots: [],
  })

  const originalOpenSync = fs.openSync
  let swapped = false
  fs.openSync = (path, ...args) => {
    if (!swapped && String(path).includes('.tmp-')) {
      swapped = true
      renameSync(parent, movedParent)
      symlinkSync(outside, parent, 'dir')
    }
    return originalOpenSync(path, ...args)
  }
  syncBuiltinESMExports()
  try {
    assert.throws(() => savePlanArtifact(join(parent, 'reviewed-plan.json'), artifact))
    assert.equal(swapped, true)
    assert.deepEqual(readdirSync(outside), [])
    assert.deepEqual(readdirSync(movedParent), [])
  } finally {
    fs.openSync = originalOpenSync
    syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})

test('plan artifact destination cannot collide with a planned operation', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-plan-collision-'))
  try {
    const target = join(root, 'target')
    mkdirSync(target)
    const plannedPath = join(target, '.opencode', 'agents', 'zeus.md')
    const create = (artifactPath) =>
      createPlanArtifact({
        target,
        packageRoot: root,
        packageVersion: '1.6.0-beta.12',
        plannedAt: new Date().toISOString(),
        artifactPath,
        options: {},
        files: [{ path: plannedPath, action: 'create', bytes: 1 }],
        snapshots: [{ path: plannedPath, exists: false, sha256: null, size: 0, mode: null }],
      })

    assert.throws(() => create(plannedPath), /planned operation/i)
    assert.throws(() => create(join(target, '.opencode', 'agents')), /planned operation/i)
    assert.equal(existsSync(plannedPath), false)
    assert.deepEqual(readdirSync(target), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('plan artifact destination cannot be the package source root or install target', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-plan-root-collision-'))
  try {
    const packageRoot = join(root, 'package')
    const target = join(root, 'target')
    mkdirSync(packageRoot)
    mkdirSync(target)
    const create = (artifactPath) =>
      createPlanArtifact({
        target,
        packageRoot,
        packageVersion: '1.6.0-beta.12',
        plannedAt: new Date().toISOString(),
        artifactPath,
        options: {},
        files: [],
        snapshots: [],
      })

    assert.throws(() => create(packageRoot), /package source/i)
    assert.throws(() => create(target), /install target/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('plan artifact rejects unsafe operation paths and symlink artifact paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-plan-path-'))
  try {
    const target = join(root, 'target')
    mkdirSync(target)
    const artifact = createPlanArtifact({
      target,
      packageRoot: root,
      packageVersion: '1.6.0-beta.12',
      plannedAt: new Date().toISOString(),
      options: {},
      files: [],
      snapshots: [],
    })
    artifact.operations.push({
      path: '../outside',
      action: 'update',
      bytes: 1,
      outputFingerprint: 'c'.repeat(64),
      before: { exists: false, sha256: null, size: 0, mode: null },
    })
    assert.throws(() => validatePlanArtifact(artifact), /path/i)
    const actual = join(root, 'plan.json')
    const link = join(root, 'plan-link.json')
    writeFileSync(actual, '{}')
    symlinkSync(actual, link)
    assert.throws(() => loadPlanArtifact(link), /symlink/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('source fingerprint changes when a package source file changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-source-fingerprint-'))
  try {
    writeFileSync(join(root, 'source.js'), 'before')
    const before = sourceFingerprint(root)
    writeFileSync(join(root, 'source.js'), 'after')
    assert.notEqual(sourceFingerprint(root), before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('external global TUI operations are restricted and included in drift checks', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-plan-external-drift-'))
  const previousHome = process.env.HOME
  const previousXdg = process.env.XDG_CONFIG_HOME
  try {
    const target = join(root, 'target')
    const packageRoot = join(root, 'package')
    const home = join(root, 'home')
    const tuiPath = join(home, '.opencode', 'tui.json')
    mkdirSync(target)
    mkdirSync(packageRoot)
    mkdirSync(join(home, '.opencode'), { recursive: true })
    writeFileSync(join(packageRoot, 'source.js'), 'stable')
    writeFileSync(tuiPath, '{"plugin":["plugins/pantheon-tui"]}\n')
    process.env.HOME = home
    delete process.env.XDG_CONFIG_HOME
    const file = {
      path: tuiPath,
      action: 'update',
      bytes: 13,
      outputFingerprint: 'c'.repeat(64),
    }
    const artifact = createPlanArtifact({
      target,
      packageRoot,
      packageVersion: '1.6.0-beta.12',
      plannedAt: new Date().toISOString(),
      options: {},
      files: [file],
      snapshots: [{ path: tuiPath, ...snapshot(tuiPath) }],
    })
    assert.equal(artifact.operations[0].scope, 'user-config')

    writeFileSync(tuiPath, '{"plugin":[]}\n')
    const drift = findPlanDrift(artifact, {
      target,
      packageRoot,
      packageVersion: '1.6.0-beta.12',
      files: [file],
      snapshots: [{ path: tuiPath, ...snapshot(tuiPath) }],
    })
    assert.ok(drift.includes(tuiPath))
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
    rmSync(root, { recursive: true, force: true })
  }
})
