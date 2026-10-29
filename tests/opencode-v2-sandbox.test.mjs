import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { migrateV1toV2 } from '../scripts/install/config-migration.mjs'

const ROOT = process.cwd()
const RUNNER = join(ROOT, 'scripts', 'test-opencode-v2-sandbox.sh')
const containsAsciiControl = (value) =>
  [...value].some((character) => {
    const code = character.charCodeAt(0)
    return (code < 0x20 && code !== 0x0a) || code === 0x7f
  })

// Everything above the CLI dispatch is function definitions except the direct
// entrypoint preflight. For unit fixtures, replace only that bootstrap with a
// private adjacent-helper source so the real entrypoint can still be tested.
// The generated runner's expected repo value is shell-quoted by the real
// generator; this helper preserves the real generation path for adversarial
// fixture directories.
const RUNNER_SRC = readFileSync(RUNNER, 'utf8')
const CLI_MARKER = RUNNER_SRC.indexOf('# ── CLI ─')
const BOOTSTRAP_START = RUNNER_SRC.indexOf('# Keep this bootstrap self-contained')
const BOOTSTRAP_END = RUNNER_SRC.indexOf('\n# Derived from this script', BOOTSTRAP_START)
const DEFINITIONS =
  CLI_MARKER > 0 && BOOTSTRAP_START > 0 && BOOTSTRAP_END > BOOTSTRAP_START
    ? `${RUNNER_SRC.slice(0, BOOTSTRAP_START)}
SCRIPT_DIR="$(cd "$(dirname "$RUNNER_DEFS")" && pwd)"
SANDBOX_ENV_HELPER="$SCRIPT_DIR/sandbox-env.sh"
source "$SANDBOX_ENV_HELPER"
SANDBOX_ROOT="\${PANTHEON_SANDBOX_ROOT:-$HOME/pantheon-sandbox}"
pantheon_validate_sandbox_root "$SANDBOX_ROOT" || exit 2
${RUNNER_SRC.slice(BOOTSTRAP_END + 1, CLI_MARKER)}`
    : ''

/** Run the real write_run_test_sh for `repoDir`; returns the generated path. */
function generate(repoDir, sandboxRoot, defsFile) {
  writeFileSync(defsFile, DEFINITIONS)
  copyFileSync(join(ROOT, 'scripts', 'sandbox-env.sh'), join(dirname(defsFile), 'sandbox-env.sh'))
  const res = spawnSync(
    'bash',
    [
      '-c',
      'set -euo pipefail\nsource "$RUNNER_DEFS"\nREPO_DIR="$INPUT_REPO"\nSANDBOX_ROOT="$INPUT_SANDBOX"\nmkdir -p "$SANDBOX_ROOT"\nwrite_run_test_sh',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNNER_DEFS: defsFile,
        INPUT_REPO: repoDir,
        INPUT_SANDBOX: sandboxRoot,
      },
    },
  )
  assert.equal(
    res.status,
    0,
    `write_run_test_sh failed for ${JSON.stringify(repoDir)}:\n${res.stderr}`,
  )
  return join(sandboxRoot, 'run-test.sh')
}

/** Execute the generated script and return its stdout. */
function runGenerated(generated, stubBin) {
  // Fail the package installation immediately without invoking a real install.
  const res = spawnSync('bash', [generated], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${stubBin}:${process.env.PATH}` },
  })
  return res.stdout
}

function invokeSandboxRunner(sandboxRoot, workDir, args = ['--reset'], overrides = {}) {
  const scriptsDir = join(workDir, 'fixture-repo', 'scripts')
  const runner = join(scriptsDir, 'test-opencode-v2-sandbox.sh')
  mkdirSync(scriptsDir, { recursive: true })
  copyFileSync(RUNNER, runner)
  copyFileSync(join(ROOT, 'scripts', 'sandbox-env.sh'), join(scriptsDir, 'sandbox-env.sh'))
  return spawnSync('bash', [runner, ...args], {
    cwd: workDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PANTHEON_SANDBOX_ROOT: sandboxRoot,
      ...overrides,
    },
    timeout: 10000,
  })
}

test('runner script exists and is executable, with valid bash syntax', () => {
  assert.ok(existsSync(RUNNER), 'scripts/test-opencode-v2-sandbox.sh missing')
  assert.ok(statSync(RUNNER).mode & 0o111, 'runner script is not executable')
  const res = spawnSync('bash', ['-n', RUNNER], { encoding: 'utf8' })
  assert.equal(res.status, 0, `bash -n failed:\n${res.stderr}`)
})

test('sandbox global and project init opt into runtime without dropping default components', () => {
  const globalInitCommands =
    RUNNER_SRC.match(
      /^[ \t]*(?:pantheon-opencode|"\$pan") init --headless[^\\\n]*(?:\\\n[^\n]*)?/gm,
    ) ?? []
  assert.equal(globalInitCommands.length, 2, 'both sandbox global-init paths must be covered')
  for (const command of globalInitCommands) {
    assert.match(
      command,
      /--components(?:=|\s+)agents,skills,instructions,commands,plugins,runtime(?:\s|$)/,
      `sandbox global init must preserve default components and explicitly add runtime: ${command}`,
    )
  }

  const projectInitCommands =
    RUNNER_SRC.match(/^[ \t]*\(cd "\$dir" && "\$pan" init --project[^\n]*$/gm) ?? []
  assert.equal(projectInitCommands.length, 1, 'project initialization path must be covered')
  for (const command of projectInitCommands) {
    assert.match(
      command,
      /--components(?:=|\s+)agents,skills,instructions,commands,plugins,runtime(?:\s|\)|$)/,
      `sandbox project init must preserve default components and explicitly add runtime: ${command}`,
    )
  }
})

test('sandbox overrides inherited XDG paths including runtime and polls its private OpenCode log', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-v2-env-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const sandboxRoot = join(workDir, 'sandbox root')
  const outsideRoot = join(workDir, 'inherited-host-paths')
  const definitions = join(workDir, 'runner-definitions.sh')
  writeFileSync(definitions, DEFINITIONS)
  copyFileSync(join(ROOT, 'scripts', 'sandbox-env.sh'), join(workDir, 'sandbox-env.sh'))

  const script = `set -euo pipefail
source "$RUNNER_DEFS"
SANDBOX_ROOT="$SANDBOX_ROOT_INPUT"
SANDBOX_HOME="$SANDBOX_ROOT/home"
NPM_PREFIX="$SANDBOX_HOME/.npm-global"
V2_CONFIG="$SANDBOX_ROOT/private-config/project/opencode.json"
V2_DB="$SANDBOX_ROOT/private-db/data/opencode-v2.db"
V2_PORT=49376
V2_SERVER_LOG="$SANDBOX_ROOT/v2-server.log"
V2_SERVICE_STATE="$SANDBOX_HOME/.local/state/opencode/service.json"
V2_HANDSHAKE_TIMEOUT=1
sandbox_env
[[ "$HOME" == "$SANDBOX_HOME" ]]
[[ "$XDG_CONFIG_HOME" == "$SANDBOX_HOME/.config" ]]
[[ "$XDG_CONFIG_DIRS" == "$SANDBOX_HOME/.config/xdg" ]]
[[ "$XDG_DATA_HOME" == "$SANDBOX_HOME/.local/share" ]]
[[ "$XDG_DATA_DIRS" == "$SANDBOX_HOME/.local/share/xdg" ]]
[[ "$XDG_STATE_HOME" == "$SANDBOX_HOME/.local/state" ]]
[[ "$XDG_CACHE_HOME" == "$SANDBOX_HOME/.cache" ]]
[[ "$XDG_RUNTIME_DIR" == "$SANDBOX_ROOT/run" ]]
[[ "$(bash -c 'printf %s "$XDG_RUNTIME_DIR"')" == "$SANDBOX_ROOT/run" ]]
[[ "$(stat -c %a "$XDG_RUNTIME_DIR")" == "700" ]]
[[ "$PANTHEON_HOME" == "$SANDBOX_HOME/.config/opencode" ]]
[[ "$TMPDIR" == "$SANDBOX_ROOT/tmp" ]]
[[ "$TMP" == "$TMPDIR" && "$TEMP" == "$TMPDIR" ]]
[[ -d "$TMPDIR" && "$(stat -c %a "$TMPDIR")" == "700" ]]
[[ "$OPENCODE_CONFIG_DIR" == "$(dirname "$V2_CONFIG")" ]]
[[ "$OPENCODE_DB" == "$V2_DB" ]]
[[ -z "\${OPENCODE_CONFIG:-}" && -z "\${OPENCODE_DATA_DIR:-}" ]]
runtime_log="$LOG_PATH"
[[ "$runtime_log" == "$SANDBOX_HOME/.local/share/opencode/log/opencode.log" ]]
mkdir -p "$(dirname "$runtime_log")"
for server in pantheon-code-mode pantheon-memory pantheon-persistence pantheon-resources pantheon-vision; do
  printf 'message="mcp connected" server=%s\\n' "$server" >> "$runtime_log"
done
sleep 30 &
V2_SERVER_PID=$!
wait_for_v2_handshakes
`
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      RUNNER_DEFS: definitions,
      PANTHEON_SANDBOX_ROOT: sandboxRoot,
      SANDBOX_ROOT_INPUT: sandboxRoot,
      XDG_CONFIG_HOME: join(outsideRoot, 'config'),
      XDG_CONFIG_DIRS: join(outsideRoot, 'config-dirs'),
      XDG_DATA_HOME: join(outsideRoot, 'data'),
      XDG_DATA_DIRS: join(outsideRoot, 'data-dirs'),
      XDG_STATE_HOME: join(outsideRoot, 'state'),
      XDG_CACHE_HOME: join(outsideRoot, 'cache'),
      XDG_RUNTIME_DIR: join(outsideRoot, 'runtime'),
      PANTHEON_HOME: join(outsideRoot, 'pantheon'),
      TMPDIR: join(outsideRoot, 'tmp'),
      TMP: join(outsideRoot, 'legacy-tmp'),
      TEMP: join(outsideRoot, 'legacy-temp'),
      OPENCODE_CONFIG: join(outsideRoot, 'opencode.json'),
      OPENCODE_DATA_DIR: join(outsideRoot, 'opencode-data'),
    },
  })

  assert.equal(result.status, 0, `sandbox handshake polling failed:\n${result.stderr}`)
  assert.ok(
    existsSync(join(sandboxRoot, 'home', '.local', 'share', 'opencode', 'log', 'opencode.log')),
    'the runtime log must be written under the private XDG data home',
  )
  assert.equal(statSync(join(sandboxRoot, 'run')).mode & 0o777, 0o700)
  assert.equal(existsSync(outsideRoot), false, 'inherited host paths must not be read or written')
})

test('filesystem root spellings are rejected before mkdir or chmod', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-v2-filesystem-root-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const definitions = join(workDir, 'runner-definitions.sh')
  const helper = join(workDir, 'sandbox-env.sh')
  const npmPrefix = join(workDir, 'npm-prefix')
  const venv = join(workDir, 'venv')
  const calls = join(workDir, 'mkdir-chmod-calls')
  mkdirSync(join(npmPrefix, 'bin'), { recursive: true })
  mkdirSync(join(venv, 'bin'), { recursive: true })
  writeFileSync(definitions, DEFINITIONS)
  copyFileSync(join(ROOT, 'scripts', 'sandbox-env.sh'), helper)
  for (const command of ['mkdir', 'chmod']) {
    writeFileSync(
      join(npmPrefix, 'bin', command),
      `#!/bin/sh\nprintf '%s %s\\n' '${command}' "$*" >> "$SANDBOX_CALLS"\n`,
      { mode: 0o755 },
    )
  }

  for (const root of ['/', '//', '/./']) {
    const result = spawnSync(
      'bash',
      [
        '-c',
        'source "$HELPER"; pantheon_sandbox_env "$ROOT" "$HOME_DIR" "$NPM_PREFIX" "$VENV" "$CONFIG_DIR"',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HELPER: helper,
          ROOT: root,
          HOME_DIR: join(workDir, 'private-home'),
          NPM_PREFIX: npmPrefix,
          VENV: venv,
          CONFIG_DIR: join(workDir, 'private-config'),
          SANDBOX_CALLS: calls,
        },
      },
    )
    assert.notEqual(result.status, 0, `${JSON.stringify(root)} must be rejected`)
    assert.match(result.stderr, /sandbox path validation failed/)
    assert.equal(
      existsSync(calls),
      false,
      `${JSON.stringify(root)} must call neither mkdir nor chmod`,
    )
  }
})

