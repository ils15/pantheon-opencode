/**
 * no-live-config-writes.test.mjs — regression guard: no test may spawn a
 * process that writes into the developer's REAL OpenCode config directory.
 *
 * WHY THIS EXISTS
 * ---------------
 * `tests/tarball-packaging.test.mjs` used to install our own packed tarball with
 * `npm install <tarball>`. That runs the package's `postinstall` →
 * `sync-tui.mjs`, which resolves the *user's* config dir and then copies the
 * repo's src/plugins/tui over the live ~/.config/opencode/plugins/pantheon-tui
 * and runs `npm ci --omit=dev` in it. The failure mode was SILENT: the suite
 * passed while rewriting the developer's environment, because the bytes written
 * happened to match what was already on disk.
 *
 * SCOPE (stated honestly — this is narrower than "never writes outside")
 * This guard covers child-process invocations that can reach a config-dir
 * writer: `npm install`/`npm ci` (which run lifecycle scripts) and direct
 * spawns of the two config-writing scripts. It does NOT cover:
 *   - in-process writes by a test via fs APIs
 *   - ordinary npm side effects such as the shared ~/.npm cache
 *   - transient SQLite sidecars. Observed in full-suite runs: the `-shm` and
 *     `-wal` files of both memory/memory.db and .pantheon/persistence/project.db
 *     (4 paths). Attribution evidence: each changed in runs that executed no
 *     SQLite-writing test to a differing hash, and all four are SQLite runtime
 *     scratch owned by the LIVE MCP servers rather than installation content,
 *     so the change is attributed to the ambient running server, not the suite.
 *     None is config content and none is written by an installer.
 * Those are real but low severity, and are out of scope here by design.
 *
 * WHY ONLY XDG_CONFIG_HOME COUNTS AS A REDIRECT
 * ---------------------------------------------
 * The scripts this guard names do NOT honor PANTHEON_HOME:
 *   - scripts/sync-tui.mjs:49-58 (resolveConfigDir) reads only
 *     XDG_CONFIG_HOME, then falls back to ~/.opencode. It has no PANTHEON_HOME
 *     branch at all.
 *   - scripts/sync-artifacts.mjs receives configDir as an argument; every
 *     writer inside it (agents, routing.yml, skills, AGENTS.md, commands, MCP
 *     scripts, code-mode payload, tiers.json) targets whatever dir it is handed,
 *     which for sync-tui is the XDG-resolved one.
 * Other consumers DO honor PANTHEON_HOME — scripts/prune.mjs:47,
 * scripts/uninstall.mjs:82, scripts/doctor.mjs:266 and src/mcp/_pantheon_paths.py:35
 * — but none of them is reachable from an npm lifecycle or from a direct
 * sync-tui/sync-artifacts spawn, so accepting PANTHEON_HOME here would certify
 * a redirect that does not actually sandbox anything.
 *
 * THIS APPLIES TO THE npm BRANCH TOO, deliberately. `npm install <our tarball>`
 * is flagged as a config-dir writer precisely because it runs `postinstall` →
 * sync-tui.mjs, and sync-tui ignores PANTHEON_HOME. So an `npm install` sandboxed
 * with PANTHEON_HOME alone would pass this guard and still rewrite the live
 * config — the exact original bug. The npm branch is therefore as strict as the
 * script branch, accepting only XDG_CONFIG_HOME. Do not "helpfully" add
 * PANTHEON_HOME back to either branch without first adding a PANTHEON_HOME
 * branch to scripts/sync-tui.mjs resolveConfigDir().
 *
 * ESCAPE HATCH
 * ------------
 * A false positive is suppressed with a `guard:allow <reason>` comment on the
 * offending line or the line above it. The reason is mandatory and the
 * allowlisted lines are printed by the test, so every exemption is visible at
 * review time rather than becoming invisible dead space.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'

const ROOT = process.cwd()
const TESTS_DIR = join(ROOT, 'tests')

/** This file embeds deliberately-bad source strings as detector fixtures. */
const SELF = 'no-live-config-writes.test.mjs'

