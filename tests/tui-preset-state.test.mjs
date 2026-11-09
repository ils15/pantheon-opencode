import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  buildPresetSection,
  clearActivePreset,
  globalActivePresetPath,
  PRESET_NAMES,
  projectActivePresetPath,
  readActivePresetMarker,
  writeActivePreset,
} from '../src/plugins/tui/src/preset-state.ts'

describe('preset names (drift pin)', () => {
  it('mirrors routing.yml `presets:` exactly', async () => {
    const { loadPresetDefs } = await import('../src/pantheon/presets.mjs')
    const canonical = Object.keys(loadPresetDefs()).sort()
    assert.deepEqual([...PRESET_NAMES].sort(), canonical)
  })

  it('the global path resolves under <config>/opencode/.pantheon', () => {
    const path = globalActivePresetPath({ XDG_CONFIG_HOME: '/x' })
    assert.equal(path, join('/x', 'opencode', '.pantheon', 'active-preset.json'))
    assert.equal(projectActivePresetPath(), join(process.cwd(), '.pantheon', 'active-preset.json'))
  })
})

describe('marker I/O', () => {
  it('writes the version-1 marker with the tui-settings source, .bak on rewrite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantheon-preset-'))
    try {
      const path = join(dir, 'active-preset.json')
      writeActivePreset(path, 'go-fast', '2026-11-09T12:00:00.000Z')
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      assert.deepEqual(raw, {
        version: 1,
        preset: 'go-fast',
        source: 'tui-settings',
        updated_at: '2026-11-09T12:00:00.000Z',
      })
      assert.equal(existsSync(`${path}.bak`), false, 'no backup before a rewrite exists')

      writeActivePreset(path, 'anthropic', '2026-11-09T13:00:00.000Z')
      assert.equal(JSON.parse(readFileSync(`${path}.bak`, 'utf8')).preset, 'go-fast')
      assert.equal(readActivePresetMarker(path)?.name, 'anthropic')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('clear deletes the marker with a .bak backup (the `none` contract)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantheon-preset-'))
    try {
      const path = join(dir, 'active-preset.json')
      writeActivePreset(path, 'go-free', '2026-11-09T12:00:00.000Z')
      clearActivePreset(path)
      assert.equal(existsSync(path), false, 'the CLI contract deletes, not writes "none"')
      assert.equal(JSON.parse(readFileSync(`${path}.bak`, 'utf8')).preset, 'go-free')
      assert.equal(readActivePresetMarker(path), null)
      clearActivePreset(path) // idempotent when already gone
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses unknown preset names — a typo must not strand the runtime', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pantheon-preset-')), 'active-preset.json')
    try {
      assert.throws(() => writeActivePreset(path, 'go-ultimate'), /unknown preset/)
      assert.equal(existsSync(path), false)
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  })

  it('reads tolerate a corrupt marker as no preset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantheon-preset-'))
    try {
      const path = join(dir, 'active-preset.json')
      writeFileSync(path, '{oops', 'utf8')
      assert.equal(readActivePresetMarker(path), null)
      writeFileSync(path, JSON.stringify({ preset: 'none' }), 'utf8')
      assert.equal(readActivePresetMarker(path), null, '"none" reads as no preset')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('preset section rows', () => {
  it('lists every preset plus none, marking the active one', () => {
    const section = buildPresetSection({ globalName: 'go-fast', projectName: null })
    const rows = section.rows
    assert.deepEqual(
      rows.map((row) => row.id),
      [...PRESET_NAMES.map((name) => `preset.${name}`), 'preset.none'],
    )
    const active = rows.find((row) => row.id === 'preset.go-fast')
    assert.equal(active.disabled, true)
    assert.match(active.description, /active \(global\)/)
    const none = rows.find((row) => row.id === 'preset.none')
    assert.equal(none.disabled, false)
  })

  it('shows a project override as read-only context', () => {
    const section = buildPresetSection({ globalName: 'go-fast', projectName: 'anthropic' })
    const project = section.rows.find((row) => row.id === 'preset.project')
    assert.equal(project.selectable, false)
    assert.match(project.title, /\(project\)/)
    assert.match(project.description, /wins over the global marker/)
  })
})
