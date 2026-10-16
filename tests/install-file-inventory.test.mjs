import assert from 'node:assert/strict'
import { createHash as cryptoCreateHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { restoreBackupSet } from '../scripts/install/backup.mjs'
import {
  applyFileDriftPlan,
  classifyFileInventory,
  updateFileInventory,
} from '../scripts/install/file-inventory.mjs'
import { createInitialState, readState, writeState } from '../scripts/install/state.mjs'

const hash = (content) => createHash(content)
function createHash(content) {
  return cryptoCreateHash('sha256').update(content).digest('hex')
}

function withTarget(fn) {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-inventory-'))
  try {
    return fn(target)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
}

function seedOwnedFile(target, relPath, content, component = 'agents', layout = 'project-v1') {
  const path = join(target, relPath)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, { mode: 0o640 })
  const state = createInitialState('1.0.0')
  updateFileInventory(state, target, {
    selectedComponents: [component],
    verifiedFiles: [
      { path, sha256: hash(content), mode: 0o640, component, layout, action: 'create' },
    ],
  })
  writeState(target, state)
  return state
}

test('inventory classifies current, missing, drift, modified, stale, and unselected files', () => {
  withTarget((target) => {
    const state = createInitialState('1.0.0')
    const files = [
      ['agents/current.md', 'current', 'agents'],
      ['agents/missing.md', 'missing', 'agents'],
      ['agents/update.md', 'old', 'agents'],
      ['agents/modified.md', 'owned', 'agents'],
      ['agents/stale.md', 'stale', 'agents'],
      ['skills/keep.md', 'skill', 'skills'],
    ]
    for (const [relPath, content] of files) {
      const path = join(target, relPath)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, content)
    }
    updateFileInventory(state, target, {
      selectedComponents: ['agents', 'skills'],
      verifiedFiles: files.map(([relPath, content, component]) => ({
        path: join(target, relPath),
        sha256: hash(content),
        mode: 0o644,
        component,
        layout: 'project-v1',
        action: 'create',
      })),
    })
    unlinkSync(join(target, 'agents', 'missing.md'))
    writeFileSync(join(target, 'agents', 'modified.md'), 'user edit')
    const report = classifyFileInventory(target, state, {
      selectedComponents: ['agents'],
      desiredFiles: new Map([
        ['agents/current.md', { sha256: hash('current') }],
        ['agents/update.md', { sha256: hash('new') }],
      ]),
    })
    const classes = Object.fromEntries(
      report.entries.map((entry) => [entry.path, entry.classification]),
    )
    assert.equal(classes['agents/current.md'], 'current')
    assert.equal(classes['agents/missing.md'], 'missing')
    assert.equal(classes['agents/update.md'], 'update-drift')
    assert.equal(classes['agents/modified.md'], 'modified')
    assert.equal(classes['agents/stale.md'], 'stale-owned')
    assert.equal(classes['skills/keep.md'], 'unselected')
    assert.deepEqual(
      report.operations.map((operation) => operation.path),
      ['agents/stale.md'],
    )
  })
})

test('legacy and invalid inventory are ambiguous and cannot create removal operations', () => {
  withTarget((target) => {
    const state = createInitialState('1.0.0')
    state.file_inventory = {
      schema_version: 1,
      target_root: target,
      legacy_unknown: true,
      entries: [],
    }
    const report = classifyFileInventory(target, state, { selectedComponents: ['agents'] })
    assert.equal(report.manualReview, true)
    assert.deepEqual(report.operations, [])

    state.file_inventory.legacy_unknown = false
    state.file_inventory.entries = [
      {
        path: '../outside',
        component: 'agents',
        layout: 'project-v1',
        sha256: hash('x'),
        mode: 0o644,
      },
    ]
    const invalid = classifyFileInventory(target, state, { selectedComponents: ['agents'] })
    assert.equal(invalid.entries[0].classification, 'ambiguous')
    assert.deepEqual(invalid.operations, [])
    assert.throws(
      () =>
        updateFileInventory(state, target, {
          selectedComponents: ['agents'],
          verifiedFiles: [
            {
              path: join(target, '../outside'),
              sha256: hash('x'),
              mode: 0o644,
              component: 'agents',
              layout: 'project-v1',
              action: 'create',
            },
          ],
        }),
      /outside the selected target/,
    )

    state.file_inventory = { schema_version: 1, target_root: target, entries: [] }
    const malformed = classifyFileInventory(target, state, { selectedComponents: ['agents'] })
    assert.equal(malformed.manualReview, true)
    assert.deepEqual(malformed.operations, [])
  })
})

