import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const ROOT = process.cwd()
const escapedRoot = ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const forbidden = new RegExp(
  `(?:${escapedRoot}|\\/home\\/|\\/workspace\\/|pantheon[\\\\/]src[\\\\/])`,
  'i',
)
const executableForbidden = new RegExp(
  `(?:${escapedRoot}|\\/home\\/|\\/workspace\\/|pantheon[\\\\/]src[\\\\/])`,
  'i',
)
const privateUrl =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[^/\s"]+\.(?:local|internal|corp))(?:[:/]|$)/i

function pack() {
  // Do not bypass prepack: the published archive is the artifact under test.
  const result = execFileSync('npm', ['pack', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return JSON.parse(result)[0].filename
}

function textFiles(root) {
  const files = []
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (statSync(path).isDirectory()) files.push(...textFiles(path))
    else files.push(path)
  }
  return files
}

function assertExecutableConfigIsPathFree(packageRoot) {
  const configPath = join(packageRoot, 'opencode.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  assert.equal(config.plugin, undefined, 'published opencode.json must be a path-free template')
  assert.doesNotMatch(readFileSync(configPath, 'utf8'), executableForbidden)
  assert.doesNotMatch(readFileSync(configPath, 'utf8'), privateUrl)
}

test('tarball contains no machine paths and ships the runtime inputs', () => {
  const tarball = pack()
  const work = mkdtempSync(join(tmpdir(), 'pantheon-tarball-'))
  try {
    const listing = execFileSync('tar', ['-tzf', join(ROOT, tarball)], { encoding: 'utf8' })
    assert.doesNotMatch(listing, forbidden)
    assert.doesNotMatch(listing, /(?:^|\/)logs(?:\/|$)|\.log$/i)
    execFileSync('tar', ['-xzf', join(ROOT, tarball), '-C', work])
    const contents = readFileSync(join(work, 'package', 'opencode.json'), 'utf8')
    assertExecutableConfigIsPathFree(join(work, 'package'))
    assert.doesNotMatch(contents, forbidden)
    for (const file of textFiles(join(work, 'package'))) {
      const rel = file.slice(join(work, 'package').length + 1)
      const text = readFileSync(file, 'utf8')
      // Documentation may show safe placeholder commands/paths. Executable
      // configs and archive entries may not contain machine paths or logs.
      if (
        /^(?:README\.md|AGENTS\.md|CHANGELOG\.md|docs\/|src\/skills\/|src\/agents\/|src\/pantheon\/vision\.ts)/.test(
          rel,
        )
      )
        continue
      assert.doesNotMatch(text, forbidden, `forbidden path in ${file}`)
      assert.doesNotMatch(text, /\/tmp\//i, `temporary machine path in ${file}`)
      assert.doesNotMatch(text, privateUrl, `private URL in ${file}`)
    }
    for (const file of ['package/scripts/doctor.mjs', 'package/src/plugins/pantheon-hooks.ts']) {
      assert.match(listing, new RegExp(`^${file.replaceAll('/', '\\/')}$`, 'm'))
    }
    assert.match(listing, /^package\/bin\/pantheon-init\.mjs$/m)
    const doctor = readFileSync(join(work, 'package', 'scripts', 'doctor.mjs'), 'utf8')
    assert.match(doctor, /--profile sandbox/)
    assert.match(doctor, /exitCode = 2/)

    const redaction = spawnSync(process.execPath, [join(ROOT, 'scripts', 'redaction-gate.mjs'), join(ROOT, tarball)], {
      encoding: 'utf8',
    })
    assert.equal(redaction.status, 0, redaction.stderr || redaction.stdout)
  } finally {
    rmSync(work, { recursive: true, force: true })
    rmSync(join(ROOT, tarball), { force: true })
  }
})

test('installed package resolves hooks to its installed absolute path', () => {
  const tarball = pack()
  const work = mkdtempSync(join(tmpdir(), 'pantheon-prefix-'))
  const project = join(work, 'project')
  mkdirSync(project)
  try {
    execFileSync('npm', ['install', '--prefix', work, join(ROOT, tarball)], {
      encoding: 'utf8',
    })
    const cli = join(work, 'node_modules', 'pantheon-opencode', 'bin', 'pantheon-init.mjs')
    const result = spawnSync(
      process.execPath,
      [cli, 'init', '--project', '--no-mcp', '--headless', '-y'],
      {
        cwd: project,
        encoding: 'utf8',
      },
    )
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const config = JSON.parse(readFileSync(join(project, 'opencode.json'), 'utf8'))
    const installedRoot = resolve(work, 'node_modules', 'pantheon-opencode')
    assert.deepEqual(config.plugin, [join(installedRoot, 'src', 'plugins', 'pantheon-hooks.ts')])
    assert.equal(existsSync(config.plugin[0]), true)
    assert.doesNotMatch(JSON.stringify(config), executableForbidden)
    const tui = JSON.parse(readFileSync(join(project, '.opencode', 'tui.json'), 'utf8'))
    assert.deepEqual(tui.plugin, [join(installedRoot, 'src', 'plugins', 'tui', 'dist', 'tui.tsx')])
    assert.equal(existsSync(tui.plugin[0]), true)
    assert.equal(
      tui.plugin.some((entry) => !entry.startsWith('/')),
      false,
    )
  } finally {
    rmSync(join(ROOT, tarball), { force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test('package validator rejects executable templates with machine paths', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'pantheon-package-fixture-'))
  try {
    mkdirSync(join(fixture, 'scripts'), { recursive: true })
    execFileSync('cp', [
      join(ROOT, 'scripts', 'validate-package.mjs'),
      join(fixture, 'scripts', 'validate-package.mjs'),
    ])
    execFileSync('cp', [join(ROOT, 'package.json'), join(fixture, 'package.json')])
    execFileSync('cp', [join(ROOT, 'plugin.json'), join(fixture, 'plugin.json')])
    execFileSync('cp', [
      join(ROOT, 'src', 'plugins', 'tui', 'package.json'),
      join(fixture, 'tui.json'),
    ])
    execFileSync('cp', [join(ROOT, 'opencode.json'), join(fixture, 'opencode.json')])
    const configPath = join(fixture, 'opencode.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    config.plugin = ['/home/checkout/src/plugins/pantheon-hooks.ts']
    writeFileSync(configPath, `${JSON.stringify(config)}\n`)
    const result = spawnSync(process.execPath, [join(fixture, 'scripts', 'validate-package.mjs')], {
      cwd: fixture,
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Package validation failed/)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
