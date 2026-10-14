/**
 * bench/lib/args.mjs — pure CLI argument parsing for bench/bin/bench.mjs
 * (beta-10 latency slice, harness complement).
 *
 * Two explicit measurement PROFILES (never inferred, always stated):
 *
 *   host               — what the host config dir injects on its own: the
 *                        global AGENTS.md only. The run directories stay empty,
 *                        which is exactly the profile the F0/F1 runs measured.
 *   double-injection   — the real in-repo profile: the global AGENTS.md AND a
 *                        project AGENTS.md materialized inside each run
 *                        directory. This is the profile the AGENTS.md carve
 *                        acts on, because only here is the global+project
 *                        duplicate actually loaded.
 *
 * Each profile has its own control: an arm is identified by the fixtures it
 * injects (--global-agents / --project-agents) plus a --label that names the
 * output. Nothing is inferred from the host, so a control and a candidate can
 * run same-day against the same host and model.
 *
 * Unknown flags are REJECTED (a typo must never silently measure the wrong
 * thing). The parser is pure — it returns a descriptor or throws UsageError —
 * so the CLI shell keeps all I/O.
 *
 * @module bench/lib/args
 */

/** Recognized profiles. */
export const PROFILES = ['host', 'double-injection']
export const DEFAULT_RUNS = 5
export const DEFAULT_LABEL = 'baseline'

/** A usage error is a caller mistake; the CLI maps it to exit code 2. */
export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function readValue(argv, index, flag) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`${flag} requires a value`)
  }
  return value
}

/**
 * Parse the bench CLI argv (already sliced past `node script`).
 *
 * Returns { runs, profile, label, globalAgents, projectAgents }.
 * Throws UsageError on an unknown flag, a missing value, an invalid profile, or
 * a `--project-agents` that would never be injected (host profile).
 */
export function parseBenchArgs(argv) {
  const out = {
    runs: DEFAULT_RUNS,
    profile: 'host',
    label: DEFAULT_LABEL,
    globalAgents: null,
    projectAgents: null,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--runs': {
        const raw = readValue(argv, i, '--runs')
        const value = Number(raw)
        if (!Number.isInteger(value) || value < 1) {
          throw new UsageError('--runs must be a positive integer')
        }
        out.runs = value
        i += 1
        break
      }
      case '--profile': {
        const value = readValue(argv, i, '--profile')
        if (!PROFILES.includes(value)) {
          throw new UsageError(`--profile must be one of ${PROFILES.join('|')} (got ${value})`)
        }
        out.profile = value
        i += 1
        break
      }
      case '--label': {
        const value = readValue(argv, i, '--label')
        if (!LABEL_RE.test(value)) {
          throw new UsageError('--label must be a filesystem-safe name (letters, digits, . _ -)')
        }
        out.label = value
        i += 1
        break
      }
      case '--global-agents': {
        out.globalAgents = readValue(argv, i, '--global-agents')
        i += 1
        break
      }
      case '--project-agents': {
        out.projectAgents = readValue(argv, i, '--project-agents')
        i += 1
        break
      }
      default:
        throw new UsageError(`unknown argument: ${arg}`)
    }
  }

  if (out.projectAgents !== null && out.profile !== 'double-injection') {
    throw new UsageError(
      '--project-agents is only injected under --profile double-injection; ' +
        'refusing to accept a fixture that would never be loaded',
    )
  }
  if (out.profile === 'double-injection' && out.projectAgents === null) {
    throw new UsageError('--profile double-injection requires --project-agents <path>')
  }

  return out
}
