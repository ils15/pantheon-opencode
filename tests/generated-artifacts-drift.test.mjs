/**
 * generated-artifacts-drift.test.mjs — the committed generators must be
 * validated on every PR, not only when someone runs `npm pack`.
 *
 * Incident class this pins: `src/agents/*.md` are generated from
 * `src/agents/roster.json`, and AGENTS.md / AGENTS.global.md are generated from
 * `src/instructions/*`. Their only historical enforcer was `prepack`, which
 * runs at release time — so drift could sit on `main` indefinitely and was
 * discovered only when a packaging test happened to pack the tarball.
 *
 * This file is a static contract: it asserts the fast CI lane and the local
 * commit hook both fail on drift, and that the generators themselves still
 * compare the right things (rebuild + `git diff`, not a lossy `--check`).
 *
 * Run: node --test tests/generated-artifacts-drift.test.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const read = (relPath) =>
  readFileSync(fileURLToPath(new URL(`../${relPath}`, import.meta.url)), 'utf8')

const packageJson = JSON.parse(read('package.json'))
const ci = read('.github/workflows/ci.yml')
const preCommit = load(read('.pre-commit-config.yaml'))

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Return the body of the named step in ci.yml (its `env:`/`run:` lines),
 * stopping at the next step or at the next top-level job key.
 */
function ciStep(label) {
  const pattern = new RegExp(
    `^ {6}- name: ${escapeRegExp(label)}\\n([\\s\\S]*?)(?=^ {6}- |^ {2}[a-z][a-z0-9-]*:)`,
    'm',
  )
  const match = ci.match(pattern)
  assert.ok(match, `ci.yml must define the step "${label}"`)
  return match[1]
}

test('package.json exposes one generated-artifacts gate that covers every generator', () => {
  const script = packageJson.scripts['check:generated']
  assert.ok(script, 'package.json must define "check:generated" so CI and hooks share one command')
  assert.match(script, /npm run check:roster/, 'check:generated must verify the agent roster')
  assert.match(
    script,
    /npm run check:decision-router/,
    'check:generated must verify the committed decision-router bundles',
  )
  assert.match(
    script,
    /npm run check:plugin/,
    'check:generated must verify the committed plugin bundle',
  )
  assert.match(
    script,
    /node scripts\/build-agents-md\.mjs --check/,
    'check:generated must verify AGENTS.md / AGENTS.global.md',
  )
})

test('check:plugin rebuilds to a temp file and byte-compares the committed bundle', () => {
  const script = packageJson.scripts['check:plugin']
  assert.ok(script, 'package.json must define check:plugin')
  assert.match(
    script,
    /node scripts\/build-plugin\.mjs --check/,
    'check:plugin must use the generator in check mode, not diff a mutated worktree',
  )
})

test('package:validate (already on the CI fast lane) runs check:generated', () => {
  const validate = packageJson.scripts['package:validate']
  assert.ok(validate, 'package.json must keep package:validate')
  assert.match(
    validate,
    /&& npm run check:generated\s*$/,
    'package:validate must end with check:generated so drift fails the existing CI step',
  )
})

test('prepack still enforces the roster: drift is fixed, never bypassed', () => {
  const prepack = packageJson.scripts.prepack
  assert.ok(prepack, 'package.json must keep prepack')
  assert.match(
    prepack,
    /check:roster/,
    'prepack must keep check:roster; removing the gate hides drift instead of fixing it',
  )
})

test('CI rebuilds the roster and fails on any diff, not on a lossy --check', () => {
  const step = ciStep('Generated artifacts are in sync')
  assert.match(step, /npm run build:roster/, 'the step must rebuild src/agents from roster.json')
  assert.match(
    step,
    /git diff --exit-code src\/agents/,
    'the step must diff the rebuilt files: --check trims whitespace and misses formatter rewrites',
  )
  assert.doesNotMatch(step, /continue-on-error:\s*true/, 'drift must fail the job')
  assert.match(
    step,
    /ls-files --others --exclude-standard -- src\/agents/,
    'the step must reject unexpected untracked files under src/agents',
  )

  const stepIndex = ci.indexOf('- name: Generated artifacts are in sync')
  assert.ok(
    stepIndex > ci.indexOf('run: npm run package:validate'),
    'the rebuild must run after package:validate, where the fast lane already validated manifests',
  )
  assert.ok(
    stepIndex < ci.indexOf('\n  test-suite:'),
    'the rebuild must stay in the validate job, before the parallel test job',
  )
})

