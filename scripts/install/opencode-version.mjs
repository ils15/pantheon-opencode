/** OpenCode major-version selection shared by the CLI and installer. */

import { spawnSync } from 'node:child_process'

import { warning } from './cli-ui.mjs'

const VALID_VERSIONS = new Set(['v1', 'v2', 'auto'])

/** @param {string[]} args @returns {'v1'|'v2'|'auto'|null} */
export function parseOpenCodeVersion(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg.startsWith('--opencode-version=')) return normalize(arg.split('=', 2)[1])
    if (arg === '--opencode-version') return normalize(args[index + 1])
    // --version v1|v2 was supported by 1.4.x. Bare --version remains the
    // package version command and is deliberately not interpreted here.
    if (arg.startsWith('--version=')) return normalize(arg.split('=', 2)[1])
    if (arg === '--version' && args[index + 1]?.startsWith('v')) {
      // Preserve bare --version/package-version compatibility, while making
      // unsupported OpenCode selectors (for example v3) fail loudly.
      return normalize(args[index + 1])
    }
  }
  return null
}

function normalize(value) {
  if (!VALID_VERSIONS.has(value)) {
    throw new Error(`Invalid OpenCode version "${value}" — expected v1, v2, or auto`)
  }
  return value
}

/**
 * Ask the host binary for its version. Throws on any spawn failure so the
 * caller can fail soft in one place.
 *
 * stderr is captured alongside stdout. A host that prints its version banner to
 * stderr and nothing to stdout would otherwise soft-fail to V1 — a wrong
 * answer whose cause has nothing to do with the host's generation.
 * @param {string} binary
 * @returns {{stdout: string, stderr: string}}
 */
