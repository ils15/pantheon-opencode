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
  const skillDirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  const lock = {}
  for (const id of skillDirs) {
    const skillMd = join(SKILLS_DIR, id, 'SKILL.md')
    if (existsSync(skillMd)) {
      lock[relative(ROOT, skillMd).split('\\').join('/')] = createHash('sha256')
        .update(readFileSync(skillMd))
        .digest('hex')
    }
    const refDir = join(SKILLS_DIR, id, 'references')
    if (!existsSync(refDir)) continue
    for (const name of readdirSync(refDir).sort()) {
      if (!name.endsWith('.md')) continue
      const refPath = join(refDir, name)
      lock[relative(ROOT, refPath).split('\\').join('/')] = createHash('sha256')
        .update(readFileSync(refPath))
        .digest('hex')
    }
  }

  const sorted = Object.fromEntries(Object.entries(lock).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(LOCK_PATH, `${JSON.stringify(sorted, null, 2)}\n`)
  process.stdout.write(`Updated ${Object.keys(sorted).length} skill digests in skills-lock.json\n`)
}

updateSkillsLock()