test('symlinks and special files are ambiguous and never followed or removed', () => {
  withTarget((target) => {
    const outside = mkdtempSync(join(tmpdir(), 'pantheon-inventory-outside-'))
    try {
      writeFileSync(join(outside, 'victim'), 'outside')
      symlinkSync(join(outside, 'victim'), join(target, 'linked.md'))
      symlinkSync(outside, join(target, 'linked-dir'), 'dir')
      mkdirSync(join(target, 'directory-entry'))
      const state = createInitialState('1.0.0')
      state.file_inventory = {
        schema_version: 1,
        target_root: target,
        legacy_unknown: false,
        entries: [
          {
            path: 'linked.md',
            component: 'agents',
            layout: 'project-v1',
            sha256: hash('outside'),
            mode: 0o644,
          },
          {
            path: 'linked-dir/victim',
            component: 'agents',
            layout: 'project-v1',
            sha256: hash('outside'),
            mode: 0o644,
          },
          {
            path: 'directory-entry',
            component: 'agents',
            layout: 'project-v1',
            sha256: hash('not a regular file'),
            mode: 0o755,
          },
        ],
      }
      const report = classifyFileInventory(target, state, { selectedComponents: ['agents'] })
      assert.ok(report.entries.every((entry) => entry.classification === 'ambiguous'))
      assert.deepEqual(report.operations, [])
      assert.equal(readFileSync(join(outside, 'victim'), 'utf8'), 'outside')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

test('inventory reconciliation updates selected entries but preserves unselected ownership', () => {
  withTarget((target) => {
    const state = createInitialState('1.0.0')
    const agentsFile = join(target, 'agents/a.md')
    const skillsFile = join(target, 'skills/s.md')
    mkdirSync(join(target, 'agents'), { recursive: true })
    mkdirSync(join(target, 'skills'), { recursive: true })
    writeFileSync(agentsFile, 'old')
    writeFileSync(skillsFile, 'skill')
    updateFileInventory(state, target, {
      selectedComponents: ['agents', 'skills'],
      verifiedFiles: [
        {
          path: agentsFile,
          sha256: hash('old'),
          mode: 0o644,
          component: 'agents',
          layout: 'project-v1',
          action: 'create',
        },
        {
          path: skillsFile,
          sha256: hash('skill'),
          mode: 0o644,
          component: 'skills',
          layout: 'project-v1',
          action: 'create',
        },
      ],
    })
    state.file_inventory.entries.push({ path: '../legacy', component: 'invalid-unowned-record' })
    writeFileSync(agentsFile, 'new')
    writeFileSync(skillsFile, 'changed skill')
    updateFileInventory(state, target, {
      selectedComponents: ['agents'],
      verifiedFiles: [
        {
          path: join(target, 'agents/a.md'),
          sha256: hash('new'),
          mode: 0o600,
          component: 'agents',
          layout: 'project-v1',
          action: 'update',
        },
        {
          path: skillsFile,
          sha256: hash('changed skill'),
          mode: 0o600,
          component: 'skills',
          layout: 'project-v1',
          action: 'update',
        },
      ],
    })
    assert.equal(
      state.file_inventory.entries.find((entry) => entry.component === 'agents').sha256,
      hash('new'),
    )
    assert.ok(state.file_inventory.entries.some((entry) => entry.component === 'skills'))
    assert.equal(
      state.file_inventory.entries.find((entry) => entry.component === 'skills').sha256,
      hash('skill'),
    )
    assert.ok(state.file_inventory.entries.some((entry) => entry.path === '../legacy'))
  })
})

test('recorded-state classification is explicit when desired payload is unavailable', () => {
  withTarget((target) => {
    const state = seedOwnedFile(target, 'agents/a.md', 'installed')
    const report = classifyFileInventory(target, state, {
      desiredUnavailable: true,
      selectedComponents: ['agents'],
    })
    assert.equal(report.entries[0].classification, 'recorded-current')
    assert.deepEqual(report.operations, [])
  })
})

test('inventory root identity mismatch is ambiguous and never authorizes deletion', () => {
  withTarget((target) => {
    const state = seedOwnedFile(target, 'agents/a.md', 'owned')
    state.file_inventory.target_root = join(target, 'moved')
    const report = classifyFileInventory(target, state, {
      selectedComponents: ['agents'],
      desiredFiles: new Map(),
    })
    assert.equal(report.manualReview, true)
    assert.equal(report.entries[0].classification, 'ambiguous')
    assert.deepEqual(report.operations, [])
  })
})

test('apply revalidates reviewed operations, backs up, deletes exact files only, and writes state', () => {
  withTarget((target) => {
    const state = seedOwnedFile(target, 'agents/stale.md', 'owned')
    mkdirSync(join(target, 'agents', 'nested'), { recursive: true })
    writeFileSync(join(target, 'agents', 'nested', 'user.md'), 'keep')
    const preview = classifyFileInventory(target, state, {
      selectedComponents: ['agents'],
      desiredFiles: new Map(),
    })
    const result = applyFileDriftPlan(target, state, preview, {
      selectedComponents: ['agents'],
      desiredFiles: new Map(),
    })
    assert.equal(existsSync(join(target, 'agents/stale.md')), false)
    assert.equal(readFileSync(join(target, 'agents/nested/user.md'), 'utf8'), 'keep')
    assert.ok(result.backupDir)
    assert.equal(readFileSync(join(result.backupDir, 'agents/stale.md'), 'utf8'), 'owned')
    assert.ok(readState(target).file_inventory.entries.length === 0)
    assert.deepEqual(readdirSync(join(target, 'agents', 'nested')), ['user.md'])
    restoreBackupSet(result.backupDir, target, { dryRun: false })
    assert.equal(readFileSync(join(target, 'agents/stale.md'), 'utf8'), 'owned')
  })
})

test('apply aborts on plan-set or content drift before backup and deletion', () => {
  withTarget((target) => {
    const state = seedOwnedFile(target, 'agents/stale.md', 'owned')
    const reviewed = classifyFileInventory(target, state, {
      selectedComponents: ['agents'],
      desiredFiles: new Map(),
    })
    writeFileSync(join(target, 'agents/stale.md'), 'changed')
    assert.throws(
      () =>
        applyFileDriftPlan(target, state, reviewed, {
          selectedComponents: ['agents'],
          desiredFiles: new Map(),
        }),
      /drift|changed|review/i,
    )
    assert.equal(readFileSync(join(target, 'agents/stale.md'), 'utf8'), 'changed')
    assert.equal(existsSync(join(target, '.pantheon', 'backups')), false)
  })
})

test('apply rejects a symlinked state file before backup or deletion', () => {
  withTarget((target) => {
    const state = seedOwnedFile(target, 'agents/stale.md', 'owned')
    const outside = mkdtempSync(join(tmpdir(), 'pantheon-inventory-state-'))
    try {
      const externalState = join(outside, 'state.json')
      const statePath = join(target, '.pantheon', 'install-state.json')
      const externalBytes = readFileSync(statePath)
      writeFileSync(externalState, externalBytes)
      unlinkSync(statePath)
      symlinkSync(externalState, statePath)

      const reviewed = classifyFileInventory(target, state, {
        selectedComponents: ['agents'],
        desiredFiles: new Map(),
      })
      assert.throws(
        () =>
          applyFileDriftPlan(target, state, reviewed, {
            selectedComponents: ['agents'],
            desiredFiles: new Map(),
          }),
        /symlink|regular file/i,
      )
      assert.equal(readFileSync(join(target, 'agents/stale.md'), 'utf8'), 'owned')
      assert.deepEqual(readFileSync(externalState), externalBytes)
      assert.equal(existsSync(join(target, '.pantheon/backups')), false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

test('apply rejects symlinked state ancestors and a persisted inventory for another root', () => {
  withTarget((target) => {
    const state = seedOwnedFile(target, 'agents/stale.md', 'owned')
    const outside = mkdtempSync(join(tmpdir(), 'pantheon-inventory-state-parent-'))
    try {
      const stateDir = join(target, '.pantheon')
      const externalState = join(outside, 'install-state.json')
      const originalState = readFileSync(join(stateDir, 'install-state.json'))
      writeFileSync(externalState, originalState)
      rmSync(stateDir, { recursive: true })
      symlinkSync(outside, stateDir, 'dir')

      const reviewed = classifyFileInventory(target, state, {
        selectedComponents: ['agents'],
        desiredFiles: new Map(),
      })
      assert.throws(
        () =>
          applyFileDriftPlan(target, state, reviewed, {
            selectedComponents: ['agents'],
            desiredFiles: new Map(),
          }),
        /symlink/i,
      )
      assert.equal(readFileSync(join(target, 'agents/stale.md'), 'utf8'), 'owned')
      assert.deepEqual(readFileSync(externalState), originalState)
      assert.equal(existsSync(join(outside, 'backups')), false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  withTarget((target) => {
    const state = seedOwnedFile(target, 'agents/stale.md', 'owned')
    const statePath = join(target, '.pantheon', 'install-state.json')
    const persistedState = JSON.parse(readFileSync(statePath, 'utf8'))
    persistedState.file_inventory.target_root = join(target, 'different-root')
    writeFileSync(statePath, `${JSON.stringify(persistedState)}\n`)
    const reviewed = classifyFileInventory(target, state, {
      selectedComponents: ['agents'],
      desiredFiles: new Map(),
    })

    assert.throws(
      () =>
        applyFileDriftPlan(target, state, reviewed, {
          selectedComponents: ['agents'],
          desiredFiles: new Map(),
        }),
      /invalid for this target/i,
    )
    assert.equal(readFileSync(join(target, 'agents/stale.md'), 'utf8'), 'owned')
    assert.equal(existsSync(join(target, '.pantheon/backups')), false)
  })
})

test('dry classification and preview leave state and target bytes untouched', () => {
  withTarget((target) => {
    const state = seedOwnedFile(target, 'agents/stale.md', 'owned')
    writeState(target, state)
    const stateBefore = readFileSync(join(target, '.pantheon', 'install-state.json'))
    const report = classifyFileInventory(target, readState(target), {
      selectedComponents: ['agents'],
      desiredFiles: new Map(),
    })
    assert.equal(report.operations.length, 1)
    assert.equal(readFileSync(join(target, 'agents/stale.md'), 'utf8'), 'owned')
    assert.deepEqual(readFileSync(join(target, '.pantheon', 'install-state.json')), stateBefore)
    assert.equal(existsSync(join(target, '.pantheon', 'backups')), false)
  })
})