test('direct CI prepare-and-run keeps the launched V2 process and MCP log on the sandbox XDG paths', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-v2-direct-ci-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const sandboxRoot = join(workDir, 'sandbox')
  const sandboxHome = join(sandboxRoot, 'home')
  const sandboxBin = join(sandboxHome, '.npm-global', 'bin')
  const externalRoot = join(workDir, 'external-xdg')
  const tarball = join(workDir, 'fixture.tgz')
  mkdirSync(sandboxBin, { recursive: true })
  writeFileSync(tarball, 'fake package artifact')

  const writeExecutable = (name, source) => {
    const path = join(sandboxBin, name)
    writeFileSync(path, source)
    chmodSync(path, 0o755)
  }

  writeExecutable('npm', '#!/bin/sh\nexit 0\n')
  writeExecutable('node', '#!/bin/sh\nexit 0\n')
  writeExecutable(
    'curl',
    `#!/bin/sh
for arg do
  case "$arg" in http://*) url="$arg" ;; esac
done
case "$url" in
  *'/global/health') test -f "$PANTHEON_SANDBOX_ROOT/home/server.started" ;;
  *) exit 7 ;;
esac
`,
  )
  writeExecutable(
    'pantheon-opencode',
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == doctor ]]; then exit 0; fi
if [[ "$1" != init ]]; then exit 2; fi
if [[ "\${2:-}" == --headless ]]; then exit 0; fi
mkdir -p .opencode/scripts .venv/bin
config_path="\${PANTHEON_V2_CONFIG:-$PWD/opencode.json}"
mkdir -p "$(dirname "$config_path")"
printf '%s\n' '{"mcp":{"servers":{}}}' > "$config_path"
for script in code_mode.py memory_mcp.py mcp_persistence.py mcp_resources.py pantheon_vision.py; do
  : > ".opencode/scripts/$script"
done
printf '%s\n' '#!/bin/sh' 'exit 0' > .venv/bin/python3
chmod +x .venv/bin/python3
`,
  )
  writeExecutable(
    'opencode2',
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == mcp && "\${2:-}" == list ]]; then
  printf '%s\n' \
    'pantheon-code-mode connected' \
    'pantheon-memory connected' \
    'pantheon-persistence connected' \
    'pantheon-resources connected' \
    'pantheon-vision connected'
  exit 0
fi
if [[ "\${1:-}" != serve ]]; then exit 2; fi
root="$PANTHEON_SANDBOX_ROOT"
[[ "$HOME" == "$root/home" ]] || exit 21
[[ "$XDG_CONFIG_HOME" == "$HOME/.config" ]] || exit 22
[[ "$XDG_DATA_HOME" == "$HOME/.local/share" ]] || exit 23
[[ "$XDG_STATE_HOME" == "$HOME/.local/state" ]] || exit 24
[[ "$XDG_RUNTIME_DIR" == "$root/run" ]] || exit 25
[[ "$PANTHEON_HOME" == "$HOME/.config/opencode" ]] || exit 26
[[ "$TMPDIR" == "$root/tmp" && "$TMP" == "$TMPDIR" && "$TEMP" == "$TMPDIR" ]] || exit 27
[[ "$OPENCODE_CONFIG_DIR" == "$root/project-v2/private-config" ]] || exit 28
[[ "$OPENCODE_DB" == "$root/private-db/opencode.db" ]] || exit 29
[[ "$PORT" == "$PANTHEON_V2_PORT" ]] || exit 30
[[ -z "\${OPENCODE_CONFIG:-}" && -z "\${OPENCODE_DATA_DIR:-}" ]] || exit 31
[[ "$(stat -c %a "$XDG_RUNTIME_DIR")" == 700 ]] || exit 32
runtime_log="$XDG_DATA_HOME/opencode/log/opencode.log"
runtime_dir="$root/project-v2/.opencode"
python_bin="$root/project-v2/.venv/bin/python3"
mkdir -p "$(dirname "$runtime_log")" "$XDG_STATE_HOME/opencode"
printf 'HOME=%s\nXDG_CONFIG_HOME=%s\nXDG_CONFIG_DIRS=%s\nXDG_DATA_HOME=%s\nXDG_DATA_DIRS=%s\nXDG_STATE_HOME=%s\nXDG_CACHE_HOME=%s\nXDG_RUNTIME_DIR=%s\nPANTHEON_HOME=%s\nTMPDIR=%s\nTMP=%s\nTEMP=%s\nOPENCODE_CONFIG_DIR=%s\nOPENCODE_DB=%s\nPORT=%s\nLOG_PATH=%s\n' \\
  "$HOME" "$XDG_CONFIG_HOME" "$XDG_CONFIG_DIRS" "$XDG_DATA_HOME" "$XDG_DATA_DIRS" \\
  "$XDG_STATE_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR" "$PANTHEON_HOME" \\
  "$TMPDIR" "$TMP" "$TEMP" "$OPENCODE_CONFIG_DIR" "$OPENCODE_DB" "$PORT" "$runtime_log" \\
  > "$root/server-env.txt"
for item in \\
  'pantheon-code-mode|code_mode.py' \\
  'pantheon-memory|memory_mcp.py' \\
  'pantheon-persistence|mcp_persistence.py' \\
  'pantheon-resources|mcp_resources.py' \\
  'pantheon-vision|pantheon_vision.py'; do
  name="\${item%%|*}"
  script="\${item#*|}"
  printf 'spawning process { command: "%s", args: ["scripts/%s"], cwd: "%s" }\n' \\
    "$python_bin" "$script" "$runtime_dir"
  printf 'message="mcp connected" server=%s\n' "$name" >> "$runtime_log"
done
port="$PANTHEON_V2_PORT"
printf '{"url":"http://127.0.0.1:%s","pid":%s,"id":"fixture","version":"v2","password":"fixture"}\n' \\
  "$port" "$$" > "$XDG_STATE_HOME/opencode/service.json"
touch "$root/home/server.started"
exec sleep 60
`,
  )

  for (const [name, override] of [
    ['config', { PANTHEON_V2_CONFIG: join(externalRoot, 'config-secret', 'opencode.json') }],
    ['database', { PANTHEON_V2_DB: join(externalRoot, 'database-secret', 'opencode.db') }],
  ]) {
    const rejected = spawnSync('bash', [RUNNER, '--prepare', '--run', 'v2'], {
      cwd: workDir,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        PANTHEON_SANDBOX_ROOT: sandboxRoot,
        PANTHEON_SANDBOX_TARBALL: tarball,
        PANTHEON_V2_PORT: '49378',
        ...override,
      },
    })
    assert.notEqual(
      rejected.status,
      0,
      `${name} override must fail the real direct prepare/run entrypoint`,
    )
    assert.match(rejected.stderr, /sandbox config\/database path validation failed/)
    assert.doesNotMatch(
      `${rejected.stdout}\n${rejected.stderr}`,
      /config-secret|database-secret|opencode\.json|opencode\.db/,
    )
    assert.equal(
      existsSync(externalRoot),
      false,
      `${name} rejection must not create external paths`,
    )
  }

  const result = spawnSync('bash', [RUNNER, '--prepare', '--run', 'v2'], {
    cwd: workDir,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PANTHEON_SANDBOX_ROOT: sandboxRoot,
      PANTHEON_SANDBOX_TARBALL: tarball,
      OPENCODE_V2_SPEC: 'fixture-opencode',
      PANTHEON_V2_PORT: '49378',
      PANTHEON_V2_CONFIG: join(sandboxRoot, 'project-v2', 'private-config', 'opencode.json'),
      PANTHEON_V2_DB: join(sandboxRoot, 'private-db', 'opencode.db'),
      PANTHEON_V2_HANDSHAKE_TIMEOUT: '3',
      PANTHEON_V2_MCP_LIST_TIMEOUT: '3',
      XDG_CONFIG_HOME: join(externalRoot, 'config'),
      XDG_CONFIG_DIRS: join(externalRoot, 'config-dirs'),
      XDG_DATA_HOME: join(externalRoot, 'divergent-data-home'),
      XDG_DATA_DIRS: join(externalRoot, 'data-dirs'),
      XDG_STATE_HOME: join(externalRoot, 'state'),
      XDG_CACHE_HOME: join(externalRoot, 'cache'),
      XDG_RUNTIME_DIR: join(externalRoot, 'runtime'),
      PANTHEON_HOME: join(externalRoot, 'pantheon'),
      TMPDIR: join(externalRoot, 'tmpdir'),
      TMP: join(externalRoot, 'tmp'),
      TEMP: join(externalRoot, 'temp'),
      OPENCODE_CONFIG: join(externalRoot, 'opencode.json'),
      OPENCODE_DATA_DIR: join(externalRoot, 'opencode-data'),
      OPENCODE_DB: join(externalRoot, 'ignored-db', 'opencode.db'),
    },
  })

  assert.equal(
    result.status,
    0,
    `direct CI sandbox validation failed:\n${result.stderr}\n${result.stdout}`,
  )
  assert.match(result.stdout, /mcp-list → PASS/)
  assert.match(result.stdout, /doctor → PASS/)
  assert.match(result.stdout, /Base validation v2: PASS\./)
  assert.deepEqual(
    readFileSync(join(sandboxRoot, 'server-env.txt'), 'utf8').trim().split('\n'),
    [
      `HOME=${sandboxHome}`,
      `XDG_CONFIG_HOME=${join(sandboxHome, '.config')}`,
      `XDG_CONFIG_DIRS=${join(sandboxHome, '.config', 'xdg')}`,
      `XDG_DATA_HOME=${join(sandboxHome, '.local', 'share')}`,
      `XDG_DATA_DIRS=${join(sandboxHome, '.local', 'share', 'xdg')}`,
      `XDG_STATE_HOME=${join(sandboxHome, '.local', 'state')}`,
      `XDG_CACHE_HOME=${join(sandboxHome, '.cache')}`,
      `XDG_RUNTIME_DIR=${join(sandboxRoot, 'run')}`,
      `PANTHEON_HOME=${join(sandboxHome, '.config', 'opencode')}`,
      `TMPDIR=${join(sandboxRoot, 'tmp')}`,
      `TMP=${join(sandboxRoot, 'tmp')}`,
      `TEMP=${join(sandboxRoot, 'tmp')}`,
      `OPENCODE_CONFIG_DIR=${join(sandboxRoot, 'project-v2', 'private-config')}`,
      `OPENCODE_DB=${join(sandboxRoot, 'private-db', 'opencode.db')}`,
      'PORT=49378',
      `LOG_PATH=${join(sandboxHome, '.local', 'share', 'opencode', 'log', 'opencode.log')}`,
    ],
    'the actual launched service must receive only the canonical sandbox environment and log path',
  )
  const runtimeLog = join(sandboxHome, '.local', 'share', 'opencode', 'log', 'opencode.log')
  assert.equal(
    readFileSync(runtimeLog, 'utf8').match(/message="mcp connected" server=/g)?.length,
    5,
    'all five expected MCP handshakes must be written where the direct harness polls',
  )
  assert.equal(statSync(join(sandboxRoot, 'run')).mode & 0o777, 0o700)
  assert.equal(statSync(join(sandboxRoot, 'tmp')).mode & 0o777, 0o700)
  assert.equal(
    existsSync(externalRoot),
    false,
    'no inherited external XDG/config/temp path may be created',
  )
})

