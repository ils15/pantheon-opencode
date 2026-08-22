/**
 * Auto-Wake Consumer — scans signal files from the BackgroundJobBoard
 * and returns completed job signals for Zeus to process.
 *
 * Signal files are created by the board on every terminal state transition
 * (completed/error/cancelled). This module consumes them atomically by
 * reading the `.signal.json` content, then renaming to `.consumed.json`,
 * preventing race conditions where the same signal is processed twice.
 *
 * The rename is the commit point: if Zeus crashes between the read and the
 * rename, the `.signal.json` file remains and will be re-processed on restart.
 * This gives **at-least-once** delivery, which is acceptable because the board's
 * `markReconciled()` is idempotent.
 *
 * @module auto-wake
 */

import { existsSync } from 'node:fs'
import { readdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

/** Signal structure written by BackgroundJobBoard.writeSignal(). */
export interface WakeSignal {
  taskID: string
  alias: string
  agent: string
  state: string
  summary: string | null
  timestamp: number
}

/** Default signal directory (matches BoardOptions.signalDir default in plugin.ts). */
const DEFAULT_SIGNAL_DIR = '.pantheon/deepwork/board-signals'

/**
 * Scan the signal directory for `*.signal.json` files, atomically consume
 * each by renaming to `*.consumed.json`, and return the parsed signals.
 *
 * Safe to call multiple times — already-consumed files (`.consumed.json`)
 * are ignored, and the atomic rename prevents double-processing.
 *
 * The flow per signal file:
 * 1. Read the `.signal.json` content
 * 2. Rename `.signal.json` → `.consumed.json` (atomic: OS-level rename)
 * 3. If rename succeeds, push the signal into the result
 * 4. If rename fails (another process consumed it first), skip
 *
 * @param signalDir  Directory to scan (default: `.pantheon/deepwork/board-signals`)
 * @returns List of wake signals from newly consumed files
 */
export async function consumeWakeSignals(signalDir?: string): Promise<WakeSignal[]> {
  const dir = signalDir ?? DEFAULT_SIGNAL_DIR

  // If the signal directory doesn't exist, there are no signals
  if (!existsSync(dir)) {
    return []
  }

  const entries = await readdir(dir, { withFileTypes: true })
  const signals: WakeSignal[] = []

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.signal.json')) continue

    const signalPath = join(dir, entry.name)
    const consumedName = entry.name.replace(/\.signal\.json$/, '.consumed.json')
    const consumedPath = join(dir, consumedName)

    try {
      // Step 1: Read the file content
      const content = await readFile(signalPath, 'utf-8')
      const data = JSON.parse(content) as WakeSignal

      // Step 2: Atomically rename — this is the commit point.
      // If this fails, the .signal.json remains and we'll retry next call.
      await rename(signalPath, consumedPath)

      // Step 3: Only add to results after successful rename
      signals.push(data)
    } catch {
      // Rename failed (another consumer got there first) or file is corrupted.
      // Skip silently in either case.
      continue
    }
  }

  return signals
}
