#!/usr/bin/env node

/**
 * build-plugin.mjs — Bundles src/plugin.ts into src/plugin/index.js.
 *
 * Ensures OpenCode and Node.js can import the Pantheon plugin from node_modules
 * without triggering ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING on Node 22+.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const entry = join(root, 'src', 'plugin.ts')
const outfile = join(root, 'src', 'plugin', 'index.js')

let built = false
try {
  const { buildSync } = await import('esbuild')
  buildSync({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  })
  built = true
} catch {
  // Fallback to cached or binary esbuild
  const possibleBins = [
    join(root, 'node_modules', '.bin', 'esbuild'),
    '/home/ils15/.npm/_npx/0c9ac6e560028c15/node_modules/esbuild/bin/esbuild',
    '/home/ils15/.npm/_npx/fd45a72a545557e9/node_modules/esbuild/bin/esbuild',
  ]
  for (const bin of possibleBins) {
    if (existsSync(bin)) {
      execFileSync(bin, [
        entry,
        `--outfile=${outfile}`,
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--packages=external',
      ])
      built = true
      break
    }
  }
}

if (!built) {
  throw new Error('Could not find esbuild to bundle src/plugin.ts')
}

console.log('Built src/plugin/index.js via esbuild.')
