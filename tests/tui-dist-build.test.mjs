import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const tuiPackage = join(root, 'src/plugins/tui')
const dist = join(tuiPackage, 'dist')

function readDistSnapshot(directory) {
  return Object.fromEntries(
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => [entry.name, readFileSync(join(directory, entry.name))]),
  )
}

function assertSourceImportsStayInPackage(directory, packageSource) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      assertSourceImportsStayInPackage(path, packageSource)
      continue
    }
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue

    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
      const specifier = match[1]
      if (!specifier.startsWith('.')) continue
      const target = relative(packageSource, resolve(dirname(path), specifier))
      assert.ok(
        target !== '..' && !target.startsWith(`..${sep}`) && !isAbsolute(target),
        `${relative(packageSource, path)} imports outside the TUI source package: ${specifier}`,
      )
    }
  }
}

test('a clean TUI build reproduces every packaged dist artifact byte-for-byte', () => {
  const before = readDistSnapshot(dist)
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'pantheon-tui-dist-build-'))
  const buildPackage = join(temporaryRoot, 'src/plugins/tui')

  try {
    mkdirSync(join(temporaryRoot, 'src/plugins'), { recursive: true })
    cpSync(join(root, 'tsconfig.json'), join(temporaryRoot, 'tsconfig.json'))
    cpSync(tuiPackage, buildPackage, {
      recursive: true,
      filter: (source) => !relative(tuiPackage, source).split(sep).includes('node_modules'),
    })
    assertSourceImportsStayInPackage(join(buildPackage, 'src'), join(buildPackage, 'src'))
    symlinkSync(
      join(root, 'node_modules'),
      join(temporaryRoot, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    execFileSync('npm', ['run', 'build', '--prefix', buildPackage], {
      cwd: root,
      stdio: 'pipe',
    })

    const after = readDistSnapshot(join(buildPackage, 'dist'))
    for (const [name, contents] of Object.entries(after)) {
      if (!name.endsWith('.js')) continue
      assert.doesNotMatch(
        contents.toString('utf8'),
        /(?:from\s*|import\s*)['"](?:\.\.\/)+pantheon\//,
        `${name} must not import root src/pantheon modules`,
      )
    }
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'dist file list')
    for (const name of Object.keys(before)) {
      assert.deepEqual(after[name], before[name], `${name} must be reproducible`)
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
})
