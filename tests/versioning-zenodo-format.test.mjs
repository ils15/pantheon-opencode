import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const BIOME_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'biome')

/** Write the six versioned manifests/locks required by the inventory validator. */
function writeFixture(root, version) {
  const manifest = (name, value) => `${JSON.stringify({ name, version: value }, null, 2)}\n`
  const lock = (name, value) =>
    `${JSON.stringify(
      { name, version: value, lockfileVersion: 3, packages: { '': { name, version: value } } },
      null,
      2,
    )}\n`

  writeFileSync(join(root, 'package.json'), manifest('pantheon-opencode', version))
  writeFileSync(join(root, 'plugin.json'), manifest('pantheon', version))
  writeFileSync(
    join(root, 'pyproject.toml'),
    `[project]\nname = "pantheon"\nversion = "${version}"\n`,
  )
  mkdirSync(join(root, 'src/plugins/tui'), { recursive: true })
  writeFileSync(join(root, 'src/plugins/tui/package.json'), manifest('pantheon-tui', version))
  writeFileSync(join(root, 'package-lock.json'), lock('pantheon-opencode', version))
  writeFileSync(join(root, 'src/plugins/tui/package-lock.json'), lock('pantheon-tui', version))
}

/** Reproduce the JSON.stringify(.., null, 2) shape that Biome rejects. */
function writeZenodo(root, version) {
  const document = {
    title: 'Pantheon',
    creators: [{ name: 'Igor Leite da Silva' }],
    version,
    keywords: ['opencode', 'ai-agents', 'multi-agent', 'orchestration', 'developer-tools'],
    related_identifiers: [
      {
        identifier: 'https://github.com/ils15/pantheon-opencode',
        relation: 'isSupplementTo',
        resource_type: 'software',
      },
    ],
  }
  writeFileSync(join(root, '.zenodo.json'), `${JSON.stringify(document, null, 2)}\n`)
}

function makeFixture(version) {
  const root = mkdtempSync(join(tmpdir(), 'zenodo-fixture-'))
  cpSync(join(REPO_ROOT, 'scripts'), join(root, 'scripts'), { recursive: true })
  writeFixture(root, version)
  writeZenodo(root, version)
  writeFileSync(
    join(root, 'CHANGELOG.md'),
    ['# Changelog', '', '## [Unreleased]', '', '### Added', '', '- An unreleased change.', ''].join(
      '\n',
    ),
  )
  return root
}

test('apply --beta writes .zenodo.json with arrays Biome keeps inline', () => {
  assert.ok(existsSync(BIOME_BIN), `biome binary not found at ${BIOME_BIN}`)
  const root = makeFixture('1.5.0-beta.2')
  try {
    const result = spawnSync(process.execPath, ['scripts/versioning.mjs', 'apply', '--beta'], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)

    const raw = readFileSync(join(root, '.zenodo.json'), 'utf8')
    const document = JSON.parse(raw)
    assert.equal(document.version, '1.5.0-beta.3')
    assert.deepEqual(document.keywords, [
      'opencode',
      'ai-agents',
      'multi-agent',
      'orchestration',
      'developer-tools',
    ])
    // Primitive array must be collapsed onto one line, as Biome expects.
    assert.match(raw, /"keywords": \["opencode"/)
    assert.doesNotMatch(raw, /"keywords": \[\n/)

    const biome = spawnSync(
      BIOME_BIN,
      ['check', '--config-path', join(REPO_ROOT, 'biome.json'), join(root, '.zenodo.json')],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      },
    )
    assert.equal(biome.status, 0, `${biome.stdout}\n${biome.stderr}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
