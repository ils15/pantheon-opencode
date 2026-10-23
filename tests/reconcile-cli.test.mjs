import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createInitialState, writeState } from '../scripts/install/state.mjs'

const CLI = join(process.cwd(), 'scripts', 'reconcile.mjs')
const INIT = join(process.cwd(), 'bin', 'pantheon-init.mjs')
const DOCTOR = join(process.cwd(), 'scripts', 'doctor.mjs')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

// The seeded inventories below are project-v1 layouts. Pin the host generation
// so the preview does not depend on which OpenCode binary is installed on the
// machine running the tests (a V2 host would classify every owned path as a
// layout mismatch).
const BASE_ENV = { OPENCODE_VERSION: 'v1' }

function run(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: cwd, XDG_CONFIG_HOME: join(cwd, '.config'), ...BASE_ENV },
  })
}

function seedTarget(target, entries) {
  mkdirSync(target, { recursive: true })
  const state = createInitialState('1.0.0')
  state.file_inventory.target_root = target
  state.file_inventory.entries = []
  state.file_inventory.legacy_unknown = false
  for (const { path, content, component = 'agents', layout = 'project-v1' } of entries) {
    const absolute = join(target, path)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content)
    state.file_inventory.entries.push({
      path,
      component,
      layout,
      sha256: sha256(content),
      mode: statSync(absolute).mode & 0o777,
    })
  }
  writeState(target, state)
  return state
}

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-reconcile-cli-'))
  try {
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('reconcile preview is read-only, scoped to selected components, and saves a private exact plan', () => {
  withRoot((root) => {
    const target = join(root, 'project')
    const planPath = join(root, 'review.json')
    seedTarget(target, [
      { path: '.opencode/agents/retired.md', content: 'old agent' },
      { path: '.opencode/skills/retired/SKILL.md', content: 'old skill', component: 'skills' },
    ])
    const beforeState = readFileSync(join(target, '.pantheon', 'install-state.json'))
    const preview = run(
      ['--target', target, '--components', 'agents', '--dry-run', '--save-plan', planPath],
      root,
    )
    assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`)
    assert.match(preview.stdout, /stale-owned/)
    assert.equal(readFileSync(join(target, '.opencode/agents/retired.md'), 'utf8'), 'old agent')
    assert.equal(existsSync(join(target, '.pantheon/backups')), false)
    assert.deepEqual(readFileSync(join(target, '.pantheon', 'install-state.json')), beforeState)

    const artifact = JSON.parse(readFileSync(planPath, 'utf8'))
    assert.equal(statSync(planPath).mode & 0o777, 0o600)
    assert.deepEqual(
      artifact.operations.map((operation) => operation.path),
      ['.opencode/agents/retired.md'],
    )
    assert.equal(artifact.operations[0].sha256, sha256('old agent'))
    assert.equal(
      artifact.operations.some((operation) => operation.path.includes('retired/SKILL')),
      false,
    )
  })
})

test('reconcile honors explicit global targets and keeps explicit targets project-scoped by default', () => {
  withRoot((root) => {
    const globalTarget = join(root, 'custom-global')
    const globalPlan = join(root, 'global-review.json')
    seedTarget(globalTarget, [
      { path: 'agents/retired.md', content: 'old global agent', layout: 'global' },
    ])
    const globalReview = run(
      ['--global', '--target', globalTarget, '--components', 'agents', '--save-plan', globalPlan],
      root,
    )
    assert.equal(globalReview.status, 0, `${globalReview.stdout}\n${globalReview.stderr}`)
    assert.match(globalReview.stdout, /stale-owned\s+agents\/retired\.md/)
    assert.equal(JSON.parse(readFileSync(globalPlan, 'utf8')).selected_layouts.agents, 'global')

    const projectTarget = join(root, 'custom-project')
    const projectPlan = join(root, 'project-review.json')
    seedTarget(projectTarget, [
      { path: '.opencode/agents/retired.md', content: 'old project agent' },
    ])
    const projectReview = run(
      ['--target', projectTarget, '--components', 'agents', '--save-plan', projectPlan],
      root,
    )
    assert.equal(projectReview.status, 0, `${projectReview.stdout}\n${projectReview.stderr}`)
    assert.match(projectReview.stdout, /stale-owned\s+\.opencode\/agents\/retired\.md/)
    assert.equal(
      JSON.parse(readFileSync(projectPlan, 'utf8')).selected_layouts.agents,
      'project-v1',
    )
  })
})

test('reconcile requires authorization, backs up, and removes only exact reviewed regular files', () => {
  withRoot((root) => {
    const target = join(root, 'project')
    const planPath = join(root, 'review.json')
    seedTarget(target, [{ path: '.opencode/agents/retired.md', content: 'old agent' }])
    const saved = run(['--target', target, '--components', 'agents', '--save-plan', planPath], root)
    assert.equal(saved.status, 0, saved.stderr)

    const unauthorized = run(['--apply-plan', planPath], root)
    assert.equal(unauthorized.status, 2)
    assert.equal(existsSync(join(target, '.opencode/agents/retired.md')), true)

    mkdirSync(join(target, '.opencode/agents/nested'), { recursive: true })
    writeFileSync(join(target, '.opencode/agents/nested/user.md'), 'keep')
    const applied = run(['--apply-plan', planPath, '--yes'], root)
    assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`)
    assert.equal(existsSync(join(target, '.opencode/agents/retired.md')), false)
    assert.equal(readFileSync(join(target, '.opencode/agents/nested/user.md'), 'utf8'), 'keep')
    const backup = join(target, '.pantheon/backups')
    const backupSet = join(backup, readdirSync(backup)[0], '.opencode/agents/retired.md')
    assert.equal(readFileSync(backupSet, 'utf8'), 'old agent')
    assert.deepEqual(
      JSON.parse(readFileSync(join(target, '.pantheon', 'install-state.json'))).file_inventory
        .entries,
      [],
    )
  })
})

