import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import type { PluginConfig } from 'opencode'
import { BackgroundJobBoard } from './pantheon/background-job-board.ts'
import { FilePersistenceAdapter } from './pantheon/file-persistence.ts'
import { applyActivePresetToConfig } from './pantheon/presets.mjs'
import { activePresetCandidates, createVisionHandler } from './pantheon/vision.ts'

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

/**
 * Pantheon plugin for OpenCode. Pasted images are intercepted via the
 * `chat.message` hook (proven to fire in opencode 1.18.11). When a provider
 * key is available — env PANTHEON_OPENCODE_API_KEY / OPENCODE_API_KEY, or the
 * opencode auth store for `opencode auth login` users — the image is
 * described NATIVELY by the multimodal model via the opencode Zen
 * OpenAI-compatible endpoint, and replaced with the text description — no MCP
 * tool required. Without a key the legacy pattern applies: the image is
 * replaced with a text instruction telling the model to call a vision MCP tool
 * (default `pantheon_vision_vision_describe`). Either way the image never reaches
 * the main provider, so text-only models cannot fail with an `image_url` error.
 *
 * The canonical `pantheon-vision` MCP owns the standalone describe/OCR/analyze
 * tools. The installed OpenCode plugin API exposes no stable pre-provider
 * message hook (1.18.11 only exposes the experimental history transform), so
 * that transform is retained as the runtime-compatible fallback. If a stable
 * provider-bound hook is added, register the same sanitizer there instead of
 * assuming this experimental hook is guaranteed to run.
 *
 * IMPORTANT (OpenCode 1.18.11 legacy loader): this module must export EXACTLY
 * ONE function-valued export — the default plugin. The legacy loader does
 * `Object.values(mod)` and invokes every function export as a plugin factory;
 * any named function export (e.g. a re-exported helper like
 * generateInjectionPrompt) is called with a PluginInput object and can throw.
 * Helpers live in src/pantheon/vision.ts and are imported from there directly.
 */
const plugin: Plugin = async (input: PluginInput) => {
  const vision = createVisionHandler(input)

  return {
    config: async (config: PluginConfig) => {
      config.agentsPath = config.agentsPath ?? []
      config.agentsPath.push(new URL('./agents', import.meta.url).pathname)
      config.skillsPaths = config.skillsPaths ?? []
      config.skillsPaths.push(new URL('./skills', import.meta.url).pathname)

      // Apply the active model preset (`init --preset` / `set-tier` write
      // .pantheon/active-preset.json): resolve it with the SAME candidate
      // order the vision handler uses (project > XDG > HOME) and mutate the
      // agent models / reasoning effort / fallback models + provider configs.
      // Fail-safe: without an active preset the config is untouched; a missing
      // provider key is logged and skipped — the hook must never break startup
      // (set-tier already fail-fast validates keys at write time). Vision
      // rotation stays in vision.ts, which resolves its model independently.
      try {
        const resolved = applyActivePresetToConfig(config, {
          candidates: activePresetCandidates(),
        })
        if (resolved) {
          console.log(
            `[Pantheon Plugin] Applied model preset: ${resolved.name} (${resolved.source})`,
          )
        }
      } catch (err) {
        console.warn(`[Pantheon Plugin] Active preset skipped: ${(err as Error).message}`)
      }
    },
    'chat.message': vision.chatMessage,
    'experimental.chat.messages.transform': vision.messagesTransform,
    event: vision.event,
  }
}

export default plugin
