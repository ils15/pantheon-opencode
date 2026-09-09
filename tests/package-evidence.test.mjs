import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/package-evidence.mjs', import.meta.url))
const VERSION = '1.2.3'
const TARGET_SHA = 'a'.repeat(40)

function writeFixtureFile(root, relativePath, content) {
  const path = join(root, relativePath)
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function fixtureDocuments() {
  const packageJson = JSON.stringify({ name: 'pantheon-opencode', version: VERSION }, null, 2)
  const pluginJson = JSON.stringify({ name: 'pantheon', version: VERSION }, null, 2)
  const tuiJson = JSON.stringify({ name: 'pantheon-tui', version: VERSION }, null, 2)
  const rootLock = JSON.stringify(
    {
      name: 'pantheon-opencode',
      version: VERSION,
      lockfileVersion: 3,
      packages: { '': { name: 'pantheon-opencode', version: VERSION } },
    },
    null,
    2,
  )
  const tuiLock = JSON.stringify(
    {
      name: 'pantheon-tui',
      version: VERSION,
      lockfileVersion: 3,
      packages: { '': { name: 'pantheon-tui', version: VERSION } },
    },
    null,
    2,
  )
  return {
    'package.json': `${packageJson}\n`,
    'plugin.json': `${pluginJson}\n`,
    'pyproject.toml': `[project]\nname = "pantheon"\nversion = "${VERSION}"\n`,
    'package-lock.json': `${rootLock}\n`,
    'src/plugins/tui/package.json': `${tuiJson}\n`,
    'src/plugins/tui/package-lock.json': `${tuiLock}\n`,
  }
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'package-evidence-'))
  for (const [path, content] of Object.entries(fixtureDocuments())) {
    writeFixtureFile(root, path, content)
    writeFixtureFile(root, join('package', path), content)
  }
  for (const path of [
    'src/plugin.ts',
    'src/plugin-v2.ts',
    'src/pantheon/v2-bridge.ts',
    'src/plugins/tui/dist/tui.js',
    'src/plugins/tui/dist/server.js',
    'bin/pantheon-init.mjs',
    'scripts/doctor.mjs',
    '.pantheon/code-mode/compress-inline.py',
  ]) {
    writeFixtureFile(root, join('package', path), 'fixture\n')
  }
  return root
}

function makeFakeNpm(root, mode = 'one') {
  const bin = join(root, 'fake-bin')
  const log = join(root, 'npm.log')
  const lifecycleMarker = join(root, 'lifecycle-ran')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'npm'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_NPM_LOG"
if [ "$1" = "pack" ]; then
  destination=""
  previous=""
  for argument in "$@"; do
    if [ "$previous" = "--pack-destination" ]; then destination="$argument"; fi
    previous="$argument"
  done
  if [ "${mode}" = "traversal" ]; then
    python3 - "$destination/fixture.tgz" <<'PY'
import io
import sys
import tarfile

with tarfile.open(sys.argv[1], "w:gz") as archive:
    payload = b"unsafe"
    entry = tarfile.TarInfo("package/../escape.txt")
    entry.size = len(payload)
    archive.addfile(entry, io.BytesIO(payload))
PY
  elif [ "${mode}" = "symlink" ]; then
    python3 - "$destination/fixture.tgz" <<'PY'
import sys
import tarfile

with tarfile.open(sys.argv[1], "w:gz") as archive:
    entry = tarfile.TarInfo("package/unsafe-link")
    entry.type = tarfile.SYMTYPE
    entry.linkname = "/tmp/package-evidence-escape"
    archive.addfile(entry)
PY
  elif [ "${mode}" != "zero" ]; then
    rm "$PWD/package/package-lock.json"
    tar -czf "$destination/fixture.tgz" -C "$PWD" package
    if [ "${mode}" = "multiple" ]; then cp "$destination/fixture.tgz" "$destination/second.tgz"; fi
  fi
  printf '[{"filename":"fixture.tgz"}]\\n'
  exit 0
fi
if [ "$1" = "ci" ]; then
  case " $* " in
    *" --ignore-scripts "*) ;;
    *) touch "$FAKE_NPM_LIFECYCLE_MARKER" ;;
  esac
  exit 0
fi
exit 91
`,
  )
  chmodSync(join(bin, 'npm'), 0o755)
  return { bin, log, lifecycleMarker }
}

function runEvidence(root, mode = 'one') {
  const outputDir = join(root, 'evidence')
  const fakeNpm = makeFakeNpm(root, mode)
  const result = spawnSync(
    process.execPath,
    [SCRIPT, `--output-dir=${outputDir}`, `--target-sha=${TARGET_SHA}`],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeNpm.bin}${delimiter}${process.env.PATH}`,
        FAKE_NPM_LOG: fakeNpm.log,
        FAKE_NPM_LIFECYCLE_MARKER: fakeNpm.lifecycleMarker,
      },
    },
  )
  return { ...result, outputDir, log: fakeNpm.log }
}

