import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  findUniqueZenodoDeposition,
  zenodoReleaseMarker,
} from '../scripts/recover-zenodo-deposition.mjs'
import { parseZenodoMarker, zenodoMarker } from '../scripts/zenodo-release-state.mjs'

const workflow = readFileSync(join(process.cwd(), '.github/workflows/zenodo.yml'), 'utf8')

test('passes the release body file from deposition to publication without the token', () => {
  assert.match(
    workflow,
    /gh api "repos\/\$GITHUB_REPOSITORY\/releases\/tags\/\$RELEASE_TAG" > "\$body"/,
  )
  assert.match(workflow, /printf 'ZENODO_RELEASE_BODY_FILE=%s\\n' "\$body" >> "\$GITHUB_ENV"/)
  assert.match(workflow, /BODY_FILE="\$ZENODO_RELEASE_BODY_FILE" MARKER=/)
  assert.doesNotMatch(workflow, /BODY_FILE="\$body" MARKER=/)
  assert.match(workflow, /ZENODO_TOKEN: \$\{\{ secrets\.ZENODO_TOKEN \}\}/)
  assert.match(workflow, /recover-zenodo-deposition\.mjs/)
  assert.match(workflow, /ZENODO_DEPOSITIONS_URL=.*ZENODO_TOKEN=.*RELEASE_MARKER=/)
  assert.match(
    workflow,
    /validateZenodoResponse\(JSON\.parse\(readFileSync\(process\.env\.RECOVERED_FILE/,
  )
  assert.match(
    workflow,
    /writeFileSync\(process\.env\.STATE_FILE, JSON\.stringify\(\{ \.\.\.recovered, state: 'created' \}\)\)/,
  )
  assert.match(workflow, /state=created/)
  assert.doesNotMatch(workflow, /submitted=.*recovered/)
})

test('successful publication persists published state and DOI, then reruns without creating again', () => {
  let releaseBody = 'Release notes'
  let createCalls = 0
  let publishCalls = 0

  const publish = () => {
    const existing = parseZenodoMarker(releaseBody)
    if (existing?.state === 'published') return existing

    createCalls += 1
    const depositionId = 42
    publishCalls += 1
    const published = zenodoMarker({
      id: depositionId,
      doi: '10.5281/zenodo.42',
      state: 'published',
    })
    releaseBody = `${releaseBody}\n\n${published}\n`
    return parseZenodoMarker(releaseBody)
  }

  assert.deepEqual(publish(), {
    id: 42,
    doi: '10.5281/zenodo.42',
    state: 'published',
    claim: null,
  })
  assert.equal(createCalls, 1)
  assert.equal(publishCalls, 1)

  assert.deepEqual(publish(), {
    id: 42,
    doi: '10.5281/zenodo.42',
    state: 'published',
    claim: null,
  })
  assert.equal(createCalls, 1)
  assert.equal(publishCalls, 1)
})

test('created marker rerun reuses its id and reaches upload/publication without creating again', () => {
  assert.match(workflow, /existing=\n\s+doi=\n\s+state=\n\s+if \[ -f "\$state_file" \]; then/)
  assert.match(workflow, /if \[ "\$state" = created \]; then/)
  assert.match(workflow, /existing=\$\(node -e[\s\S]*?\.id\|\|''\)[\s\S]*?\$state_file"\)/)
  assert.match(
    workflow,
    /\[ -n "\$existing" \] \|\| \{ echo '::error::Created Zenodo marker has no deposition id.'/,
  )
  assert.match(workflow, /if \[ "\$submitted" != true \] && ! node -e/)
  assert.match(workflow, /state: 'published'/)

  let createCalls = 0
  let uploadCalls = 0
  let publishCalls = 0
  const created = parseZenodoMarker(zenodoMarker({ id: 42, state: 'created' }))
  assert.equal(created.state, 'created')
  assert.equal(created.id, 42)
  if (created.state === 'created') {
    uploadCalls += 1
    publishCalls += 1
  } else {
    createCalls += 1
  }
  assert.deepEqual(
    { createCalls, uploadCalls, publishCalls },
    { createCalls: 0, uploadCalls: 1, publishCalls: 1 },
  )
})

test('recovered id and DOI survive the pending handoff and are persisted in the published marker', () => {
  const pending = zenodoMarker({ state: 'pending', claim: 'run-1' })
  const recovered = { id: 42, doi: '10.5281/zenodo.42' }
  const state = { ...recovered, state: 'created' }
  const published = zenodoMarker({ ...recovered, state: 'published' })
  const releaseBody = `notes\n${published}`

  assert.match(pending, /state=pending/)
  assert.deepEqual(state, { id: 42, doi: '10.5281/zenodo.42', state: 'created' })
  assert.deepEqual(parseZenodoMarker(releaseBody), {
    id: 42,
    doi: '10.5281/zenodo.42',
    state: 'published',
    claim: null,
  })
})

function fakeFetch(payload) {
  return async (url, options) => {
    assert.equal(new URL(url).searchParams.get('q'), zenodoReleaseMarker('v1.4.3'))
    assert.equal(options.headers.Authorization, 'Bearer test-token')
    return { ok: true, status: 200, json: async () => payload }
  }
}

test('recovers the single deposition after a runner crash', async () => {
  const marker = zenodoReleaseMarker('v1.4.3')
  assert.deepEqual(
    await findUniqueZenodoDeposition(
      'https://zenodo.org/api/deposit/depositions',
      'test-token',
      marker,
      fakeFetch({ hits: { total: 1, hits: [{ id: 42, metadata: { description: marker } }] } }),
    ),
    { id: 42, doi: null },
  )
})

test('follows every Zenodo search page and preserves the recovered DOI contract', async () => {
  const marker = zenodoReleaseMarker('v1.4.3')
  const requests = []
  const result = await findUniqueZenodoDeposition(
    'https://zenodo.org/api/deposit/depositions',
    'test-token',
    marker,
    async (url) => {
      requests.push(String(url))
      const page =
        requests.length === 1
          ? {
              hits: { total: 2, hits: [{ id: 7, metadata: { description: 'other' } }] },
              links: { next: 'https://zenodo.org/api/deposit/depositions?page=2' },
            }
          : {
              hits: {
                total: 2,
                hits: [{ id: 42, doi: '10.5281/zenodo.42', metadata: { description: marker } }],
              },
              links: {},
            }
      return { ok: true, status: 200, json: async () => page }
    },
  )
  assert.equal(requests.length, 2)
  assert.deepEqual(result, { id: 42, doi: '10.5281/zenodo.42' })
})

test('fails closed for incomplete or ambiguous pagination metadata', async () => {
  const marker = zenodoReleaseMarker('v1.4.3')
  for (const payload of [
    { hits: { hits: [{ id: 42, metadata: { description: marker } }] }, links: {} },
    {
      hits: { total: 2, hits: [{ id: 42, metadata: { description: marker } }] },
      links: { next: 'https://evil.example/page=2' },
    },
  ]) {
    await assert.rejects(
      findUniqueZenodoDeposition(
        'https://zenodo.org/api/deposit/depositions',
        'test-token',
        marker,
        fakeFetch(payload),
      ),
      /ambiguous pagination|unsafe pagination|before all results/,
    )
  }
})

test('fails closed when recovery finds zero or multiple exact matches', async () => {
  const marker = zenodoReleaseMarker('v1.4.3')
  for (const payload of [
    { hits: { total: 0, hits: [] } },
    {
      hits: {
        total: 2,
        hits: [
          { id: 1, metadata: { description: marker } },
          { id: 2, metadata: { description: marker } },
        ],
      },
    },
  ]) {
    await assert.rejects(
      findUniqueZenodoDeposition(
        'https://zenodo.org/api/deposit/depositions',
        'test-token',
        marker,
        fakeFetch(payload),
      ),
      /exactly one matching deposition/,
    )
  }
})
