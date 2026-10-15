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
 * --scenarios restricts the interleave to a subset (default A,B) so a claim
 * scenario (B) can be measured in a short, robust job; an omitted scenario is
 * simply not measured, never silently folded into the other.
 *
 * Unknown flags are REJECTED (a typo must never silently measure the wrong
 * thing). The parser is pure — it returns a descriptor or throws UsageError —
 * so the CLI shell keeps all I/O.
 *
 * @module bench/lib/args
 */

/** Recognized profiles. */
export const PROFILES = ['host', 'double-injection']
/** Recognized scenarios. */
export const SCENARIOS = ['A', 'B']
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
const AGENT_RE = /^[a-z][a-z0-9-]{0,63}$/
const RESULT_PATH_RE = /^bench\/results\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/

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
 * Returns { runs, profile, label, globalAgents, projectAgents, agentsDir,
 * controlAgentsDir,
 * skillsDir, paired, rootAgent, controlRootAgent, out }.
 * Throws UsageError on an unknown flag, a missing value, an invalid profile, or
 * a `--project-agents` that would never be injected (host profile).
 */
export function parseBenchArgs(argv) {
  const out = {
    runs: DEFAULT_RUNS,
    profile: 'host',
    label: DEFAULT_LABEL,
    scenarios: [...SCENARIOS],
    globalAgents: null,
    projectAgents: null,
    agentsDir: null,
    controlAgentsDir: null,
    skillsDir: null,
    promptFile: null,
    paired: false,
    routingParity: false,
    rootAgent: null,
    controlRootAgent: null,
    out: null,
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
      case '--scenario':
      case '--scenarios': {
        const flag = arg
        const value = readValue(argv, i, flag)
        const list = value
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter((s) => s !== '')
        if (list.length === 0 || list.some((s) => !SCENARIOS.includes(s))) {
          throw new UsageError(`--scenarios must be a comma list from ${SCENARIOS.join(',')}`)
        }
        if (flag === '--scenario' && list.length !== 1) {
          throw new UsageError('--scenario accepts exactly one scenario')
        }
        out.scenarios = SCENARIOS.filter((s) => list.includes(s))
        i += 1
        break
      }
      case '--root-agent':
      case '--control-root-agent': {
        const value = readValue(argv, i, arg)
        if (!AGENT_RE.test(value)) throw new UsageError(`${arg} must be a lowercase agent id`)
        if (arg === '--root-agent') out.rootAgent = value
        else out.controlRootAgent = value
        i += 1
        break
      }
      case '--paired': {
        out.paired = true
        break
      }
      case '--routing-parity': {
        out.routingParity = true
        break
      }
      case '--out': {
        const value = readValue(argv, i, '--out')
        if (!RESULT_PATH_RE.test(value)) {
          throw new UsageError('--out must be a filename under bench/results ending in .json')
        }
        out.out = value
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
      case '--agents-dir': {
        out.agentsDir = readValue(argv, i, '--agents-dir')
        i += 1
        break
      }
      case '--control-agents-dir': {
        out.controlAgentsDir = readValue(argv, i, '--control-agents-dir')
        i += 1
        break
      }
      case '--skills-dir': {
        out.skillsDir = readValue(argv, i, '--skills-dir')
        i += 1
        break
      }
      case '--prompt-file': {
        out.promptFile = readValue(argv, i, '--prompt-file')
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
  if (out.paired) {
    if (out.scenarios.length !== 1 || out.scenarios[0] !== 'B') {
      throw new UsageError('--paired root-agent comparison requires scenario B only')
    }
    if (out.rootAgent === null || out.controlRootAgent === null) {
      throw new UsageError('--paired requires --root-agent and --control-root-agent')
    }
    if (out.agentsDir === null) throw new UsageError('--paired requires --agents-dir <path>')
    if (out.skillsDir === null) throw new UsageError('--paired requires --skills-dir <path>')
    if (out.out === null) throw new UsageError('--paired requires --out <bench/results/file.json>')
    if (out.profile !== 'double-injection') {
      throw new UsageError('--paired requires --profile double-injection for D4 fidelity')
    }
    if (out.globalAgents === null) {
      throw new UsageError('--paired requires --global-agents <path> for D4 fidelity')
    }
    if (out.projectAgents === null) {
      throw new UsageError('--paired requires --project-agents <path> for D4 fidelity')
    }
  } else if (
    out.rootAgent !== null ||
    out.controlRootAgent !== null ||
    out.controlAgentsDir !== null ||
    out.promptFile !== null ||
    out.routingParity ||
    out.out !== null ||
    out.agentsDir !== null ||
    out.skillsDir !== null
  ) {
    throw new UsageError(
      '--root-agent, --control-root-agent, --agents-dir, --control-agents-dir, --routing-parity, --skills-dir, --prompt-file, and --out require --paired',
    )
  }

  return out
}