test('reconcile aborts saved plan when operation-set ownership drifts before apply', () => {
  withRoot((root) => {
    const target = join(root, 'project')
    const planPath = join(root, 'review.json')
    const owned = join(target, '.opencode/agents/retired.md')
    seedTarget(target, [{ path: '.opencode/agents/retired.md', content: 'old agent' }])
    const saved = run(['--target', target, '--components', 'agents', '--save-plan', planPath], root)
    assert.equal(saved.status, 0, saved.stderr)
    writeFileSync(owned, 'user changed it')

    const applied = run(['--apply-plan', planPath, '--yes'], root)
    assert.equal(applied.status, 3)
    assert.equal(readFileSync(owned, 'utf8'), 'user changed it')
    assert.equal(existsSync(join(target, '.pantheon/backups')), false)
  })
})

test('init records a versioned per-file inventory after verified writes', () => {
  withRoot((root) => {
    const result = spawnSync(
      process.execPath,
      [
        INIT,
        'init',
        '--project',
        '--components',
        'agents',
        '--no-mcp',
        '--version',
        'v1',
        '--yes',
        '--headless',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: root,
          XDG_CONFIG_HOME: join(root, '.config'),
          ...BASE_ENV,
        },
      },
    )
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const state = JSON.parse(readFileSync(join(root, '.pantheon', 'install-state.json'), 'utf8'))
    assert.equal(state.file_inventory.schema_version, 1)
    assert.equal(state.file_inventory.target_root, root)
    assert.ok(state.file_inventory.entries.length > 0)
    assert.ok(state.file_inventory.entries.every((entry) => entry.component === 'agents'))
    assert.ok(state.file_inventory.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)))
    assert.ok(state.file_inventory.entries.every((entry) => Number.isInteger(entry.mode)))
    assert.ok(
      state.file_inventory.entries.every(
        (entry) =>
          Object.keys(entry).sort().join(',') === 'component,layout,mode,path,sha256' &&
          !Object.hasOwn(entry, 'content'),
      ),
    )
  })
})

test('doctor reports recorded-file drift distinctly without modifying the target', () => {
  withRoot((root) => {
    const target = join(root, 'project')
    const ownedPath = '.opencode/agents/zeus.md'
    seedTarget(target, [{ path: ownedPath, content: 'installed agent' }])
    writeFileSync(join(target, ownedPath), 'user changed this')
    const statePath = join(target, '.pantheon', 'install-state.json')
    const beforeState = readFileSync(statePath)
    const result = spawnSync(
      process.execPath,
      [DOCTOR, '--target', target, '--profile', 'lite', '--json'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: root,
          XDG_CONFIG_HOME: join(root, '.config'),
          ...BASE_ENV,
        },
      },
    )
    assert.ok([0, 2].includes(result.status), `${result.stdout}\n${result.stderr}`)
    const report = JSON.parse(result.stdout)
    assert.ok(report.findings.some((finding) => finding.code === 'installer_file_modified'))
    assert.equal(readFileSync(join(target, ownedPath), 'utf8'), 'user changed this')
    assert.deepEqual(readFileSync(statePath), beforeState)
  })
})