test('config and database overrides outside the sandbox fail before any external write', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-v2-path-confinement-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const sandboxRoot = join(workDir, 'sandbox')
  const externalRoot = join(workDir, 'private external target')

  for (const [name, override] of [
    ['config', { PANTHEON_V2_CONFIG: join(externalRoot, 'config', 'opencode.json') }],
    ['config equal to root', { PANTHEON_V2_CONFIG: sandboxRoot }],
    ['config parent equal to root', { PANTHEON_V2_CONFIG: join(sandboxRoot, 'opencode.json') }],
    ['database', { PANTHEON_V2_DB: join(externalRoot, 'db', 'opencode.db') }],
    [
      'traversal',
      { PANTHEON_V2_DB: join(sandboxRoot, '..', 'private external target', 'db.sqlite') },
    ],
  ]) {
    const result = invokeSandboxRunner(sandboxRoot, workDir, ['--cost'], override)
    assert.notEqual(result.status, 0, `${name} override must be rejected`)
    assert.match(result.stderr, /sandbox config\/database path validation failed/)
    assert.doesNotMatch(
      `${result.stdout}\n${result.stderr}`,
      /private external target|opencode\.json|opencode\.db/,
    )
    assert.equal(
      existsSync(externalRoot),
      false,
      `${name} rejection must not create the external path`,
    )
    assert.equal(
      existsSync(sandboxRoot),
      false,
      `${name} rejection must happen before sandbox setup`,
    )
  }
})

test('config override rejects an in-root symlink that escapes to an external target', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-v2-config-symlink-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const sandboxRoot = join(workDir, 'sandbox')
  const externalRoot = join(workDir, 'external target')
  const project = join(sandboxRoot, 'project-v2')
  const marker = join(externalRoot, 'preserve.txt')
  mkdirSync(project, { recursive: true })
  mkdirSync(externalRoot)
  writeFileSync(marker, 'unchanged')
  symlinkSync(externalRoot, join(project, 'linked-config'))

  const result = invokeSandboxRunner(sandboxRoot, workDir, ['--cost'], {
    PANTHEON_V2_CONFIG: join(project, 'linked-config', 'opencode.json'),
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /sandbox config\/database path validation failed/)
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /external target|linked-config/)
  assert.equal(readFileSync(marker, 'utf8'), 'unchanged')
  assert.equal(existsSync(join(externalRoot, 'opencode.json')), false)
  assert.equal(existsSync(join(sandboxRoot, 'home')), false)
})

test('generated runner and launcher reject external config/database overrides before setup', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-v2-generated-paths-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const sandboxRoot = join(workDir, 'generated sandbox')
  const externalRoot = join(workDir, 'external target')
  const defsFile = join(workDir, 'runner-definitions.sh')
  const generated = generate(join(workDir, 'fixture-repo'), sandboxRoot, defsFile)
  const launcher = join(sandboxRoot, 'start-pantheon.sh')

  for (const [script, key, leaf] of [
    [generated, 'PANTHEON_V2_CONFIG', 'config/opencode.json'],
    [generated, 'PANTHEON_V2_DB', 'db/opencode.db'],
    [launcher, 'PANTHEON_V2_CONFIG', 'launcher-config/opencode.json'],
    [launcher, 'PANTHEON_V2_DB', 'launcher-db/opencode.db'],
  ]) {
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, [key]: join(externalRoot, leaf) },
    })
    assert.notEqual(result.status, 0, `${key} must be rejected by ${script}`)
    assert.match(result.stderr, /sandbox config\/database path validation failed/)
    assert.doesNotMatch(
      `${result.stdout}\n${result.stderr}`,
      /external target|opencode\.json|opencode\.db/,
    )
    assert.equal(
      existsSync(externalRoot),
      false,
      `${key} rejection must not create the external path`,
    )
  }

  const repoReadSentinel = 'THEMIS_REPO_READ_SENTINEL_3f29b'
  writeFileSync(join(sandboxRoot, '.repo-dir'), repoReadSentinel)
  for (const configPath of [sandboxRoot, join(sandboxRoot, 'opencode.json')]) {
    const result = spawnSync('bash', [generated], {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, PANTHEON_V2_CONFIG: configPath },
    })
    assert.notEqual(result.status, 0, 'config root and root-parent overrides must fail closed')
    assert.match(result.stderr, /sandbox config\/database path validation failed/)
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(repoReadSentinel))
    assert.equal(existsSync(join(sandboxRoot, 'home')), false)
  }
})

test('direct and generated path failures redact absolute paths and reject ASCII controls', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-v2-path-redaction-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const sentinel = 'THEMIS_PATH_SENTINEL_4ab29'
  const directRoot = join(workDir, 'direct-sandbox')
  const generatedRoot = join(workDir, 'generated-sandbox')
  const externalPath = join(workDir, `${sentinel}-external`, 'opencode.json')
  const generated = generate(join(workDir, 'fixture-repo'), generatedRoot, join(workDir, 'defs.sh'))
  const launcher = join(generatedRoot, 'start-pantheon.sh')

  const cases = [
    {
      label: 'direct external config',
      result: invokeSandboxRunner(directRoot, workDir, ['--cost'], {
        PANTHEON_V2_CONFIG: externalPath,
      }),
      finding: /sandbox config\/database path validation failed/,
    },
    {
      label: 'direct control in sandbox root',
      result: invokeSandboxRunner(directRoot, workDir, ['--cost'], {
        PANTHEON_SANDBOX_ROOT: `${directRoot}\u0001${sentinel}`,
      }),
      finding: /sandbox preflight validation failed/,
    },
    {
      label: 'generated external config',
      result: spawnSync('bash', [generated], {
        encoding: 'utf8',
        env: { ...process.env, PANTHEON_V2_CONFIG: externalPath },
      }),
      finding: /sandbox config\/database path validation failed/,
    },
    {
      label: 'generated control in database path',
      result: spawnSync('bash', [launcher], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PANTHEON_V2_DB: join(generatedRoot, `private\u007f${sentinel}.db`),
        },
      }),
      finding: /sandbox config\/database path validation failed/,
    },
  ]

  for (const { label, result, finding } of cases) {
    const output = `${result.stdout}\n${result.stderr}`
    const report = JSON.stringify({
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
    })
    assert.notEqual(result.status, 0, `${label} must fail closed`)
    assert.match(result.stderr, finding, `${label} should retain a generic finding`)
    assert.doesNotMatch(output, new RegExp(sentinel), `${label} leaked the sentinel`)
    assert.doesNotMatch(report, new RegExp(sentinel), `${label} leaked the sentinel in JSON`)
    assert.equal(containsAsciiControl(output), false, `${label} echoed a control character`)
    assert.equal(containsAsciiControl(report), false, `${label} echoed a control character in JSON`)
  }
  assert.equal(existsSync(join(workDir, `${sentinel}-external`)), false)
  assert.equal(existsSync(join(directRoot, 'home')), false)
})

test('generated launchers reject symlinked entrypoints and helpers before sourcing them', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-v2-launcher-symlinks-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const sandboxRoot = join(workDir, 'sandbox')
  const generated = generate(join(workDir, 'fixture-repo'), sandboxRoot, join(workDir, 'defs.sh'))
  const launcher = join(sandboxRoot, 'start-pantheon.sh')
  const aliasRoot = join(workDir, 'alias-root')
  const marker = join(workDir, 'external-helper-was-sourced')
  const sentinelHelper = join(workDir, 'sentinel-helper.sh')
  mkdirSync(aliasRoot)
  writeFileSync(
    sentinelHelper,
    '#!/usr/bin/env bash\nprintf \'sourced\\n\' >> "$SENTINEL_MARKER"\necho EXTERNAL_HELPER_SENTINEL\n',
  )
  writeFileSync(join(aliasRoot, 'sandbox-env.sh'), readFileSync(sentinelHelper, 'utf8'))

  for (const target of [generated, launcher]) {
    const alias = join(aliasRoot, target.split('/').at(-1))
    symlinkSync(target, alias)
    const result = spawnSync('bash', [alias], {
      encoding: 'utf8',
      env: { ...process.env, SENTINEL_MARKER: marker },
    })
    assert.notEqual(result.status, 0, 'a symlinked launcher entrypoint must be rejected')
    assert.match(result.stderr, /sandbox launcher preflight validation failed/)
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /EXTERNAL_HELPER_SENTINEL/)
    assert.equal(existsSync(marker), false, 'the adjacent sentinel helper must not be sourced')
  }

  const helper = join(sandboxRoot, 'sandbox-env.sh')
  rmSync(helper)
  symlinkSync(sentinelHelper, helper)
  const helperResult = spawnSync('bash', [launcher], {
    encoding: 'utf8',
    env: { ...process.env, SENTINEL_MARKER: marker },
  })
  assert.notEqual(helperResult.status, 0, 'a symlinked helper must be rejected')
  assert.match(helperResult.stderr, /sandbox launcher preflight validation failed/)
  assert.doesNotMatch(`${helperResult.stdout}\n${helperResult.stderr}`, /EXTERNAL_HELPER_SENTINEL/)
  assert.equal(existsSync(marker), false, 'the external helper must not be sourced')
})

test('direct runner preflight rejects symlinked roots and helpers before sourcing', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-v2-direct-preflight-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const scriptsDir = join(workDir, 'fixture-repo', 'scripts')
  const runner = join(scriptsDir, 'test-opencode-v2-sandbox.sh')
  const helper = join(scriptsDir, 'sandbox-env.sh')
  const externalHelper = join(workDir, 'external-helper.sh')
  const marker = join(workDir, 'preflight-side-effect')
  mkdirSync(scriptsDir, { recursive: true })
  copyFileSync(RUNNER, runner)
  writeFileSync(
    externalHelper,
    '#!/usr/bin/env bash\nprintf sourced > "$SENTINEL_MARKER"\necho EXTERNAL_HELPER_SENTINEL\n',
  )

  symlinkSync(externalHelper, helper)
  const helperResult = spawnSync('bash', [runner, '--help'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PANTHEON_SANDBOX_ROOT: join(workDir, 'safe-sandbox'),
      SENTINEL_MARKER: marker,
    },
  })
  assert.notEqual(helperResult.status, 0)
  assert.match(helperResult.stderr, /sandbox preflight validation failed/)
  assert.doesNotMatch(`${helperResult.stdout}\n${helperResult.stderr}`, /EXTERNAL_HELPER_SENTINEL/)
  assert.equal(existsSync(marker), false, 'a symlinked helper must not be sourced')

  rmSync(helper)
  writeFileSync(helper, readFileSync(externalHelper, 'utf8'))
  const outsideRoot = join(workDir, 'outside-root')
  const sandboxLink = join(workDir, 'sandbox-link')
  mkdirSync(outsideRoot)
  symlinkSync(outsideRoot, sandboxLink)
  const rootResult = spawnSync('bash', [runner, '--help'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PANTHEON_SANDBOX_ROOT: sandboxLink,
      SENTINEL_MARKER: marker,
    },
  })
  assert.notEqual(rootResult.status, 0)
  assert.match(rootResult.stderr, /sandbox preflight validation failed/)
  assert.doesNotMatch(`${rootResult.stdout}\n${rootResult.stderr}`, /EXTERNAL_HELPER_SENTINEL/)
  assert.equal(existsSync(marker), false, 'invalid root must be rejected before sourcing')
  assert.equal(existsSync(join(outsideRoot, 'home')), false, 'invalid root must not be initialized')
})

