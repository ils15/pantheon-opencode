/**
 * F3 — the pre-commit guard rejects staged `.pantheon/` runtime state while
 * keeping the versioned exceptions (ADRs, code-mode payload) and files that are
 * already tracked working. Runs the real hook script against real staged state.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOOK = join(repoRoot, 'scripts', 'hooks', 'check-pantheon-runtime-staged.mjs')

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-runtime-guard-'))
  copyFileSync(join(repoRoot, '.gitignore'), join(dir, '.gitignore'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'guard@test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Guard Test'], { cwd: dir })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  execFileSync('git', ['add', 'README.md'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
  return dir
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
