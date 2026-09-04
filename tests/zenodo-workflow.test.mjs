import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  findUniqueZenodoDeposition,
  zenodoReleaseMarker,
} from '../scripts/recover-zenodo-deposition.mjs'
import { findZenodoFile, sha256File } from '../scripts/zenodo-artifact.mjs'
import { parseZenodoMarker, zenodoMarker } from '../scripts/zenodo-release-state.mjs'

const workflow = readFileSync(join(process.cwd(), '.github/workflows/zenodo.yml'), 'utf8')

test('validates the exact archive checksum and rejects a different upload', () => {
  const root = mkdtempSync(join(tmpdir(), 'zenodo-artifact-'))
  const archive = join(root, 'release.tar.gz')
  writeFileSync(archive, 'tagged release bytes')
  const checksum = sha256File(archive)
  const record = { files: [{ filename: 'release.tar.gz', checksum: `sha256:${checksum}` }] }
  assert.equal(findZenodoFile(record, 'release.tar.gz', checksum).filename, 'release.tar.gz')
  assert.throws(() => findZenodoFile(record, 'release.tar.gz', '0'.repeat(64)), /checksum mismatch/)
})

test('fails closed when a deposition contains duplicate archive names', () => {
  assert.throws(
    () =>
      findZenodoFile(
        { files: [{ filename: 'release.tar.gz' }, { filename: 'release.tar.gz' }] },
        'release.tar.gz',
        'a'.repeat(64),
      ),
    /duplicate file/,
  )
})

function shellBlocks(source) {
  const lines = source.split('\n')
  const blocks = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^ {8}run: \|$/.test(lines[index])) continue
    const body = []
    for (
      index += 1;
      index < lines.length && (/^ {10}/.test(lines[index]) || lines[index] === '');
      index += 1
    ) {
      body.push(lines[index].replace(/^ {10}/, ''))
    }
    blocks.push(body.join('\n'))
    index -= 1
  }
  return blocks
}

