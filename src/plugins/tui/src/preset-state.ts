/**
 * preset-state.ts — the Model Preset section of the settings window.
 *
 * TUI-local replica (the bundle must stay self-contained). The preset NAMES
 * mirror routing.yml's `presets:` and are drift-pinned by
 * tests/tui-preset-state.test.mjs against `loadPresetDefs()`. The marker file
 * shape mirrors scripts/install/model-picker.mjs's `buildActivePresetFile`
 * (version 1), and the readers (`resolveActivePreset`, vision.ts candidates)
 * only consult `.preset`, so the window writes `source: 'tui-settings'`.
 *
 * Scope note: the window writes the GLOBAL marker only
 * (`<config-dir>/opencode/.pantheon/active-preset.json`). A project marker
 * wins (it precedes the global path in every runtime candidate list), so it
 * is displayed read-only. `none` DELETES the marker with a .bak backup — the
 * same contract as the CLI's `set-tier none`.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { SettingsRow, SettingsTab } from './pantheon-settings-state.ts'

/** Mirrors routing.yml `presets:` — drift-pinned against loadPresetDefs(). */
export const PRESET_NAMES: readonly string[] = Object.freeze([
  'go-free',
  'go-fast',
  'go-premium',
  'go-hybrid',
  'anthropic',
  'openai',
])

export interface ActivePresetMarker {
  version: number
  preset: string
  source: string
  updated_at: string
}

export function globalActivePresetPath(env: Record<string, string | undefined> = process.env) {
  const xdg = env.XDG_CONFIG_HOME
  const home = env.HOME ?? ''
  const root = xdg ?? join(home, '.config')
  return join(root, 'opencode', '.pantheon', 'active-preset.json')
}

export function projectActivePresetPath() {
  return join(process.cwd(), '.pantheon', 'active-preset.json')
}

/** Fail-open read: missing/corrupt marker = no active preset. */
export function readActivePresetMarker(path: string): { name: string; updatedAt: string } | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { preset?: unknown; updated_at?: unknown }
    if (typeof raw?.preset !== 'string' || raw.preset === '' || raw.preset === 'none') return null
    return {
      name: raw.preset,
      updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : '',
    }
  } catch {
    return null
  }
}

function writeMarkerAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tui.tmp`
  writeFileSync(temp, content)
  renameSync(temp, path)
}

/** Select a preset globally: .bak backup, atomic write, version-1 marker. */
export function writeActivePreset(
  path: string,
  name: string,
  nowIso = new Date().toISOString(),
): void {
  if (!PRESET_NAMES.includes(name)) {
    throw new TypeError(`Refusing to persist unknown preset "${name}"`)
  }
  backupMarker(path)
  const marker: ActivePresetMarker = {
    version: 1,
    preset: name,
    source: 'tui-settings',
    updated_at: nowIso,
  }
  writeMarkerAtomically(path, `${JSON.stringify(marker, null, 2)}\n`)
}

/** Clear the global marker (the `none` contract): .bak backup, then remove. */
export function clearActivePreset(path: string): void {
  backupMarker(path)
  rmSync(path, { force: true })
}

function backupMarker(path: string): void {
  if (!existsSync(path)) return
  mkdirSync(dirname(path), { recursive: true })
  copyFileSync(path, `${path}.bak`)
}

export interface PresetSectionInput {
  globalName: string | null
  projectName: string | null
}

/** The staged value 'none' means: delete the global marker (the CLI contract). */
export const PRESET_NONE = 'none'

export const PRESET_CYCLE: readonly string[] = Object.freeze([PRESET_NONE, ...PRESET_NAMES])

export function buildPresetTab(input: PresetSectionInput): SettingsTab {
  const rows: SettingsRow[] = [
    {
      id: 'preset',
      name: 'Preset',
      value: input.globalName ?? PRESET_NONE,
      cycle: PRESET_CYCLE,
      note: 'global marker · atomic write, .bak backup · none = opencode defaults',
    },
  ]
  if (input.projectName !== null) {
    rows.push({
      id: 'preset.project',
      name: 'Project',
      value: input.projectName,
      note: `${projectActivePresetPath()} wins over the global marker — read-only here`,
    })
  }
  return {
    id: 'preset',
    title: 'Preset',
    groups: [{ title: 'Model preset', rows }],
  }
}
