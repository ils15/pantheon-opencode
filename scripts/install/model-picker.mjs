#!/usr/bin/env node
/**
 * model-picker.mjs — interactive model preset selection + persistence
 *
 * Used by the installer (interactive prompt) and the `pantheon-opencode`
 * CLI. Writes the active preset marker to <presetDir>/.pantheon/active-preset.json
 * which the plugin (src/plugin.ts) reads on startup via resolveActivePreset().
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { loadPresetDefs } from '../../src/pantheon/presets.mjs'

/**
 * Build the active-preset.json payload (version 1).
 *
 * @param {string} presetName
 * @param {string} [source] 'cli' | 'interactive'
 * @returns {{version: number, preset: string, source: string, updated_at: string}}
 */
export function buildActivePresetFile(presetName, source = 'cli') {
  return {
    version: 1,
    preset: presetName,
    source,
    updated_at: new Date().toISOString(),
  }
}

/**
 * Persist the active preset marker, backing up any previous file to .bak.
 *
 * @param {string} presetDir install target (project root or global opencode dir)
 * @param {string} presetName
 * @param {{dryRun?: boolean, source?: string, logger?: object}} [opts]
 * @returns {{written: boolean, path: string, backupPath: string|null}}
 */
export function writeActivePreset(
  presetDir,
  presetName,
  { dryRun = false, source = 'cli', logger = console } = {},
) {
  const dir = join(presetDir, '.pantheon')
  const filePath = join(dir, 'active-preset.json')
  const backupPath = join(dir, 'active-preset.json.bak')

  if (dryRun) {
    logger.log?.(`[dry-run] Would write model preset "${presetName}" to ${filePath}`)
    return { written: false, path: filePath, backupPath: null }
  }

  mkdirSync(dir, { recursive: true })
  let backupMade = false
  if (existsSync(filePath)) {
    copyFileSync(filePath, backupPath)
    backupMade = true
  }
  writeFileSync(`${filePath}.tmp-${process.pid}`, `${JSON.stringify(buildActivePresetFile(presetName, source), null, 2)}\n`)
  renameSync(`${filePath}.tmp-${process.pid}`, filePath)
  return { written: true, path: filePath, backupPath: backupMade ? backupPath : null }
}

/**
 * Interactive model preset picker. Asks the user to choose a preset; persists
 * the choice unless dryRun. `rl` may be injected for tests; otherwise a
 * readline/promises interface on stdin/stdout is created and closed.
 *
 * @param {{presetDir?: string, presets?: object, dryRun?: boolean, logger?: object, rl?: object}} [opts]
 * @returns {Promise<string|null>} chosen preset name or null (skipped/unknown)
 */
export async function runModelPicker({
  presetDir,
  presets,
  dryRun = false,
  logger = console,
  rl,
} = {}) {
  const defs = presets ?? loadPresetDefs()
  const names = Object.keys(defs)
  if (names.length === 0) {
    logger.warn?.('Model presets: no presets defined in routing.yml')
    return null
  }

  const list = names.map((n, i) => `  ${i + 1}) ${n} — ${defs[n].description ?? ''}`).join('\n')
  const rli = rl ?? createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rli.question(
      `\nModel presets (number or name; blank to skip):\n${list}\n> `,
    )
    const trimmed = (answer ?? '').trim()
    if (trimmed === '' || trimmed.toLowerCase() === 'none') {
      logger.log?.('Skipping model preset selection.')
      return null
    }
    let name = null
    if (names.includes(trimmed)) {
      name = trimmed
    } else {
      const idx = Number(trimmed)
      if (Number.isInteger(idx) && idx >= 1 && idx <= names.length) {
        name = names[idx - 1]
      }
    }
    if (!name) {
      logger.warn?.(`Unknown preset "${trimmed}" — skipping model preset selection.`)
      return null
    }
    if (!dryRun) {
      writeActivePreset(presetDir, name, { dryRun: false, source: 'interactive', logger })
    } else {
      logger.log?.(`[dry-run] Would set model preset "${name}"`)
    }
    return name
  } finally {
    if (!rl) rli.close()
  }
}
