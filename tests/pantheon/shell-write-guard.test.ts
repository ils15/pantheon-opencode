import assert from 'node:assert/strict'
import test from 'node:test'
import { acquireFileLease, releaseFileLease } from '../../src/pantheon/file-leases.ts'
import {
  checkShellWriteLease,
  extractShellWriteTargets,
} from '../../src/pantheon/shell-write-guard.ts'

test('extractShellWriteTargets detects POSIX redirections and ignores fd redirects and /dev/null', () => {
  assert.deepEqual(extractShellWriteTargets('echo hi > out.txt'), ['out.txt'])
  assert.deepEqual(extractShellWriteTargets('echo hi >> "dir/my file.txt"'), ['dir/my file.txt'])
  assert.deepEqual(extractShellWriteTargets('cmd 2> err.log 1>>out.log'), ['err.log', 'out.log'])
  assert.deepEqual(extractShellWriteTargets('npm test > /dev/null 2>&1'), [])
  assert.deepEqual(extractShellWriteTargets('echo "a > b"'), [])
})

test('extractShellWriteTargets detects tee, sed -i, cp, mv, rm, touch', () => {
  assert.deepEqual(extractShellWriteTargets('cat a.txt | tee -a b.txt c.txt'), ['b.txt', 'c.txt'])
  assert.deepEqual(extractShellWriteTargets("sed -i 's/a/b/g' src/app.ts"), ['src/app.ts'])
  assert.deepEqual(extractShellWriteTargets("sed -i.bak -e 's/a/b/' a.ts b.ts"), ['a.ts', 'b.ts'])
  assert.deepEqual(extractShellWriteTargets("sed -i '' 's/a/b/' mac.ts"), ['mac.ts'])
  assert.deepEqual(extractShellWriteTargets('cp -r src/a.ts src/b.ts'), ['src/b.ts'])
  assert.deepEqual(extractShellWriteTargets('mv old.ts new.ts'), ['old.ts', 'new.ts'])
  assert.deepEqual(extractShellWriteTargets('rm -rf dist build/out.js'), ['dist', 'build/out.js'])
  assert.deepEqual(extractShellWriteTargets('touch -c a.txt b.txt'), ['a.txt', 'b.txt'])
})

test('extractShellWriteTargets detects PowerShell write cmdlets and nested shells', () => {
  assert.deepEqual(extractShellWriteTargets('Set-Content -Path "src\\a.ts" -Value "x"'), [
    'src\\a.ts',
  ])
  assert.deepEqual(extractShellWriteTargets('"x" | Out-File -FilePath out.log -Encoding utf8'), [
    'out.log',
  ])
  assert.deepEqual(extractShellWriteTargets('Add-Content notes.md "line"'), ['notes.md'])
  assert.deepEqual(extractShellWriteTargets('Remove-Item -Path a.txt -Force'), ['a.txt'])
  assert.deepEqual(extractShellWriteTargets('bash -c "echo x > nested.txt"'), ['nested.txt'])
})

test('checkShellWriteLease blocks shell writes outside ownedFiles or inside forbiddenFiles', () => {
  const sid = 'ses-shell-lease'
  try {
    acquireFileLease(sid, {
      role: 'shell-worker',
      rootDir: '/repo/app',
      ownedFiles: ['src/allowed.ts'],
      forbiddenFiles: ['.env'],
    })

    assert.equal(checkShellWriteLease(sid, 'echo ok > src/allowed.ts').allowed, true)
    assert.equal(checkShellWriteLease(sid, 'git status && npm test > /dev/null 2>&1').allowed, true)

    const blocked = checkShellWriteLease(sid, 'sed -i "s/a/b/" src/other.ts')
    assert.equal(blocked.allowed, false)
    assert.ok(blocked.reason?.includes('shell-worker'))
    assert.ok(blocked.reason?.includes('src/allowed.ts'))

    const blockedPs = checkShellWriteLease(sid, 'Set-Content -Path .env -Value SECRET')
    assert.equal(blockedPs.allowed, false)
  } finally {
    releaseFileLease(sid)
  }
})
