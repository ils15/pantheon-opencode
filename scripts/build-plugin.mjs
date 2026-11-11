#!/usr/bin/env node

/**
 * build-plugin.mjs — Bundles src/plugin.ts into src/plugin/index.js.
 *
 * Ensures OpenCode and Node.js can import the Pantheon plugin from node_modules
 * without triggering ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING on Node 22+.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

buildSync({
  entryPoints: [join(root, 'src', 'plugin.ts')],
  outfile: join(root, 'src', 'plugin', 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
})

console.log('Built src/plugin/index.js via esbuild.')