test('service diagnostics omit registration secrets from streams and serialized reports', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-v2-diagnostic-redaction-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const definitions = join(workDir, 'runner-definitions.sh')
  writeFileSync(definitions, DEFINITIONS)
  copyFileSync(join(ROOT, 'scripts', 'sandbox-env.sh'), join(workDir, 'sandbox-env.sh'))
  const serviceState = join(workDir, 'service.json')
  const serviceLog = join(workDir, 'service.log')
  const runtimeLog = join(workDir, 'runtime.log')
  const registrationSentinel = 'THEMIS_REGISTRATION_SENTINEL_7d91a'
  const serviceLogSentinel = 'THEMIS_SERVICE_LOG_SENTINEL_27a3f'
  const runtimeLogSentinel = 'THEMIS_RUNTIME_LOG_SENTINEL_518cb'
  writeFileSync(
    serviceState,
    JSON.stringify({
      url: 'http://127.0.0.1:49376',
      pid: 1,
      password: registrationSentinel,
    }),
  )
  writeFileSync(serviceLog, `${serviceLogSentinel}\n\u001b[31mcontrol sentinel\u001b[0m\n`)
  writeFileSync(runtimeLog, `${runtimeLogSentinel}\n\u001b[2Jcontrol sentinel\n`)

  const result = spawnSync(
    'bash',
    [
      '-c',
      'source "$RUNNER_DEFS"; V2_SERVICE_STATE="$SERVICE_STATE"; V2_SERVER_LOG="$SERVICE_LOG"; LOG_PATH="$RUNTIME_LOG"; print_v2_diagnostics',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNNER_DEFS: definitions,
        PANTHEON_SANDBOX_ROOT: join(workDir, 'sandbox'),
        SERVICE_STATE: serviceState,
        SERVICE_LOG: serviceLog,
        RUNTIME_LOG: runtimeLog,
      },
    },
  )
  const report = JSON.stringify({
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  })
  assert.equal(result.status, 0, result.stderr)
  for (const sentinel of [registrationSentinel, serviceLogSentinel, runtimeLogSentinel, '\u001b']) {
    assert.doesNotMatch(result.stdout, new RegExp(sentinel))
    assert.doesNotMatch(result.stderr, new RegExp(sentinel))
    assert.doesNotMatch(report, new RegExp(sentinel))
  }
  assert.match(result.stderr, /service log exists \(contents omitted\)/)
  assert.match(result.stderr, /runtime log exists \(contents omitted\)/)

  const generated = generate(
    join(workDir, 'fixture-repo'),
    join(workDir, 'generated'),
    join(workDir, 'defs-generated.sh'),
  )
  const generatedSource = readFileSync(generated, 'utf8')
  assert.doesNotMatch(generatedSource, /cat "\$V2_SERVICE_STATE"/)
  assert.match(generatedSource, /service registration exists \(contents omitted\)/)
  const diagnosticStart = generatedSource.indexOf('print_v2_diagnostics() {')
  const diagnosticEnd = generatedSource.indexOf(
    '\n}\n\nwait_for_v2_service_registration',
    diagnosticStart,
  )
  assert.ok(diagnosticStart >= 0 && diagnosticEnd > diagnosticStart)
  const generatedDiagnostic = generatedSource.slice(diagnosticStart, diagnosticEnd + 2)
  const generatedResult = spawnSync(
    'bash',
    ['-c', 'source "$HELPER"; eval "$DIAGNOSTIC_FUNCTION"; print_v2_diagnostics'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HELPER: join(workDir, 'sandbox-env.sh'),
        DIAGNOSTIC_FUNCTION: generatedDiagnostic,
        V2_SERVICE_STATE: serviceState,
        V2_SERVER_LOG: serviceLog,
        LOG_PATH: runtimeLog,
      },
    },
  )
  const generatedReport = JSON.stringify({
    stdout: generatedResult.stdout,
    stderr: generatedResult.stderr,
    status: generatedResult.status,
  })
  assert.equal(generatedResult.status, 0, generatedResult.stderr)
  for (const sentinel of [serviceLogSentinel, runtimeLogSentinel, '\u001b']) {
    assert.doesNotMatch(
      `${generatedResult.stdout}\n${generatedResult.stderr}`,
      new RegExp(sentinel),
    )
    assert.doesNotMatch(generatedReport, new RegExp(sentinel))
  }
  assert.match(generatedResult.stderr, /service log exists \(contents omitted\)/)
  assert.match(generatedResult.stderr, /runtime log exists \(contents omitted\)/)
})

test('direct and generated registration timeouts redact URL and PID and clean up', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-v2-registration-timeout-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))

  const generated = generate(
    join(workDir, 'fixture-repo'),
    join(workDir, 'generated-sandbox'),
    join(workDir, 'runner-definitions.sh'),
  )
  const generatedSource = readFileSync(generated, 'utf8')
  const urlSentinel = 'http://THEMIS_REGISTRATION_URL_SENTINEL_61fc.invalid:49376'
  const urlHostSentinel = urlSentinel.slice('http://'.length, -':49376'.length)
  const pidSentinel = '94726183'
  const genericFailure = 'ERROR: timed out waiting for V2 service registration.'

  const extractFunction = (source, name) => {
    const start = source.indexOf(`${name}() {`)
    const end = source.indexOf('\n}\n', start)
    assert.ok(start >= 0 && end > start, `${name} function not found`)
    return source.slice(start, end + 2)
  }

  for (const [kind, source] of [
    ['direct', RUNNER_SRC],
    ['generated', generatedSource],
  ]) {
    const functionFile = join(workDir, `${kind}-registration-timeout.sh`)
    const statePath = join(workDir, `${kind}-service.json`)
    const cleanupPath = join(workDir, `${kind}-cleanup.log`)
    writeFileSync(
      statePath,
      JSON.stringify({
        url: 'http://stale-registration.invalid:49376',
        pid: 1,
        id: 'fixture',
        version: 'v2',
        password: 'fixture',
      }),
    )
    writeFileSync(
      functionFile,
      [
        extractFunction(source, 'stop_v2_service'),
        extractFunction(source, 'print_v2_diagnostics'),
        extractFunction(source, 'wait_for_v2_service_registration'),
      ].join('\n'),
    )

    const harness = `set -euo pipefail
source "$FUNCTION_FILE"
V2_LOOPBACK_HOST="$URL_HOST_SENTINEL"
V2_PORT=49376
V2_HANDSHAKE_TIMEOUT=1
V2_SERVER_PID="$PID_SENTINEL"
V2_SERVICE_STATE="$SERVICE_STATE"
V2_SERVER_LOG="$SERVICE_LOG"
LOG_PATH="$RUNTIME_LOG"
PID_SENTINEL="$PID_SENTINEL"
kill() {
  if [[ "$1" == -0 && "$2" == "$PID_SENTINEL" ]]; then return 0; fi
  if [[ "$1" == "$PID_SENTINEL" ]]; then printf 'kill %s\\n' "$1" >> "$CLEANUP_LOG"; return 0; fi
  return 1
}
wait() { printf 'wait %s\\n' "$1" >> "$CLEANUP_LOG"; }
sleep() { :; }
pantheon_validate_sandbox_path() { return 0; }
trap stop_v2_service EXIT
set +e
wait_for_v2_service_registration
status=$?
set -e
[[ "$status" -eq 1 ]] || exit 92
exit 1
`
    const result = spawnSync('bash', ['-c', harness], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        FUNCTION_FILE: functionFile,
        URL_HOST_SENTINEL: urlHostSentinel,
        PID_SENTINEL: pidSentinel,
        SERVICE_STATE: statePath,
        SERVICE_LOG: join(workDir, `${kind}-service.log`),
        RUNTIME_LOG: join(workDir, `${kind}-runtime.log`),
        CLEANUP_LOG: cleanupPath,
      },
    })
    const jsonReport = JSON.stringify({
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
    })
    const streams = `${result.stdout}\n${result.stderr}`

    assert.equal(result.status, 1, `${kind} timeout must remain a failure:\n${streams}`)
    assert.match(result.stderr, new RegExp(genericFailure))
    for (const sentinel of [urlSentinel, pidSentinel]) {
      assert.equal(result.stdout.includes(sentinel), false)
      assert.equal(result.stderr.includes(sentinel), false)
      assert.equal(jsonReport.includes(sentinel), false)
    }
    assert.equal(existsSync(statePath), false, `${kind} exit trap must remove registration state`)
    assert.equal(
      readFileSync(cleanupPath, 'utf8'),
      `kill ${pidSentinel}\nwait ${pidSentinel}\n`,
      `${kind} exit trap must stop and reap the service process`,
    )
  }

  {
    const sandboxRoot = join(workDir, 'THEMIS_DISTINCT_SANDBOX_ROOT_SENTINEL')
    const repoRoot = join(workDir, 'THEMIS_DISTINCT_REPO_ROOT_SENTINEL')
    const fullGenerated = generate(
      repoRoot,
      sandboxRoot,
      join(workDir, 'full-runner-definitions.sh'),
    )
    const privateEnv = join(workDir, 'THEMIS_PRIVATE_ENV_SENTINEL')
    const configPath = join(sandboxRoot, 'THEMIS_CONFIG_PATH_SENTINEL', 'opencode.json')
    const dbPath = join(sandboxRoot, 'THEMIS_DATABASE_PATH_SENTINEL', 'opencode.db')
    const urlSentinel = 'http://THEMIS_FULL_RUN_URL_SENTINEL.invalid:49376'
    const pidSentinel = 'THEMIS_FULL_RUN_PID_SENTINEL_94726183'
    const serviceLogSentinel = 'THEMIS_SERVICE_LOG_CONTENT_SENTINEL'
    const runtimeLogSentinel = 'THEMIS_RUNTIME_LOG_CONTENT_SENTINEL'
    const toolBin = join(workDir, 'fixture-bin')
    const npmPrefix = join(sandboxRoot, 'home', '.npm-global')
    const v2Project = join(sandboxRoot, 'project-v2')
    const v2Runtime = join(v2Project, '.opencode')
    const v2Python = join(v2Project, '.venv', 'bin', 'python3')
    const serviceState = join(sandboxRoot, 'home', '.local', 'state', 'opencode', 'service.json')
    const servicePidFile = join(workDir, 'THEMIS_FAKE_SERVICE_PID_SENTINEL')
    const curlCountFile = join(workDir, 'THEMIS_CURL_COUNT_SENTINEL')

    mkdirSync(toolBin, { recursive: true })
    mkdirSync(join(repoRoot, 'scripts'), { recursive: true })
    mkdirSync(dirname(configPath), { recursive: true })
    mkdirSync(join(npmPrefix, 'bin'), { recursive: true })
    mkdirSync(join(v2Runtime, 'scripts'), { recursive: true })
    mkdirSync(dirname(v2Python), { recursive: true })
    writeFileSync(join(repoRoot, 'pantheon-opencode-fixture.tgz'), 'fixture')
    writeFileSync(configPath, '{}\n')
    writeFileSync(v2Python, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    for (const script of [
      'code_mode.py',
      'memory_mcp.py',
      'mcp_persistence.py',
      'mcp_resources.py',
      'pantheon_vision.py',
    ]) {
      writeFileSync(join(v2Runtime, 'scripts', script), '# fixture\n')
    }

    const stub = (name, contents) => {
      const path = join(toolBin, name)
      writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${contents}\n`)
      chmodSync(path, 0o755)
    }
    stub('npm', 'exit 0')
    stub('node', 'exit 0')
    stub('git', 'exit 1')
    stub(
      'curl',
      `count=0
if [[ -f "$CURL_COUNT_FILE" ]]; then read -r count < "$CURL_COUNT_FILE"; fi
count=$((count + 1))
printf '%s\\n' "$count" > "$CURL_COUNT_FILE"
if [[ "$count" -eq 1 ]]; then exit 7; fi
exit 0`,
    )
    stub('pantheon-opencode', `case "\${1:-}" in init|doctor) exit 0 ;; *) exit 0 ;; esac`)
    writeFileSync(
      join(npmPrefix, 'bin', 'opencode2'),
      `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  --version) printf '%s\\n' 'opencode2 fixture' ;;
  serve)
    printf '%s\\n' '${serviceLogSentinel}'
    mkdir -p "$HOME/.local/share/opencode/log"
    printf '%s\\n' '${runtimeLogSentinel}' >> "$HOME/.local/share/opencode/log/opencode.log"
    mkdir -p "$(dirname "$HOME/.local/state/opencode/service.json")"
    printf '{"url":"%s","pid":"%s","id":"fixture","version":"v2","password":"fixture"}\\n' \\
      '${urlSentinel}' '${pidSentinel}' > "$HOME/.local/state/opencode/service.json"
    printf '%s\\n' "$$" > "$SERVICE_PID_FILE"
    exec /bin/sleep 300
    ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    )

    const fullResult = spawnSync('bash', [fullGenerated], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        HOME: join(privateEnv, 'home'),
        XDG_CONFIG_HOME: join(privateEnv, 'config'),
        XDG_CONFIG_DIRS: join(privateEnv, 'config-dirs'),
        XDG_DATA_HOME: join(privateEnv, 'data'),
        XDG_DATA_DIRS: join(privateEnv, 'data-dirs'),
        XDG_STATE_HOME: join(privateEnv, 'state'),
        XDG_CACHE_HOME: join(privateEnv, 'cache'),
        XDG_RUNTIME_DIR: join(privateEnv, 'runtime'),
        TMPDIR: join(privateEnv, 'tmp'),
        TMP: join(privateEnv, 'legacy-tmp'),
        TEMP: join(privateEnv, 'legacy-temp'),
        PATH: `${toolBin}:${process.env.PATH}`,
        PANTHEON_V2_CONFIG: configPath,
        PANTHEON_V2_DB: dbPath,
        PANTHEON_V2_HOST: 'THEMIS_FULL_RUN_URL_SENTINEL.invalid',
        PANTHEON_V2_HANDSHAKE_TIMEOUT: '1',
        SERVICE_PID_FILE: servicePidFile,
        CURL_COUNT_FILE: curlCountFile,
      },
    })
    const fullReport = JSON.stringify({
      stdout: fullResult.stdout,
      stderr: fullResult.stderr,
      status: fullResult.status,
      signal: fullResult.signal,
    })
    const fullOutput = `${fullResult.stdout}\n${fullResult.stderr}`

    assert.equal(
      fullResult.status,
      1,
      `full generated runner must fail on registration timeout:\n${fullOutput}`,
    )
    assert.match(fullResult.stderr, /ERROR: timed out waiting for V2 service registration\./)
    assert.match(fullResult.stdout, /Final verdict: FAIL/)
    for (const sentinel of [
      workDir,
      sandboxRoot,
      'THEMIS_DISTINCT_SANDBOX_ROOT_SENTINEL',
      repoRoot,
      'THEMIS_DISTINCT_REPO_ROOT_SENTINEL',
      configPath,
      'THEMIS_CONFIG_PATH_SENTINEL',
      dbPath,
      'THEMIS_DATABASE_PATH_SENTINEL',
      privateEnv,
      urlSentinel,
      'THEMIS_FULL_RUN_URL_SENTINEL.invalid',
      pidSentinel,
      serviceLogSentinel,
      runtimeLogSentinel,
    ]) {
      assert.equal(fullResult.stdout.includes(sentinel), false, `stdout leaked ${sentinel}`)
      assert.equal(fullResult.stderr.includes(sentinel), false, `stderr leaked ${sentinel}`)
      assert.equal(fullReport.includes(sentinel), false, `JSON report leaked ${sentinel}`)
    }
    assert.doesNotMatch(fullOutput, /(?:url|pid)=/i)
    assert.equal(
      existsSync(serviceState),
      false,
      'the generated exit trap must remove service registration state',
    )
    const fakeServicePid = Number(readFileSync(servicePidFile, 'utf8').trim())
    assert.ok(Number.isSafeInteger(fakeServicePid) && fakeServicePid > 0)
    assert.throws(
      () => process.kill(fakeServicePid, 0),
      /ESRCH/,
      'the generated exit trap must stop its fake service',
    )
  }
})

