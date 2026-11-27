#!/usr/bin/env node

/**
 * build-plugin.mjs — Bundles src/plugin.ts into src/plugin/index.js.
 *
 * Ensures OpenCode and Node.js can import the Pantheon plugin from node_modules
 * without triggering ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING on Node 22+.
 *
 * Usage:
 *   node scripts/build-plugin.mjs          # write src/plugin/index.js
 *   node scripts/build-plugin.mjs --check  # build to a temp file, byte-compare
 *
 * `--check` never touches the committed bundle, so it can run in the
 * pre-commit hook and in `check:generated` without mutating the worktree.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const entry = join(root, 'src', 'plugin', 'index.ts')
const committed = join(root, 'src', 'plugin', 'index.js')

const checkOnly = process.argv.includes('--check')
const tempDir = checkOnly ? mkdtempSync(join(tmpdir(), 'pantheon-plugin-')) : null
const outfile = checkOnly ? join(tempDir, 'index.js') : committed

let built = false
try {
  try {
    const { buildSync } = await import('esbuild')
    buildSync({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      external: ['../plugins/tui/dist/tui.js'],
    })
    built = true
  } catch {
    // Fallback to local node_modules binary
    const localBin = join(root, 'node_modules', '.bin', 'esbuild')
    if (existsSync(localBin)) {
      execFileSync(localBin, [
        entry,
        `--outfile=${outfile}`,
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--packages=external',
        '--external:../plugins/tui/dist/tui.js',
      ])
      built = true
    }
  }

  if (!built) {
    throw new Error('Could not find esbuild to bundle src/plugin.ts')
  }

  if (!checkOnly) {
    console.log('Built src/plugin/index.js via esbuild.')
  } else if (!existsSync(committed)) {
    console.error('[DRIFT] src/plugin/index.js is missing — run: npm run build:plugin')
    process.exitCode = 1
  } else {
    const expected = readFileSync(outfile)
    const actual = readFileSync(committed)
    if (!actual.equals(expected)) {
      console.error(
        '[DRIFT] src/plugin/index.js does not match a fresh build of src/plugin/index.ts',
      )
      console.error('Run: npm run build:plugin')
      process.exitCode = 1
    } else {
      console.log('[OK] src/plugin/index.js matches a fresh build of src/plugin/index.ts.')
    }
  }
} finally {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
}
