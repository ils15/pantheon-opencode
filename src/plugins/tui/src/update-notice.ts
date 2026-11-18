/**
 * Update notifier core (TUI-local copy — the bundle must stay self-contained,
 * same precedent as cost-data.ts/model-pricing.ts).
 *
 * Pin + notify, never silent auto-update: one notice per newer version,
 * TTL-cached, offline-safe, and a stable install is never advertised a beta
 * (the update guard owns that crossing). docs/design/2.0-settings-and-install.md
 */

export const UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000

export interface UpdateCheckState {
  /** Last version a notice was surfaced for (no repeats per version). */
  lastNotifiedVersion?: string
  /** Last version seen on the registry (persisted across TTL restarts). */
  lastKnownLatestVersion?: string
  /** Last time the registry was queried, for the TTL. */
  lastCheckMs?: number
}

export interface UpdateNoticeInput {
  currentVersion: string
  latestVersion: string
  state?: UpdateCheckState
  nowMs?: number
  ttlMs?: number
  isPt?: boolean
}

export interface UpdateNotice {
  version: string
  message: string
}

const isBetaOrRc = (version: string) => /-(?:beta|rc)\.\d+$/.test(String(version).trim())

/** True when `latestVersion` is strictly newer and compatible with `currentVersion` channel. */
export function isNewerUpdateAvailable(currentVersion: string, latestVersion: string): boolean {
  const current = String(currentVersion).trim()
  const latest = String(latestVersion).trim()
  if (!current || !latest) return false
  // A stable install is never advertised a prerelease: explicit opt-in owns that crossing.
  if (!isBetaOrRc(current) && isBetaOrRc(latest)) return false
  return comparePantheonVersions(latest, current) > 0
}

/** Package specifier matching the running release line (`@beta` on prereleases). */
export function packageSpecForVersion(version: string): string {
  return isBetaOrRc(version) ? 'pantheon-opencode@beta' : 'pantheon-opencode'
}

/** Format a bilingual toast title + message for a newly discovered update. */
export function formatUpdateToast(
  currentVersion: string,
  latestVersion: string,
  isPt = false,
): { title: string; message: string } {
  const spec = packageSpecForVersion(currentVersion)
  if (isPt) {
    return {
      title: `Pantheon v${latestVersion} disponível`,
      message: `Atualize em /pantheon-settings (Atualizações) ou \`opencode plugin update ${spec}\``,
    }
  }
  return {
    title: `Pantheon v${latestVersion} available`,
    message: `Update in /pantheon-settings (Updates) or \`opencode plugin update ${spec}\``,
  }
}

/** Compact persistent badge rendered in Home footer and Sidebar header when an update exists. */
export function formatUpdateBadge(
  currentVersion: string,
  latestVersion: string | null | undefined,
  options: { isPt?: boolean; compact?: boolean } = {},
): string | null {
  if (!latestVersion || !isNewerUpdateAvailable(currentVersion, latestVersion)) return null
  const version = latestVersion.trim().replace(/^v/i, '')
  if (options.compact) return `↑ v${version} (/pantheon-settings)`
  return options.isPt
    ? `↑ v${version} disponível · /pantheon-settings`
    : `↑ v${version} available · /pantheon-settings`
}

/** Resolve cached newer version from persisted check state (no network call needed). */
export function resolveCachedAvailableUpdate(
  currentVersion: string,
  state: UpdateCheckState | undefined,
): string | null {
  if (!state) return null
  const candidate = state.lastKnownLatestVersion ?? state.lastNotifiedVersion
  if (!candidate) return null
  return isNewerUpdateAvailable(currentVersion, candidate) ? candidate : null
}

/** Stamp `lastKnownLatestVersion` onto an `UpdateCheckState` without altering TTL/notice fields. */
export function withKnownLatest(
  state: UpdateCheckState,
  latestVersion: string | null,
): UpdateCheckState {
  if (!latestVersion) return state
  return { ...state, lastKnownLatestVersion: latestVersion }
}

let availableUpdateState: string | null = null
const availableUpdateListeners = new Set<(version: string | null) => void>()

export function getAvailableUpdateVersion(): string | null {
  return availableUpdateState
}

export function setAvailableUpdateVersion(version: string | null): void {
  const normalized = version && version.trim() !== '' ? version.trim() : null
  if (normalized === availableUpdateState) return
  availableUpdateState = normalized
  for (const listener of availableUpdateListeners) {
    try {
      listener(availableUpdateState)
    } catch {}
  }
}

export function subscribeAvailableUpdate(listener: (version: string | null) => void): () => void {
  availableUpdateListeners.add(listener)
  return () => {
    availableUpdateListeners.delete(listener)
  }
}

/** Semver-ish compare for X.Y.Z[-(beta|rc).N]; prereleases sort before their release. */
export function comparePantheonVersions(left: string, right: string): number {
  const parse = (version: string) => {
    const match = String(version)
      .trim()
      .match(/^(\d+)\.(\d+)\.(\d+)(?:-(beta|rc)\.(\d+))?$/)
    if (!match) return null
    const [, major = '', minor = '', patch = '', stage = '', stageNum = ''] = match
    const stageRank = stage === 'beta' ? 1 : stage === 'rc' ? 2 : 3
    return {
      core: [+major, +minor, +patch] as [number, number, number],
      stageRank,
      stageNum: stage !== '' ? +stageNum : Number.POSITIVE_INFINITY,
    }
  }
  const a = parse(left)
  const b = parse(right)
  if (!a || !b) return 0
  const [aMajor, aMinor, aPatch] = a.core
  const [bMajor, bMinor, bPatch] = b.core
  if (aMajor !== bMajor) return aMajor - bMajor
  if (aMinor !== bMinor) return aMinor - bMinor
  if (aPatch !== bPatch) return aPatch - bPatch
  if (a.stageRank !== b.stageRank) return a.stageRank - b.stageRank
  return a.stageNum - b.stageNum
}

export function pickUpdateNotice(input: UpdateNoticeInput): UpdateNotice | null {
  const { currentVersion, latestVersion, state = {}, nowMs = Date.now(), isPt = false } = input
  const ttlMs = input.ttlMs ?? UPDATE_CHECK_TTL_MS

  const lastCheck = state.lastCheckMs ?? 0
  if (nowMs - lastCheck < ttlMs) return null
  if (state.lastNotifiedVersion === latestVersion) return null
  if (!isNewerUpdateAvailable(currentVersion, latestVersion)) return null

  return {
    version: latestVersion,
    message: formatUpdateToast(currentVersion, latestVersion, isPt).message,
  }
}

/** The state to persist after a check (notified or not) for the TTL. */
export function nextCheckState(
  previous: UpdateCheckState,
  notice: UpdateNotice | null,
  nowMs: number,
): UpdateCheckState {
  const lastNotifiedVersion = notice?.version ?? previous.lastNotifiedVersion
  return {
    lastCheckMs: nowMs,
    ...(lastNotifiedVersion !== undefined ? { lastNotifiedVersion } : {}),
  }
}
