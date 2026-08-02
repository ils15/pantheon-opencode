import type { PluginConfig } from 'opencode'
import { BackgroundJobBoard } from './pantheon/background-job-board.ts'
import { FilePersistenceAdapter } from './pantheon/file-persistence.ts'
import { applyPreset, resolveActivePreset } from './pantheon/presets.mjs'

// ─── Background Job Board Singleton ────────────────────────────────────

const board = new BackgroundJobBoard({
  maxConcurrentPerAgent: 3,
  signalDir: '.pantheon/deepwork/board-signals',
})

// Wire up file-based persistence and recover orphaned jobs from crashes
const persistence = new FilePersistenceAdapter('.pantheon/board/state.json')
board.setPersistence(persistence)

// Recover on startup — any jobs left in "running" state become "error"
board.recoverRunningJobs().catch((err) =>
  console.error('[Pantheon Plugin] Failed to recover running jobs:', err),
)

// Log board state changes to console for observability
board.onTerminal((taskID: string) => {
  const job = board.get(taskID)
  if (job) {
    console.log(
      `[Pantheon Plugin] Board terminal: [${job.alias}] ${job.description} → ${job.state}${job.resultSummary ? ` — ${job.resultSummary}` : ''}`,
    )
  }
})

/**
 * Get the global BackgroundJobBoard singleton.
 *
 * All modules (Zeus, auto-wake, etc.) should access the board through this
 * function to ensure a single consistent state machine across the plugin.
 */
export function getBackgroundJobBoard(): BackgroundJobBoard {
  return board
}

export default {
  name: 'pantheon',
  version: '5.0.0',
  description: 'Pantheon multi-agent orchestration platform',

  hooks: {
    config: async (config: PluginConfig) => {
      config.agentsPath = config.agentsPath ?? []
      config.agentsPath.push(new URL('./agents', import.meta.url).pathname)

      config.skillsPaths = config.skillsPaths ?? []
      config.skillsPaths.push(new URL('./skills', import.meta.url).pathname)

      // Model preset injection (resolveActivePreset reads env/file, applyPreset
      // mutates config). Kept after agents/skills paths; never blocks startup.
      try {
        const home = process.env.HOME ?? ''
        const xdg = process.env.XDG_CONFIG_HOME ?? `${home}/.config`
        const candidates = [
          `${process.cwd()}/.pantheon/active-preset.json`,
          `${xdg}/opencode/.pantheon/active-preset.json`,
          `${home}/.opencode/.pantheon/active-preset.json`,
        ]
        const resolved = resolveActivePreset({ candidates })
        if (!resolved) return config
        applyPreset(config, resolved)
        console.log(`[Pantheon Plugin] Model preset active: ${resolved.name} (source: ${resolved.source})`)
      } catch (err: any) {
        if (err?.code === 'PANTHEON_MISSING_API_KEY') {
          console.error(
            '[Pantheon Plugin] Preset requires a provider API key environment variable. Set the required key for your selected provider or clear the preset: pantheon-opencode set-tier none',
          )
        } else {
          console.warn(`[Pantheon Plugin] Model preset ignored: ${err?.message ?? err}`)
        }
      }

      return config
    },
  },
} satisfies PluginConfig
