import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import type { PluginConfig } from 'opencode'
import { BackgroundJobBoard } from './pantheon/background-job-board.ts'
import { FilePersistenceAdapter } from './pantheon/file-persistence.ts'
import {
  createImageTransform,
  imageCacheKey,
  isImageFilePart,
  parseImageResponse,
  replaceImagePartInPlace,
} from './pantheon/multimodal.ts'
import { applyPreset, resolveActivePreset } from './pantheon/presets.mjs'

// ─── Background Job Board Singleton ────────────────────────────────────

const board = new BackgroundJobBoard({
  maxConcurrentPerAgent: 3,
  signalDir: '.pantheon/deepwork/board-signals',
})
const persistence = new FilePersistenceAdapter('.pantheon/board/state.json')
board.setPersistence(persistence)
board
  .recoverRunningJobs()
  .catch((err) => console.error('[Pantheon Plugin] Failed to recover running jobs:', err))
board.onTerminal((taskID: string) => {
  const job = board.get(taskID)
  if (job) {
    console.log(
      `[Pantheon Plugin] Board terminal: [${job.alias}] ${job.description} → ${job.state}${job.resultSummary ? ` — ${job.resultSummary}` : ''}`,
    )
  }
})

/** Return the process-wide BackgroundJobBoard used by Pantheon agents. */
export function getBackgroundJobBoard(): BackgroundJobBoard {
  return board
}

/** Resolve active-preset files in the same order used by the config hook. */
function activePresetCandidates(): string[] {
  const home = process.env.HOME ?? ''
  const xdg = process.env.XDG_CONFIG_HOME ?? `${home}/.config`
  return [
    `${process.cwd()}/.pantheon/active-preset.json`,
    `${xdg}/opencode/.pantheon/active-preset.json`,
    `${home}/.opencode/.pantheon/active-preset.json`,
  ]
}

const DEFAULT_VISION_MODEL = 'opencode-go/mimo-v2.5'

// Keep pure helpers available to the dependency-free test harness. OpenCode
// requires named runtime exports to be functions, which all of these are.
export { imageCacheKey, isImageFilePart, parseImageResponse, replaceImagePartInPlace }

/**
 * Pantheon plugin for OpenCode. Image FileParts are transformed before the
 * provider conversion; the active model is never changed for the user turn.
 */
const plugin: Plugin = async (input: PluginInput) => {
  const transformImages = createImageTransform(input.client, input.directory, () => {
    const resolved = resolveActivePreset({ candidates: activePresetCandidates() })
    return resolved?.vision?.model ?? DEFAULT_VISION_MODEL
  })

  return {
    config: async (config: PluginConfig) => {
      config.agentsPath = config.agentsPath ?? []
      config.agentsPath.push(new URL('./agents', import.meta.url).pathname)
      config.skillsPaths = config.skillsPaths ?? []
      config.skillsPaths.push(new URL('./skills', import.meta.url).pathname)

      try {
        const resolved = resolveActivePreset({ candidates: activePresetCandidates() })
        if (!resolved) return
        applyPreset(config, resolved)
        console.log(
          `[Pantheon Plugin] Model preset active: ${resolved.name} (source: ${resolved.source})`,
        )
      } catch (err) {
        if ((err as { code?: string } | null)?.code === 'PANTHEON_MISSING_API_KEY') {
          console.error(
            '[Pantheon Plugin] Preset requires a provider API key environment variable. Set the required key for your selected provider or clear the preset: pantheon-opencode set-tier none',
          )
        } else {
          console.warn('[Pantheon Plugin] Preset ignored due to invalid configuration')
        }
      }
    },
    'experimental.chat.messages.transform': async (_hookInput, output) => {
      await transformImages(output.messages)
    },
  }
}

export default plugin
