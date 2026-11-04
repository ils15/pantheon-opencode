/**
 * whats-new-state.ts — last-seen version for the one-time "What's new" window.
 *
 * The TUI shows a dismissable release-highlights dialog once per Pantheon
 * version. Whether a version was already seen is persisted next to the other
 * opencode-level Pantheon state: `<configDir>/.pantheon/whats-new.json`, the
 * same directory that already holds `install-state.json` (scripts/install/
 * state.mjs) and the active-preset file the sidebar reads. There is no
 * established persistent TUI KV store (the host `api.kv` is per-process), so
 * the plugin owns one small JSON file with the atomic-write discipline used
 * across the repo (unique tmp + rename, mirrors scripts/install/verify.mjs).
 *
 * Fail-open everywhere: a missing or corrupt file reads as "never seen" (the
 * window may show), a failed write is silent (the window may show again) —
 * neither can ever block TUI startup.
 */
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** State file name, kept next to `install-state.json` in `<configDir>/.pantheon/`. */
export const WHATS_NEW_STATE_FILENAME = 'whats-new.json'

/** Shape of the persisted file — the plugin owns this file outright. */
export interface WhatsNewStateFile {
  seenVersion: string | null
  updatedAt: string
}

type Env = Record<string, string | undefined>

/** Parse a state file body; null when unreadable as the expected shape. */
export function parseWhatsNewState(raw: string): WhatsNewStateFile | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const seen = record.seenVersion
    if (typeof seen !== 'string' && seen !== null) return null
    return { seenVersion: seen, updatedAt: String(record.updatedAt ?? '') }
  } catch {
    return null
  }
}

/** Read the persisted state; null when missing or corrupt (never throws). */
export async function readWhatsNewState(statePath: string): Promise<WhatsNewStateFile | null> {
  try {
    return parseWhatsNewState(await readFile(statePath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Whether the one-time window should show for `version`: any version change
 * since the last dismissal (including downgrades). A falsy version — the
 * resolver failed — never shows.
 */
export async function shouldShowWhatsNew(
  version: string | null | undefined,
  statePath: string,
): Promise<boolean> {
  if (typeof version !== 'string' || version.trim() === '') return false
  const state = await readWhatsNewState(statePath)
  return state?.seenVersion !== version
}

/**
 * Persist `version` as seen (atomic tmp + rename, 0o600). Never throws: a
 * failed write leaves the state untouched and the window may show again —
 * the same fail-open contract as the rest of the plugin.
 */
export async function markSeenWhatsNew(version: string, statePath: string): Promise<boolean> {
  if (typeof version !== 'string' || version.trim() === '') return false
  const previous = await readWhatsNewState(statePath)
  const next: WhatsNewStateFile = {
    seenVersion: version,
    updatedAt: new Date().toISOString(),
  }
  const tmpPath = `${statePath}.tmp-${process.pid}`
  try {
    await mkdir(dirname(statePath), { recursive: true })
    await writeFile(tmpPath, `${JSON.stringify({ ...previous, ...next }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(tmpPath, statePath)
    return true
  } catch {
    try {
      await unlink(tmpPath)
    } catch {
      /* nothing to clean up */
    }
    return false
  }
}

/** `stat`-based existence probe (async I/O discipline). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Default state path: `<configDir>/.pantheon/whats-new.json`, resolving the
 * OpenCode config directory exactly like src/pantheon/tui-version-check.ts
 * (`$XDG_CONFIG_HOME/opencode` → `~/.opencode`), defaulting to the XDG
 * location `init` creates when neither exists yet.
 */
export async function defaultWhatsNewStatePath(
  env: Env = process.env,
  home: string = homedir(),
): Promise<string> {
  const xdgConfig = env.XDG_CONFIG_HOME || join(home, '.config')
  const primary = join(xdgConfig, 'opencode')
  if (await pathExists(primary)) return join(primary, '.pantheon', WHATS_NEW_STATE_FILENAME)

  const legacy = join(home, '.opencode')
  if (await pathExists(legacy)) return join(legacy, '.pantheon', WHATS_NEW_STATE_FILENAME)

  return join(primary, '.pantheon', WHATS_NEW_STATE_FILENAME)
}
