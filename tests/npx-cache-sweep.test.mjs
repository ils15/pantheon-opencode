import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  findPantheonNpxCacheCopies,
  sweepStalePantheonNpxCaches,
} from '../scripts/install/npx-cache-sweep.mjs'

function fixtureCacheRoot() {
  const root = join(tmpdir(), `pantheon-sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  return root
}

function makeCopy(cacheRoot, hash, version) {
  const dir = join(cacheRoot, '_npx', hash, 'node_modules', 'pantheon-opencode')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pantheon-opencode', version }))
  return dir
}

function makeNeighbor(cacheRoot, hash) {
  const dir = join(cacheRoot, '_npx', hash, 'node_modules', 'some-other-package')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'some-other-package' }))
  return dir
}

test('find lists every pantheon-opencode copy with its version', async () => {
  const cacheRoot = fixtureCacheRoot()
  try {
    const a = makeCopy(cacheRoot, 'aaa111', '1.6.1')
    const b = makeCopy(cacheRoot, 'bbb222', '1.6.2-beta.12')
    const found = await findPantheonNpxCacheCopies({ cacheRoot })
    assert.equal(found.length, 2)
    const versions = found.map((c) => c.version).sort()
    assert.deepEqual(versions, ['1.6.1', '1.6.2-beta.12'])
    assert.ok(found.every((c) => c.dir === a || c.dir === b))
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true })
  }
})

test('find ignores cache entries without a pantheon-opencode copy', async () => {
  const cacheRoot = fixtureCacheRoot()
  try {
    makeNeighbor(cacheRoot, 'ccc333')
    const found = await findPantheonNpxCacheCopies({ cacheRoot })
    assert.equal(found.length, 0)
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true })
  }
})

test('find tolerates a missing cache root', async () => {
  const found = await findPantheonNpxCacheCopies({ cacheRoot: join(tmpdir(), 'pantheon-nope') })
  assert.deepEqual(found, [])
})

test('sweep removes stale copies and keeps the active one', async () => {
  const cacheRoot = fixtureCacheRoot()
  try {
    const stale = makeCopy(cacheRoot, 'aaa111', '1.6.1')
    const active = makeCopy(cacheRoot, 'bbb222', '1.6.2-beta.12')
    const neighbor = makeNeighbor(cacheRoot, 'aaa111')
    const result = await sweepStalePantheonNpxCaches({ keep: active, cacheRoot })
    assert.deepEqual(result.removed, [stale])
    // The active copy and the unrelated neighbor both survive.
    const kept = await findPantheonNpxCacheCopies({ cacheRoot })
    assert.deepEqual(
      kept.map((c) => c.version),
      ['1.6.2-beta.12'],
    )
    assert.ok(existsSync(neighbor), 'unrelated package in the same cache entry must survive')
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true })
  }
})

test('sweep resolves the keep path (trailing separator, relative forms)', async () => {
  const cacheRoot = fixtureCacheRoot()
  try {
    const stale = makeCopy(cacheRoot, 'aaa111', '1.6.1')
    const active = makeCopy(cacheRoot, 'bbb222', '1.6.2-beta.12')
    const result = await sweepStalePantheonNpxCaches({
      keep: `${active}${require_node_path_sep()}`,
      cacheRoot,
    })
    assert.deepEqual(result.removed, [stale])
    const kept = await findPantheonNpxCacheCopies({ cacheRoot })
    assert.deepEqual(
      kept.map((c) => c.version),
      ['1.6.2-beta.12'],
    )
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true })
  }
})

function require_node_path_sep() {
  return process.platform === 'win32' ? '\\' : '/'
}

test('sweep with no keep removes nothing and reports all copies', async () => {
  const cacheRoot = fixtureCacheRoot()
  try {
    makeCopy(cacheRoot, 'aaa111', '1.6.1')
    const result = await sweepStalePantheonNpxCaches({ keep: null, cacheRoot })
    assert.deepEqual(result.removed, [])
    const kept = await findPantheonNpxCacheCopies({ cacheRoot })
    assert.equal(kept.length, 1)
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true })
  }
})
