import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const projectPlugin = join(repoRoot, 'src', 'plugin-v2')
const confirmPhrase = 'RUN PICKLEBALL JEV'

function usage() {
  process.stdout.write(
    `${[
      'Explicit live Jev probe (never used by the offline or host-runtime tests):',
      '  node dev/tests/live-jev.mjs --live-jev',
      'Requires PICKLEBALL_LIVE_HOME (private prepared OpenCode/decision-router home)',
      'and PICKLEBALL_LIVE_MODEL (host model for the Zeus prompt).',
    ].join('\n')}\n`,
  )
}

if (process.argv.includes('--help')) {
  usage()
  process.exit(0)
}
if (!process.argv.includes('--live-jev')) {
  process.stderr.write('Refusing: use the separate explicit --live-jev command.\n')
  usage()
  process.exit(2)
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('Refusing live Jev: an interactive terminal confirmation is required.\n')
  process.exit(2)
}

const liveHome = process.env.PICKLEBALL_LIVE_HOME
const liveModel = process.env.PICKLEBALL_LIVE_MODEL
if (!liveHome || !liveModel || !existsSync(liveHome)) {
  process.stderr.write(
    'Refusing live Jev: set PICKLEBALL_LIVE_HOME to an existing private home and PICKLEBALL_LIVE_MODEL.\n',
  )
  process.exit(2)
}

const privateHome = realpathSync(liveHome)
const currentHome = process.env.HOME ? realpathSync(process.env.HOME) : ''
if (privateHome === currentHome) {
  process.stderr.write(
    'Refusing live Jev: PICKLEBALL_LIVE_HOME must not be the normal user HOME.\n',
  )
  process.exit(2)
}

const decisionConfig = join(privateHome, '.config', 'pantheon', 'decision-router.json')
if (!existsSync(decisionConfig)) {
  process.stderr.write(
    'Refusing live Jev: the private HOME must already contain decision-router.json; this harness will not enable consent or create caps.\n',
  )
  process.exit(2)
}
if (!existsSync(projectPlugin)) {
  process.stderr.write('Refusing live Jev: the unchanged production V2 plugin is unavailable.\n')
  process.exit(2)
}

process.stdout.write(
  `${[
    'LIVE PROVIDER / JEV DISCLOSURE',
    'This command may send the synthetic pickleball state below to the selected host model and,',
    'only if Pantheon permits it, to the native Jev provider. Provider charges are possible.',
    'The production decision-router consent, route, budget, and decision.egress permission gates',
    'remain active; this harness does not set consent, permissions, or budget caps.',
    'No browser, MCP server, local bridge, or live call is used by the ordinary test commands.',
    `To proceed, type exactly: ${confirmPhrase}`,
  ].join('\n')}\n`,
)

const terminal = createInterface({ input: process.stdin, output: process.stdout })
const confirmation = await terminal.question('Confirmation: ')
terminal.close()
if (confirmation !== confirmPhrase) {
  process.stdout.write('Live Jev probe cancelled.\n')
  process.exit(0)
}

const hostBin = process.env.PICKLEBALL_OPENCODE_BIN ?? 'opencode'
const safePath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'
const project = mkdtempSync(join(tmpdir(), 'pickleball-live-jev-'))
const config = {
  default_agent: 'zeus',
  plugins: [projectPlugin],
}
writeFileSync(join(project, 'opencode.json'), JSON.stringify(config, null, 2), { mode: 0o600 })

const prompt = [
  'Use the existing `pantheon_jev_decide` tool exactly once with this synthetic test input.',
  'Do not call any other tool, dispatch an agent, run a skill, or take an action.',
  'Return the tool result as advisory only.',
  JSON.stringify({
    state:
      'Pickleball practice: choose a serve target, rate rally readiness, and decide if a player is ready to rotate.',
    questions: [
      {
        type: 'choice',
        name: 'serve_target',
        instructions: 'Choose a safe target for a consistent practice serve.',
        choices: [
          { value: 'deep', description: 'Aim deep with recovery to ready position.' },
          { value: 'body', description: 'Aim at the body and recover to ready position.' },
        ],
      },
      {
        type: 'score',
        name: 'rally_readiness',
        instructions: 'Rate readiness to maintain a controlled rally.',
        levels: [{ label: 'developing' }, { label: 'ready' }, { label: 'advanced' }],
      },
      {
        type: 'predicate',
        name: 'ready_to_rotate',
        instructions: 'Is the player ready to rotate to the next practice station?',
      },
    ],
  }),
].join('\n')

const env = {
  PATH: safePath,
  HOME: privateHome,
  XDG_CONFIG_HOME: join(privateHome, '.config'),
  XDG_DATA_HOME: join(privateHome, '.local', 'share'),
  XDG_STATE_HOME: join(privateHome, '.local', 'state'),
  XDG_CACHE_HOME: join(privateHome, '.cache'),
  TMPDIR: tmpdir(),
}

let host
try {
  host = spawn(hostBin, ['run', '--standalone', '--agent', 'zeus', '--model', liveModel, prompt], {
    cwd: project,
    env,
    stdio: 'inherit',
  })
  const exitCode = await new Promise((resolveExit, reject) => {
    host.once('error', reject)
    host.once('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)))
  })
  process.exitCode = exitCode
} finally {
  if (host && host.exitCode === null && host.signalCode === null) {
    host.kill('SIGTERM')
    await new Promise((resolveExit) => host.once('exit', resolveExit))
  }
  rmSync(project, { recursive: true, force: true })
}