test('CI rebuilds the plugin bundle and fails on any diff', () => {
  const step = ciStep('Plugin bundle freshness')
  assert.match(step, /npm run build:plugin/, 'the step must rebuild src/plugin/index.js')
  assert.match(
    step,
    /git diff --exit-code src\/plugin/,
    'the step must diff the rebuilt bundle so a stale or concurrently-mutated bundle fails CI',
  )
  assert.doesNotMatch(step, /continue-on-error:\s*true/, 'a stale bundle must fail the job')
  assert.match(
    step,
    /ls-files --others --exclude-standard -- src\/plugin/,
    'the step must reject unexpected untracked files under src/plugin',
  )
})

test('pre-commit rebuilds both generators, backs up unstaged drift, and reports both', () => {
  const localHooks = (preCommit.repos ?? []).flatMap((repo) =>
    repo.repo === 'local' ? (repo.hooks ?? []) : [],
  )
  const hook = localHooks.find((candidate) => candidate.id === 'generated-artifacts')
  assert.ok(hook, 'pre-commit must define a local hook with id "generated-artifacts"')
  assert.equal(hook.language, 'system', 'the hook must run the repository Node toolchain')
  assert.equal(
    hook.pass_filenames,
    false,
    'the hook must check the whole generated set, not only staged filenames',
  )
  assert.equal(
    String(hook.entry).trim(),
    'node scripts/check-generated-hook.mjs',
    'the hook must run the checked hook script',
  )

  const scriptPath = fileURLToPath(new URL('../scripts/check-generated-hook.mjs', import.meta.url))
  assert.ok(existsSync(scriptPath), 'scripts/check-generated-hook.mjs must exist')
  const script = readFileSync(scriptPath, 'utf8')
  assert.match(script, /build-roster\.mjs/, 'the hook must rebuild the roster')
  assert.match(script, /build-plugin\.mjs/, 'the hook must rebuild the plugin bundle')
  assert.match(
    script,
    /pantheon-generated-backup/,
    'the hook must back up unstaged generated edits before the rebuild normalizes them',
  )
  assert.match(
    script,
    /process\.exit\(failed \? 1 : 0\)/,
    'the hook must evaluate every generator before exiting non-zero',
  )
  assert.match(
    script,
    /existsSync/,
    'a deleted generated file must be handled instead of crashing lstat',
  )
  assert.match(script, /deleted|missing/i, 'a deleted generated file must be reported as drift')
  assert.match(script, /BACKUP_MAX_AGE_MS|7 \* 24/, 'old backups must be pruned')
  assert.match(script, /rmSync/, 'old backup directories must be removable')
  assert.match(
    script,
    /unexpected untracked/,
    'untracked strays under generated dirs must fail the hook',
  )
  assert.match(
    script,
    /working tree was rewritten/,
    'unstaged normalization must be announced explicitly, not silently',
  )
})

/**
 * The hook must be proven by behaviour, not by grepping its source. Each case
 * builds a throwaway git repo with a copy of the real hook script and stub
 * generators, so the real exit status and stderr are exercised without
 * touching the working tree.
 */
const HOOK_SOURCE = fileURLToPath(new URL('../scripts/check-generated-hook.mjs', import.meta.url))

