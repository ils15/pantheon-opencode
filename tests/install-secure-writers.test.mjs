import assert from 'node:assert/strict'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { copyAgentPrompts, writeAgentsMdManaged } from '../scripts/build-agents-md.mjs'
import { writeActivePreset } from '../scripts/install/model-picker.mjs'
import {
  copyFiles,
  installSkills,
  ROOT,
  writeConfigWithBackup,
} from '../scripts/install/shared.mjs'
import { createInitialState, writeState } from '../scripts/install/state.mjs'

function withDirectories(fn) {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-secure-writers-'))
  const target = join(root, 'target')
  const outside = join(root, 'outside')
  mkdirSync(target)
  mkdirSync(outside)
  try {
    fn({ root, target, outside })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('writeState rejects a symlinked state directory without changing outside files', () => {
  withDirectories(({ target, outside }) => {
    const sentinel = join(outside, 'sentinel')
    const before = 'do not overwrite'
    writeFileSync(sentinel, before)
    symlinkSync(outside, join(target, '.pantheon'), 'dir')

    assert.throws(() => writeState(target, createInitialState('1.0.0')), /symlink/i)
    assert.equal(readFileSync(sentinel, 'utf8'), before)
    assert.equal(lstatSync(sentinel).isFile(), true)
  })
})

test('writeState rejects a planted temporary symlink without changing its target', () => {
  withDirectories(({ target, outside }) => {
    const stateDir = join(target, '.pantheon')
    const sentinel = join(outside, 'sentinel')
    const before = 'state sentinel'
    mkdirSync(stateDir)
    writeFileSync(sentinel, before)
    symlinkSync(sentinel, join(stateDir, `install-state.json.tmp-${process.pid}`))

    assert.throws(() => writeState(target, createInitialState('1.0.0')))
    assert.equal(readFileSync(sentinel, 'utf8'), before)
  })
})

test('writeState rejects a symlinked final file without changing its target', () => {
  withDirectories(({ target, outside }) => {
    const stateDir = join(target, '.pantheon')
    const sentinel = join(outside, 'sentinel')
    const before = 'final sentinel'
    mkdirSync(stateDir)
    writeFileSync(sentinel, before)
    symlinkSync(sentinel, join(stateDir, 'install-state.json'))

    assert.throws(() => writeState(target, createInitialState('1.0.0')), /symlink/i)
    assert.equal(readFileSync(sentinel, 'utf8'), before)
  })
})

test('writeActivePreset rejects a symlinked preset directory without changing outside files', () => {
  withDirectories(({ target, outside }) => {
    const sentinel = join(outside, 'sentinel')
    const before = 'preset sentinel'
    writeFileSync(sentinel, before)
    symlinkSync(outside, join(target, '.pantheon'), 'dir')

    assert.throws(() => writeActivePreset(target, 'go-fast'), /symlink/i)
    assert.equal(readFileSync(sentinel, 'utf8'), before)
  })
})

test('writeActivePreset rejects a symlinked final file without changing its target', () => {
  withDirectories(({ target, outside }) => {
    const presetDir = join(target, '.pantheon')
    const sentinel = join(outside, 'sentinel')
    const before = 'active sentinel'
    mkdirSync(presetDir)
    writeFileSync(sentinel, before)
    symlinkSync(sentinel, join(presetDir, 'active-preset.json'))

    assert.throws(() => writeActivePreset(target, 'go-fast'), /symlink/i)
    assert.equal(readFileSync(sentinel, 'utf8'), before)
  })
})

test('writeActivePreset rejects a planted backup symlink without changing its target', () => {
  withDirectories(({ target, outside }) => {
    const presetDir = join(target, '.pantheon')
    const active = join(presetDir, 'active-preset.json')
    const backup = `${active}.bak`
    const sentinel = join(outside, 'sentinel')
    const previous = '{"preset":"go-free"}\n'
    const before = 'backup sentinel'
    mkdirSync(presetDir)
    writeFileSync(active, previous)
    writeFileSync(sentinel, before)
    symlinkSync(sentinel, backup)

    assert.throws(() => writeActivePreset(target, 'go-fast'), /symlink/i)
    assert.equal(readFileSync(sentinel, 'utf8'), before)
    assert.equal(readFileSync(active, 'utf8'), previous)
  })
})

test('writeActivePreset rejects a planted temporary symlink without changing its target', () => {
  withDirectories(({ target, outside }) => {
    const presetDir = join(target, '.pantheon')
    const active = join(presetDir, 'active-preset.json')
    const sentinel = join(outside, 'sentinel')
    const previous = '{"preset":"go-free"}\n'
    const before = 'temporary sentinel'
    mkdirSync(presetDir)
    writeFileSync(active, previous)
    writeFileSync(sentinel, before)
    symlinkSync(sentinel, `${active}.tmp-${process.pid}`)

    assert.throws(() => writeActivePreset(target, 'go-fast'))
    assert.equal(readFileSync(sentinel, 'utf8'), before)
    assert.equal(readFileSync(active, 'utf8'), previous)
    assert.equal(existsSync(`${active}.bak`), false)
  })
})

test('copyAgentPrompts rejects a symlinked destination directory without changing outside files', () => {
  withDirectories(({ target, outside }) => {
    const source = join(target, 'source')
    const destination = join(target, 'agents')
    const sentinel = join(outside, 'scout.md')
    const before = 'outside agent prompt'
    mkdirSync(source)
    writeFileSync(join(source, 'scout.md'), 'generated source prompt')
    writeFileSync(sentinel, before)
    symlinkSync(outside, destination, 'dir')

    assert.throws(() => copyAgentPrompts(source, destination), /symlink/i)
    assert.equal(readFileSync(sentinel, 'utf8'), before)
  })
})

test('writeAgentsMdManaged rejects a symlinked parent without changing outside files', () => {
  withDirectories(({ target, outside }) => {
    const linkedParent = join(target, 'config')
    const sentinel = join(outside, 'AGENTS.md')
    const before = 'user-owned instructions\n'
    writeFileSync(sentinel, before)
    symlinkSync(outside, linkedParent, 'dir')

    assert.throws(
      () => writeAgentsMdManaged(join(linkedParent, 'AGENTS.md'), 'generated managed content\n'),
      /symlink/i,
    )
    assert.equal(readFileSync(sentinel, 'utf8'), before)
  })
})

test('clean agent sync rejects a symlinked destination parent without deleting outside files', () => {
  withDirectories(({ target, outside }) => {
    const source = join(target, 'empty-source')
    const destination = join(target, 'agents')
    const sentinel = join(outside, 'talos.md')
    const before = 'outside agent data'
    mkdirSync(source)
    writeFileSync(sentinel, before)
    symlinkSync(outside, destination, 'dir')

    assert.throws(() => copyFiles(source, destination, false, null, true), /symlink/i)
    assert.equal(readFileSync(sentinel, 'utf8'), before)
  })
})

test('stale skill cleanup rejects a symlinked destination parent without deleting outside files', () => {
  withDirectories(({ target, outside }) => {
    const configDir = join(target, '.opencode')
    const linkedSkills = join(configDir, 'skills')
    const sentinel = join(outside, 'stale-skill', 'README.md')
    const before = 'outside skill data'
    mkdirSync(configDir)
    mkdirSync(join(outside, 'stale-skill'))
    writeFileSync(sentinel, before)
    symlinkSync(outside, linkedSkills, 'dir')

    assert.throws(() => installSkills([], target, false), /symlink/i)
    assert.equal(readFileSync(sentinel, 'utf8'), before)
  })
})

test('installSkills rejects an unchanged SKILL.md symlink without reading through it', () => {
  withDirectories(({ target, outside }) => {
    const skill = 'tdd-with-agents'
    const source = join(ROOT, 'src', 'skills', skill, 'SKILL.md')
    const skillDir = join(target, '.opencode', 'skills', skill)
    const linkedSkill = join(skillDir, 'SKILL.md')
    const externalTarget = join(outside, 'SKILL.md')
    const original = readFileSync(source, 'utf8')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(externalTarget, original)
    symlinkSync(externalTarget, linkedSkill)

    assert.throws(() => installSkills([skill], target, false), /symlink/i)
    assert.equal(lstatSync(linkedSkill).isSymbolicLink(), true)
    assert.equal(readFileSync(externalTarget, 'utf8'), original)
  })
})

test('config writes preserve existing private mode and use a private mode for new files', () => {
  withDirectories(({ target }) => {
    const previousUmask = process.umask(0o022)
    try {
      const existingConfig = join(target, 'existing-opencode.json')
      writeFileSync(existingConfig, '{"old":true}\n', { mode: 0o600 })

      writeConfigWithBackup(existingConfig, '{"new":true}\n', false)
      assert.equal(statSync(existingConfig).mode & 0o777, 0o600)

      const newConfig = join(target, 'new-opencode.json')
      writeConfigWithBackup(newConfig, '{"new":true}\n', false)
      assert.equal(statSync(newConfig).mode & 0o777, 0o600)
    } finally {
      process.umask(previousUmask)
    }
  })
})

test('state and preset files are not group- or world-accessible', () => {
  withDirectories(({ target }) => {
    writeState(target, createInitialState('1.0.0'))
    writeActivePreset(target, 'go-fast')

    for (const file of [
      join(target, '.pantheon', 'install-state.json'),
      join(target, '.pantheon', 'active-preset.json'),
    ]) {
      assert.equal(statSync(file).mode & 0o077, 0)
    }
  })
})
