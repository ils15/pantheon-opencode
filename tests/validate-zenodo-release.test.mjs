import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  validateZenodoConfiguration,
  validateZenodoRelease,
} from '../scripts/validate-zenodo-release.mjs'
import {
  parseZenodoMarker,
  validateZenodoResponse,
  zenodoMarker,
} from '../scripts/zenodo-release-state.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'zenodo-release-'))
  mkdirSync(join(root, 'src/plugins/tui'), { recursive: true })
  cpSync(join(process.cwd(), 'package.json'), join(root, 'package.json'))
  cpSync(join(process.cwd(), 'plugin.json'), join(root, 'plugin.json'))
  cpSync(join(process.cwd(), 'pyproject.toml'), join(root, 'pyproject.toml'))
  cpSync(
    join(process.cwd(), 'src/plugins/tui/package.json'),
    join(root, 'src/plugins/tui/package.json'),
  )
  return root
}

test('accepts a matching stable release and optional citation', () => {
  const root = fixture()
  writeFileSync(join(root, 'CITATION.cff'), 'cff-version: 1.2.0\nversion: 1.4.3\n')
  assert.deepEqual(validateZenodoRelease(root, 'v1.4.3').citation, {
    present: true,
    version: '1.4.3',
  })
})

test('rejects a tag that differs from the manifests', () => {
  assert.throws(() => validateZenodoRelease(fixture(), 'v1.4.4'), /does not match package.json/)
})

test('rejects a mismatching citation version', () => {
  const root = fixture()
  writeFileSync(join(root, 'CITATION.cff'), 'version: 9.9.9\n')
  assert.throws(() => validateZenodoRelease(root, 'v1.4.3'), /CITATION.cff version differs/)
})

test('validates absolute HTTPS Zenodo URLs, expected placeholders, and matching host', () => {
  assert.equal(
    validateZenodoConfiguration({
      depositionsUrl: 'https://zenodo.org/api/deposit/depositions',
      filesUrlTemplate: 'https://zenodo.org/api/deposit/depositions/{id}/files',
      publishUrlTemplate: 'https://zenodo.org/api/deposit/depositions/{id}/actions/publish',
      creatorName: 'Test Author',
    }),
    true,
  )
  assert.throws(
    () =>
      validateZenodoConfiguration({
        depositionsUrl: 'http://zenodo.org/api/deposit/depositions',
        filesUrlTemplate: 'https://zenodo.org/api/deposit/depositions/{id}/files',
        publishUrlTemplate: 'https://zenodo.org/api/deposit/depositions/{id}/actions/publish',
        creatorName: 'Test Author',
      }),
    /absolute HTTPS/,
  )
  assert.throws(
    () =>
      validateZenodoConfiguration({
        depositionsUrl: 'https://zenodo.org/api/deposit/depositions',
        filesUrlTemplate: 'https://evil.example/{id}/files',
        publishUrlTemplate: 'https://zenodo.org/api/deposit/depositions/{id}/actions/publish',
        creatorName: 'Test Author',
      }),
    /host/,
  )
  assert.throws(
    () =>
      validateZenodoConfiguration({
        depositionsUrl: 'https://zenodo.org/api/deposit/depositions',
        filesUrlTemplate: 'https://zenodo.org/api/deposit/depositions/{id}/{record}',
        publishUrlTemplate: 'https://zenodo.org/api/deposit/depositions/{id}/actions/publish',
        creatorName: 'Test Author',
      }),
    /placeholder/,
  )
})

test('rejects malformed Zenodo responses and missing publication DOI', () => {
  assert.throws(() => validateZenodoResponse({ id: '42' }), /valid deposition id/)
  assert.throws(() => validateZenodoResponse({ id: 42 }, { requireDoi: true }), /valid DOI/)
  assert.deepEqual(
    validateZenodoResponse(
      { id: 42, metadata: { doi: '10.5281/zenodo.42' } },
      { requireDoi: true },
    ),
    {
      id: 42,
      doi: '10.5281/zenodo.42',
    },
  )
})

test('marker makes creation reruns fail closed and preserves the returned DOI', () => {
  const pending = zenodoMarker({ state: 'pending', claim: 'run-1' })
  assert.deepEqual(parseZenodoMarker(`notes\n${pending}`), {
    id: null,
    doi: null,
    state: 'pending',
    claim: 'run-1',
  })
  const published = zenodoMarker({ id: 42, doi: '10.5281/zenodo.42', state: 'published' })
  assert.deepEqual(parseZenodoMarker(published), {
    id: 42,
    doi: '10.5281/zenodo.42',
    state: 'published',
    claim: null,
  })
  assert.deepEqual(parseZenodoMarker('<!-- zenodo-deposition-id:42 -->'), {
    id: 42,
    doi: null,
    state: 'created',
    claim: null,
  })
})
