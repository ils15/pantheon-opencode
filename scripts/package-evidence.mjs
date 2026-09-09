#!/usr/bin/env node
/** Build and verify the single immutable npm package evidence artifact. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { validateInventory } from './manifest-inventory.mjs'

const CI_ARGS = ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund']
const REQUIRED_PAYLOAD = [
  'package/package.json',
  'package/plugin.json',
  'package/pyproject.toml',
  'package/src/plugins/tui/package.json',
  'package/src/plugins/tui/package-lock.json',
  'package/src/plugin.ts',
  'package/src/plugin-v2.ts',
  'package/src/pantheon/v2-bridge.ts',
  'package/src/plugins/tui/dist/tui.js',
  'package/src/plugins/tui/dist/server.js',
  'package/bin/pantheon-init.mjs',
  'package/scripts/doctor.mjs',
  'package/.pantheon/code-mode/compress-inline.py',
]

function fail(message) {
  throw new Error(message)
}

function resolveTargetSha(root, supplied) {
  const raw =
    supplied ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  const sha = String(raw).trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(sha))
    fail('target SHA must be a full lowercase 40-character hexadecimal SHA')
  return sha
}

function createOutputDirectory(outputDir) {
  const directory = outputDir ?? mkdtempSync(join(tmpdir(), 'pantheon-package-evidence-'))
  mkdirSync(directory, { recursive: true })
  if (readdirSync(directory).length !== 0) fail(`output directory must be empty: ${directory}`)
  return { directory }
}

function packOnce(root, outputDir) {
  const raw = execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', outputDir],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )
  let result
  try {
    result = JSON.parse(raw)
  } catch (error) {
    fail(`npm pack returned malformed JSON: ${error.message}`)
  }
  if (!Array.isArray(result) || result.length !== 1 || typeof result[0]?.filename !== 'string') {
    fail('npm pack must produce exactly one JSON result')
  }
  const tgzFiles = readdirSync(outputDir).filter((name) => name.endsWith('.tgz'))
  if (tgzFiles.length !== 1)
    fail(`package evidence requires exactly one .tgz, found ${tgzFiles.length}`)
  if (tgzFiles[0] !== result[0].filename)
    fail('npm pack result does not identify the sole .tgz artifact')
  return join(outputDir, tgzFiles[0])
}

function validateArchiveEntries(tarball) {
  const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
  const entries = listing.split('\n').filter(Boolean)
  if (entries.length === 0) fail('package tarball is empty')
  for (const entry of entries) {
    const normalized = entry.replace(/\/$/, '')
    const parts = normalized.split('/')
    if (
      isAbsolute(normalized) ||
      normalized.includes('\\') ||
      parts.includes('..') ||
      (!normalized.startsWith('package/') && normalized !== 'package')
    ) {
      fail(`unsafe package archive entry: ${entry}`)
    }
  }
  const detailed = execFileSync('tar', ['-tvzf', tarball], { encoding: 'utf8' })
  for (const line of detailed.split('\n').filter(Boolean)) {
    if (/^[lh]/i.test(line)) fail(`package archive contains a link entry: ${line}`)
  }
  return new Set(entries)
}

function extractSafely(tarball, workDir) {
  const extractionRoot = join(workDir, 'extract')
  mkdirSync(extractionRoot)
  validateArchiveEntries(tarball)
  execFileSync(
    'tar',
    ['-xzf', tarball, '--directory', extractionRoot, '--no-same-owner', '--no-same-permissions'],
    { encoding: 'utf8' },
  )
  const realRoot = realpathSync(extractionRoot)
  const walk = (current) => {
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) fail(`package archive extraction contains a symlink: ${current}`)
    const resolved = realpathSync(current)
    if (resolved !== realRoot && !resolved.startsWith(`${realRoot}/`)) {
      fail(`package archive extraction escaped its temporary directory: ${current}`)
    }
    if (stat.isDirectory()) for (const name of readdirSync(current)) walk(join(current, name))
  }
  walk(extractionRoot)
  return join(extractionRoot, 'package')
}

function validatePayload(packageRoot, inventory) {
  for (const relativePath of REQUIRED_PAYLOAD) {
    const path = join(packageRoot, relativePath.replace(/^package\//, ''))
    if (!existsSync(path) || !lstatSync(path).isFile())
      fail(`required package payload is missing: ${relativePath}`)
  }
  for (const document of inventory.documents) {
    const { entry, path: sourcePath } = document
    const packagedPath = join(packageRoot, entry.file)
    if (entry.role === 'lock' && entry.file === 'package-lock.json' && !existsSync(packagedPath)) {
      // npm-packlist excludes the package root lockfile by policy. It remains
      // validated below as source evidence, but is not fabricated in the tgz.
      continue
    }
    if (!existsSync(packagedPath) || !lstatSync(packagedPath).isFile())
      fail(`versioned package payload is missing: package/${entry.file}`)
    if (sha256(sourcePath) !== sha256(packagedPath))
      fail(`published package payload differs from source: ${entry.file}`)
  }
}

function collectLockfileEvidence(inventory, entries, packageRoot) {
  return inventory.documents
    .filter(({ entry }) => entry.role === 'lock')
    .map(({ entry, data, path: sourcePath }) => {
      const archivePath = `package/${entry.file}`
      const packagedPath = join(packageRoot, entry.file)
      const publishedInTarball = entries.has(archivePath)
      return {
        file: entry.file,
        sourceSha256: sha256(sourcePath),
        publishedSha256: publishedInTarball ? sha256(packagedPath) : null,
        sourceName: data.name,
        sourceVersion: data.version,
        lockfileVersion: data.lockfileVersion,
        parity: 'validated-against-manifest',
        publishedInTarball,
      }
    })
}

function installProductionDependencies(root) {
  // The root package-lock.json is source evidence only: npm-packlist omits it
  // from the root of an npm package, so root ci must validate the source tree.
  execFileSync('npm', CI_ARGS, { cwd: root, stdio: 'inherit' })
  execFileSync('npm', CI_ARGS, {
    cwd: join(root, 'src', 'plugins', 'tui'),
    stdio: 'inherit',
  })
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function createPackageEvidence(root, { outputDir, targetSha } = {}) {
  const inventory = validateInventory(root)
  const sha = resolveTargetSha(root, targetSha)
  const output = createOutputDirectory(outputDir)
  let workDir
  try {
    const tarball = packOnce(root, output.directory)
    workDir = mkdtempSync(join(tmpdir(), 'pantheon-package-evidence-check-'))
    const entries = validateArchiveEntries(tarball)
    const packageRoot = extractSafely(tarball, workDir)
    validatePayload(packageRoot, inventory)
    installProductionDependencies(root)
    const digest = sha256(tarball)
    if (!/^[0-9a-f]{64}$/.test(digest)) fail('tarball SHA-256 is not lowercase 64-hex')
    const metadata = {
      version: inventory.sourceVersion,
      targetSha: sha,
      tarballSha256: digest,
      tarball: tarball.split('/').at(-1),
      lockfilePolicy: {
        rootPackageLockfile: entries.has('package/package-lock.json')
          ? 'published-by-npm-pack'
          : 'omitted-by-npm-pack',
        note: entries.has('package/package-lock.json')
          ? 'npm pack published the root package-lock.json; lockfile parity is validated and recorded as source evidence, while tarball validation covers only the payload npm pack publishes.'
          : 'npm pack omits the package root package-lock.json by policy; lockfile parity is validated and recorded as source evidence, while tarball validation covers only the payload npm pack publishes.',
      },
      lockfileEvidence: collectLockfileEvidence(inventory, entries, packageRoot),
    }
    writeFileSync(join(output.directory, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`)
    writeFileSync(join(output.directory, 'version'), `${metadata.version}\n`)
    writeFileSync(join(output.directory, 'target-sha'), `${metadata.targetSha}\n`)
    writeFileSync(join(output.directory, 'tarball-sha256'), `${metadata.tarballSha256}\n`)
    return { ...metadata, outputDir: output.directory, tarball }
  } catch (error) {
    rmSync(output.directory, { recursive: true, force: true })
    throw error
  } finally {
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  }
}

function parseOptions(args) {
  const options = {}
  for (const arg of args) {
    const match = /^--(output-dir|target-sha)=(.*)$/.exec(arg)
    if (!match) fail(`unsupported package evidence option: ${arg}`)
    options[match[1] === 'output-dir' ? 'outputDir' : 'targetSha'] = match[2]
  }
  return options
}

if (process.argv[1]?.endsWith('package-evidence.mjs')) {
  try {
    const evidence = createPackageEvidence(process.cwd(), parseOptions(process.argv.slice(2)))
    console.log(JSON.stringify(evidence))
  } catch (error) {
    console.error(`package-evidence: ${error.message}`)
    process.exit(1)
  }
}
