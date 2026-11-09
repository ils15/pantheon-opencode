import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  buildDoctorSection,
  classifyDecisionConfigHealth,
  classifyInstallVersion,
  classifyOverridesHealth,
  isSupportedNodeFloor,
  MIN_SUPPORTED_NODE_VERSION,
} from '../src/plugins/tui/src/doctor-state.ts'

const POLICY_SOURCE = new URL('../scripts/node-engine-policy.mjs', import.meta.url)

const EMPTY_LOAD = { global: {}, project: {}, corruptGlobal: false }

describe('node floor (drift pin)', () => {
  it('pins the floor against the canonical policy source', () => {
    const source = readFileSync(POLICY_SOURCE, 'utf8')
    assert.ok(
      source.includes(`MIN_SUPPORTED_NODE_VERSION = '${MIN_SUPPORTED_NODE_VERSION}'`),
      'the node floor drifted from scripts/node-engine-policy.mjs',
    )
  })

  it('accepts the floor and above, rejects below and prereleases', () => {
    assert.equal(isSupportedNodeFloor('26.4.0'), true)
    assert.equal(isSupportedNodeFloor('v26.4.1'), true)
    assert.equal(isSupportedNodeFloor('27.0.0'), true)
    assert.equal(isSupportedNodeFloor('26.3.9'), false)
    assert.equal(isSupportedNodeFloor('24.10.0'), false)
    assert.equal(isSupportedNodeFloor('26.4.0-rc.1'), false, 'prerelease below the floor')
    assert.equal(isSupportedNodeFloor('junk'), false)
  })
})

describe('install version health (H2)', () => {
  it('reads pantheon_version from install-state and classifies drift', () => {
    const home = mkdtempSync(join(tmpdir(), 'pantheon-doctor-'))
    try {
      const env = { XDG_CONFIG_HOME: join(home, 'config') }
      const dir = join(home, 'config', 'opencode', '.pantheon')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'install-state.json'),
        JSON.stringify({ pantheon_version: '2.0.0-beta.1' }),
        'utf8',
      )
      const older = classifyInstallVersion('2.0.0-beta.2', env)
      assert.equal(older.status, 'older')
      assert.equal(older.installed, '2.0.0-beta.1')
      writeFileSync(
        join(dir, 'install-state.json'),
        JSON.stringify({ pantheon_version: '2.0.0-beta.3' }),
        'utf8',
      )
      assert.equal(classifyInstallVersion('2.0.0-beta.2', env).status, 'newer')
      writeFileSync(
        join(dir, 'install-state.json'),
        JSON.stringify({ pantheon_version: '2.0.0-beta.2' }),
        'utf8',
      )
      assert.equal(classifyInstallVersion('2.0.0-beta.2', env).status, 'ok')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('a missing state file is unknown, not a failure', () => {
    const home = mkdtempSync(join(tmpdir(), 'pantheon-doctor-'))
    try {
      const health = classifyInstallVersion('2.0.0-beta.2', {
        XDG_CONFIG_HOME: join(home, 'config'),
      })
      assert.equal(health.status, 'unknown')
      assert.equal(health.installed, null)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('overrides health (K)', () => {
  it('flags unknown ids against the registry without treating them as fatal', () => {
    const health = classifyOverridesHealth({
      global: { 'not-in-registry': { action: 'disable' } },
      project: {},
      corruptGlobal: false,
    })
    assert.equal(health.status, 'unknown-ids')
    assert.deepEqual(health.unknownIds, ['not-in-registry'])
  })

  it('corrupt global outranks unknown ids', () => {
    const health = classifyOverridesHealth({
      global: {},
      project: {},
      corruptGlobal: true,
    })
    assert.equal(health.status, 'corrupt')
  })

  it('clean when every id is known', () => {
    const health = classifyOverridesHealth({
      global: { 'gate-j1-risk-gate': { action: 'disable' } },
      project: {},
      corruptGlobal: false,
    })
    assert.equal(health.status, 'clean')
  })
})

describe('decision config health', () => {
  it('absent without a file, corrupt with junk', () => {
    const home = mkdtempSync(join(tmpdir(), 'pantheon-doctor-'))
    try {
      const env = { XDG_CONFIG_HOME: join(home, 'config') }
      assert.equal(classifyDecisionConfigHealth(env).status, 'absent')
      mkdirSync(join(home, 'config', 'pantheon'), { recursive: true })
      writeFileSync(join(home, 'config', 'pantheon', 'decision-router.json'), '{oops', 'utf8')
      assert.equal(classifyDecisionConfigHealth(env).status, 'corrupt')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('doctor section rows', () => {
  it('renders the four file checks with the CLI pointer', () => {
    const section = buildDoctorSection({
      runningVersion: '2.0.0-beta.2',
      nodeVersion: '26.4.0',
      load: EMPTY_LOAD,
      env: { XDG_CONFIG_HOME: '/nonexistent-doctor-fixture' },
    })
    assert.deepEqual(
      section.rows.map((row) => row.id),
      ['doctor.version', 'doctor.node', 'doctor.overrides', 'doctor.decision'],
    )
    for (const row of section.rows) {
      assert.equal(row.selectable, false, 'the section is read-only')
    }
    assert.match(section.hint, /pantheon-opencode doctor/)
    const node = section.rows.find((row) => row.id === 'doctor.node')
    assert.equal(node.marker, '[✓]')
    const version = section.rows.find((row) => row.id === 'doctor.version')
    assert.match(version.title, /unknown/, 'missing install-state reads as unknown')
  })
})
