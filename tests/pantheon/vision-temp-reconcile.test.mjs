import assert from 'node:assert/strict'
import { mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  adoptOrphanTempImages,
  forgetTempFile,
  reconcileTempImagesOnce,
  sweepStrayTempWrites,
  TEMP_FILE_GRACE_MS,
  tempFileLRU,
} from '../../src/pantheon/vision.ts'

const OLD = 'a'.repeat(64)
const MID = 'b'.repeat(64)
const LIVE = 'c'.repeat(64)

function scratch() {
  return mkdtempSync(join(tmpdir(), 'pantheon-vision-reconcile-'))
}

function image(dir, hash, ext = 'png') {
  const path = join(dir, `${hash}.${ext}`)
  writeFileSync(path, hash)
  return path
}

function age(path, msBeforeNow) {
  utimesSync(path, new Date(Date.now() - msBeforeNow), new Date(Date.now() - msBeforeNow))
}

describe('adoptOrphanTempImages', () => {
  it('adopts content-hash files with their on-disk mtime, oldest first', () => {
    const dir = scratch()
    const oldPath = image(dir, OLD)
    const midPath = image(dir, MID, 'jpg')
    age(oldPath, 3 * 60 * 60 * 1000)
    age(midPath, 30 * 60 * 1000)
    forgetTempFile(oldPath)
    forgetTempFile(midPath)

    const adopted = adoptOrphanTempImages(dir)
    assert.equal(adopted, 2)
    // Insertion order = eviction order: the OLDER file must sit at the front.
    const keys = [...tempFileLRU.keys()]
    assert.ok(keys.indexOf(oldPath) < keys.indexOf(midPath))
    assert.ok(tempFileLRU.get(oldPath) < tempFileLRU.get(midPath))
    forgetTempFile(oldPath)
    forgetTempFile(midPath)
  })

  it('never touches files already registered (a live entry keeps its recency)', () => {
    const dir = scratch()
    const livePath = image(dir, LIVE)
    const stalePath = image(dir, OLD)
    age(livePath, 5 * 60 * 60 * 1000) // on disk it looks ancient
    age(stalePath, 4 * 60 * 60 * 1000)
    tempFileLRU.set(livePath, Date.now()) // but this process just touched it
    forgetTempFile(stalePath)

    adoptOrphanTempImages(dir)
    assert.ok(tempFileLRU.get(livePath) > Date.now() - 1000)
    assert.equal(tempFileLRU.has(stalePath), true)
    forgetTempFile(livePath)
    forgetTempFile(stalePath)
  })

  it('ignores non content-hash names and returns 0 for a missing dir', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'notes.txt'), 'not an image')
    writeFileSync(join(dir, `${'d'.repeat(63)}.png`), 'short hash')
    forgetTempFile(join(dir, 'notes.txt'))

    assert.equal(adoptOrphanTempImages(dir), 0)
    assert.equal(adoptOrphanTempImages(join(dir, 'does-not-exist')), 0)
  })
})

describe('sweepStrayTempWrites', () => {
  it('unlinks old .tmp-<pid> strays and keeps young ones and real images', () => {
    const dir = scratch()
    const deadStray = join(dir, `${OLD}.png.tmp-1234`)
    const liveStray = join(dir, `${MID}.png.tmp-9999`)
    const real = image(dir, OLD)
    writeFileSync(deadStray, 'partial')
    writeFileSync(liveStray, 'partial')
    age(deadStray, TEMP_FILE_GRACE_MS + 60_000)

    const swept = sweepStrayTempWrites(dir)
    assert.equal(swept, 1)
    assert.equal(missing(deadStray), true)
    assert.equal(missing(liveStray), false) // a concurrent live write elsewhere
    assert.equal(missing(real), false) // real images are never strays
  })

  it('returns 0 for a missing dir and respects a custom grace', () => {
    const dir = scratch()
    assert.equal(sweepStrayTempWrites(join(dir, 'nope')), 0)
    const stray = join(dir, `${OLD}.jpg.tmp-77`)
    writeFileSync(stray, 'partial')
    age(stray, 1_000)
    assert.equal(sweepStrayTempWrites(dir, Date.now(), 60_000), 0)
    assert.equal(sweepStrayTempWrites(dir, Date.now(), 100), 1)
  })
})

describe('reconcileTempImagesOnce', () => {
  it('runs both passes per dir exactly once, then is a no-op', () => {
    const dir = scratch()
    const oldPath = image(dir, OLD)
    const stray = join(dir, `${MID}.webp.tmp-42`)
    writeFileSync(stray, 'partial')
    age(oldPath, 2 * 60 * 60 * 1000)
    age(stray, TEMP_FILE_GRACE_MS + 60_000)
    forgetTempFile(oldPath)

    const first = reconcileTempImagesOnce(dir)
    assert.equal(first.adopted, 1)
    assert.equal(first.swept, 1)
    assert.equal(tempFileLRU.has(oldPath), true)
    assert.equal(missing(stray), true)

    const second = reconcileTempImagesOnce(dir)
    assert.deepEqual(second, { adopted: 0, swept: 0 })
    forgetTempFile(oldPath)
  })
})

function missing(path) {
  try {
    statSync(path)
    return false
  } catch {
    return true
  }
}