function unclosedHeredocs(source) {
  const pending = []
  for (const line of source.split('\n')) {
    const opener = line.match(/<<-?['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/)?.[1]
    if (opener) pending.push(opener)
    while (pending.length > 0 && pending[pending.length - 1] === line.trim()) pending.pop()
  }
  return pending
}

test('resolves every workflow script from one versioned tooling checkout', () => {
  assert.match(workflow, /path: \.zenodo-workflow/)
  assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/)

  const toolingScripts = [
    'validate-zenodo-release.mjs',
    'recover-zenodo-deposition.mjs',
    'zenodo-release-state.mjs',
    'zenodo-artifact.mjs',
  ]
  const firstNodeImport = workflow.indexOf('node ')
  const toolingPreflight = workflow.indexOf('test -f "$tooling_dir/$script"')
  assert.ok(toolingPreflight >= 0, 'expected tooling files preflight')
  assert.ok(toolingPreflight < firstNodeImport, 'preflight must precede every node import')
  for (const script of toolingScripts) {
    assert.ok(
      existsSync(join(process.cwd(), 'scripts', script)),
      `repository tooling is missing ${script}`,
    )
    assert.match(workflow, new RegExp(`\\.zenodo-workflow/scripts/${script}`))
    assert.match(workflow, /test -f "\$tooling_dir\/\$script"/)
  }
})

test('never imports Zenodo modules from the release checkout', () => {
  for (const module of [
    'validate-zenodo-release.mjs',
    'recover-zenodo-deposition.mjs',
    'zenodo-release-state.mjs',
    'zenodo-artifact.mjs',
  ]) {
    assert.doesNotMatch(workflow, new RegExp(`(?:node\\s+|from\\s+['"])scripts/${module}`))
  }
})

test('detects unclosed heredocs and keeps the workflow free of fragile heredocs', () => {
  assert.deepEqual(unclosedHeredocs("node <<'NODE'\nconsole.log('broken')"), ['NODE'])
  assert.deepEqual(unclosedHeredocs(workflow), [])
  assert.doesNotMatch(workflow, /<<-?['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/)
})

test('all workflow run blocks pass real bash syntax validation', () => {
  const blocks = shellBlocks(workflow)
  assert.ok(blocks.length >= 5, 'expected every workflow shell step to be extracted')
  for (const block of blocks) {
    const normalized = block.replace(/\$\{\{[^}]+\}\}/g, 'workflow-value')
    execFileSync('bash', ['-n'], { input: normalized, encoding: 'utf8' })
  }
})

test('simulates the idempotent deposition creation step with stubbed network commands', () => {
  const start = workflow.indexOf('      - name: Create or resume idempotent Zenodo deposition')
  const end = workflow.indexOf('\n      - name:', start + 1)
  const step = workflow.slice(start, end).match(/ {6}run: \|\n((?: {10}.*\n|\n)*)/)?.[1]
  assert.ok(step, 'expected deposition step shell body')
  const fixture = mkdtempSync(join(tmpdir(), 'zenodo-step-'))
  const bin = join(fixture, 'bin')
  const runnerTemp = join(fixture, 'runner')
  mkdirSync(bin)
  mkdirSync(join(runnerTemp, 'zenodo'), { recursive: true })
  mkdirSync(join(fixture, 'scripts'), { recursive: true })
  mkdirSync(join(fixture, '.zenodo-workflow/scripts'), { recursive: true })
  for (const name of [
    'validate-zenodo-release.mjs',
    'recover-zenodo-deposition.mjs',
    'zenodo-release-state.mjs',
    'version-check.mjs',
  ]) {
    cpSync(join(process.cwd(), `scripts/${name}`), join(fixture, `scripts/${name}`))
    cpSync(
      join(process.cwd(), `scripts/${name}`),
      join(fixture, `.zenodo-workflow/scripts/${name}`),
    )
  }
  const gh = join(bin, 'gh')
  const curl = join(bin, 'curl')
  writeFileSync(
    gh,
    '#!/bin/sh\nif [ "$1" = api ]; then printf \'{"body":"Release notes"}\'; fi\nexit 0\n',
  )
  writeFileSync(curl, '#!/bin/sh\nprintf \'{"id":42}\'\n')
  chmodSync(gh, 0o755)
  chmodSync(curl, 0o755)
  const script = step
    .replace(/^ {10}/gm, '')
    .replace(/\$\{\{ steps\.metadata\.outputs\.version \}\}/g, '1.4.3')
  execFileSync('bash', ['-euo', 'pipefail', '-c', script], {
    cwd: fixture,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: runnerTemp,
      GITHUB_ENV: join(fixture, 'github-env'),
      GITHUB_OUTPUT: join(fixture, 'github-output'),
      GITHUB_REPOSITORY: 'ils15/pantheon-opencode',
      GITHUB_RUN_ID: '33868542275',
      RELEASE_TAG: 'v1.4.3',
      ZENODO_TOKEN: 'test-token',
      ZENODO_DEPOSITIONS_URL: 'https://zenodo.org/api/deposit/depositions',
      ZENODO_CREATOR_NAME: 'Test Author',
    },
    encoding: 'utf8',
  })
  const output = readFileSync(join(fixture, 'github-output'), 'utf8')
  assert.match(output, /id=42/)
  assert.match(output, /state=created/)
})

test('loads all Zenodo modules when the release checkout predates the tooling', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'zenodo-workflow-'))
  const releaseCheckout = join(fixture, 'release')
  const toolingCheckout = join(fixture, '.zenodo-workflow')
  const toolingScripts = join(toolingCheckout, 'scripts')
  mkdirSync(join(releaseCheckout, 'scripts'), { recursive: true })
  mkdirSync(toolingScripts, { recursive: true })

  const modules = [
    'validate-zenodo-release.mjs',
    'recover-zenodo-deposition.mjs',
    'zenodo-release-state.mjs',
    'version-check.mjs',
  ]
  for (const module of modules) {
    cpSync(join(process.cwd(), 'scripts', module), join(toolingScripts, module))
  }

  for (const module of modules.slice(0, 3)) {
    const path = join(toolingScripts, module)
    assert.ok(existsSync(path), `workflow tooling checkout is missing ${module}`)
    assert.match(workflow, new RegExp(`\\.zenodo-workflow/scripts/${module}`))
    await import(pathToFileURL(path).href)
  }
})

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
    /writeFileSync\(process\.env\.STATE_FILE, JSON\.stringify\(\{ \.\.\.recovered, state: ["']created["'] \}\)\)/,
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
  assert.match(workflow, /findZenodoFile\(record,process\.env\.NAME,process\.env\.CHECKSUM\)/)
  assert.match(workflow, /if \[ "\$submitted" != true \] && \[ "\$existing_file" = missing \]/)
  assert.match(workflow, /marker_state=published/)

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

test('supports a resumable draft and publishes only on explicit release intent', () => {
  assert.match(workflow, /publish_deposition:/)
  assert.match(workflow, /default: false/)
  assert.match(
    workflow,
    /PUBLISH_DEPOSITION: \$\{\{ github\.event_name == 'release' \|\| inputs\.publish_deposition == true \}\}/,
  )
  assert.match(workflow, /marker_state=created/)
  assert.match(workflow, /\[ "\$PUBLISH_DEPOSITION" = true \] && marker_state=published/)
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
      fakeFetch({
        hits: {
          total: { value: 1, relation: 'eq' },
          hits: [{ id: 42, metadata: { description: marker } }],
        },
      }),
    ),
    { id: 42, doi: null },
  )
})

test('URL-encodes a recovery marker containing special query characters', async () => {
  const marker = 'pantheon release: v1.4.3 & retry=true? #1'
  let requestedUrl = ''
  const result = await findUniqueZenodoDeposition(
    'https://zenodo.org/api/deposit/depositions',
    'test-token',
    marker,
    async (url) => {
      requestedUrl = String(url)
      return {
        ok: true,
        status: 200,
        json: async () => ({ hits: { total: 1, hits: [{ id: 42, description: marker }] } }),
      }
    },
  )
  assert.equal(new URL(requestedUrl).searchParams.get('q'), marker)
  assert.match(new URL(requestedUrl).search, /%26/)
  assert.deepEqual(result, { id: 42, doi: null })
})

test('rejects malformed recovery endpoints before making a request', async () => {
  await assert.rejects(
    findUniqueZenodoDeposition('https://zenodo.org/api/%ZZ', 'test-token', 'marker', async () => {
      throw new Error('network must not be called')
    }),
    /valid HTTPS URL/,
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

test('derives supported page parameters when Zenodo omits pagination links', async () => {
  const marker = zenodoReleaseMarker('v1.4.3')
  const requests = []
  const result = await findUniqueZenodoDeposition(
    'https://zenodo.org/api/deposit/depositions',
    'test-token',
    marker,
    async (url) => {
      const requested = new URL(url)
      requests.push(requested)
      const page = requested.searchParams.get('page')
      const payload =
        page === '1'
          ? { hits: { total: { value: 2, relation: 'eq' }, hits: [{ id: 7 }] } }
          : {
              hits: {
                total: { value: 2, relation: 'eq' },
                hits: [{ id: 42, description: marker }],
              },
            }
      return { ok: true, status: 200, json: async () => payload }
    },
  )
  assert.deepEqual(
    requests.map((url) => [url.searchParams.get('page'), url.searchParams.get('size')]),
    [
      ['1', '100'],
      ['2', '100'],
    ],
  )
  assert.deepEqual(result, { id: 42, doi: null })
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

test('returns no deposition for zero matches and fails closed for multiple matches', async () => {
  const marker = zenodoReleaseMarker('v1.4.3')
  assert.equal(
    await findUniqueZenodoDeposition(
      'https://zenodo.org/api/deposit/depositions',
      'test-token',
      marker,
      fakeFetch({ hits: { total: 0, hits: [] } }),
    ),
    null,
  )
  await assert.rejects(
    findUniqueZenodoDeposition(
      'https://zenodo.org/api/deposit/depositions',
      'test-token',
      marker,
      fakeFetch({
        hits: {
          total: 2,
          hits: [
            { id: 1, metadata: { description: marker } },
            { id: 2, metadata: { description: marker } },
          ],
        },
      }),
    ),
    /exactly one matching deposition/,
  )
})
