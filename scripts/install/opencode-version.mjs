/** OpenCode host gate shared by the CLI and installer. */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The only host generation this installer writes. Pantheon registers the plugin
 * surface through the plural `plugins` key with directory entries, which an
 * OpenCode 1.x host ignores entirely — so a host the probe cannot confirm as
 * 2.x is refused before any write, never served a config it cannot load.
 */
const SUPPORTED_GENERATION = 'v2'

/**
 * The hard refusal for a confirmed 1.x host. Exported so the CLI, setup and
 * tests quote exactly one sentence for the same fact.
 * @param {number|string} major
 * @returns {string}
 */
export function unsupportedHostMessage(major = 1) {
  return (
    `Pantheon 2.0 requires OpenCode 2.x; this host is ${major}.x — uninstall Pantheon 1.x ` +
    'or upgrade the host'
  )
}

/**
 * How to make the gate deterministic when no host binary can be probed. Shared
 * by every unreadable-host refusal so the escape hatch is stated exactly once.
 */
const PIN_HINT = 'pin OPENCODE_VERSION=v2 to skip the probe'

/**
 * Budget for `opencode --version` during a real install. A hung host binary
 * must not block the installer forever.
 */
const HOST_PROBE_TIMEOUT_MS = 5000

/**
 * Budget for the same probe during a DRY RUN. A preview is bounded: the dry run
 * probes the host like the apply does (plan and apply must make the SAME
 * decision), so its latency must stay small even on a host that hangs.
 */
export const DRY_RUN_PROBE_TIMEOUT_MS = 2000

/**
 * Ask the host binary for its version. Throws on any spawn failure so the
 * caller can fail soft in one place.
 *
 * The probe RUNS THE HOST, and a host is not a pure function of its `--version`
 * flag: OpenCode 2.x creates `~/.cache/opencode`, `~/.local/share/opencode/log`
 * and `~/.local/state/opencode` before printing. A dry run promises "no files
 * were written", so the probe runs inside a throwaway HOME/XDG sandbox that is
 * deleted before returning. The same isolation is used for the install path:
 * plan and apply must make the SAME decision, and a HOME-sensitive wrapper
 * would otherwise let them disagree — the exact divergence the shared probe
 * exists to prevent.
 *
 * stderr is captured alongside stdout so a host that prints its version banner
 * to stderr is still readable.
 * @param {string} binary
 * @param {number} [timeoutMs=HOST_PROBE_TIMEOUT_MS]
 * @returns {{stdout: string, stderr: string}}
 */
