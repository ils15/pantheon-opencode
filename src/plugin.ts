import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import type { PluginConfig } from 'opencode'
import { BackgroundJobBoard } from './pantheon/background-job-board.ts'
import { FilePersistenceAdapter } from './pantheon/file-persistence.ts'
import { applyPreset, resolveActivePreset } from './pantheon/presets.mjs'
import {
  activePresetCandidates,
  createVisionHandler,
  generateInjectionPrompt,
  generateNativeInjection,
  getVisionMode,
  isImageFilePart,
  matchesModelPattern,
  matchesWildcardPattern,
  modelMatchesAnyPattern,
  resolveNativeVisionConfig,
} from './pantheon/vision.ts'

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

// Keep pure helpers available to the dependency-free test harness. OpenCode
// requires named runtime exports to be functions, which all of these are.
export {
  activePresetCandidates,
  generateInjectionPrompt,
  generateNativeInjection,
  getVisionMode,
  isImageFilePart,
  matchesModelPattern,
  matchesWildcardPattern,
  modelMatchesAnyPattern,
  resolveNativeVisionConfig,
}

/**
 * Pantheon plugin for OpenCode. Pasted images are intercepted via the
 * `chat.message` hook (proven to fire in opencode 1.18.11). When a provider
 * key is available (PANTHEON_OPENCODE_API_KEY / OPENCODE_API_KEY) the image is
 * described NATIVELY by the multimodal model via the opencode Zen
 * OpenAI-compatible endpoint, and replaced with the text description — no MCP
 * tool required. Without a key the legacy pattern applies: the image is
 * replaced with a text instruction telling the model to call a vision MCP tool
 * (default `mcp__bifrost__describe_image`). Either way the image never reaches
 * the main provider, so text-only models cannot fail with an `image_url` error.
 */
const plugin: Plugin = async (input: PluginInput) => {
  const vision = createVisionHandler(input)

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
    'chat.message': vision.chatMessage,
    event: vision.event,
  }
}

export default plugin