test('package evidence packs once, validates npm payload, hashes it, and uses locked production ci', () => {
  const root = makeFixture()
  try {
    const result = runEvidence(root)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const calls = readFileSync(result.log, 'utf8').trim().split('\n')
    assert.equal(calls.filter((call) => call.startsWith('pack ')).length, 1)
    assert.deepEqual(calls.slice(1), [
      'ci --ignore-scripts --omit=dev --no-audit --no-fund',
      'ci --ignore-scripts --omit=dev --no-audit --no-fund',
    ])
    assert.ok(calls.every((call) => !call.includes('install')))
    assert.equal(existsSync(join(root, 'lifecycle-ran')), false)

    const metadata = JSON.parse(readFileSync(join(result.outputDir, 'metadata.json'), 'utf8'))
    const tarball = join(result.outputDir, metadata.tarball)
    const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex')
    const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n')
    assert.equal(metadata.tarballSha256, digest)
    assert.equal(metadata.version, VERSION)
    assert.equal(entries.includes('package/package-lock.json'), false)
    assert.ok(entries.includes('package/src/plugins/tui/package-lock.json'))
    assert.ok(entries.includes('package/src/plugins/tui/dist/tui.js'))
    assert.ok(entries.includes('package/src/plugins/tui/dist/server.js'))
    assert.equal(readFileSync(join(result.outputDir, 'target-sha'), 'utf8').trim(), TARGET_SHA)
    assert.equal(metadata.lockfilePolicy.rootPackageLockfile, 'omitted-by-npm-pack')
    assert.match(metadata.lockfilePolicy.note, /source evidence/i)
    assert.deepEqual(
      metadata.lockfileEvidence.map(({ file, publishedInTarball }) => ({
        file,
        publishedInTarball,
      })),
      [
        { file: 'package-lock.json', publishedInTarball: false },
        { file: 'src/plugins/tui/package-lock.json', publishedInTarball: true },
      ],
    )
    for (const evidence of metadata.lockfileEvidence) {
      assert.match(evidence.sourceSha256, /^[0-9a-f]{64}$/)
      assert.equal(evidence.sourceVersion, VERSION)
      assert.equal(evidence.parity, 'validated-against-manifest')
    }
    assert.equal(metadata.lockfileEvidence[0].publishedSha256, null)
    assert.equal(
      metadata.lockfileEvidence[1].publishedSha256,
      metadata.lockfileEvidence[1].sourceSha256,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('package evidence does not reinsert npm-omitted root lockfile into the tgz', () => {
  const root = makeFixture()
  try {
    const result = runEvidence(root)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const metadata = JSON.parse(readFileSync(join(result.outputDir, 'metadata.json'), 'utf8'))
    const tarball = join(result.outputDir, metadata.tarball)
    const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    assert.doesNotMatch(entries, /^package\/package-lock\.json$/m)
    assert.doesNotMatch(readFileSync(SCRIPT, 'utf8'), /tar.*-czf/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

for (const mode of ['zero', 'multiple', 'traversal', 'symlink']) {
  test(`package evidence rejects ${mode} tarballs`, () => {
    const root = makeFixture()
    try {
      const result = runEvidence(root, mode)
      assert.notEqual(result.status, 0)
      if (mode === 'zero' || mode === 'multiple') {
        assert.match(result.stderr, new RegExp(`found ${mode === 'zero' ? '0' : '2'}`))
      } else {
        assert.match(result.stderr, /unsafe package archive entry|contains a link entry/)
      }
      assert.equal(existsSync(join(root, 'evidence')), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('npm ci production flags do not execute lifecycle scripts', () => {
  const root = mkdtempSync(join(tmpdir(), 'package-evidence-ci-'))
  const marker = join(root, 'lifecycle-ran')
  const packageJson = {
    name: 'package-evidence-ci-fixture',
    version: VERSION,
    scripts: {
      preinstall: `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"`,
      install: `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"`,
      postinstall: `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"`,
    },
  }
  const packageLock = {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: packageJson.name, version: packageJson.version },
    },
  }
  try {
    writeFileSync(join(root, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`)
    writeFileSync(join(root, 'package-lock.json'), `${JSON.stringify(packageLock, null, 2)}\n`)
    execFileSync('npm', ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: root,
      stdio: 'pipe',
    })
    assert.equal(existsSync(marker), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
