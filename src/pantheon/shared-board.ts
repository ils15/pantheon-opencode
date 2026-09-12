/**
 * Process-wide BackgroundJobBoard singleton shared by every Pantheon plugin
 * surface (src/plugin.ts V1, src/plugins/pantheon-hooks.ts).
 *
 * WHY globalThis and not a module-level `const`: opencode loads each plugin
 * TWICE from two different filesystem paths (the installed npm package AND
 * the repo source — see src/pantheon/plugin-once.ts). Each load is a separate
 * module instance, so a plain ESM singleton would yield TWO boards: the
 * native-task mirror in pantheon-hooks would register jobs on one instance
 * while the finalize path (session.idle + idle scan in plugin.ts) listens on
 * the other, and the job would never finalize. A globalThis-anchored value is
 * process-global by construction, deduping both module copies.
 *
 * The persistence file and signal dir are RELATIVE paths — the board operates
 * against the opencode project root (the cwd of the plugin process), matching
 * the pre-existing plugin.ts wiring exactly.
 */
import { BackgroundJobBoard } from './background-job-board.ts'
import { FilePersistenceAdapter } from './file-persistence.ts'

const BOARD_KEY = '__pantheonSharedBoard'

/** Construction inputs mirror the original plugin.ts module-scope board. */
const BOARD_OPTIONS = {
  maxConcurrentPerAgent: 3,
  signalDir: '.pantheon/deepwork/board-signals',
} as const

export function getSharedBoard(): BackgroundJobBoard {
  const host = globalThis as { [BOARD_KEY]?: BackgroundJobBoard }
  const existing = host[BOARD_KEY]
  if (existing instanceof BackgroundJobBoard) return existing
  const board = new BackgroundJobBoard(BOARD_OPTIONS)
  board.setPersistence(new FilePersistenceAdapter('.pantheon/board/state.json'))
  host[BOARD_KEY] = board
  return board
}
