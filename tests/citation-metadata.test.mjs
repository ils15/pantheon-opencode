import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ZENODO_CONCEPT_DOI } from '../scripts/zenodo-record.mjs'

const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url))
const read = (path) => readFileSync(root(path), 'utf8')

const citation = read('CITATION.cff')
const packageJson = JSON.parse(read('package.json'))
const zenodo = JSON.parse(read('.zenodo.json'))
const roster = JSON.parse(read('src/agents/roster.json'))
const readme = read('README.md')

/** Pull one top-level CFF key's value without adding a YAML dependency. */
function cffValue(source, key) {
  const block = new RegExp(`^${key}:[ \\t]*([\\s\\S]*?)(?=\\n[a-z][a-z0-9-]*:)`, 'm').exec(source)
  assert.ok(block, `CITATION.cff is missing the ${key} key`)
  return block[1].replace(/^[ \t]*>-?[ \t]*\n?/m, '').trim()
}

function agentCount(source, pattern, label) {
  const match = pattern.exec(source)
  assert.ok(match, `${label} does not state an agent count`)
  return Number(match[1])
}

const rosterCount = Object.keys(roster.agents).length

test('every surface that states the agent count states the roster count', () => {
  assert.equal(rosterCount, 8, 'src/agents/roster.json is the source of truth')
  assert.equal(
    agentCount(
      packageJson.description,
      /(\d+) canonical agents (?:plus|\+) on-demand/,
      'package.json',
    ),
    rosterCount,
  )
  assert.equal(
    agentCount(zenodo.description, /(\d+) canonical agents (?:plus|\+) on-demand/, '.zenodo.json'),
    rosterCount,
  )
  assert.equal(agentCount(readme, /with (\d+) specialized agents/, 'README.md'), rosterCount)
  assert.equal(
    agentCount(cffValue(citation, 'abstract'), /(\d+) canonical agents/, 'CITATION.cff abstract'),
    rosterCount,
  )
})

test('the cited abstract carries no other hand-maintained count', () => {
  const abstract = cffValue(citation, 'abstract')
  // The v2.4.0 audit finding: the abstract said "14 specialized agents" and
  // nothing in the release tooling ever rewrote it. The roster count is the
  // only agent number allowed to appear.
  assert.doesNotMatch(abstract, /\b14\b/)
  assert.ok(abstract.includes(`${rosterCount} canonical agents`))
  assert.match(abstract, /on-demand ephemeral workers/)
  assert.match(abstract, /Jev/)
  assert.match(abstract, /OpenCode 2\.x/)
})

test('CITATION.cff satisfies cff-version 1.2.0 required keys and the audit fields', () => {
  for (const key of ['cff-version', 'message', 'title', 'authors']) {
    assert.match(citation, new RegExp(`^${key}:`, 'm'), `CITATION.cff is missing ${key}`)
  }
  assert.match(citation, /^cff-version: 1\.2\.0$/m)
  assert.match(citation, /^type: software$/m)
  assert.match(citation, /^version: "?[0-9]+\.[0-9]+\.[0-9]+/m)

  // CFF 1.2.0 requires the ORCID as a URL; the bare identifier is invalid.
  const authorBlock = citation.slice(citation.indexOf('authors:'))
  assert.match(authorBlock, /orcid: ["']?https:\/\/orcid\.org\/0000-0001-7787-7562["']?/)
  assert.ok(
    zenodo.creators.some((creator) => creator.orcid === '0000-0001-7787-7562'),
    'the ORCID must match .zenodo.json',
  )
})

test('CITATION.cff version matches package.json and its DOI stays the concept DOI', () => {
  assert.equal(cffValue(citation, 'version').replace(/["']/g, ''), packageJson.version)
  assert.equal(cffValue(citation, 'doi'), ZENODO_CONCEPT_DOI)
  assert.equal(ZENODO_CONCEPT_DOI, '10.5281/zenodo.22650136')
})

test('the published tarball ships the machine-readable citation', () => {
  assert.ok(
    packageJson.files.includes('CITATION.cff'),
    'package.json "files" must ship CITATION.cff alongside the README',
  )
  assert.ok(packageJson.files.includes('README.md'))
})

test('RELEASING.md describes the archive history accurately', () => {
  const releasing = read('docs/RELEASING.md')

  // The old claim contradicted the concept, which holds ~20 prerelease versions.
  assert.doesNotMatch(releasing, /intentionally absent from the Zenodo family/)
  assert.match(releasing, /prerelease versions archived before v2\.0\.0 remain/i)
})

test('RELEASING.md states the tag-time metadata invariant', () => {
  const releasing = read('docs/RELEASING.md')

  assert.match(releasing, /read from `\.zenodo\.json` at the \*\*tagged commit\*\*/)
  assert.match(
    releasing,
    /Never tag a release whose `\.zenodo\.json` still carries the previous version/,
  )
  assert.match(releasing, /the tag only determines the file name and the version DOI/i)
})

test('the slice selector routes citation artifacts to this suite', async () => {
  const { mapFileToSlice } = await import('../scripts/test-slice.mjs')

  for (const file of ['CITATION.cff', '.zenodo.json', 'docs/RELEASING.md']) {
    assert.equal(mapFileToSlice(file).command, 'node --test tests/citation-metadata.test.mjs')
  }
})

test('RELEASING.md documents the immutable 1.4.3 mislabels as a cautionary example', () => {
  const releasing = read('docs/RELEASING.md')

  for (const record of ['22650137', '22688985', '22709558', '22728638', '22729516']) {
    assert.ok(releasing.includes(record), `docs/RELEASING.md must name record ${record}`)
  }
  for (const version of [
    'v1.5.0-beta.1',
    'v1.5.0-beta.3',
    'v1.5.0-beta.4',
    'v1.5.0-beta.5',
    'v1.5.0-beta.6',
  ]) {
    assert.ok(releasing.includes(version), `docs/RELEASING.md must name ${version}`)
  }
  assert.match(releasing, /duplicate version labels/i)
  assert.match(
    releasing,
    /v1\.0\.0–v1\.4\.3 were never archived|v1\.0\.0-v1\.4\.3 were never archived/,
  )
})
