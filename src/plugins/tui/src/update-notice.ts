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
  /** Last time the registry was queried, for the TTL. */
  lastCheckMs?: number
}

export interface UpdateNoticeInput {
  currentVersion: string
  latestVersion: string
  state?: UpdateCheckState
  nowMs?: number
  ttlMs?: number
}

export interface UpdateNotice {
  version: string
  message: string
}

/** Semver-ish compare for X.Y.Z[-beta.N]; betas sort before their release. */
export function comparePantheonVersions(left: string, right: string): number {
  const parse = (version: string) => {
    const match = String(version)
      .trim()
      .match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/)
    if (!match) return null
    return {
      core: [+match[1], +match[2], +match[3]],
      beta: match[4] === undefined ? Number.POSITIVE_INFINITY : +match[4],
    }
  }
  const a = parse(left)
  const b = parse(right)
  if (!a || !b) return 0
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index]
  }
  return a.beta - b.beta
}

export function pickUpdateNotice(input: UpdateNoticeInput): UpdateNotice | null {
  const { currentVersion, latestVersion, state = {}, nowMs = Date.now() } = input
  const ttlMs = input.ttlMs ?? UPDATE_CHECK_TTL_MS

  const lastCheck = state.lastCheckMs ?? 0
  if (nowMs - lastCheck < ttlMs) return null
  if (state.lastNotifiedVersion === latestVersion) return null

  const stable = (version: string) => !/-beta\.\d+$/.test(version)
  // A stable install is never advertised a beta: the update guard owns that
  // crossing and requires explicit opt-in there.
  if (stable(currentVersion) && !stable(latestVersion)) return null

  if (comparePantheonVersions(latestVersion, currentVersion) <= 0) return null

  return {
    version: latestVersion,
    message:
      `pantheon-opencode ${latestVersion} available — ` +
      'changelog in /pantheon-settings, adopt with `pantheon-opencode update`',
  }
}

/** The state to persist after a check (notified or not) for the TTL. */
export function nextCheckState(
  previous: UpdateCheckState,
  notice: UpdateNotice | null,
  nowMs: number,
): UpdateCheckState {
  return {
    lastCheckMs: nowMs,
    lastNotifiedVersion: notice?.version ?? previous.lastNotifiedVersion,
  }
}