test('sandbox rejects a symlinked root before creating or changing its target', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-v2-symlink-root-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const outsideRoot = join(workDir, 'outside target')
  const sandboxRoot = join(workDir, 'sandbox root')
  const marker = join(outsideRoot, 'preserve.txt')
  mkdirSync(outsideRoot)
  writeFileSync(marker, 'unchanged')
  symlinkSync(outsideRoot, sandboxRoot)

  const result = invokeSandboxRunner(sandboxRoot, workDir)

  assert.notEqual(result.status, 0, 'a symlinked sandbox root must fail closed')
  assert.match(result.stderr, /sandbox preflight validation failed/)
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /sandbox root|outside target/)
  assert.equal(readFileSync(marker, 'utf8'), 'unchanged')
  assert.equal(existsSync(join(outsideRoot, 'home')), false)
  assert.equal(existsSync(join(outsideRoot, 'tmp')), false)
})

test('sandbox rejects a symlinked root ancestor before creating or changing its target', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-v2-symlink-ancestor-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const outsideRoot = join(workDir, 'outside target')
  const symlinkAncestor = join(workDir, 'sandbox-parent')
  const sandboxRoot = join(symlinkAncestor, 'sandbox root')
  const targetRoot = join(outsideRoot, 'sandbox root')
  const marker = join(targetRoot, 'preserve.txt')
  mkdirSync(targetRoot, { recursive: true })
  writeFileSync(marker, 'unchanged')
  symlinkSync(outsideRoot, symlinkAncestor)

  const result = invokeSandboxRunner(sandboxRoot, workDir)

  assert.notEqual(result.status, 0, 'a symlinked sandbox ancestor must fail closed')
  assert.match(result.stderr, /sandbox preflight validation failed/)
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /sandbox-parent|outside target/)
  assert.equal(readFileSync(marker, 'utf8'), 'unchanged')
  assert.equal(existsSync(targetRoot), true)
})

test('runner rejects a relative sandbox root before creating sandbox files', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-v2-relative-root-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const fixtureRepo = join(workDir, 'repo')
  const scriptsDir = join(fixtureRepo, 'scripts')
  const relativeRoot = 'relative-sandbox-root-secret'
  const runner = join(scriptsDir, 'test-opencode-v2-sandbox.sh')
  mkdirSync(scriptsDir, { recursive: true })
  copyFileSync(RUNNER, runner)
  copyFileSync(join(ROOT, 'scripts', 'sandbox-env.sh'), join(scriptsDir, 'sandbox-env.sh'))

  const result = spawnSync('bash', [runner, '--cost'], {
    cwd: workDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PANTHEON_SANDBOX_ROOT: relativeRoot,
    },
    timeout: 10000,
  })

  assert.notEqual(result.status, 0, 'a relative sandbox root must fail closed')
  assert.match(result.stderr, /sandbox preflight validation failed/)
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(relativeRoot))
  assert.equal(existsSync(join(workDir, relativeRoot)), false)
  assert.equal(existsSync(join(fixtureRepo, relativeRoot)), false)
  assert.equal(existsSync(join(fixtureRepo, relativeRoot, 'home', '.config')), false)
  assert.equal(existsSync(join(fixtureRepo, 'home')), false)
})