/**
 * scripts/ that mutate the user's config dir when run. `postinstall.mjs` is
 * deliberately absent: it only validates the Node major and prints a banner.
 * `sync-artifacts.mjs` is present because sync-tui.mjs:150,195 calls it and it
 * writes agents, routing.yml, skills, AGENTS.md, commands, MCP scripts and the
 * code-mode payload into configDir.
 */
const SIDE_EFFECTING_SCRIPTS = ['sync-tui.mjs', 'sync-artifacts.mjs']

/** Env var that actually redirects the config dir for the scripts above. */
const REDIRECT_KEY = 'XDG_CONFIG_HOME'

const CHILD_PROCESS_CALLS = ['execFileSync', 'execSync', 'spawnSync', 'spawn', 'execFile', 'exec']

/** Recursively collect scannable sources under tests/. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full, out)
      continue
    }
    if (/\.(mjs|cjs|js|ts|py)$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * Every identifier in this file that must be treated as a child-process call.
 * That is the node:child_process API itself, plus any `import { x as y }` alias
 * and any local wrapper binding — both defeat a naive callee regex, and both
 * are idiomatic in this test suite (tests/pantheon/helpers/ wraps spawns).
 * @param {string} src
 * @returns {string[]}
 */
function calleeNames(src) {
  const names = new Set(CHILD_PROCESS_CALLS)
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]node:child_process['"]/g)) {
    for (const part of m[1].split(',')) {
      const as = part.match(/^\s*(\w+)\s+as\s+(\w+)\s*$/)
      if (as && CHILD_PROCESS_CALLS.includes(as[1])) names.add(as[2])
    }
  }
  for (const m of src.matchAll(
    /\b(?:const|let|var|function)\s+(\w+)\s*(?:=|\([^)]*\)\s*(?:=>|\{))[^;\n]*?\b(\w+)\s*\(/g,
  )) {
    if (CHILD_PROCESS_CALLS.includes(m[2])) names.add(m[1])
  }
  return [...names]
}

/**
 * Match child-process invocations and capture their source text.
 * @param {string} src
 * @returns {{ command: string, args: string, options: string, index: number, kind: string, text: string }[]}
 */
function findInvocations(src) {
  const out = []
  const callRe = new RegExp(`\\b(${calleeNames(src).join('|')})\\s*\\(`, 'g')
  let m = callRe.exec(src)
  while (m !== null) {
    const open = m.index + m[0].length - 1
    let depth = 0
    let end = -1
    for (let i = open; i < src.length; i++) {
      const c = src[i]
      if (c === '(') depth++
      else if (c === ')') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) {
      m = callRe.exec(src)
      continue
    }
    const body = src.slice(open + 1, end)
    const parts = []
    let depth2 = 0
    let cur = ''
    for (const c of body) {
      if ('([{'.includes(c)) depth2++
      else if (')]}'.includes(c)) depth2--
      if (c === ',' && depth2 === 0) {
        parts.push(cur)
        cur = ''
      } else cur += c
    }
    parts.push(cur)
    out.push({
      command: parts[0] ?? '',
      args: parts[1] ?? '',
      options: parts.slice(2).join(','),
      index: m.index,
      kind: m[1],
      text: body,
    })
    m = callRe.exec(src)
  }
  return out
}

/**
 * Classify an invocation. Returns 'npm', 'script' or null.
 * Handles both the array form (`npm`, ['install', …]) and the shell-string form
 * (`execSync('npm install ' + tarball)`) that sync-tui.mjs:176 itself uses.
 */
