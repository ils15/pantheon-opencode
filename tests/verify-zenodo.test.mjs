import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = fileURLToPath(new URL('../scripts/verify-zenodo.mjs', import.meta.url))
const RECORD_MODULE = fileURLToPath(new URL('../scripts/zenodo-record.mjs', import.meta.url))
const PACKAGE_VERSION = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')).version

async function load() {
  return import(SCRIPT)
}

/** The shape Zenodo's InvenioRDM REST API returns for a concept-DOI lookup. */
function conceptPayload({
  version = '2.4.0',
  recordId = 24621817,
  publicationDate = '2026-11-28',
  size = 5700435,
  conceptrecid = '22650136',
} = {}) {
  return {
    id: recordId,
    conceptrecid,
    doi: `10.5281/zenodo.${recordId}`,
    metadata: {
      title: 'Pantheon Opencode',
      version,
      publication_date: publicationDate,
    },
    files: [{ key: 'ils15/pantheon-opencode-v2.4.0.zip', size }],
  }
}

function stubFetch(payload, { status = 200 } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    }
  }
  fetchImpl.calls = calls
  return fetchImpl
}

test('concept DOI and record id are the concept ones, not a version DOI', async () => {
  const { ZENODO_CONCEPT_RECID, ZENODO_CONCEPT_DOI, ZENODO_CONCEPT_RECORD_URL } = await import(
    RECORD_MODULE
  )

  assert.equal(ZENODO_CONCEPT_RECID, '22650136')
  assert.equal(ZENODO_CONCEPT_DOI, '10.5281/zenodo.22650136')
  assert.equal(ZENODO_CONCEPT_RECORD_URL, 'https://zenodo.org/api/records/22650136')
})

test('passes when the concept latest archived version matches the expected version', async () => {
  const { verifyZenodo } = await load()
  const fetchImpl = stubFetch(conceptPayload())

  const result = await verifyZenodo({ expected: '2.4.0', fetchImpl })

  assert.equal(result.ok, true)
  assert.equal(result.exitCode, 0)
  assert.equal(result.expected, '2.4.0')
  assert.equal(result.latest.version, '2.4.0')
  assert.equal(result.latest.recordId, 24621817)
  assert.equal(result.latest.doi, '10.5281/zenodo.24621817')
  assert.equal(result.latest.publicationDate, '2026-11-28')
  assert.equal(result.latest.fileSize, 5700435)
  assert.equal(result.conceptDoi, '10.5281/zenodo.22650136')
})

test('fails when the concept lags behind the expected version (the v1.x failure mode)', async () => {
  const { verifyZenodo } = await load()
  const fetchImpl = stubFetch(conceptPayload({ version: '2.3.4', recordId: 24590137 }))

  const result = await verifyZenodo({ expected: '2.4.0', fetchImpl })

  assert.equal(result.ok, false)
  assert.equal(result.exitCode, 1)
  assert.equal(result.latest.version, '2.3.4')
  assert.match(result.reason, /2\.3\.4/)
  assert.match(result.reason, /2\.4\.0/)
})

test('reports a Zenodo API error instead of a false pass', async () => {
  const { verifyZenodo, ZenodoVerifyError, ZENODO_EXIT } = await load()
  const fetchImpl = stubFetch({ status: 'error' }, { status: 503 })

  await assert.rejects(
    () => verifyZenodo({ expected: '2.4.0', fetchImpl }),
    (error) => {
      assert.ok(error instanceof ZenodoVerifyError)
      assert.equal(error.exitCode, ZENODO_EXIT.api)
      assert.match(error.message, /503/)
      return true
    },
  )
})

test('reports a network failure as an API error, never as success', async () => {
  const { verifyZenodo, ZENODO_EXIT } = await load()
  const fetchImpl = async () => {
    throw new Error('getaddrinfo ENOTFOUND zenodo.org')
  }

  await assert.rejects(
    () => verifyZenodo({ expected: '2.4.0', fetchImpl }),
    (error) => error.exitCode === ZENODO_EXIT.api && /ENOTFOUND/.test(error.message),
  )
})