test('runner is V2-only: no V1 leg, no sibling-repo inference', () => {
  const src = readFileSync(RUNNER, 'utf8')
  // The V1 install spec and binary are gone. `@opencode/cli` is only an
  // install spec, never a dependency of this package.
  assert.doesNotMatch(
    src,
    /OPENCODE_V1_SPEC|opencode-ai@1\.18\.18/,
    'V1 install spec still present',
  )
  assert.doesNotMatch(src, /check_binary "V1/, 'generated script still probes a V1 binary')
  assert.doesNotMatch(src, /prepare_project v1/, 'still generates a project-v1')
  assert.match(
    src,
    /OPENCODE_V2_SPEC="\$\{OPENCODE_V2_SPEC:-@opencode\/cli@latest\}"/,
    'sandbox should default to the current stable OpenCode CLI package',
  )
  // `--run v1` must fail loudly rather than silently testing the wrong leg.
  assert.match(src, /the V1 leg was removed/, '--run v1 must be rejected explicitly')

  // REPO_DIR must come from the script's own location. Inferring it from a
  // sibling directory named "pantheon" resolved to a DIFFERENT checkout that
  // had unrelated uncommitted work, and --prepare packs a tarball inside it.
  assert.match(
    src,
    /REPO_DIR="\$\(cd "\$SCRIPT_DIR\/\.\." && pwd\)"/,
    'REPO_DIR must be derived from SCRIPT_DIR',
  )
  assert.doesNotMatch(
    src,
    /SANDBOX_DIR\/\.\.\/pantheon/,
    'REPO_DIR must not be inferred from a sibling ../pantheon directory',
  )
})

test('direct and generated MCP failures redact config and mcp-list output', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-v2-mcp-failure-redaction-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))

  const directStart = RUNNER_SRC.indexOf('check_mcp_list() {')
  const directEnd = RUNNER_SRC.indexOf('\n}\n\ncheck_doctor()', directStart)
  assert.ok(directStart >= 0 && directEnd > directStart, 'direct MCP check function not found')
  const directCheck = RUNNER_SRC.slice(directStart, directEnd + 2)

  const generated = generate(
    join(workDir, 'fixture-repo'),
    join(workDir, 'generated-sandbox'),
    join(workDir, 'runner-definitions.sh'),
  )
  const generatedSource = readFileSync(generated, 'utf8')
  const generatedCheckStart = generatedSource.indexOf('check_mcp() {')
  const generatedCheckEnd = generatedSource.indexOf(
    '\n}\n\necho "--- Binaries ---"',
    generatedCheckStart,
  )
  assert.ok(
    generatedCheckStart >= 0 && generatedCheckEnd > generatedCheckStart,
    'generated MCP check function not found',
  )
  const generatedCheck = generatedSource.slice(generatedCheckStart, generatedCheckEnd + 2)

  const reportStart = RUNNER_SRC.indexOf('write_report() {')
  const reportEnd = RUNNER_SRC.indexOf('\n}\n\nwrite_cost_report() {', reportStart)
  assert.ok(reportStart >= 0 && reportEnd > reportStart, 'direct report function not found')
  const writeReport = RUNNER_SRC.slice(reportStart, reportEnd + 2)

  const secretSentinel = 'synthetic redaction fixture phrase'
  const pathSentinel = 'THEMIS_MCP_PATH_SENTINEL_3c94'
  const controlSentinel = 'THEMIS_MCP_CONTROL_SENTINEL_8b12'
  const outputSentinel = 'THEMIS_MCP_OUTPUT_SENTINEL_5fa0'
  const scenarios = [
    ['registration', 'MCP registration check failed', 17],
    ['handshake', 'MCP connectivity check failed', 17],
    ['list-error', 'MCP connectivity check failed', 17],
    ['list-invalid', 'MCP connectivity check failed', 0],
  ]

  for (const runnerKind of ['direct', 'generated']) {
    for (const [failureStage, diagnostic, listExit] of scenarios) {
      const caseDir = join(workDir, `${runnerKind}-${failureStage}`)
      const sandboxRoot = join(caseDir, 'sandbox')
      const project = join(sandboxRoot, 'project-v2')
      const stubBin = join(caseDir, 'stub-bin')
      const functionFile = join(caseDir, 'mcp-functions.sh')
      const configPath = join(project, 'opencode.json')
      const reportPath = join(caseDir, 'report.md')
      mkdirSync(stubBin, { recursive: true })
      mkdirSync(join(project, '.opencode'), { recursive: true })
      mkdirSync(join(project, '.venv', 'bin'), { recursive: true })
      writeFileSync(
        configPath,
        JSON.stringify({
          mcp: {
            servers: {
              'preserved-entry': {
                credential: secretSentinel,
                preservedPath: `/private/${pathSentinel}/config.json`,
                control: `\u001b${controlSentinel}`,
              },
            },
          },
        }),
      )
      const fakeMcp = join(stubBin, 'opencode2')
      writeFileSync(
        fakeMcp,
        `#!/usr/bin/env bash
cat "$CONFIG_PATH"
printf 'captured mcp response: %s /private/%s/config.json \\033[31m%s\\033[0m\\n' \\
  "$OUTPUT_SENTINEL" "$PATH_SENTINEL" "$CONTROL_SENTINEL"
exit "$MCP_LIST_EXIT"
`,
        { mode: 0o755 },
      )
      writeFileSync(
        functionFile,
        runnerKind === 'direct' ? `${directCheck}\n${writeReport}` : generatedCheck,
      )

      const harness = `set -euo pipefail
source "$FUNCTION_FILE"
SANDBOX_DIR="$SANDBOX_ROOT"
SANDBOX_ROOT="$SANDBOX_ROOT"
PROJECT_DIR="$PROJECT_DIR_INPUT"
STUB_BIN="$STUB_BIN_INPUT"
V2_MCP_LIST_TIMEOUT=3
RESULT_STATUS=''
RESULT_DETAIL=''
start_v2_service() { return 0; }
wait_for_v2_mcp_registrations() { sleep 0.1; [[ "$FAILURE_STAGE" != registration ]]; }
wait_for_v2_handshakes() { sleep 0.1; [[ "$FAILURE_STAGE" != handshake ]]; }
print_v2_diagnostics() { printf '%s\\n' 'service diagnostics omitted' >&2; }
if [[ "$RUNNER_KIND" == generated ]]; then
  record_status() { RESULT_STATUS="$2"; RESULT_DETAIL="$3"; printf '%s: %s — %s\\n' "$2" "$1" "$3"; }
  check_mcp 'V2' "$STUB_BIN" "$PROJECT_DIR"
  [[ "$RESULT_STATUS" == FAIL ]] || exit 91
  printf 'Serialized check: %s — %s\\n' "$RESULT_STATUS" "$RESULT_DETAIL"
  exit 1
fi
declare -A RESULTS=()
declare -A DETAILS=()
PROMPT_IDS=()
PANTHEON_SANDBOX_MODEL=fixture
V2_BIN=opencode2
OPENCODE_V2_SPEC=fixture
REPORT_FILE="$REPORT_PATH"
log() { printf '%s\\n' "$*"; }
sandbox_bin() { printf '%s\\n' "$STUB_BIN"; }
project_dir() { printf '%s\\n' "$PROJECT_DIR"; }
record() { RESULTS["$1:$2"]="$3"; DETAILS["$1:$2"]="$4"; RESULT_STATUS="$3"; }
probe_verdict() { if [[ "$1" -eq "$2" && "$1" -gt 0 ]]; then printf PASS; else printf FAIL; fi; }
check_mcp_list fixture
[[ "$RESULT_STATUS" == FAIL ]] || exit 92
write_report fixture
exit 1
`
      const result = spawnSync('bash', ['-c', harness], {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          FUNCTION_FILE: functionFile,
          SANDBOX_ROOT: sandboxRoot,
          PROJECT_DIR_INPUT: project,
          STUB_BIN_INPUT: fakeMcp,
          CONFIG_PATH: configPath,
          OUTPUT_SENTINEL: outputSentinel,
          PATH_SENTINEL: pathSentinel,
          CONTROL_SENTINEL: controlSentinel,
          MCP_LIST_EXIT: String(listExit),
          REPORT_PATH: reportPath,
          FAILURE_STAGE: failureStage,
          RUNNER_KIND: runnerKind,
        },
      })
      const serializedReport = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : ''
      const jsonReport = JSON.stringify({
        stdout: result.stdout,
        stderr: result.stderr,
        status: result.status,
        report: serializedReport,
      })
      const streams = `${result.stdout}\n${result.stderr}`

      assert.equal(
        result.status,
        1,
        `${runnerKind}/${failureStage} must retain a failing result:\n${streams}`,
      )
      assert.match(streams, new RegExp(diagnostic))
      assert.equal(
        readFileSync(configPath, 'utf8').includes(secretSentinel),
        true,
        'the preserved private config fixture must remain intact',
      )
      for (const sentinel of [secretSentinel, pathSentinel, controlSentinel, outputSentinel]) {
        assert.doesNotMatch(
          streams,
          new RegExp(sentinel),
          `${runnerKind}/${failureStage} leaked ${sentinel}`,
        )
        assert.doesNotMatch(
          jsonReport,
          new RegExp(sentinel),
          `${runnerKind}/${failureStage} leaked ${sentinel} in JSON`,
        )
        assert.doesNotMatch(
          serializedReport,
          new RegExp(sentinel),
          `${runnerKind}/${failureStage} leaked ${sentinel} in report`,
        )
      }
      assert.equal(
        containsAsciiControl(streams),
        false,
        `${runnerKind}/${failureStage} echoed a control character`,
      )
      assert.equal(
        containsAsciiControl(jsonReport),
        false,
        `${runnerKind}/${failureStage} echoed a control character in JSON`,
      )
      assert.equal(
        containsAsciiControl(serializedReport),
        false,
        `${runnerKind}/${failureStage} echoed a control character in report`,
      )
      if (runnerKind === 'direct') {
        assert.match(
          serializedReport,
          /\| mcp-list \| FAIL \| MCP (?:registration|connectivity) check failed \|/,
        )
      } else {
        assert.match(result.stdout, /FAIL: V2 MCP — MCP (?:registration|connectivity) check failed/)
      }
    }
  }
})

test('sandbox V2 MCP rewriting keeps managed entries under mcp.servers', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-mcp-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const sandboxRoot = join(workDir, 'sandbox')
  const project = join(sandboxRoot, 'project-v2')
  const runtime = join(project, '.opencode')
  const python = join(project, '.venv', 'bin', 'python3')
  const configPath = join(project, 'opencode.json')
  const defsFile = join(workDir, 'runner-definitions.sh')
  mkdirSync(join(runtime, 'scripts'), { recursive: true })
  mkdirSync(join(project, '.venv', 'bin'), { recursive: true })
  writeFileSync(python, '#!/bin/sh\n', { mode: 0o755 })

  const managed = {
    'pantheon-code-mode': 'code_mode.py',
    'pantheon-memory': 'memory_mcp.py',
    'pantheon-persistence': 'mcp_persistence.py',
    'pantheon-resources': 'mcp_resources.py',
    'pantheon-vision': 'pantheon_vision.py',
  }
  for (const script of Object.values(managed)) writeFileSync(join(runtime, 'scripts', script), '')
  const existing = {
    type: 'local',
    cwd: '/stale/runtime',
    command: ['/stale/python', 'scripts/mcp_resources.py'],
    disabled: true,
  }
  writeFileSync(
    configPath,
    JSON.stringify({
      mcp: {
        servers: {
          'pantheon-resources': existing,
          'user-nested': { type: 'remote', url: 'https://nested.example/mcp' },
        },
        'user-flat': { type: 'remote', url: 'https://flat.example/mcp' },
      },
    }),
  )

  writeFileSync(defsFile, DEFINITIONS)
  copyFileSync(join(ROOT, 'scripts', 'sandbox-env.sh'), join(workDir, 'sandbox-env.sh'))
  const rewritten = spawnSync(
    'bash',
    ['-c', 'set -euo pipefail\nsource "$RUNNER_DEFS"\nrewrite_v2_mcp_config'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNNER_DEFS: defsFile,
        PANTHEON_SANDBOX_ROOT: sandboxRoot,
      },
    },
  )
  assert.equal(rewritten.status, 0, `config rewrite failed:\n${rewritten.stderr}`)

  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  assert.deepEqual(Object.keys(config.mcp.servers), [
    'pantheon-resources',
    'user-nested',
    'pantheon-code-mode',
    'pantheon-memory',
    'pantheon-persistence',
    'pantheon-vision',
  ])
  assert.equal(config.mcp['pantheon-resources'], undefined)
  assert.deepEqual(config.mcp['user-flat'], {
    type: 'remote',
    url: 'https://flat.example/mcp',
  })
  assert.deepEqual(config.mcp.servers['pantheon-resources'], {
    type: 'local',
    cwd: runtime,
    command: [python, 'scripts/mcp_resources.py'],
    enabled: true,
  })
  assert.equal(migrateV1toV2(config).mcp.servers['pantheon-resources'].cwd, runtime)

  const generated = generate(join(workDir, 'repo'), join(workDir, 'generated'), defsFile)
  const generatedSource = readFileSync(generated, 'utf8')
  assert.match(generatedSource, /servers = mcp\.setdefault\("servers", \{\}\)/)
  assert.match(generatedSource, /entry = servers\.get\(name\)/)
  assert.match(
    generatedSource,
    /validated\.get\("mcp", \{\}\)\.get\("servers", \{\}\)\.get\(name\)/,
  )
})

