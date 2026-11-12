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

export const VISION_MODEL_OPTIONS: readonly string[] = Object.freeze([
  'auto',
  'opencode-go/mimo-v2.6-flash',
  'google/gemini-2.5-flash',
  'openai/gpt-5-mini',
  'anthropic/claude-3-5-haiku',
  'opencode-go/mimo-v2.5',
])

export function visionConfigPaths(
  cwd = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): string[] {
  const home = env.HOME ?? ''
  const xdg = env.XDG_CONFIG_HOME ?? join(home, '.config')
  return [
    join(cwd, '.opencode', 'opencode-vision.json'),
    join(xdg, 'opencode', 'opencode-vision.json'),
  ]
}

export function readConfiguredVisionModel(
  cwd = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): string {
  for (const path of visionConfigPaths(cwd, env)) {
    try {
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { visionModel?: unknown }
        if (typeof parsed?.visionModel === 'string' && parsed.visionModel.trim()) {
          return parsed.visionModel.trim()
        }
      }
    } catch {
      // ignore corrupt/missing
    }
  }
  return 'auto'
}

export function writeConfiguredVisionModel(
  model: string,
  cwd = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): void {
  const home = env.HOME ?? ''
  const xdg = env.XDG_CONFIG_HOME ?? join(home, '.config')
  const projectDir = join(cwd, '.opencode')
  const targetPath = existsSync(projectDir)
    ? join(projectDir, 'opencode-vision.json')
    : join(xdg, 'opencode', 'opencode-vision.json')

  let current: Record<string, unknown> = {}
  try {
    if (existsSync(targetPath)) {
      current = JSON.parse(readFileSync(targetPath, 'utf8')) as Record<string, unknown>
    }
  } catch {
    current = {}
  }

  if (model === 'auto' || !model.trim()) {
    delete current.visionModel
  } else {
    current.visionModel = model.trim()
  }

  mkdirSync(dirname(targetPath), { recursive: true })
  const temp = `${targetPath}.tui.tmp`
  writeFileSync(temp, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
  renameSync(temp, targetPath)
}

export interface PresetSectionInput {
  globalName: string | null
  projectName: string | null
  visionModel?: string
}

/** The staged value 'none' means: delete the global marker (the CLI contract). */
export const PRESET_NONE = 'none'

export const PRESET_CYCLE: readonly string[] = Object.freeze([PRESET_NONE, ...PRESET_NAMES])

export function buildPresetTab(input: PresetSectionInput, languagePref?: string): SettingsTab {
  const isPt = languagePref === 'pt-BR'
  const rows: SettingsRow[] = [
    {
      id: 'preset',
      name: isPt ? 'Predefinição' : 'Preset',
      value: input.globalName ?? PRESET_NONE,
      cycle: PRESET_CYCLE,
      note: isPt
        ? 'marcador global · gravação atômica, backup .bak · none = padrão OpenCode'
        : 'global marker · atomic write, .bak backup · none = opencode defaults',
    },
  ]
  if (input.projectName !== null) {
    rows.push({
      id: 'preset.project',
      name: isPt ? 'Projeto' : 'Project',
      value: input.projectName,
      note: isPt
        ? `${projectActivePresetPath()} tem precedência sobre o global — somente leitura aqui`
        : `${projectActivePresetPath()} wins over the global marker — read-only here`,
    })
  }
  if (input.visionModel !== undefined) {
    rows.push({
      id: 'preset.vision_model',
      name: isPt ? 'Modelo de Visão' : 'Vision Model',
      value: input.visionModel || 'auto',
      cycle: VISION_MODEL_OPTIONS,
      note: isPt
        ? 'modelo para inspeção de imagens (vision_describe) · salvo em opencode-vision.json'
        : 'model for image inspection (vision_describe) · saved in opencode-vision.json',
    })
  }
  return {
    id: 'preset',
    title: 'Preset',
    groups: [{ title: isPt ? 'Predefinição de modelo' : 'Model preset', rows }],
  }
}
