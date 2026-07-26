import type { PluginConfig } from 'opencode'
import { BackgroundJobBoard } from './pantheon/background-job-board.ts'
import { FilePersistenceAdapter } from './pantheon/file-persistence.ts'

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

      return config
    },
  },
} satisfies PluginConfig
