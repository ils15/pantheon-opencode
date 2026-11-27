/**
 * F3 — the pre-commit guard rejects staged `.pantheon/` runtime state while
 * keeping the versioned exceptions (ADRs, code-mode payload) and files that are
 * already tracked working. Runs the real hook script against real staged state.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  classifyPath,
  EXCEPTION_PREFIXES,
} from '../../scripts/hooks/check-pantheon-runtime-staged.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOOK = join(repoRoot, 'scripts', 'hooks', 'check-pantheon-runtime-staged.mjs')

function initRepo(dir, { gitignore = null } = {}) {
  if (gitignore !== null) writeFileSync(join(dir, '.gitignore'), gitignore)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'guard@test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Guard Test'], { cwd: dir })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  execFileSync('git', ['add', 'README.md'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
  return dir
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-runtime-guard-'))
  copyFileSync(join(repoRoot, '.gitignore'), join(dir, '.gitignore'))
  return initRepo(dir)
}

/** A repository WITHOUT Pantheon's ignore rules (the fail-open scenario). */
function makeBareRepo(gitignore = null) {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-runtime-guard-bare-'))
  return initRepo(dir, { gitignore })
}

function write(dir, rel, body = 'x\n') {
  mkdirSync(join(dir, dirname(rel)), { recursive: true })
  writeFileSync(join(dir, rel), body)
}

function stage(dir, rel, { force = false } = {}) {
  const args = ['add']
  if (force) args.push('-f')
  args.push('--', rel)
  execFileSync('git', args, { cwd: dir })
}

