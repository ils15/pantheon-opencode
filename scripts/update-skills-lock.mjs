#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SKILLS_DIR = join(ROOT, 'src', 'skills')
const LOCK_PATH = join(ROOT, 'skills-lock.json')

/** Rebuild the sorted SHA-256 inventory for every canonical skill file. */
function updateSkillsLock() {
  const skillFiles = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(SKILLS_DIR, entry.name, 'SKILL.md'))
    .filter((path) => existsSync(path))
    .sort()

  const lock = Object.fromEntries(
    skillFiles.map((path) => [
      relative(ROOT, path).split('\\').join('/'),
      createHash('sha256').update(readFileSync(path)).digest('hex'),
    ]),
  )
  writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`)
  process.stdout.write(`Updated ${Object.keys(lock).length} skill digests in skills-lock.json\n`)
}

updateSkillsLock()