function makeHookFixture(options = {}) {
  const { tuiBuildFails = false } = options
  const base = mkdtempSync(join(tmpdir(), 'pantheon-hook-fixture-'))
  const tmp = mkdtempSync(join(tmpdir(), 'pantheon-hook-tmp-'))
  mkdirSync(join(base, 'scripts'), { recursive: true })
  mkdirSync(join(base, 'src', 'agents'), { recursive: true })
  mkdirSync(join(base, 'src', 'plugin'), { recursive: true })
  mkdirSync(join(base, 'src', 'plugins', 'tui', 'dist'), { recursive: true })
  writeFileSync(
    join(base, 'scripts', 'check-generated-hook.mjs'),
    readFileSync(HOOK_SOURCE, 'utf8'),
  )
  writeFileSync(
    join(base, 'scripts', 'build-roster.mjs'),
    "import { writeFileSync } from 'node:fs'\nwriteFileSync('src/agents/a.md', 'canonical\\n')\n",
  )
  writeFileSync(
    join(base, 'scripts', 'build-plugin.mjs'),
    "import { writeFileSync } from 'node:fs'\nwriteFileSync('src/plugin/index.js', 'canonical\\n')\n",
  )
  // Third generator: the hook runs `npm --silent run build --prefix
  // src/plugins/tui`. A stub package + build script keeps it deterministic and
  // offline (no install, no tsdown).
  writeFileSync(
    join(base, 'src', 'plugins', 'tui', 'package.json'),
    JSON.stringify(
      { name: 'tui-fixture', private: true, scripts: { build: 'node build.mjs' } },
      null,
      2,
    ),
  )
  writeFileSync(
    join(base, 'src', 'plugins', 'tui', 'build.mjs'),
    tuiBuildFails
      ? "console.error('stub tui build failed')\nprocess.exit(1)\n"
      : [
          "import { mkdirSync, writeFileSync } from 'node:fs'",
          "mkdirSync('dist', { recursive: true })",
          "writeFileSync('dist/tui.js', 'canonical\\n')",
          '',
        ].join('\n'),
  )
  writeFileSync(join(base, 'src', 'agents', 'a.md'), 'canonical\n')
  writeFileSync(join(base, 'src', 'plugin', 'index.js'), 'canonical\n')
  writeFileSync(join(base, 'src', 'plugins', 'tui', 'dist', 'tui.js'), 'canonical\n')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: base })
  execFileSync('git', ['add', '.'], { cwd: base })
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init'],
    { cwd: base },
  )

  return {
    base,
    run: () =>
      spawnSync(process.execPath, [join(base, 'scripts', 'check-generated-hook.mjs')], {
        cwd: base,
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: tmp },
      }),
    cleanup: () => {
      rmSync(base, { recursive: true, force: true })
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

test('hook behaviour: a clean generated tree exits zero and checks all three generators', () => {
  const fixture = makeHookFixture()
  try {
    const result = fixture.run()
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /checking agent roster/)
    assert.match(result.stderr, /checking plugin bundle/)
    assert.match(result.stderr, /checking TUI bundle/)
  } finally {
    fixture.cleanup()
  }
})

test('hook behaviour: a failing TUI generator is exercised, not tolerated', () => {
  const fixture = makeHookFixture({ tuiBuildFails: true })
  try {
    const result = fixture.run()
    assert.notEqual(result.status, 0, 'a failing TUI generator must fail the hook')
    assert.match(result.stderr, /checking TUI bundle/)
    assert.match(result.stderr, /TUI bundle: generator failed/)
    // The other generators still ran, so one attempt reports every drift.
    assert.match(result.stderr, /checking agent roster/)
    assert.match(result.stderr, /checking plugin bundle/)
  } finally {
    fixture.cleanup()
  }
})

test('hook behaviour: a deleted generated file fails and still runs all three generators', () => {
  const fixture = makeHookFixture()
  try {
    rmSync(join(fixture.base, 'src', 'agents', 'a.md'))
    const result = fixture.run()
    assert.notEqual(result.status, 0, 'a deleted generated file must fail the hook')
    assert.match(result.stderr, /missing\/deleted: src\/agents\/a\.md/)
    assert.match(result.stderr, /checking agent roster/)
    assert.match(result.stderr, /checking plugin bundle/)
    assert.match(result.stderr, /checking TUI bundle/)
  } finally {
    fixture.cleanup()
  }
})

test('hook behaviour: an untracked stray under a generated dir fails and is named', () => {
  const fixture = makeHookFixture()
  try {
    writeFileSync(join(fixture.base, 'src', 'agents', 'stray.md'), 'stray\n')
    const result = fixture.run()
    assert.notEqual(result.status, 0, 'an untracked stray must fail the hook')
    assert.match(result.stderr, /unexpected untracked/)
    assert.match(result.stderr, /src\/agents\/stray\.md/)
  } finally {
    fixture.cleanup()
  }
})

test('.gitignore neutralises editor droppings under the generated trees', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  for (const name of ['x.md~', 'x.md.swp', 'x.md.swo', 'x.md.orig', 'x.md.rej']) {
    const result = spawnSync('git', ['check-ignore', '-q', `src/agents/${name}`], { cwd: root })
    assert.equal(
      result.status,
      0,
      `src/agents/${name} must be ignored, not an untracked gate failure`,
    )
  }
})
