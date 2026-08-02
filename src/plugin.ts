import type { Plugin, PluginInput } from '@opencode-ai/plugin'
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
board
  .recoverRunningJobs()
  .catch((err) => console.error('[Pantheon Plugin] Failed to recover running jobs:', err))

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
 *
 * NOTE: opencode loads plugins by calling the module and applying its
 * function-export check to EVERY export — each export must be a function
 * (or `{ server: fn }`). Keeping this as a function export is required.
 */
export function getBackgroundJobBoard(): BackgroundJobBoard {
  return board
}

// ─── Active Preset Resolution (shared by config + chat.message hooks) ───

/**
 * Active-preset candidate files in priority order: project cwd, XDG config,
 * HOME .opencode. Mirrors the resolution the config hook performs at startup.
 */
function activePresetCandidates(): string[] {
  const home = process.env.HOME ?? ''
  const xdg = process.env.XDG_CONFIG_HOME ?? `${home}/.config`
  return [
    `${process.cwd()}/.pantheon/active-preset.json`,
    `${xdg}/opencode/.pantheon/active-preset.json`,
    `${home}/.opencode/.pantheon/active-preset.json`,
  ]
}

/**
 * True when a message part carries an image attachment.
 *
 * In @opencode-ai/plugin 1.18.11 / @opencode-ai/sdk the Part union has NO
 * `type: "image"` member — images arrive as FilePart with `type: "file"` and
 * an `image/*` mime (e.g. "image/png"). The bare `type === "image"` check is
 * tolerated for forward-compat should the SDK add a dedicated image part.
 */
function isImagePart(part: unknown): boolean {
  if (!part || typeof part !== 'object') return false
  const p = part as { type?: unknown; mime?: unknown }
  if (p.type === 'image') return true
  if (p.type === 'file' && typeof p.mime === 'string') return p.mime.startsWith('image/')
  return false
}

/**
 * Default multimodal model used when an image turn arrives with no active
 * preset (or an active preset without a `vision` key) — e.g. "Preset: default".
 * opencode-go/qwen3.7-plus is multimodal + tool_call:true (verified via
 * models.dev). Overridable per-user via PANTHEON_VISION_MODEL for different
 * providers.
 */
const DEFAULT_VISION_MODEL = process.env.PANTHEON_VISION_MODEL ?? 'opencode-go/qwen3.7-plus'

/**
 * Modality routing: when a USER turn carries an image attachment, route ONLY
 * that turn to a multimodal model by mutating `output.message.model` (per-turn
 * mutation — the next turn reverts to the preset's text model). The active
 * preset's `vision` model wins when it defines one; otherwise image turns fall
 * back to DEFAULT_VISION_MODEL so they still route with no preset active
 * ("Preset: default"). Text-only turns pass through untouched.
 *
 * NOTE: the chat.message hook signature is `(input, output) => Promise<void>`
 * (mutate output in place) — NOT `Promise<output>`. The `chat.message`
 * output has no params/options slot (that lives on the separate `chat.params`
 * hook), so the preset's vision `reasoning_effort` is intentionally not
 * applied here.
 *
 * NEVER throws: any error degrades to passthrough so a hook fault can't
 * crash or block a turn.
 */
async function routeVisionTurn(
  _input: unknown,
  output: {
    message?: { role?: string; model: { providerID: string; modelID: string } }
    parts?: unknown[]
  },
): Promise<void> {
  try {
    // output.message is a UserMessage; guard role defensively and only look
    // at user-role messages (never assistant/tool traffic).
    if (!output?.message || output.message.role !== 'user') return
    const parts = Array.isArray(output.parts) ? output.parts : []
    if (!parts.some(isImagePart)) return

    // Resolve lazily — only image turns touch the filesystem/registry.
    // `vision` is typed on ResolvedPreset (presets.d.mts): { model, reasoning_effort? } | null.
    const resolved = resolveActivePreset({ candidates: activePresetCandidates() })
    // Preset vision model wins when the active preset defines one; otherwise
    // fall back to the default multimodal model so image turns route even with
    // no preset active. (vision.reasoning_effort remains unused — chat.message
    // output has no params/options slot to apply it through.)
    const visionModel = resolved?.vision?.model ?? DEFAULT_VISION_MODEL

    // Vision model strings are "provider/model" (e.g. "opencode-go/qwen3.7-plus")
    // while UserMessage.model is { providerID, modelID } — split on first '/'.
    const slash = visionModel.indexOf('/')
    if (slash <= 0 || slash >= visionModel.length - 1) return
    output.message.model = {
      providerID: visionModel.slice(0, slash),
      modelID: visionModel.slice(slash + 1),
    }
    console.log(`[Pantheon Plugin] Image detected — routing turn to vision model ${visionModel}`)
  } catch (err) {
    console.warn(
      '[Pantheon Plugin] Vision routing skipped:',
      err instanceof Error ? err.message : String(err),
    )
  }
}

/**
 * Pantheon plugin for opencode.
 *
 * opencode 1.18.x requires the plugin default export to be a FUNCTION
 * `(input: PluginInput, options?: PluginOptions) => Promise<Hooks>` — a plain
 * object export fails to load with "Plugin export is not a function".
 * The `config` hook receives the mutable Config object by reference and
 * mutates it in place (its return value is discarded by the runtime).
 */
const plugin: Plugin = async (_input: PluginInput) => {
  return {
    config: async (config: PluginConfig) => {
      // Agents/skills path injection (legacy fields; no-ops in opencode 1.18.x
      // which loads agents/skills by directory convention, but kept for
      // backwards compatibility with earlier opencode versions).
      config.agentsPath = config.agentsPath ?? []
      config.agentsPath.push(new URL('./agents', import.meta.url).pathname)

      config.skillsPaths = config.skillsPaths ?? []
      config.skillsPaths.push(new URL('./skills', import.meta.url).pathname)

      // Model preset injection (resolveActivePreset reads env/file, applyPreset
      // mutates config). Kept after agents/skills paths; never blocks startup.
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
          console.warn('[Pantheon Plugin] Model preset ignored due to invalid preset configuration')
        }
      }
    },
    'chat.message': routeVisionTurn,
  }
}

export default plugin