test('direct and generated MCP validation failures redact preserved config entries', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-v2-mcp-redaction-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const credentialSentinel = 'THEMIS_MCP_CREDENTIAL_SENTINEL_55e1'
  const controlSentinel = 'THEMIS_MCP_CONTROL_SENTINEL_c81d'
  const config = {
    mcp: {
      servers: {
        'pantheon-memory': {
          credential: credentialSentinel,
          control: `\u001b${controlSentinel}`,
        },
      },
    },
  }
  const prepareConfig = (root) => {
    const project = join(root, 'project-v2')
    const python = join(project, '.venv', 'bin', 'python3')
    const configPath = join(project, 'opencode.json')
    mkdirSync(dirname(python), { recursive: true })
    writeFileSync(python, '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(configPath, JSON.stringify(config))
    return configPath
  }

  const directRoot = join(workDir, 'direct-sandbox')
  const directConfig = prepareConfig(directRoot)
  const directDefs = join(workDir, 'direct-definitions.sh')
  writeFileSync(directDefs, DEFINITIONS)
  copyFileSync(join(ROOT, 'scripts', 'sandbox-env.sh'), join(workDir, 'sandbox-env.sh'))
  const directResult = spawnSync(
    'bash',
    [
      '-c',
      'set -euo pipefail\nsource "$RUNNER_DEFS"\nSANDBOX_ROOT="$INPUT_ROOT"\nTARGET_VERSION=v2\nV2_CONFIG="$INPUT_CONFIG"\nrewrite_v2_mcp_config',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNNER_DEFS: directDefs,
        INPUT_ROOT: directRoot,
        INPUT_CONFIG: directConfig,
      },
    },
  )

  const generatedRoot = join(workDir, 'generated-sandbox')
  const generated = generate(
    join(workDir, 'fixture-repo'),
    generatedRoot,
    join(workDir, 'generated-defs.sh'),
  )
  const generatedSource = readFileSync(generated, 'utf8')
  const functionStart = generatedSource.indexOf('\nrewrite_v2_mcp_config() {')
  const functionEnd = generatedSource.indexOf('\n}\n\ntrap stop_v2_service EXIT', functionStart)
  assert.ok(
    functionStart >= 0 && functionEnd > functionStart,
    'generated MCP rewrite function not found',
  )
  const generatedFunction = join(workDir, 'generated-rewrite.sh')
  writeFileSync(generatedFunction, generatedSource.slice(functionStart + 1, functionEnd + 2))
  const generatedConfig = prepareConfig(generatedRoot)
  const generatedResult = spawnSync(
    'bash',
    [
      '-c',
      'set -euo pipefail\nsource "$HELPER"\nsource "$REWRITE_FUNCTION"\nSANDBOX_DIR="$INPUT_ROOT"\nV2_CONFIG="$INPUT_CONFIG"\nrewrite_v2_mcp_config',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HELPER: join(generatedRoot, 'sandbox-env.sh'),
        REWRITE_FUNCTION: generatedFunction,
        INPUT_ROOT: generatedRoot,
        INPUT_CONFIG: generatedConfig,
      },
    },
  )

  for (const [label, result] of [
    ['direct', directResult],
    ['generated', generatedResult],
  ]) {
    const output = `${result.stdout}\n${result.stderr}`
    const report = JSON.stringify({
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
    })
    assert.notEqual(
      result.status,
      0,
      `${label} MCP validation must fail for the absent sandbox runtime`,
    )
    assert.match(result.stderr, /ERROR: sandbox MCP validation failed\./)
    for (const sentinel of [credentialSentinel, controlSentinel, 'pantheon-memory']) {
      assert.doesNotMatch(output, new RegExp(sentinel), `${label} output leaked ${sentinel}`)
      assert.doesNotMatch(report, new RegExp(sentinel), `${label} JSON output leaked ${sentinel}`)
    }
    assert.equal(
      output.includes(String.fromCharCode(0x1b)),
      false,
      `${label} output leaked a control character`,
    )
    assert.equal(
      report.includes(String.fromCharCode(0x1b)),
      false,
      `${label} JSON output leaked a control character`,
    )
  }
})

test('generated run-test.sh defines its mcp-list timeout under nounset', () => {
  const src = readFileSync(RUNNER, 'utf8')
  assert.match(
    src,
    /V2_MCP_LIST_TIMEOUT="\$\{PANTHEON_V2_MCP_LIST_TIMEOUT:-15\}"/,
    'the generated script must define the timeout consumed by `timeout`',
  )
  assert.match(src, /pantheon_sandbox_env \\\n {2}"\$SANDBOX_DIR"/)
})

test('prepare generates an interactive launcher isolated to the sandbox beta', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-launcher-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const repoDir = join(workDir, 'repo')
  const sandboxRoot = join(workDir, 'sandbox')
  mkdirSync(repoDir, { recursive: true })

  generate(repoDir, sandboxRoot, join(workDir, 'runner-definitions.sh'))
  const launcher = join(sandboxRoot, 'start-pantheon.sh')
  assert.ok(existsSync(launcher), 'prepare must create the launcher it advertises')
  assert.ok(statSync(launcher).mode & 0o111, 'launcher must be executable')
  const syntax = spawnSync('bash', ['-n', launcher], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, `launcher has invalid bash syntax:\n${syntax.stderr}`)

  const src = readFileSync(launcher, 'utf8')
  const runTest = readFileSync(join(sandboxRoot, 'run-test.sh'), 'utf8')
  assert.match(src, /source "\$SANDBOX_ENV_HELPER"/)
  assert.ok(
    src.indexOf('pantheon_launcher_preflight "$0"') < src.indexOf('source "$SANDBOX_ENV_HELPER"'),
    'launcher must preflight its lexical entrypoint and helper before sourcing',
  )
  assert.match(src, /if \[\[ ! -f "\$helper" \|\| -L "\$helper" \]\]/)
  assert.ok(
    src.indexOf('pantheon_validate_sandbox_root') < src.indexOf('cd "$SANDBOX_DIR/project-v2"'),
    'launcher must validate the sandbox before changing into the project directory',
  )
  assert.match(runTest, /source "\$SANDBOX_ENV_HELPER"/)
  assert.ok(
    runTest.indexOf('pantheon_launcher_preflight "$0"') <
      runTest.indexOf('source "$SANDBOX_ENV_HELPER"'),
    'generated runner must preflight its lexical entrypoint and helper before sourcing',
  )
  assert.match(runTest, /if \[\[ ! -f "\$helper" \|\| -L "\$helper" \]\]/)
  assert.match(src, /pantheon_sandbox_env/)
  assert.match(runTest, /pantheon_sandbox_env/)
  assert.equal(
    readFileSync(join(sandboxRoot, 'sandbox-env.sh'), 'utf8'),
    readFileSync(join(ROOT, 'scripts', 'sandbox-env.sh'), 'utf8'),
    'the standalone launcher must use the shared sandbox environment helper',
  )
  const helper = readFileSync(join(sandboxRoot, 'sandbox-env.sh'), 'utf8')
  assert.match(helper, /export XDG_CONFIG_HOME="\$sandbox_home\/\.config"/)
  assert.match(helper, /export XDG_DATA_HOME="\$HOME\/\.local\/share"/)
  assert.match(helper, /LOG_PATH="\$XDG_DATA_HOME\/opencode\/log\/opencode\.log"/)
  assert.match(helper, /export XDG_RUNTIME_DIR="\$sandbox_root\/run"/)
  assert.match(helper, /export PANTHEON_HOME="\$XDG_CONFIG_HOME\/opencode"/)
  assert.match(helper, /export TMPDIR="\$sandbox_root\/tmp"/)
  assert.match(src, /"\$SANDBOX_DIR\/project-v2"/)
  assert.match(src, /service set port "\$V2_PORT"/)
  assert.match(src, /PANTHEON_V2_PORT:-49376/)
  assert.match(src, /probe\.setsockopt\(socket\.SOL_SOCKET, socket\.SO_REUSEADDR, 1\)/)
  assert.match(src, /Reusing the existing beta sandbox OpenCode service/)
  assert.match(src, /dedicated V2 port .* occupied by a different or unverifiable service/)
  assert.match(src, /"@opencode", "cli"/)
  assert.match(src, /opencode-v2\.db/)
  assert.ok(
    src.indexOf('service set port') < src.indexOf('exec "$NPM_PREFIX/bin/opencode2"'),
    'the managed service port must be isolated before the TUI starts',
  )
  assert.match(src, /exec "\$NPM_PREFIX\/bin\/opencode2" "\$@"/)
})

test('generated runner validates .repo-dir against its trusted source before npm pack', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-v2-repo-metadata-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const expectedRepo = join(workDir, 'expected fixture repo')
  const externalRepo = join(workDir, 'external target repo')
  const externalSentinel = 'THEMIS_REPO_METADATA_SENTINEL_93bb1'
  mkdirSync(expectedRepo)
  mkdirSync(externalRepo)
  writeFileSync(join(externalRepo, 'sentinel.txt'), externalSentinel)

  const cases = [
    {
      name: 'missing metadata',
      setup: (metadata) => rmSync(metadata),
    },
    {
      name: 'symlink to external sentinel',
      setup: (metadata) => {
        rmSync(metadata)
        symlinkSync(join(externalRepo, 'sentinel.txt'), metadata)
      },
    },
    {
      name: 'malformed multi-line path',
      setup: (metadata) => writeFileSync(metadata, `${expectedRepo}\n${externalRepo}\n`),
    },
    {
      name: 'ASCII control in path',
      setup: (metadata) => {
        const controlRepo = join(workDir, 'external-\u0001-target')
        mkdirSync(controlRepo)
        writeFileSync(join(controlRepo, 'sentinel.txt'), externalSentinel)
        writeFileSync(metadata, `${controlRepo}\n`)
      },
    },
    {
      name: 'tampered external repo path',
      setup: (metadata) => writeFileSync(metadata, `${externalRepo}\n`),
    },
  ]

  for (const [index, item] of cases.entries()) {
    const sandboxRoot = join(workDir, `sandbox-${index}`)
    const generated = generate(expectedRepo, sandboxRoot, join(workDir, `defs-${index}.sh`))
    const metadata = join(sandboxRoot, '.repo-dir')
    const stubBin = join(workDir, `stub-bin-${index}`)
    const packCalls = join(workDir, `pack-calls-${index}`)
    mkdirSync(stubBin)
    writeFileSync(
      join(stubBin, 'npm'),
      `#!/usr/bin/env bash
if [[ "\${1:-}" == pack ]]; then printf '%s\\n' "$PWD" >> "$PACK_CALLS"; fi
exit 1
`,
      { mode: 0o755 },
    )
    item.setup(metadata)

    const result = spawnSync('bash', [generated], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        PATH: `${stubBin}:${process.env.PATH}`,
        PACK_CALLS: packCalls,
        PANTHEON_REPO: '',
      },
    })
    const output = `${result.stdout}\n${result.stderr}`
    assert.notEqual(result.status, 0, `${item.name} must fail closed`)
    assert.match(result.stderr, /ERROR: sandbox repository metadata validation failed\./)
    assert.doesNotMatch(
      output,
      /sandbox-v2-repo-metadata-|external target repo|THEMIS_REPO_METADATA_SENTINEL/,
    )
    assert.equal(existsSync(packCalls), false, `${item.name} must fail before npm pack`)
  }

  const validSandbox = join(workDir, 'sandbox-valid')
  const validRunner = generate(expectedRepo, validSandbox, join(workDir, 'defs-valid.sh'))
  const validCalls = join(workDir, 'pack-calls-valid')
  const validBin = join(workDir, 'stub-bin-valid')
  mkdirSync(validBin)
  writeFileSync(
    join(validBin, 'npm'),
    `#!/usr/bin/env bash
if [[ "\${1:-}" == pack ]]; then printf '%s\\n' "$PWD" >> "$PACK_CALLS"; fi
exit 1
`,
    { mode: 0o755 },
  )
  const valid = spawnSync('bash', [validRunner], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      PATH: `${validBin}:${process.env.PATH}`,
      PACK_CALLS: validCalls,
      PANTHEON_REPO: '',
    },
  })
  assert.notEqual(
    valid.status,
    0,
    'the npm fixture intentionally stops after proving the pack target',
  )
  assert.deepEqual(readFileSync(validCalls, 'utf8').trim().split('\n'), [expectedRepo])
  assert.doesNotMatch(`${valid.stdout}\n${valid.stderr}`, /THEMIS_REPO_METADATA_SENTINEL/)
})

