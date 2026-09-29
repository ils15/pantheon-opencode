import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const ROOT = resolve(new URL('..', import.meta.url).pathname)
const CODE_MODE = join(ROOT, '.pantheon', 'code-mode')
const FORBIDDEN_MEMORY_BACKENDS = /vector_memory|chromadb|chroma_db/i

function payloadFiles(directory) {
  return readdirSync(directory)
    .map((name) => join(directory, name))
    .filter((path) => statSync(path).isFile())
}

test('code-mode payload contains no retired vector-memory backend references', () => {
  for (const path of payloadFiles(CODE_MODE)) {
    const source = readFileSync(path, 'utf8')
    assert.doesNotMatch(
      source,
      FORBIDDEN_MEMORY_BACKENDS,
      `retired vector-memory backend reference in ${path}`,
    )
  }
})

test('code-mode payload manifest does not approve the retired session save scripts', () => {
  const manifest = JSON.parse(readFileSync(join(CODE_MODE, 'manifest.json'), 'utf8'))
  assert.equal(manifest.scripts['session-end-save.py'], undefined)
  assert.equal(manifest.scripts['session-end-save.sh'], undefined)
})
