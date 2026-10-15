/**
 * vision-prompt.mjs — optional vision step of `pantheon-opencode init`.
 *
 * After the model-preset wizard, an interactive TTY session is offered a
 * three-way choice for the vision model:
 *   1. automatic discovery (default, Enter) — writes nothing
 *   2. pin a `provider/model`              — merges `visionModel` into the
 *      GLOBAL vision config (~/.config/opencode/opencode-vision.json)
 *   3. skip                                 — writes nothing
 *
 * Non-interactive runs (no TTY, `--yes`, `--headless`, automated sandboxes)
 * never reach this module: `installOpenCode` only calls it when
 * `interactive && !dryRun && !autoYes`. Automatic discovery therefore stays
 * the default in every non-interactive flow and no run blocks on stdin.
 *
 * The write mirrors the `/pantheon-vision` command: atomic, `.bak` backup,
 * and a MERGE — existing keys are never overwritten.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { writeConfigWithBackup } from './shared.mjs'

const CONFIG_FILENAME = 'opencode-vision.json'
/** `provider/model` — exactly one slash, no surrounding whitespace. */
const MODEL_PATTERN = /^[^\s/]+\/[^\s/]+$/
const MAX_PIN_ATTEMPTS = 3

/** Global vision config path, honoring `XDG_CONFIG_HOME` (same rule as the plugin). */
export function globalVisionConfigPath(env = process.env) {
  const home = env.HOME?.trim() || homedir()
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
  return join(xdg, 'opencode', CONFIG_FILENAME)
}

/** True when `value` looks like a `provider/model` id (one slash, no spaces). */
export function isValidVisionModel(value) {
  return typeof value === 'string' && MODEL_PATTERN.test(value.trim())
}

/**
 * Merge `visionModel` into a vision config, preserving every other key.
 * Defaults to the GLOBAL config; pass `configPath` to target another file
 * (e.g. the project config `.opencode/opencode-vision.json`). Creates the
 * parent directory when missing; never overwrites existing keys. A corrupted
 * JSON file is left byte-identical (the caller decides what to tell the user)
 * rather than clobbered.
 *
 * A concurrent writer that changes the file between the read and the atomic
 * swap makes `writeConfigWithBackup` return `'conflict'`: the write is aborted,
 * `wrote` is `false`, and the newer content is left untouched.
 *
 * @param {object} [opts]
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {boolean} [opts.dryRun]
 * @param {string} [opts.configPath] - explicit target file (defaults to global)
 * @param {(existing: string|null) => void} [opts.beforeRecheck] - test seam
 *   forwarded to `writeConfigWithBackup` to simulate a concurrent writer.
 * @returns {{path: string, wrote: boolean, reason: 'created'|'skipped'|'conflict'|'corrupt'|'dry-run'}}
 */
export function mergeVisionModel(
  model,
  { env = process.env, dryRun = false, beforeRecheck, configPath: target } = {},
) {
  const configPath = target ?? globalVisionConfigPath(env)
  let parsed = {}
  let existingRaw
  if (existsSync(configPath)) {
    existingRaw = readFileSync(configPath, 'utf8')
    try {
      const data = JSON.parse(existingRaw)
      if (data && typeof data === 'object' && !Array.isArray(data)) parsed = data
    } catch {
      return { path: configPath, wrote: false, reason: 'corrupt' }
    }
  }
  if (dryRun) return { path: configPath, wrote: false, reason: 'dry-run' }
  const next = { ...parsed, visionModel: model }
  const content = `${JSON.stringify(next, null, 2)}\n`
  mkdirSync(dirname(configPath), { recursive: true })
  const status = writeConfigWithBackup(configPath, content, false, {
    expectedContent: existingRaw,
    beforeRecheck,
    // This file is GLOBAL and lives outside the config dir, so the target-scoped
    // exact backup set never captures it. Keep its own `<file>.bak` recovery.
    beforeSwap: (existing) => {
      if (existing === null) return
      try {
        copyFileSync(configPath, `${configPath}.bak`)
      } catch {
        // Best-effort: a backup failure must not block the write.
      }
    },
  })
  return { path: configPath, wrote: status === 'created', reason: status }
}

/**
 * Ask the interactive vision question. `rl` may be injected (tests / an
 * existing readline interface); otherwise a private one is created and closed.
 * Returns `{action, visionModel?, wrote?, path?}` — never throws on bad input,
 * and never writes for the default/skip paths.
 *
 * @param {{rl?: object, logger?: object, env?: Record<string, string|undefined>, dryRun?: boolean, beforeRecheck?: (existing: string|null) => void}} [opts]
 */
export async function runVisionPrompt({
  rl,
  logger = console,
  env = process.env,
  dryRun = false,
  beforeRecheck,
} = {}) {
  let iface = rl
  let closeAfter = false
  if (!iface) {
    const { createInterface } = await import('node:readline/promises')
    iface = createInterface({ input: process.stdin, output: process.stdout })
    closeAfter = true
  }
  try {
    logger.log?.('')
    logger.log?.('Vision — how should images be described?')
    logger.log?.(
      '  1) Automatic discovery (default) — pick a vision-capable model from the host catalog',
    )
    logger.log?.('  2) Pin a provider/model (e.g. opencode-go/mimo-v2.5)')
    logger.log?.('  3) Skip')
    const answer = (await iface.question('Choice [1]: ')).trim().toLowerCase()

    if (answer === '' || answer === '1' || answer === 'auto' || answer === 'discovery') {
      logger.log?.('Vision: automatic discovery (no config written).')
      return { action: 'auto' }
    }
    if (answer === '3' || answer === 'skip' || answer === 'no') {
      logger.log?.('Vision: skipped (no config written).')
      return { action: 'skip' }
    }
    if (answer === '2' || answer === 'pin') {
      for (let attempt = 0; attempt < MAX_PIN_ATTEMPTS; attempt++) {
        const raw = (await iface.question('provider/model (e.g. opencode-go/mimo-v2.5): ')).trim()
        if (!isValidVisionModel(raw)) {
          logger.warn?.(`Invalid model "${raw}" — expected provider/model (one slash, no spaces).`)
          continue
        }
        const result = mergeVisionModel(raw, { env, dryRun, beforeRecheck })
        if (result.reason === 'corrupt') {
          logger.warn?.(
            `Vision config at ${result.path} is not valid JSON — leaving it untouched; fix it and re-run.`,
          )
          return { action: 'pin', visionModel: raw, wrote: false, path: result.path }
        }
        if (result.reason === 'conflict') {
          logger.warn?.(
            `Vision: not saved — config at ${result.path} was modified concurrently; re-run to retry.`,
          )
        } else {
          logger.log?.(`Vision: pinned ${raw} in ${result.path}.`)
        }
        return { action: 'pin', visionModel: raw, wrote: result.wrote, path: result.path }
      }
      logger.warn?.('Vision: no valid model entered — skipping (no config written).')
      return { action: 'skip' }
    }
    logger.warn?.(
      `Unknown choice "${answer}" — defaulting to automatic discovery (no config written).`,
    )
    return { action: 'auto' }
  } finally {
    if (closeAfter) iface.close()
  }
}