function classify(inv) {
  const text = `${inv.command} ${inv.args}`
  const arrayNpm = /['"`]npm['"`]/.test(inv.command) && /\b(install|ci)\b/.test(inv.args)
  const shellNpm = /\bnpm\s+(install|ci)\b/.test(text)
  if (arrayNpm || shellNpm) return 'npm'
  if (SIDE_EFFECTING_SCRIPTS.some((s) => text.includes(s))) return 'script'
  return null
}

/**
 * Is this invocation sandboxed? --ignore-scripts only counts for npm calls —
 * it is meaningless to a direct `node script.mjs` spawn, so it must not be
 * allowed to excuse one.
 */
function isIsolated(inv, kind) {
  if (new RegExp(REDIRECT_KEY).test(inv.options)) return true
  if (kind === 'npm' && /--ignore-scripts/.test(inv.args)) return true
  return false
}

/**
 * Is this line, or the one above it, carrying a documented exemption?
 * `at` is a ZERO-INDEXED line number, not a character offset — mixing the two
 * silently disables the escape hatch (the looked-up lines become `undefined`).
 * @param {string[]} lines
 * @param {number} at zero-indexed line of the call site
 * @param {string} [text] the invocation's own source, so a trailing comment
 *   inside a multi-line call is also honoured
 * @returns {string|null} the stated reason, or null
 */
function exemptionFor(lines, at, text) {
  for (const candidate of [lines[at], lines[at - 1], text]) {
    if (candidate && /guard:allow\s+\S/.test(candidate)) {
      return candidate.match(/guard:allow\s+(.*)$/m)[1].trim()
    }
  }
  return null
}

/**
 * Scan one JS/TS source. Returns violations and documented exemptions.
 * @param {string} src
 * @returns {{ violations: string[], allowed: string[] }}
 */
export function findViolations(src) {
  const violations = []
  const allowed = []
  for (const inv of findInvocations(src)) {
    const kind = classify(inv)
    if (!kind) continue
    if (isIsolated(inv, kind)) continue
    const line = src.slice(0, inv.index).split('\n').length
    const reason = exemptionFor(src.split('\n'), line - 1, inv.text)
    if (reason) {
      allowed.push(`line ${line}: ${reason}`)
      continue
    }
    const what = kind === 'npm' ? 'npm install/ci' : 'side-effecting script'
    violations.push(`line ${line}: ${what} without a config-dir redirect`)
  }
  return { violations, allowed }
}

/**
 * Python equivalent: subprocess.run/call/Popen/check_output with npm
 * install/ci, or a direct spawn of a config-writing script. test:ci runs the
 * .py tests, so an unscanned Python test could sail straight through.
 * @param {string} src
 * @returns {{ violations: string[], allowed: string[] }}
 */
export function findPythonViolations(src) {
  const violations = []
  const allowed = []
  const lines = src.split('\n')
  lines.forEach((line, i) => {
    if (!/subprocess\.(run|call|check_call|check_output|Popen)\s*\(/.test(line)) return
    const window = lines.slice(i, i + 6).join('\n')
    const isNpm = /['"]npm['"]/.test(window) && /\b(install|ci)\b/.test(window)
    const isScript = SIDE_EFFECTING_SCRIPTS.some((s) => window.includes(s))
    if (!isNpm && !isScript) return
    if (new RegExp(REDIRECT_KEY).test(window)) return
    if (isNpm && /--ignore-scripts/.test(window)) return
    const reason = exemptionFor(lines, i)
    if (reason) {
      allowed.push(`line ${i + 1}: ${reason}`)
      return
    }
    violations.push(`line ${i + 1}: python subprocess without a config-dir redirect`)
  })
  return { violations, allowed }
}

// ── The guard itself ───────────────────────────────────────────────────────

test('no test spawns a config-dir writer without redirecting the target', () => {
  const files = walk(TESTS_DIR).filter((f) => !f.endsWith(SELF))
  assert.ok(files.length > 40, `expected a populated tests/ tree, saw ${files.length} files`)

  const violations = []
  const allowed = []
  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    const { violations: v, allowed: a } = file.endsWith('.py')
      ? findPythonViolations(src)
      : findViolations(src)
    for (const item of v) violations.push(`${relative(ROOT, file)} ${item}`)
    for (const item of a) allowed.push(`${relative(ROOT, file)} ${item}`)
  }

  assert.deepEqual(
    violations,
    [],
    'These tests can write into the real OpenCode config dir.\n' +
      'A test that installs our own tarball (or spawns sync-tui / sync-artifacts)\n' +
      'runs a lifecycle or script that rewrites ~/.config/opencode — including\n' +
      '`npm ci --omit=dev` inside the live plugins/pantheon-tui.\n' +
      `Pass env: { ...process.env, ${REDIRECT_KEY}: <mkdtemp sandbox> } and make\n` +
      'sure the sandbox CONTAINS an `opencode` dir, else sync-tui falls through\n' +
      'to the real ~/.opencode. PANTHEON_HOME does NOT work for these scripts.\n' +
      'If a hit is genuinely safe, annotate the line with `guard:allow <reason>`.\n' +
      'Offending lines:\n  - ' +
      violations.join('\n  - '),
  )

  // Exemptions must stay visible so they get reviewed rather than accumulating.
  if (allowed.length > 0) {
    console.log(`  guard:allow exemptions in effect (${allowed.length}):`)
    for (const a of allowed) console.log(`    - ${a}`)
  }
})

// ── Non-vacuity ────────────────────────────────────────────────────────────
// These encode the detector's assumptions. They cannot prove those assumptions
// correct (a follow-up replaces them with independent known-bad/known-good
// corpora), but they do pin the specific shapes the detector claims to catch.

test('detector flags the direct array-form shapes', () => {
  assert.equal(
    findViolations(
      `execFileSync('npm', ['install', '--prefix', work, join(ROOT, tarball)], { encoding: 'utf8' })`,
    ).violations.length,
    1,
  )
  assert.equal(
    findViolations(`execFileSync('npm', ['ci', '--omit=dev', '--no-audit'], { cwd: root })`)
      .violations.length,
    1,
  )
  assert.equal(
    findViolations(
      `spawnSync(process.execPath, [join(ROOT, 'scripts', 'sync-tui.mjs')], { encoding: 'utf8' })`,
    ).violations.length,
    1,
  )
  assert.equal(
    findViolations(`spawnSync(node, [join(ROOT,'scripts','sync-artifacts.mjs')], {})`).violations
      .length,
    1,
  )
})

test('detector flags the shell-string and alias/wrapper idioms', () => {
  // The same shape sync-tui.mjs:176 uses.
  assert.equal(
    findViolations(`execSync('npm install ' + tarball, { cwd: pluginDir })`).violations.length,
    1,
  )
  // Aliased import defeats a naive callee regex.
  assert.equal(
    findViolations(
      `import { execFileSync as cp } from 'node:child_process'\ncp('npm', ['install', tarball])`,
    ).violations.length,
    1,
  )
  // Local wrapper helper.
  assert.equal(
    findViolations(`const run = (c, a) => execFileSync(c, a)\nrun('npm', ['install', tarball])`)
      .violations.length,
    1,
  )
})

test('detector does NOT accept a redirect the scripts ignore', () => {
  // PANTHEON_HOME is honored by prune/uninstall/doctor/_pantheon_paths, but NOT
  // by sync-tui.mjs or sync-artifacts.mjs, so it must not pass here.
  const withPantheonHome = findViolations(
    `spawnSync(process.execPath, [join(ROOT, 'scripts', 'sync-tui.mjs')], {
      env: { ...process.env, PANTHEON_HOME: sandbox },
    })`,
  )
  assert.equal(
    withPantheonHome.violations.length,
    1,
    'PANTHEON_HOME does not redirect sync-tui.mjs and must not be accepted',
  )
  const npmWithPantheonHome = findViolations(
    `execFileSync('npm', ['install', tarball], { env: { ...process.env, PANTHEON_HOME: sandbox } })`,
  )
  assert.equal(
    npmWithPantheonHome.violations.length,
    1,
    'the npm lifecycle reaches sync-tui, which ignores PANTHEON_HOME',
  )
})

test('--ignore-scripts only excuses npm, never a direct script spawn', () => {
  assert.deepEqual(
    findViolations(`execFileSync('npm', ['ci', '--ignore-scripts', '--omit=dev'], { cwd: root })`)
      .violations,
    [],
  )
  assert.equal(
    findViolations(`spawnSync(node, [join(ROOT,'scripts','sync-tui.mjs'), '--ignore-scripts'], {})`)
      .violations.length,
    1,
    '--ignore-scripts is meaningless to a direct node spawn and must not excuse it',
  )
})

test('detector accepts a real XDG_CONFIG_HOME redirect', () => {
  assert.deepEqual(
    findViolations(`execFileSync('npm', ['install', '--prefix', work, tarball], {
      encoding: 'utf8',
      env: { ...process.env, XDG_CONFIG_HOME: sandboxConfig },
    })`).violations,
    [],
  )
  assert.deepEqual(
    findViolations(`spawnSync(process.execPath, [join(ROOT,'scripts','sync-tui.mjs')], {
      env: { ...process.env, XDG_CONFIG_HOME: sandboxConfig },
    })`).violations,
    [],
  )
})

test('detector does not flag inert shapes', () => {
  // postinstall.mjs prints a banner and checks the Node major; it writes nothing.
  assert.deepEqual(
    findViolations(`spawnSync(node, [join(ROOT,'scripts','postinstall.mjs')], {})`).violations,
    [],
  )
  // npm pack runs prepack, which builds; it writes no config dir.
  assert.deepEqual(
    findViolations(`execFileSync('npm', ['pack', '--json'], { cwd: ROOT })`).violations,
    [],
  )
  // A test-local npm shim is a file write, not an invocation.
  assert.deepEqual(
    findViolations(`writeFileSync(join(bin, 'npm'), '#!/usr/bin/env bash\\nexit 0\\n')`).violations,
    [],
  )
  // The build step is not an install.
  assert.deepEqual(
    findViolations(`spawnSync('npm', ['run', 'build', '--prefix', 'src/plugins/tui'], {})`)
      .violations,
    [],
  )
})

test('a documented guard:allow exemption suppresses and is reported', () => {
  const { violations, allowed } = findViolations(`execFileSync('npm', ['install', tarball], {
  encoding: 'utf8', // guard:allow installs a fixture whose postinstall is a no-op stub
})`)
  assert.deepEqual(violations, [])
  assert.equal(allowed.length, 1)
  assert.match(allowed[0], /guard:allow|fixture/)
})

test('python subprocess calls are scanned too', () => {
  const bad = `import subprocess
subprocess.run(['npm', 'install', tarball], check=True)
`
  assert.equal(findPythonViolations(bad).violations.length, 1)
  const badScript = `import subprocess
subprocess.run(['node', 'scripts/sync-tui.mjs'], check=True)
`
  assert.equal(findPythonViolations(badScript).violations.length, 1)
  const good = `import os, subprocess
subprocess.run(['npm', 'install', tarball], env={**os.environ, 'XDG_CONFIG_HOME': sandbox})
`
  assert.deepEqual(findPythonViolations(good).violations, [])
  assert.deepEqual(
    findPythonViolations(`import subprocess\nsubprocess.run(['git','status'])\n`).violations,
    [],
  )
})

test('a python guard:allow exemption is honoured, and its absence re-flags', () => {
  // The exemption lookup was once handed a character offset where a line index
  // was expected, so the looked-up lines were always undefined and a legitimate
  // python exemption could never be applied. If the escape hatch cannot be
  // reached, the first false positive gets the whole guard deleted instead.
  const exempted = `import subprocess
# guard:allow fixture package whose postinstall is a local no-op stub
subprocess.run(['npm', 'install', tarball], check=True)
`
  const withReason = findPythonViolations(exempted)
  assert.deepEqual(withReason.violations, [], 'the guard:allow line must suppress the violation')
  assert.equal(withReason.allowed.length, 1)
  assert.match(withReason.allowed[0], /no-op stub/)

  // Same source with the reason removed must be flagged again — the exemption
  // has to come from the stated reason, not from an incidental match.
  const withoutReason = exempted.replace(
    '# guard:allow fixture package whose postinstall is a local no-op stub\n',
    '',
  )
  const reFlagged = findPythonViolations(withoutReason)
  assert.equal(reFlagged.violations.length, 1, 'removing the reason must re-flag the call')
  assert.deepEqual(reFlagged.allowed, [])

  // A bare marker with no reason is not an exemption.
  assert.equal(
    findPythonViolations(`import subprocess
# guard:allow
subprocess.run(['npm', 'install', tarball], check=True)
`).violations.length,
    1,
  )
})
