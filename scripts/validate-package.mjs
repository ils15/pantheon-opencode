#!/usr/bin/env node
/** Validate files that npm is allowed to publish. */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const executableConfigs = ['opencode.json', 'plugin.json', 'src/plugins/tui/package.json']
const checkoutRoot = ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const forbiddenPath = new RegExp(
  `(?:${checkoutRoot}|(?:^|[\\s"'(])[A-Za-z]:[\\\\/]|\\/(?:Users|home|tmp|workspace|private\\/var)\\/|pantheon[\\\\/]src[\\\\/]|(?:^|[\\\\/])logs(?:[\\\\/]|$))`,
  'i',
)
const errors = []

for (const file of executableConfigs) {
  const path = join(ROOT, file)
  if (!existsSync(path)) continue
  const text = readFileSync(path, 'utf8')
  if (forbiddenPath.test(text)) errors.push(`${file}: contains a machine, checkout, or log path`)
  try {
    const config = JSON.parse(text)
    if (Array.isArray(config.plugin) && config.plugin.some((entry) => /^\//.test(entry))) {
      errors.push(`${file}: plugin entries must not be absolute in the published template`)
    }
  } catch {
    errors.push(`${file}: invalid JSON`)
  }
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const rel = relative(ROOT, path)
    // These are local runtime state and are excluded by npm's explicit files
    // allow-list; never inspect them as publish candidates.
    if (
      name === 'node_modules' ||
      name === '.git' ||
      name === '.venv' ||
      name === '.pantheon' ||
      name === 'logs'
    )
      continue
    if (statSync(path).isDirectory()) walk(path)
    else if (/\.log$|(?:^|[\\/])logs(?:[\\/]|$)/i.test(rel))
      errors.push(`${rel}: log artifact must not ship`)
  }
}
walk(ROOT)

if (errors.length) {
  console.error('Package validation failed:')
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}