function probeHostVersion(binary, timeoutMs = HOST_PROBE_TIMEOUT_MS) {
  const sandbox = mkdtempSync(join(tmpdir(), 'pantheon-host-probe-'))
  const env = {
    ...process.env,
    HOME: sandbox,
    XDG_CONFIG_HOME: join(sandbox, '.config'),
    XDG_CACHE_HOME: join(sandbox, '.cache'),
    XDG_DATA_HOME: join(sandbox, '.local', 'share'),
    XDG_STATE_HOME: join(sandbox, '.local', 'state'),
  }
  try {
    const result = spawnSync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.error) throw result.error
    if (result.status !== 0) {
      throw new Error(`"${binary} --version" exited with status ${result.status}`)
    }
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// A version-SHAPED token: optional "v", a major, a dot, a minor. The lookbehind
// rejects starting mid-number so "1.18.33" offers ONE candidate ("1.18") rather
// than also offering "18.33". Case-insensitive because hosts print both
// "opencode v2.0.22" and "OpenCode V2.0.22".
const VERSION_TOKEN = /(?<![\d.])v?(\d+)\.(\d+)/gi

// A token immediately preceded by the tool name IS that host's own version,
// whatever else the banner mentions. This is what distinguishes
// "node v22.1.0 (opencode 1.18.33)" — where the two candidates are a runtime
// version and the tool version — from a genuine contradiction.
//
// KNOWN LIMIT, deliberately not worked around: this anchor is a NAME anchor, so
// any sentence that puts "opencode" in front of a version-shaped token reads as
// a host banner. A probe whose output is `warning: deprecated, upgrade to
// opencode 2.0.0` reads as the host naming itself 2.x. Closing it would need a
// rule that rejects a mid-sentence "opencode X.Y.Z" — but "node v22.1.0
// (opencode 2.0.22)" is exactly such a mid-sentence anchor, and it is the
// reason the anchor exists: dropping it lets a leading runtime token pose as
// the host's version. `probeHostVersion` spawns whatever OPENCODE_BIN names and
// accepts any exit-0 binary, so a wrapper or shim printing a bare path is
// indistinguishable from the real host by construction; an unknown output is
// handled by a loud refusal below, never by a silent guess.
const ANCHOR_NAME = 'opencode'

// How far back the anchor scan looks. `[\s:=]*` is unbounded, so no finite
// window is exact — the cap is what makes the scan O(1) per token instead of
// copying the whole prefix, which was quadratic and let a verbose host outrun the
// 5s spawn timeout (that timeout guards the spawn, not the parse). The budget is
// sized from the anchor itself (ANCHOR_NAME plus separators), not guessed: the
// longest separator run in any realistic banner is ~10 bytes. Past the budget an
// anchor is simply missed, and that degrades to the loud refusal path — it can
// turn a quiet resolution into a refusal, never into a different resolution.
const ANCHOR_SEPARATOR_BUDGET = 56
const ANCHOR_WINDOW_BYTES = ANCHOR_NAME.length + ANCHOR_SEPARATOR_BUDGET
const TOOL_NAME_BEFORE = new RegExp(`${ANCHOR_NAME}[\\s:=]*$`, 'i')

// A major at or above this is a calendar year, not a release number:
// "built 2026.10.04" is version-SHAPED but describes no release. So is major 0,
// which is a prerelease placeholder rather than a release — and major 0 read as
// "older than 2" would be the original defect (a 2.x beta refused as a 1.x
// host). Which brings the subtlety this gate turns on:
//
//   * UNANCHORED and implausible -> noise. A date or a build counter says
//     nothing about the host's generation, so dropping it is a resolution, not a
//     failure: "opencode v2.0.22 built 2026.10.04" stays quiet.
//   * ANCHORED and implausible -> the host's OWN version, which we cannot read.
//     Discarding it would promote a surviving `node v22` token to deciding power
//     and answer in silence — "opencode 100.0.0 (node v22.1.0)" would resolve to
//     v2 with no warning. So a refused anchored major is reported, not dropped.
//
// Both cases stay LOUD rather than silent, which is the safe direction.
const FIRST_PLAUSIBLE_MAJOR = 100

/** Is `major` a value we refuse to read as a release number? */
function isImplausibleMajor(major) {
  return major === 0 || major >= FIRST_PLAUSIBLE_MAJOR
}

/**
 * The slice of `source` the anchor scan inspects — bounded on purpose (see
 * ANCHOR_WINDOW_BYTES) so the scan does not copy the prefix per token.
 * @param {string} source @param {number} index @returns {string}
 */
function anchorWindow(source, index) {
  return source.slice(Math.max(0, index - ANCHOR_WINDOW_BYTES), index)
}

/**
 * Reduce a `--version` string to the single major it unambiguously reports.
 *
 * Anchoring on the tool name — rather than taking the first or the last
 * version-shaped token — is what makes this robust on both sides. First-match
 * anchoring lets a leading `node v22` outrank the tool's own version; last-match
 * anchoring lets a trailing `built 2026.10.04` outrank it. A name-anchored token
 * defeats both.
 *
 * @param {string} text raw `--version` output from one stream
 * @returns {{major: number}|{ambiguous: number[]}|{unreadable: number}|null}
 *   `{major}` when the host version is identifiable, `{ambiguous}` when
 *   version-shaped tokens disagree and nothing says which is the host's,
 *   `{unreadable}` when the host's own anchored token reports a major this gate
 *   will not interpret, and `null` when nothing is version-shaped.
 */
function parseHostMajor(text) {
  const source = String(text ?? '')
  const candidates = []
  let unreadable = null
  for (const match of source.matchAll(VERSION_TOKEN)) {
    const major = Number(match[1])
    const anchored = TOOL_NAME_BEFORE.test(anchorWindow(source, match.index))
    if (isImplausibleMajor(major)) {
      if (anchored && unreadable === null) unreadable = major
      continue
    }
    candidates.push({ major, anchored })
  }
  if (unreadable !== null) return { unreadable }
  if (candidates.length === 0) return null

  const anchored = candidates.filter((candidate) => candidate.anchored)
  if (anchored.length > 0) {
    const majors = new Set(anchored.map((candidate) => candidate.major))
    if (majors.size === 1) return { major: anchored[0].major }
    return { ambiguous: [...majors].sort((a, b) => a - b) }
  }

  const majors = new Set(candidates.map((candidate) => candidate.major))
  if (majors.size === 1) return { major: candidates[0].major }
  return { ambiguous: [...majors].sort((a, b) => a - b) }
}

function resolveCandidateBinary(explicitBinary, env) {
  if (explicitBinary) return explicitBinary
  if (env.OPENCODE_BIN) return env.OPENCODE_BIN
  if (process.platform !== 'win32') {
    const userHome = env.HOME || homedir()
    const standardBin = join(userHome, '.opencode', 'bin', 'opencode')
    if (existsSync(standardBin)) {
      return standardBin
    }
  }
  return 'opencode'
}

/**
 * Resolve the target OpenCode generation. There is exactly one, and the probe
 * must CONFIRM the host is 2.x before any write: there is no generation to fall
 * back to, so an unreadable host is a refusal, not a warning.
 *
 * Precedence:
 *   1. `OPENCODE_VERSION=v2` env pin — skips the probe entirely. It exists so
 *      CI, sandboxes and operators can make the answer deterministic without a
 *      runnable host binary. `v1` (or any other value) is refused.
 *   2. an `opencode2` binary basename — an explicit operator hint
 *      (`OPENCODE_BIN` pointing at it is a deliberate act) and always 2.x.
 *   3. a `--version` probe of the host binary:
 *        - major >= 2  -> v2, quiet.
 *        - major === 1 -> HARD ERROR before any write: a 1.x host is a fact,
 *          not a detection gap, and the registry this installer writes would be
 *          silently ignored there.
 *        - probe failed / unreadable / ambiguous / unparseable -> HARD ERROR
 *          before any write. The installer cannot confirm the one premise it
 *          writes for, so it refuses loudly instead of guessing; the env pin is
 *          the deterministic escape hatch for hosts that cannot be probed.
 *
 * @param {{env?: Record<string, string|undefined>, binary?: string,
 *          probe?: () => string|{stdout?: string, stderr?: string},
 *          probeTimeoutMs?: number}} [options]
 * @returns {'v2'}
 */
export function resolveOpenCodeVersion(options = {}) {
  const env = options.env ?? process.env
  if (env.OPENCODE_VERSION !== undefined) {
    if (env.OPENCODE_VERSION === SUPPORTED_GENERATION) return SUPPORTED_GENERATION
    if (env.OPENCODE_VERSION === 'v1') throw new Error(unsupportedHostMessage(1))
    throw new Error(
      `Invalid OPENCODE_VERSION "${env.OPENCODE_VERSION}" — only "${SUPPORTED_GENERATION}" can be pinned`,
    )
  }
  const binary = resolveCandidateBinary(options.binary, env)
  if (/(?:^|[\\/])opencode2(?:\.exe)?$/i.test(binary)) return SUPPORTED_GENERATION

  const probe = options.probe ?? (() => probeHostVersion(binary, options.probeTimeoutMs))
  let raw
  try {
    raw = probe()
  } catch (err) {
    throw new Error(
      `Could not probe the host OpenCode version (${err.message}). ` +
        `Pantheon 2.0 requires OpenCode 2.x — install OpenCode 2.x and put it on PATH, ` +
        `or ${PIN_HINT}.`,
    )
  }

  // Accept both the real probe's {stdout, stderr} shape and a bare string, so a
  // caller (or CI) can inject a probe without spawning a host binary.
  const streams =
    raw !== null && typeof raw === 'object'
      ? { stdout: String(raw.stdout ?? ''), stderr: String(raw.stderr ?? '') }
      : { stdout: String(raw ?? ''), stderr: '' }

  // stdout decides alone when it yields a version; stderr is a FALLBACK for the
  // host that prints nothing there, never a second vote. If both parse, stdout
  // wins, so a stderr banner can never overrule the primary source.
  const parsed = parseHostMajor(streams.stdout) ?? parseHostMajor(streams.stderr)

  if (parsed === null) {
    // A probe that RAN but printed nothing version-shaped is not evidence of a
    // 2.x host, so the gate refuses rather than guess.
    throw new Error(
      `Could not parse the host OpenCode version from ` +
        `${JSON.stringify(`${streams.stdout}${streams.stderr}`.trim())}. ` +
        `Pantheon 2.0 requires OpenCode 2.x — upgrade the host, or ${PIN_HINT}.`,
    )
  }
  if (parsed.unreadable !== undefined) {
    // The host named itself and reported a major this gate refuses to read (0,
    // or a calendar year). It is an unreadable self-report — not a confirmed
    // 2.x host — so the gate refuses.
    throw new Error(
      `The host OpenCode version output reports major ${parsed.unreadable}, which is ` +
        'not a release number this gate can interpret (a prerelease placeholder or a ' +
        `calendar year). Pantheon 2.0 requires OpenCode 2.x — upgrade the host, or ${PIN_HINT}.`,
    )
  }
  if (parsed.ambiguous) {
    // Version-shaped tokens that disagree, with no tool name to break the tie.
    // Guessing silently is the defect this gate exists to prevent, and there is
    // no generation to fall back to, so the contradiction is a refusal.
    throw new Error(
      `The host OpenCode version output has contradictory versions ` +
        `(${parsed.ambiguous.map((major) => `major ${major}`).join(', ')}) and does not say ` +
        `which is the host's. Pantheon 2.0 requires OpenCode 2.x — or ${PIN_HINT}.`,
    )
  }
  if (parsed.major === 1) {
    // A CONFIRMED 1.x host is a fact, not a detection gap: the plugin registry
    // this installer writes would be silently ignored there, losing the plugin
    // AND writing a config the host cannot use. Refuse before any write.
    throw new Error(unsupportedHostMessage(parsed.major))
  }
  return SUPPORTED_GENERATION
}