function probeHostVersion(binary) {
  const result = spawnSync(binary, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`"${binary} --version" exited with status ${result.status}`)
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
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
// opencode 2.0.0` resolves to v2 in silence. Closing it would need a rule that
// rejects a mid-sentence "opencode X.Y.Z" — but "node v22.1.0 (opencode 1.18.33)"
// is exactly such a mid-sentence anchor, and it is the reason the anchor exists:
// dropping it lets a leading runtime token flip a genuine 1.x host to v2. The
// defect class is not the nag wording (a phrase blacklist closes these three
// strings and none of the others), it is name-adjacency. `probeHostVersion`
// spawns whatever OPENCODE_BIN names and accepts any exit-0 binary, so a wrapper
// or shim printing a bare path is indistinguishable from the real host by
// construction. An operator whose `opencode` is a wrapper gets v2 silently; the
// documented remedy is `--opencode-version`, not a heuristic that would trade
// this silent misclassification for a different one.
const ANCHOR_NAME = 'opencode'

// How far back the anchor scan looks. `[\s:=]*` is unbounded, so no finite
// window is exact — the cap is what makes the scan O(1) per token instead of
// copying the whole prefix, which was quadratic and let a verbose host outrun the
// 5s spawn timeout (that timeout guards the spawn, not the parse). The budget is
// sized from the anchor itself (ANCHOR_NAME plus separators), not guessed: the
// longest separator run in any realistic banner is ~10 bytes. Past the budget an
// anchor is simply missed, and that degrades to the loud consensus path — it can
// turn a quiet resolution into a warned one, never into a different resolution.
const ANCHOR_SEPARATOR_BUDGET = 56
const ANCHOR_WINDOW_BYTES = ANCHOR_NAME.length + ANCHOR_SEPARATOR_BUDGET
const TOOL_NAME_BEFORE = new RegExp(`${ANCHOR_NAME}[\\s:=]*$`, 'i')

// A major at or above this is a calendar year, not a release number:
// "built 2026.10.04" is version-SHAPED but describes no release. So is major 0,
// which is a prerelease placeholder rather than a release — and major 0 read as
// "older than 2" is the original defect (V1 config on a 2.x host) recurring for
// a 2.x beta. Which brings the subtlety this gate turns on:
//
//   * UNANCHORED and implausible -> noise. A date or a build counter says
//     nothing about the host's generation, so dropping it is a resolution, not a
//     failure: "opencode v2.0.22 built 2026.10.04" stays quiet.
//   * ANCHORED and implausible -> the host's OWN version, which we cannot read.
//     Discarding it would promote a surviving `node v22` token to deciding power
//     and answer in silence — "opencode 100.0.0 (node v22.1.0)" would resolve to
//     v2 with no warning. So a refused anchored major is reported, not dropped.
//
// Both cases fail LOUD rather than silently, which is the safe direction, and
// the loud-v1 claim holds for the anchored case without depending on the dropped
// token being the only candidate.
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
 * anchoring lets a leading `node v22` outrank the tool's own version and flips
 * a 1.x host to v2; last-match anchoring lets a trailing `built 2026.10.04`
 * outrank it and does the same. A name-anchored token defeats both.
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

/**
 * Resolve the target OpenCode generation.
 *
 * `auto` precedence — the order is load-bearing, do not "simplify" it:
 *   1. explicit `--opencode-version` argument
 *   2. OPENCODE_VERSION env var
 *   3. an `opencode2` binary basename
 *   4. a `--version` probe of the host binary (major >= 2 => v2)
 *   5. soft-fail to v1 with one visible warning
 *
 * Step 3 stays ahead of step 4 because of WHAT THE TWO STEPS ARE. Step 3 is an
 * explicit operator hint: naming a binary `opencode2` and pointing
 * `OPENCODE_BIN` at it is a deliberate act, and it is the only one of the two
 * the operator gets to state. Step 4 is a heuristic read of a free-form string
 * that some program chose to print. A hint must not be overruled by a
 * heuristic — and the argument holds no matter what any given build prints.
 *
 * Historical note, NOT an observation of this host: an OpenCode 2.x prerelease
 * once printed "0.0.0-next-17444", which any "major >= 2 => v2" probe reads as
 * major 0 and would resolve to v1. That string does not come from the host —
 * it survives only in this repo's comments and test fixtures. It is also why a
 * major-0 anchored token now takes the loud path rather than resolving to v1 in
 * silence (see FIRST_PLAUSIBLE_MAJOR). Verified 2026-10-04: `opencode2` here is
 * a 47-byte shim that execs `opencode`, and `opencode2 --version` prints
 * "opencode v2.0.22" on stdout. So for a real `opencode2` today both the
 * basename and the probe return v2 and the ordering is harmless rather than
 * load-bearing; what it still defends is the general case above.
 *
 * Step 5 falls back to v1 rather than v2 on purpose. Writing a plural
 * `plugins` directory entry on an unknown 1.x host would be ignored there,
 * losing the plugin on that host AND dropping the V1-only surface — strictly
 * worse than the V1 default, which at least still works. The fallback is only
 * tolerable because it warns; a silent v1 is what made this a silent failure.
 *
 * @param {'v1'|'v2'|'auto'|null|undefined} requested
 * @param {{env?: Record<string, string|undefined>, binary?: string,
 *          probe?: () => string|{stdout?: string, stderr?: string},
 *          warn?: (message: string) => void}} [options]
 * @returns {'v1'|'v2'}
 */
export function resolveOpenCodeVersion(requested = 'auto', options = {}) {
  if (!VALID_VERSIONS.has(requested)) {
    throw new Error(`Invalid OpenCode version "${requested}" — expected v1, v2, or auto`)
  }
  if (requested === 'v1' || requested === 'v2') return requested
  const env = options.env ?? process.env
  if (env.OPENCODE_VERSION === 'v1' || env.OPENCODE_VERSION === 'v2') {
    return env.OPENCODE_VERSION
  }
  const binary = options.binary ?? env.OPENCODE_BIN ?? ''
  if (/(?:^|[\\/])opencode2(?:\.exe)?$/i.test(binary)) return 'v2'

  const probe = options.probe ?? (() => probeHostVersion(binary || 'opencode'))
  const warn = options.warn ?? warning
  let raw
  try {
    raw = probe()
  } catch (err) {
    warn(
      `Could not read the host OpenCode version (${err.message}). Falling back to the V1 ` +
        `configuration; if this host is OpenCode 2.x re-run with --opencode-version v2 ` +
        `(or v1 to force V1).`,
    )
    return 'v1'
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
    // A probe that RAN but whose output we cannot read is just as dangerous as
    // one that failed: silently landing on V1 is the bug this gate exists to
    // fix, so it gets the same visible warning.
    warn(
      `Could not parse the host OpenCode version from ` +
        `${JSON.stringify(`${streams.stdout}${streams.stderr}`.trim())}. ` +
        `Falling back to the V1 configuration; if this host is OpenCode 2.x re-run with ` +
        `--opencode-version v2 (or v1 to force V1).`,
    )
    return 'v1'
  }
  if (parsed.unreadable !== undefined) {
    // The host named itself and reported a major this gate refuses to read (0,
    // or a calendar year). That is not noise like a trailing build date — it is
    // the host's own version, so letting a surviving runtime token decide would
    // be a silent guess. Say what we saw and fall back loudly.
    warn(
      `The host OpenCode version output reports major ${parsed.unreadable}, which is ` +
        `not a release number this gate can interpret (a prerelease placeholder or a ` +
        `calendar year). Falling back to the V1 configuration; pass --opencode-version v2 ` +
        `if this host is OpenCode 2.x (or v1 to force V1).`,
    )
    return 'v1'
  }
  if (parsed.ambiguous) {
    // Version-shaped tokens that disagree, with no tool name to break the tie.
    // The reviewer accepted "wrong but loud" here; guessing silently is the
    // defect this branch exists to prevent.
    warn(
      `The host OpenCode version output has contradictory versions ` +
        `(${parsed.ambiguous.map((major) => `major ${major}`).join(', ')}) and does not say ` +
        `which is the host's. Falling back to the V1 configuration; pass ` +
        `--opencode-version v2 if this host is OpenCode 2.x (or v1 to force V1).`,
    )
    return 'v1'
  }
  return parsed.major >= 2 ? 'v2' : 'v1'
}
