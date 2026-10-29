import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLI = join(ROOT, 'bin', 'pantheon-init.mjs')

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function waitForFile(path, child, getOutput) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Expected gate file before child exit:\n${getOutput()}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for gate file:\n${getOutput()}`)
}

test('SIGINT after runtime writes records partial application at the project target', {
  timeout: 60_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-sigint-after-write-'))
  const home = join(root, 'home')
  const target = join(root, 'project')
  const fakeBin = join(root, 'bin')
  const gate = join(root, 'python-gate')
  const release = join(root, 'python-release')
  mkdirSync(home, { recursive: true })
  mkdirSync(target, { recursive: true })
  mkdirSync(fakeBin, { recursive: true })

  const fakePython = join(fakeBin, 'python3')
  writeFileSync(
    fakePython,
    `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'Python 3.12.3\\n'; exit 0; fi
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  : > ${shellQuote(gate)}
  while [ ! -e ${shellQuote(release)} ]; do sleep 0.02; done
  mkdir -p "$3/bin"
  cp "$0" "$3/bin/python3"
  chmod +x "$3/bin/python3"
  printf '#!/bin/sh\\nexit 0\\n' > "$3/bin/pip"
  chmod +x "$3/bin/pip"
  exit 0
fi
if [ "$1" = "-c" ]; then
  case "$2" in
    *FTS5=True*) printf 'SQLite 3.45.1 FTS5=True\\n' ;;
    *FastMCP*) printf 'mcp=2.2.0 fastmcp=4.1.2 fastmcp.server.app\\n' ;;
    *pantheon_home*) printf '/tmp/pantheon-test-home\\n' ;;
  esac
fi
exit 0
`,
    { mode: 0o700 },
  )

  const child = spawn(
    process.execPath,
    [CLI, 'init', '--yes', '--project', '--components', 'runtime', '--opencode-version', 'v1'],
    {
      cwd: target,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        OPENCODE_VERSION: 'v1',
        LANG: 'C',
        LC_ALL: 'C',
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  let childClosed = false
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      childClosed = true
      resolve({ code, signal })
    })
  })

  try {
    await waitForFile(gate, child, () => output)
    const runtimeScript = join(target, '.opencode', 'scripts', 'memory_mcp.py')
    assert.ok(existsSync(runtimeScript), 'runtime payload was written before the interrupt')
    const backupRoot = join(target, '.pantheon', 'backups')
    const backupNames = readdirSync(backupRoot)
    assert.ok(backupNames.length > 0, 'the recovery backup exists before the interrupt')

    process.kill(child.pid, 'SIGINT')
    await new Promise((resolve) => setTimeout(resolve, 100))
    writeFileSync(release, 'continue\n')
    const { code, signal } = await closed

    const record = JSON.parse(readFileSync(join(target, '.pantheon', 'last-run.json'), 'utf8'))
    assert.equal(code, 130, `SIGINT must exit 130:\n${output}`)
    assert.equal(signal, null, 'the handler should exit cleanly rather than by signal')
    assert.equal(record.status, 'partial')
    assert.equal(record.cancel_point, 'interrupt')
    assert.equal(record.applied, true)
    assert.match(output, /changes may be partially applied/i)
    assert.doesNotMatch(output, /nothing was applied|no configuration was changed/i)
    assert.ok(existsSync(runtimeScript), 'the already-written payload remains in place')
    assert.ok(
      backupNames.every((name) => existsSync(join(backupRoot, name, 'manifest.json'))),
      'the recovery backup remains available',
    )
  } finally {
    writeFileSync(release, 'continue\n')
    if (!childClosed && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await Promise.race([
        closed.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ])
    }
    rmSync(root, { recursive: true, force: true })
  }
})