test('the generated run-test.sh preserves repo paths without printing them (adversarial paths)', (t) => {
  // The generated runner embeds its trusted expected source path using Bash's
  // %q quoting and checks .repo-dir against it before package work. Execute
  // each adversarial path: syntax alone cannot catch accidental expansion of
  // `$`, backticks, backslashes, or quotes.
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-gen-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const defsFile = join(workDir, 'runner-definitions.sh')
  const stubBin = join(workDir, 'stub-bin')
  mkdirSync(stubBin, { recursive: true })
  writeFileSync(join(stubBin, 'npm'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })

  const cases = [
    ['ordinary path', 'pantheon'],
    ['$ expands', 'we$USER'],
    ['backtick executes', 'tick`id`'],
    ['backslash swallowed', 'back\\slash'],
    ['ampersand is a sed replacement', 'amp&ersand'],
    ['pipe is the sed delimiter', 'pi|pe'],
    ['double quote closes the context', 'dq"uote'],
    [
      'all of them at once',
      join('we$USER', 'tick`id`', 'back\\slash', 'amp&ersand', 'pi|pe', 'dq"uote'),
    ],
  ]

  for (const [label, segments] of cases) {
    const repoDir = join(workDir, label.replace(/\W+/g, '_'), segments)
    const sandboxRoot = join(workDir, `sandbox-${label.replace(/\W+/g, '_')}`)
    mkdirSync(repoDir, { recursive: true })
    mkdirSync(sandboxRoot, { recursive: true })

    const generated = generate(repoDir, sandboxRoot, defsFile)
    const syntax = spawnSync('bash', ['-n', generated], { encoding: 'utf8' })
    assert.equal(
      syntax.status,
      0,
      `[${label}] generated script is not valid bash:\n${syntax.stderr}`,
    )

    // The metadata is emitted byte-for-byte and must match the trusted,
    // shell-quoted expected value embedded in the generated runner.
    assert.equal(
      readFileSync(join(sandboxRoot, '.repo-dir'), 'utf8'),
      `${repoDir}\n`,
      `[${label}] .repo-dir must hold the repo path verbatim`,
    )
    assert.match(readFileSync(generated, 'utf8'), /^EXPECTED_REPO_DIR=/m)

    const output = runGenerated(generated, stubBin)
    assert.equal(
      output.includes(repoDir),
      false,
      `[${label}] generated script must not disclose the repo path`,
    )
  }
})

test('--reset refuses a sandbox root inside any repo it can act on', () => {
  const src = readFileSync(RUNNER, 'utf8')
  // The guard previously covered only the default REPO_DIR while the generated
  // script honoured PANTHEON_REPO, so an override could name a checkout and
  // have a tarball packed into it.
  assert.match(
    src,
    /for protected in "\$REPO_DIR" "\$\{PANTHEON_REPO:-\}"/,
    '--reset must guard both REPO_DIR and the PANTHEON_REPO override',
  )
})

function runReset(sandboxRoot, protectedRepo) {
  return spawnSync('bash', [RUNNER, '--reset'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PANTHEON_SANDBOX_ROOT: sandboxRoot,
      PANTHEON_REPO: protectedRepo,
    },
    timeout: 15000,
  })
}

test('--reset refuses an ancestor of a protected repo before deleting its sentinel', (t) => {
  const sandboxParent = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-reset-ancestor-'))
  t.after(() => rmSync(sandboxParent, { recursive: true, force: true }))
  const syntheticRepo = join(sandboxParent, 'nested', 'synthetic-repo')
  mkdirSync(join(syntheticRepo, '.git'), { recursive: true })
  const sentinel = join(syntheticRepo, 'uncommitted-work-sentinel')
  writeFileSync(sentinel, 'keep')

  // This is an isolated temp directory, not /tmp or a shared repository path.
  // The actual runner is exercised, with the synthetic nested repo supplied as
  // its protected PANTHEON_REPO override.
  const result = runReset(sandboxParent, syntheticRepo)
  const checks = {
    nonzeroExit: result.status !== 0,
    sandboxRootSurvived: existsSync(sandboxParent),
    sentinelSurvived: existsSync(sentinel),
  }
  assert.deepEqual(
    checks,
    { nonzeroExit: true, sandboxRootSurvived: true, sentinelSurvived: true },
    `reset must reject the ancestor before deletion; got ${JSON.stringify(checks)}\n${result.stdout}\n${result.stderr}`,
  )
  assert.match(result.stderr, /refusing to reset unsafe sandbox root/i)
})

test('--reset refuses a sandbox root that is an ancestor of canonical HOME', (t) => {
  const sandboxRoot = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-reset-home-ancestor-'))
  t.after(() => rmSync(sandboxRoot, { recursive: true, force: true }))
  const syntheticHome = join(sandboxRoot, 'synthetic-home')
  mkdirSync(syntheticHome, { recursive: true })
  const sentinel = join(syntheticHome, 'keep-me')
  writeFileSync(sentinel, 'synthetic HOME sentinel')

  const result = spawnSync('bash', [RUNNER, '--reset'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PANTHEON_SANDBOX_ROOT: sandboxRoot,
      PANTHEON_REPO: '',
      HOME: syntheticHome,
    },
    timeout: 15000,
  })
  const checks = {
    nonzeroExit: result.status !== 0,
    sandboxRootSurvived: existsSync(sandboxRoot),
    sentinelSurvived: existsSync(sentinel),
  }
  assert.deepEqual(
    checks,
    { nonzeroExit: true, sandboxRootSurvived: true, sentinelSurvived: true },
    `reset must reject an ancestor of HOME before deletion; got ${JSON.stringify(checks)}\n${result.stdout}\n${result.stderr}`,
  )
  assert.match(result.stderr, /refusing to reset unsafe sandbox root/i)
})

test('--reset permits the default sandbox root nested below HOME', (t) => {
  const tempParent = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-reset-home-child-'))
  t.after(() => rmSync(tempParent, { recursive: true, force: true }))
  const syntheticHome = join(tempParent, 'synthetic-home')
  const defaultSandboxRoot = join(syntheticHome, 'pantheon-sandbox')
  mkdirSync(defaultSandboxRoot, { recursive: true })
  const homeSentinel = join(syntheticHome, 'keep-me')
  const sandboxSentinel = join(defaultSandboxRoot, 'remove-me')
  writeFileSync(homeSentinel, 'synthetic HOME sentinel')
  writeFileSync(sandboxSentinel, 'sandbox content')

  const result = spawnSync('bash', [RUNNER, '--reset'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PANTHEON_SANDBOX_ROOT: '',
      PANTHEON_REPO: '',
      HOME: syntheticHome,
    },
    timeout: 15000,
  })

  assert.equal(
    result.status,
    0,
    `default sandbox reset failed:\n${result.stdout}\n${result.stderr}`,
  )
  assert.equal(existsSync(defaultSandboxRoot), false, 'default sandbox should be removed')
  assert.equal(existsSync(homeSentinel), true, 'synthetic HOME must remain intact')
  assert.equal(existsSync(sandboxSentinel), false, 'sandbox content should be removed')
})

test('--reset refuses a protected repo itself and sandbox roots inside it', (t) => {
  const tempParent = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-reset-contained-'))
  t.after(() => rmSync(tempParent, { recursive: true, force: true }))
  const protectedRepo = join(tempParent, 'synthetic-repo')
  mkdirSync(join(protectedRepo, '.git'), { recursive: true })
  const sentinel = join(protectedRepo, 'uncommitted-work-sentinel')
  writeFileSync(sentinel, 'keep')

  for (const sandboxRoot of [protectedRepo, join(protectedRepo, 'sandbox-child')]) {
    mkdirSync(sandboxRoot, { recursive: true })
    const result = runReset(sandboxRoot, protectedRepo)
    assert.notEqual(
      result.status,
      0,
      `reset must reject ${sandboxRoot}:\n${result.stdout}\n${result.stderr}`,
    )
    assert.equal(existsSync(sentinel), true, 'protected repo sentinel must survive')
  }
})

test('--reset still allows a safe sandbox root below its temporary parent', (t) => {
  const tempParent = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-reset-safe-'))
  t.after(() => rmSync(tempParent, { recursive: true, force: true }))
  const protectedRepo = join(tempParent, 'repos', 'synthetic-repo')
  const sandboxRoot = join(tempParent, 'sandboxes', 'pantheon-sandbox')
  mkdirSync(join(protectedRepo, '.git'), { recursive: true })
  mkdirSync(sandboxRoot, { recursive: true })
  const protectedSentinel = join(protectedRepo, 'keep')
  writeFileSync(protectedSentinel, 'keep')
  writeFileSync(join(sandboxRoot, 'remove-me'), 'reset this sandbox')

  const result = runReset(sandboxRoot, protectedRepo)
  assert.equal(result.status, 0, `safe reset failed:\n${result.stdout}\n${result.stderr}`)
  assert.equal(existsSync(sandboxRoot), false, 'safe sandbox root should be removed')
  assert.equal(existsSync(protectedSentinel), true, 'protected repo must remain untouched')
})

test('--reset canonicalizes a symlink alias before comparing protected repos', (t) => {
  const tempParent = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-reset-symlink-'))
  t.after(() => rmSync(tempParent, { recursive: true, force: true }))
  const protectedRepo = join(tempParent, 'synthetic-repo')
  const sandboxAlias = join(tempParent, 'sandbox-repo-alias')
  mkdirSync(join(protectedRepo, '.git'), { recursive: true })
  const sentinel = join(protectedRepo, 'uncommitted-work-sentinel')
  writeFileSync(sentinel, 'keep')
  symlinkSync(protectedRepo, sandboxAlias, 'dir')

  const result = runReset(sandboxAlias, protectedRepo)
  assert.notEqual(
    result.status,
    0,
    `symlink alias must be rejected:\n${result.stdout}\n${result.stderr}`,
  )
  assert.equal(existsSync(sandboxAlias), true, 'rejected sandbox symlink must remain intact')
  assert.equal(existsSync(sentinel), true, 'protected repo sentinel must survive')
})

test('--reset treats a path-prefix neighbor as separate from a protected repo', (t) => {
  const tempParent = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-reset-prefix-'))
  t.after(() => rmSync(tempParent, { recursive: true, force: true }))
  const sandboxRoot = join(tempParent, 'repo')
  const protectedRepo = join(tempParent, 'repo2')
  mkdirSync(sandboxRoot, { recursive: true })
  mkdirSync(join(protectedRepo, '.git'), { recursive: true })
  const sandboxSentinel = join(sandboxRoot, 'remove-me')
  const protectedSentinel = join(protectedRepo, 'keep')
  writeFileSync(sandboxSentinel, 'reset this sandbox')
  writeFileSync(protectedSentinel, 'keep')

  const result = runReset(sandboxRoot, protectedRepo)
  assert.equal(
    result.status,
    0,
    `prefix neighbor should be safe:\n${result.stdout}\n${result.stderr}`,
  )
  assert.equal(existsSync(sandboxSentinel), false, 'sandbox contents should be reset')
  assert.equal(existsSync(protectedSentinel), true, 'prefix-neighbor repo must remain untouched')
})

// The context_rehydrate/context_session_summary sandbox probe is intentionally
// removed: neither operation is registered in the Persistence MCP surface.
