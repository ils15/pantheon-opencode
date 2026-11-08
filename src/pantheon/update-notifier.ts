/**
 * Update notifier — pin + notify, never silent auto-update.
 *
 * Pure decision core: given the installed version, the registry's latest for
 * the installed channel, and the persisted notification state, decide whether
 * a notice should surface (TTL-cached, once per notified version) and what it
 * says. The network call is injectable; offline always means silent.
 *
 * Doctrine (2.0 design, docs/design/2.0-settings-and-install.md): pin by
 * default, one aggregate notice per version, adoption via
 * `pantheon-opencode update` — the stable line never advertises a beta.
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
    if (match[1] === undefined || match[2] === undefined || match[3] === undefined) {
      return null
    }
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      beta: match[4] === undefined ? Number.POSITIVE_INFINITY : +match[4],
    }
  }
  const a = parse(left)
  const b = parse(right)
  if (!a || !b) return 0
  for (let index = 0; index < 3; index += 1) {
    const left = a.core[index] ?? 0
    const right = b.core[index] ?? 0
    if (left !== right) return left - right
  }
  return a.beta - b.beta
}

/**
 * The update decision: a notice fires when the registry version is NEWER than
 * the installed one, the installed line is the same channel family the
 * registry serves (a stable install is never advertised a beta — the update
 * guard owns that crossing), and the TTL since the last check has elapsed.
 */
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
      `pantheon-opencode ${latestVersion} available (installed ${currentVersion}) — ` +
      'changelog in /pantheon-settings, adopt with `pantheon-opencode update`',
  }
}

/** The state to persist after a check (notified or not) for the TTL. */
export function nextCheckState(
  previous: UpdateCheckState,
  notice: UpdateNotice | null,
  nowMs: number,
): UpdateCheckState {
  const next: UpdateCheckState = { lastCheckMs: nowMs }
  const carried = notice?.version ?? previous.lastNotifiedVersion
  if (carried !== undefined) next.lastNotifiedVersion = carried
  return next
}
