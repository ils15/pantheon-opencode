import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSkillSearchOutput, stripAnsi } from '../scripts/skill-search.mjs'

const RAW = [
  '\u001b[38;5;250m███████╗██╗ \u001b[0m',
  '\u001b[38;5;102mInstall with\u001b[0m npx skills add <owner/repo@skill>',
  '',
  '\u001b[38;5;145mdavila7/claude-code-templates@pdf-processing-pro\u001b[0m \u001b[36m737 installs\u001b[0m',
  '\u001b[38;5;102m└ https://skills.sh/davila7/claude-code-templates/pdf-processing-pro\u001b[0m',
  '',
  '\u001b[38;5;145mmervinpraison/praisonai@pdf-processing\u001b[0m \u001b[36m70 installs\u001b[0m',
  '\u001b[38;5;102m└ https://skills.sh/mervinpraison/praisonai/pdf-processing\u001b[0m',
  '',
].join('\n')

test('stripAnsi removes all SGR escape sequences', () => {
  assert.equal(stripAnsi('\u001b[38;5;145ma@b\u001b[0m 12 installs'), 'a@b 12 installs')
  assert.equal(stripAnsi('plain'), 'plain')
})

test('parseSkillSearchOutput: skills, installs and urls paired in order', () => {
  const found = parseSkillSearchOutput(RAW)
  assert.deepEqual(found, [
    {
      skill: 'davila7/claude-code-templates@pdf-processing-pro',
      installs: 737,
      url: 'https://skills.sh/davila7/claude-code-templates/pdf-processing-pro',
    },
    {
      skill: 'mervinpraison/praisonai@pdf-processing',
      installs: 70,
      url: 'https://skills.sh/mervinpraison/praisonai/pdf-processing',
    },
  ])
})

test('parseSkillSearchOutput: entries without a url line keep the skill', () => {
  const text = [
    'banner noise',
    'owner/repo@skill-name 12 installs',
    'owner2/repo2@other 0 installs',
    '└ https://skills.sh/owner2/repo2/other',
  ].join('\n')
  const found = parseSkillSearchOutput(text)
  assert.equal(found.length, 2)
  assert.equal(found[0].skill, 'owner/repo@skill-name')
  assert.equal(found[0].installs, 12)
  assert.equal(found[0].url, undefined)
  assert.equal(found[1].url, 'https://skills.sh/owner2/repo2/other')
})

test('parseSkillSearchOutput: limit caps and install counts sort stays as printed', () => {
  const text = ['a/repo@s1 5 installs', 'b/repo@s2 900 installs', 'c/repo@s3 1 installs'].join('\n')
  assert.equal(parseSkillSearchOutput(text, { limit: 2 }).length, 2)
  assert.equal(parseSkillSearchOutput(text, { limit: 2 })[0].skill, 'a/repo@s1')
  assert.deepEqual(parseSkillSearchOutput('nothing useful here'), [])
  assert.deepEqual(parseSkillSearchOutput(''), [])
})
