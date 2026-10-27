import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ROOT } from '../scripts/install/shared.mjs'

const PROMPTS_DIR = join(ROOT, 'prompts')
const COMMANDS_DIR = join(ROOT, 'commands')

test('manual prompt templates use only named uppercase placeholders', () => {
  const promptFiles = readdirSync(PROMPTS_DIR).filter((name) => name.endsWith('.prompt.md'))
  const invalid = []
  for (const filename of promptFiles) {
    const content = readFileSync(join(PROMPTS_DIR, filename), 'utf8')
    for (const match of content.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*|<[^>\n]+>|\{\{[^}\n]*\}\}/g)) {
      if (!/^\{\{[A-Z][A-Z0-9_]*\}\}$/.test(match[0])) {
        invalid.push(`${filename}: ${match[0]}`)
      }
    }
  }
  assert.deepEqual(invalid, [])
})

test('native command argument expansion is limited to documented OpenCode variables', () => {
  const command = readFileSync(join(COMMANDS_DIR, 'pantheon.md'), 'utf8')
  const focus = readFileSync(join(COMMANDS_DIR, 'pantheon-focus.md'), 'utf8')
  assert.match(command, /\$ARGUMENTS/)
  assert.match(focus, /\$ARGUMENTS/)
  for (const filename of readdirSync(COMMANDS_DIR).filter((name) => name.endsWith('.md'))) {
    const content = readFileSync(join(COMMANDS_DIR, filename), 'utf8')
    assert.doesNotMatch(
      content,
      /\$input\b/i,
      `${filename} must not use an unsupported input variable`,
    )
  }
})
