#!/usr/bin/env node
/** Compute and optionally apply the beta version for a release PR. */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MANIFESTS = [
  { file: 'package.json', kind: 'json' },
  { file: 'pyproject.toml', kind: 'toml' },
  { file: 'plugin.json', kind: 'json' },
  { file: 'src/plugins/tui/package.json', kind: 'json' },
]

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/

export function nextStableVersion(latest, intent = 'patch') {
  const match = STABLE.exec(String(latest))
  if (!match) throw new Error(`npm latest is not a stable semver: "${latest}"`)
  const [major, minor, patch] = match.slice(1).map(Number)
  if (!['patch', 'minor', 'major'].includes(intent)) {
    throw new Error(`release intent must be patch, minor, or major: "${intent}"`)
  }
  if (intent === 'major') return `${major + 1}.0.0`
  if (intent === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

export function betaVersion(latest, intent, pr, sha) {
  if (!/^\d+$/.test(String(pr)) || Number(pr) < 1) throw new Error(`invalid PR number: "${pr}"`)
  const shortSha = String(sha).slice(0, 7)
  if (!/^[0-9a-f]{7,}$/i.test(shortSha)) throw new Error(`invalid commit SHA: "${sha}"`)
  return `${nextStableVersion(latest, intent)}-beta.${pr}.${shortSha}`
}

function writeVersion(root, { file, kind }, version) {
  const path = join(root, file)
  const raw = readFileSync(path, 'utf8')
  if (kind === 'toml') {
    const updated = raw.replace(/^(version\s*=\s*")[^"]+("\s*)$/m, `$1${version}$2`)
    if (updated === raw) throw new Error(`no version field in ${file}`)
    writeFileSync(path, updated)
    return
  }
  const content = JSON.parse(raw)
  content.version = version
  writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`)
}

export function applyBetaVersion(root, version) {
  for (const manifest of MANIFESTS) writeVersion(root, manifest, version)
  // Keep npm's lockfile metadata consistent without changing dependency data.
  const lockPath = join(root, 'package-lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  lock.version = version
  if (lock.packages?.['']) lock.packages[''].version = version
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
}

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.split('=')
    return [key.replace(/^--/, ''), value.join('=')]
  }),
)

if (args.has('latest')) {
  try {
    const version = betaVersion(
      args.get('latest'),
      args.get('intent') || 'patch',
      args.get('pr'),
      args.get('sha'),
    )
    if (args.has('apply')) applyBetaVersion(process.cwd(), version)
    console.log(version)
  } catch (error) {
    console.error(`release-beta-version: ${error.message}`)
    process.exit(1)
  }
}
