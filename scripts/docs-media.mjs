#!/usr/bin/env node
/**
 * Regenerate the terminal captures embedded in docs/opencode-v2.md.
 *
 * Every capture is recorded by VHS from a tape committed next to its output in
 * docs/assets/tui/. VHS shells out to ttyd (the terminal it drives) and ffmpeg
 * (the encoder), so all three binaries must be on PATH; when one is absent this
 * script exits 1 naming it instead of leaving stale media in place.
 *
 * Usage:
 *   node scripts/docs-media.mjs                 # record every *.tape
 *   node scripts/docs-media.mjs v2-sidebar      # record one tape (name or file)
 *   node scripts/docs-media.mjs --check         # verify prerequisites only
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = resolve(SCRIPT_DIR, '..', 'docs', 'assets', 'tui')

/** Binaries VHS needs, in the order a missing one blocks the run, plus the
 *  command that installs it. Detection is a real probe, not a PATH guess. */
const PREREQUISITES = [
  {
    bin: 'vhs',
    probe: '--version',
    install: 'go install github.com/charmbracelet/vhs@latest',
  },
  {
    bin: 'ttyd',
    probe: '--version',
    install: 'build/install ttyd — https://github.com/tsl0922/ttyd#installation',
  },
  {
    bin: 'ffmpeg',
    probe: '-version',
    install: 'install ffmpeg (e.g. `apt install ffmpeg`)',
  },
]

function probe(prerequisite) {
  const result = spawnSync(prerequisite.bin, [prerequisite.probe], { encoding: 'utf8' })
  return result.error === undefined || result.error === null
}

/** Print every missing prerequisite, why it is needed, and how to install it,
 *  then stop with a non-zero exit. Silent success on a machine that cannot
 *  record is exactly the failure this guard exists to prevent. */
function reportMissing(missing) {
  const names = missing.map((entry) => entry.bin)
  const plural = names.length === 1 ? '' : 's'
  console.error(`docs:media: missing prerequisite${plural}: ${names.join(', ')}`)
  console.error('')
  console.error('VHS records the tapes; it drives ttyd and encodes with ffmpeg.')
  for (const entry of missing) console.error(`  - ${entry.bin}: ${entry.install}`)
  console.error('')
  console.error('No capture was produced. docs/assets/tui is unchanged.')
  process.exit(1)
}

function tapesToRecord(requested) {
  const available = readdirSync(ASSETS_DIR)
    .filter((name) => name.endsWith('.tape'))
    .sort()
  if (requested.length === 0) return available
  return requested.map((name) => {
    const file = name.endsWith('.tape') ? name : `${name}.tape`
    if (!available.includes(file)) {
      console.error(`docs:media: no tape named ${file} in docs/assets/tui`)
      console.error(`Available tapes: ${available.join(', ')}`)
      process.exit(1)
    }
    return file
  })
}

/** Artifacts a tape promises (`Output` and `Screenshot` commands), so a run
 *  that exits 0 without writing them is treated as a failure. */
function declaredArtifacts(tapeFile) {
  const source = readFileSync(join(ASSETS_DIR, tapeFile), 'utf8')
  const artifacts = []
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*(Output|Screenshot)\s+(\S+)\s*$/.exec(line)
    if (match) artifacts.push({ kind: match[1], file: match[2] })
  }
  return artifacts
}

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const requested = args.filter((arg) => !arg.startsWith('--'))

const missing = PREREQUISITES.filter((prerequisite) => !probe(prerequisite))
if (missing.length > 0) reportMissing(missing)
if (checkOnly) {
  console.log(`docs:media: prerequisites present (${PREREQUISITES.map((p) => p.bin).join(', ')})`)
  process.exit(0)
}

const tapes = tapesToRecord(requested)
if (tapes.length === 0) {
  console.error('docs:media: no *.tape found in docs/assets/tui')
  process.exit(1)
}

console.log(`docs:media: recording ${tapes.length} tape(s) from docs/assets/tui`)
for (const tape of tapes) {
  console.log(`docs:media: vhs ${tape}`)
  const declared = declaredArtifacts(tape)
  if (declared.length === 0) {
    console.error(`docs:media: ${tape} declares no Output or Screenshot`)
    process.exit(1)
  }
  const runStartedAt = Date.now()
  // Remove the artifacts this tape promises BEFORE recording, so existence and
  // size afterwards prove this run wrote them. Without this, a previous run's
  // file could satisfy both checks: filesystem mtime and Date.now() disagree by
  // a few milliseconds here, so a fresh write may not look newer than the start.
  // Trade-off: a failing vhs now leaves the artifact absent instead of stale,
  // which the existence check below still reports as a failure.
  for (const artifact of declared) {
    rmSync(join(ASSETS_DIR, artifact.file), { force: true })
  }
  const result = spawnSync('vhs', [tape], { cwd: ASSETS_DIR, stdio: 'inherit' })
  if (result.error) {
    console.error(`docs:media: could not run vhs for ${tape}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`docs:media: vhs exited ${result.status ?? 'unknown'} for ${tape}`)
    process.exit(result.status ?? 1)
  }
  for (const artifact of declared) {
    const artifactPath = join(ASSETS_DIR, artifact.file)
    if (!existsSync(artifactPath)) {
      console.error(
        `docs:media: ${tape} declares ${artifact.kind} ${artifact.file}, but vhs did not write it`,
      )
      process.exit(1)
    }
    const stat = statSync(artifactPath)
    if (stat.size === 0) {
      console.error(`docs:media: ${tape} wrote an empty ${artifact.kind} ${artifact.file}`)
      process.exit(1)
    }
    if (stat.mtimeMs < runStartedAt - 1000) {
      console.error(
        `docs:media: ${artifact.file} is stale — its mtime is older than this run's start`,
      )
      process.exit(1)
    }
  }
}
console.log(`docs:media: recorded ${tapes.length} tape(s)`)