test('rejects malformed payloads instead of inventing a version', async () => {
  const { verifyZenodo, ZENODO_EXIT } = await load()
  const malformed = [
    { hits: { total: 0 } },
    { id: 1, conceptrecid: '22650136', metadata: {} },
    { id: 1, conceptrecid: '22650136', metadata: { version: '' } },
    { id: 1, conceptrecid: '22650136', metadata: { version: '2.4.0' }, files: 'nope' },
  ]

  for (const payload of malformed) {
    await assert.rejects(
      () => verifyZenodo({ expected: '2.4.0', fetchImpl: stubFetch(payload) }),
      (error) => error.exitCode === ZENODO_EXIT.payload,
      `expected a payload error for ${JSON.stringify(payload)}`,
    )
  }
})

test('refuses a record that resolves outside the expected concept family', async () => {
  const { verifyZenodo, ZENODO_EXIT } = await load()

  await assert.rejects(
    () =>
      verifyZenodo({
        expected: '2.4.0',
        fetchImpl: stubFetch(conceptPayload({ conceptrecid: '999999' })),
      }),
    (error) => error.exitCode === ZENODO_EXIT.payload && /999999/.test(error.message),
  )
})

test('actually calls the concept-DOI endpoint exactly once (anti-vacuity)', async () => {
  const { verifyZenodo, ZENODO_CONCEPT_RECORD_URL } = await load()
  const fetchImpl = stubFetch(conceptPayload())

  await verifyZenodo({ expected: '2.4.0', fetchImpl })

  assert.equal(fetchImpl.calls.length, 1, 'the verifier must perform one real request')
  assert.equal(fetchImpl.calls[0].url, ZENODO_CONCEPT_RECORD_URL)
  assert.match(fetchImpl.calls[0].url, /22650136/)
  // Zenodo 403s a bare Node fetch; the descriptive User-Agent is required.
  assert.match(String(fetchImpl.calls[0].init?.headers?.['user-agent'] ?? ''), /pantheon/)
  assert.equal(fetchImpl.calls[0].init?.headers?.accept, 'application/json')
})

test('runCli defaults --expected to package.json and emits a JSON report', async () => {
  const { runCli } = await load()
  const fetchImpl = stubFetch(conceptPayload({ version: PACKAGE_VERSION }))

  const { exitCode, stdout } = await runCli({ argv: ['--json'], fetchImpl, root: ROOT })

  assert.equal(exitCode, 0)
  const report = JSON.parse(stdout)
  assert.equal(report.expected, PACKAGE_VERSION)
  assert.equal(report.ok, true)
  assert.equal(report.conceptDoi, '10.5281/zenodo.22650136')
  assert.equal(report.latest.recordId, 24621817)
  assert.equal(report.latest.fileSize, 5700435)
})

test('runCli honours --expected over package.json and maps a mismatch to exit 1', async () => {
  const { runCli } = await load()
  const fetchImpl = stubFetch(conceptPayload({ version: '2.4.0' }))

  const { exitCode, stderr } = await runCli({
    argv: ['--expected', '2.5.0'],
    fetchImpl,
    root: ROOT,
  })

  assert.equal(exitCode, 1)
  assert.match(stderr, /2\.5\.0/)
})

test('runCli documents its flags and refuses bad input with exit 2', async () => {
  const { runCli } = await load()

  const help = await runCli({ argv: ['--help'], root: ROOT })
  assert.equal(help.exitCode, 0)
  assert.match(help.stdout, /--expected/)
  assert.match(help.stdout, /--json/)
  assert.match(help.stdout, /exit codes:/i)

  const unknown = await runCli({ argv: ['--nope'], root: ROOT })
  assert.equal(unknown.exitCode, 2)

  const invalid = await runCli({ argv: ['--expected', 'not-a-version'], root: ROOT })
  assert.equal(invalid.exitCode, 2)
  assert.match(invalid.stderr, /--expected/)
})
