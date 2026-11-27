import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acquireFileLease,
  checkFileLease,
  normalizeLeasePath,
  releaseFileLease,
} from '../../src/pantheon/file-leases.ts'

test('normalizeLeasePath handles POSIX, Windows, relative, and dot-segment paths', () => {
  assert.equal(normalizeLeasePath('src/a.ts', '/repo/app'), '/repo/app/src/a.ts')
  assert.equal(normalizeLeasePath('./src\\sub\\b.ts', '/repo/app/'), '/repo/app/src/sub/b.ts')
  assert.equal(normalizeLeasePath('src/sub/../a.ts', '/repo/app'), '/repo/app/src/a.ts')
  assert.equal(normalizeLeasePath('/repo/app/src/a.ts', '/repo/app'), '/repo/app/src/a.ts')
  assert.equal(normalizeLeasePath('src\\a.ts', 'C:\\repo\\app\\'), 'c:/repo/app/src/a.ts')
  assert.equal(
    normalizeLeasePath('C:\\repo\\app\\src\\a.ts', 'C:/repo/app'),
    'c:/repo/app/src/a.ts',
  )
})

test('checkFileLease allows everything when session has no active lease', () => {
  const sid = 'ses-lease-none'
  releaseFileLease(sid)
  const res = checkFileLease(sid, 'src/anything.ts')
  assert.equal(res.allowed, true)
})

test('checkFileLease enforces ownedFiles and names owner and allowed files on denial', () => {
  const sid = 'ses-lease-owned'
  try {
    acquireFileLease(sid, {
      role: 'worker-alpha',
      rootDir: '/repo/app',
      ownedFiles: ['src/pantheon/file-leases.ts', 'tests\\pantheon\\file-leases.test.ts'],
    })

    assert.equal(checkFileLease(sid, 'src/pantheon/file-leases.ts').allowed, true)
    assert.equal(checkFileLease(sid, '/repo/app/src/pantheon/file-leases.ts').allowed, true)
    assert.equal(checkFileLease(sid, 'tests/pantheon/file-leases.test.ts').allowed, true)

    const denied = checkFileLease(sid, 'src/plugin.ts')
    assert.equal(denied.allowed, false)
    assert.equal(denied.owner, 'worker-alpha')
    assert.ok(denied.reason?.includes('worker-alpha'))
    assert.ok(denied.reason?.includes('src/pantheon/file-leases.ts'))

    // Prefix-similar path must not match exact file lease
    const prefixDenied = checkFileLease(sid, 'src/pantheon/file-leases.ts.bak')
    assert.equal(prefixDenied.allowed, false)
  } finally {
    releaseFileLease(sid)
  }
})

test('checkFileLease enforces forbiddenFiles even when ownedFiles is empty or broader', () => {
  const sid = 'ses-lease-forbidden'
  try {
    acquireFileLease(sid, {
      role: 'worker-beta',
      rootDir: '/repo/app',
      ownedFiles: ['src'],
      forbiddenFiles: ['src/secrets.ts', '.env'],
    })

    assert.equal(checkFileLease(sid, 'src/ok.ts').allowed, true)

    const deniedSecret = checkFileLease(sid, 'src/secrets.ts')
    assert.equal(deniedSecret.allowed, false)
    assert.ok(deniedSecret.reason?.includes('worker-beta'))
    assert.ok(deniedSecret.reason?.includes('forbidden'))

    const deniedEnv = checkFileLease(sid, '/repo/app/.env')
    assert.equal(deniedEnv.allowed, false)
  } finally {
    releaseFileLease(sid)
  }
})

test('releaseFileLease removes lease and restores unrestricted access', () => {
  const sid = 'ses-lease-release'
  acquireFileLease(sid, {
    role: 'worker-gamma',
    rootDir: '/repo/app',
    ownedFiles: ['src/only.ts'],
  })
  assert.equal(checkFileLease(sid, 'src/other.ts').allowed, false)
  assert.equal(releaseFileLease(sid), true)
  assert.equal(releaseFileLease(sid), false)
  assert.equal(checkFileLease(sid, 'src/other.ts').allowed, true)
})

test('globalThis registry shares leases across distinct module references', () => {
  const sid = 'ses-lease-global'
  try {
    acquireFileLease(sid, {
      role: 'shared-owner',
      rootDir: '/repo/app',
      ownedFiles: ['src/a.ts'],
    })
    const registry = (globalThis as Record<string, unknown>).__pantheonFileLeases as Map<
      string,
      unknown
    >
    assert.ok(registry instanceof Map)
    assert.equal(registry.has(sid), true)
  } finally {
    releaseFileLease(sid)
  }
})