/** Run the hook the way pre-commit does: the hook resolves root from cwd. */
function runHook(dir, files) {
  const result = spawnSync(process.execPath, [HOOK, ...files], { cwd: dir, encoding: 'utf8' })
  return { code: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

test('F3 blocks staged .pantheon/ledger, board, memory and deepwork paths', () => {
  const dir = makeRepo()
  try {
    const blocked = [
      '.pantheon/ledger/step-ledger.json',
      '.pantheon/board/messages.ndjson',
      '.pantheon/memory/memory.db',
      '.pantheon/deepwork/v235-swarm-hardening/journal.ndjson',
    ]
    write(dir, '.pantheon/ledger/step-ledger.json', '{"version":1,"steps":{}}\n')
    write(dir, '.pantheon/board/messages.ndjson', '{}\n')
    write(dir, '.pantheon/memory/memory.db', 'sqlite\n')
    write(dir, '.pantheon/deepwork/v235-swarm-hardening/journal.ndjson', '{}\n')
    for (const rel of blocked) stage(dir, rel, { force: true })

    const result = runHook(dir, [])
    assert.equal(result.code, 1, result.output)
    for (const rel of blocked) {
      assert.ok(result.output.includes(rel), `message must name ${rel}`)
    }
    assert.match(result.output, /runtime state/)
    assert.match(result.output, /git restore --staged/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F3 blocks a path named exactly .pantheon (file and symlink)', () => {
  for (const kind of ['file', 'symlink']) {
    const dir = makeRepo()
    const outside = mkdtempSync(join(tmpdir(), 'pantheon-runtime-guard-outside-'))
    try {
      if (kind === 'symlink') symlinkSync(outside, join(dir, '.pantheon'))
      else writeFileSync(join(dir, '.pantheon'), 'runtime placeholder\n')
      stage(dir, '.pantheon', { force: true })

      const result = runHook(dir, ['.pantheon'])
      assert.equal(result.code, 1, `${kind}: ${result.output}`)
      assert.ok(result.output.includes('.pantheon'), `${kind} must be named in the message`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  }
})

test('F4 the guard blocks what .gitignore still ignores, including directory-enabler holes', () => {
  const dir = makeRepo()
  try {
    // `!.pantheon/memory-bank/` is a directory enabler, and
    // `!.pantheon/code-mode/` must not un-ignore a nested `.pantheon/`.
    const blocked = [
      '.pantheon/memory-bank/memory.db',
      '.pantheon/memory-bank/MEMORY.md',
      '.pantheon/code-mode/.pantheon/state.json',
    ]
    for (const rel of blocked) write(dir, rel, 'runtime\n')
    for (const rel of blocked) stage(dir, rel, { force: true })

    const result = runHook(dir, blocked)
    assert.equal(result.code, 1, result.output)
    for (const rel of blocked) {
      assert.ok(result.output.includes(rel), `message must name ${rel}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F4 the guard allows what .gitignore un-ignores (code-mode payload, ADRs)', () => {
  const dir = makeRepo()
  try {
    const allowedPaths = [
      '.pantheon/code-mode/foo.ts',
      '.pantheon/code-mode/compress-inline.py',
      '.pantheon/memory-bank/adr/0003-decision.md',
    ]
    write(dir, '.pantheon/code-mode/foo.ts', 'export const x = 1\n')
    write(dir, '.pantheon/code-mode/compress-inline.py', 'print(1)\n')
    write(dir, '.pantheon/memory-bank/adr/0003-decision.md', '# ADR\n')
    for (const rel of allowedPaths) stage(dir, rel)

    const result = runHook(dir, allowedPaths)
    assert.equal(result.code, 0, result.output)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F6 a repository without commits fails closed with an actionable message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-runtime-guard-unborn-'))
  try {
    copyFileSync(join(repoRoot, '.gitignore'), join(dir, '.gitignore'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'guard@test'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Guard Test'], { cwd: dir })
    write(dir, '.pantheon/ledger/step-ledger.json', '{}\n')
    stage(dir, '.pantheon/ledger/step-ledger.json', { force: true })

    const result = runHook(dir, [])
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /no commits yet/)
    assert.match(result.output, /allow-empty/)
    assert.match(result.output, /SKIP=pantheon-runtime-state/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F8 the floor blocks runtime state with no .gitignore at all', () => {
  const dir = makeBareRepo()
  try {
    const blocked = ['.pantheon/ledger/x.json', '.pantheon/state.json', '.pantheon/board/b.json']
    for (const rel of blocked) write(dir, rel, 'runtime\n')
    for (const rel of blocked) stage(dir, rel)

    const result = runHook(dir, [])
    assert.equal(result.code, 1, result.output)
    for (const rel of blocked) {
      assert.ok(result.output.includes(rel), `message must name ${rel}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F8 the floor blocks runtime state when .gitignore only ignores unrelated junk', () => {
  const dir = makeBareRepo('node_modules/\n.DS_Store\n')
  try {
    const blocked = ['.pantheon/ledger/x.json', '.pantheon/state.json', '.pantheon/board/b.json']
    for (const rel of blocked) write(dir, rel, 'runtime\n')
    for (const rel of blocked) stage(dir, rel)

    const result = runHook(dir, [])
    assert.equal(result.code, 1, result.output)
    for (const rel of blocked) {
      assert.ok(result.output.includes(rel), `message must name ${rel}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F8 exceptions are segment-bounded and never cover a nested .pantheon', () => {
  const dir = makeBareRepo()
  try {
    // Allowed without any .gitignore rule (the floor has explicit exceptions).
    const allowed = ['.pantheon/code-mode/foo.ts', '.pantheon/memory-bank/adr/x.md']
    for (const rel of allowed) write(dir, rel, 'versioned\n')
    for (const rel of allowed) stage(dir, rel)

    const allowedRun = runHook(dir, allowed)
    assert.equal(allowedRun.code, 0, allowedRun.output)

    // Nested runtime state under an exception is still runtime state.
    write(dir, '.pantheon/code-mode/.pantheon/state.json', '{}\n')
    stage(dir, '.pantheon/code-mode/.pantheon/state.json')
    const nested = runHook(dir, ['.pantheon/code-mode/.pantheon/state.json'])
    assert.equal(nested.code, 1, nested.output)
    assert.ok(nested.output.includes('.pantheon/code-mode/.pantheon/state.json'))

    // A bare `startsWith` would also allow `code-modeevil.ts`; the segment
    // boundary must not.
    assert.equal(classifyPath('.pantheon/code-modeevil.ts', new Set(), new Set()), 'blocked')
    assert.equal(classifyPath('.pantheon/code-mode/ok.ts', new Set(), new Set()), 'allowed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F8 the versioned exception list stays in parity with .gitignore un-ignore rules', () => {
  const rules = readFileSync(join(repoRoot, '.gitignore'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('!') && line.includes('.pantheon'))
    .map((line) => line.slice(1))

  const unIgnoredPrefixes = []
  for (const body of rules) {
    const relative = body
      .replace(/^\.pantheon\//, '')
      .replace(/\/\*\*$/, '')
      .replace(/\/$/, '')
    // A directory enabler re-ignores its own contents with a later rule
    // (`.pantheon/memory-bank/*`); it is not an exception by itself.
    const contentsReIgnored = readFileSync(join(repoRoot, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .some((line) => line.trim() === `.pantheon/${relative}/*`)
    if (contentsReIgnored && body.endsWith('/') && !body.endsWith('/**')) continue
    unIgnoredPrefixes.push(relative)
  }

  assert.deepEqual(
    [...new Set(unIgnoredPrefixes)].sort(),
    [...EXCEPTION_PREFIXES].sort(),
    'update EXCEPTION_PREFIXES in scripts/hooks/check-pantheon-runtime-staged.mjs when .gitignore un-ignore rules change',
  )

  // And each exception is actually un-ignored by git in this repository.
  for (const prefix of EXCEPTION_PREFIXES) {
    const probe = `.pantheon/${prefix}/__parity_probe__`
    const check = spawnSync('git', ['check-ignore', '--no-index', '-q', '--', probe], {
      cwd: repoRoot,
    })
    assert.notEqual(check.status, 0, `${probe} must not be ignored`)
  }
})

test('F3 allows the versioned exceptions derived from .gitignore un-ignore rules', () => {
  const dir = makeRepo()
  try {
    write(dir, '.pantheon/memory-bank/adr/0001-decide.md', '# ADR\n')
    write(dir, '.pantheon/code-mode/compress-inline.py', 'print(1)\n')
    stage(dir, '.pantheon/memory-bank/adr/0001-decide.md')
    stage(dir, '.pantheon/code-mode/compress-inline.py')

    const result = runHook(dir, [
      '.pantheon/memory-bank/adr/0001-decide.md',
      '.pantheon/code-mode/compress-inline.py',
      'README.md',
    ])
    assert.equal(result.code, 0, result.output)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F3 does not break a file that is already tracked (grandfathered)', () => {
  const dir = makeRepo()
  try {
    // Simulate legacy tracked runtime state committed before the guard existed.
    write(dir, '.pantheon/board/legacy.json', '{}\n')
    stage(dir, '.pantheon/board/legacy.json', { force: true })
    execFileSync('git', ['commit', '-q', '-m', 'legacy runtime snapshot'], { cwd: dir })

    write(dir, '.pantheon/board/legacy.json', '{"updated":true}\n')
    stage(dir, '.pantheon/board/legacy.json', { force: true })

    const result = runHook(dir, ['.pantheon/board/legacy.json'])
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /already tracked/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F3 blocks a force-added ignored file even when the repo tracks other .pantheon paths', () => {
  const dir = makeRepo()
  try {
    write(dir, '.pantheon/memory-bank/adr/0002-keep.md', '# ADR\n')
    stage(dir, '.pantheon/memory-bank/adr/0002-keep.md')
    execFileSync('git', ['commit', '-q', '-m', 'adr'], { cwd: dir })

    write(dir, '.pantheon/ledger/step-ledger.json', '{"version":1,"steps":{"a":1}}\n')
    stage(dir, '.pantheon/ledger/step-ledger.json', { force: true })

    const result = runHook(dir, ['.pantheon/ledger/step-ledger.json'])
    assert.equal(result.code, 1, result.output)
    assert.ok(result.output.includes('.pantheon/ledger/step-ledger.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
