import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { installSkills } from '../scripts/install/shared.mjs'

test('overrides skip and replace skills at the install target', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-skills-ovr-'))
  mkdirSync(join(target, '.pantheon'), { recursive: true })
  writeFileSync(
    join(target, '.pantheon', 'overrides.json'),
    JSON.stringify({
      'skill-auto-continue': { action: 'disable', reason: 'team doctrine' },
      'skill-tdd-with-agents': {
        action: 'replace',
        content: '# TDD - team doctrine\nRED. GREEN. REFACTOR. Nothing else.\n',
      },
    }),
  )
  try {
    const { created } = installSkills(
      ['auto-continue', 'tdd-with-agents', 'codemap'],
      target,
      false,
      '.opencode',
    )
    const base = join(target, '.opencode', 'skills')
    assert.equal(existsSync(join(base, 'auto-continue')), false, 'disabled skill is not installed')
    assert.equal(
      readFileSync(join(base, 'tdd-with-agents', 'SKILL.md'), 'utf8'),
      '# TDD - team doctrine\nRED. GREEN. REFACTOR. Nothing else.\n',
      'replaced SKILL.md carries the override content',
    )
    assert.equal(existsSync(join(base, 'codemap', 'SKILL.md')), true, 'unoverridden skill installs')
    assert.ok(created >= 2)
    // The override file itself is an input, never an artifact.
    assert.equal(existsSync(join(target, '.opencode', 'overrides.json')), false)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('a clean target with no override file installs every skill untouched', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-skills-clean-'))
  try {
    installSkills(['codemap'], target, false, '.opencode')
    assert.equal(existsSync(join(target, '.opencode', 'skills', 'codemap', 'SKILL.md')), true)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
