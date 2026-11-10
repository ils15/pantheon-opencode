import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseSkillSearchOutput,
  searchAnthropicCatalog,
  searchGithubSkills,
  searchSkillSources,
  stripAnsi,
} from '../scripts/skill-search.mjs'

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

test('searchAnthropicCatalog: token match over the curated listing', () => {
  const fakeSpawn = () => ({
    status: 0,
    stdout: 'pdf\ndocx\nxlsx\nmcp-builder\nskill-creator\nwebapp-testing\n',
    stderr: '',
  })
  const result = searchAnthropicCatalog('convert pdf tables to csv', { spawn: fakeSpawn })
  assert.ok(result.ok)
  assert.deepEqual(result.entries, [
    {
      skill: 'anthropics/skills@pdf',
      installs: null,
      url: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
      source: 'anthropic',
    },
  ])
  const empty = searchAnthropicCatalog('zzz-unknown-domain', { spawn: fakeSpawn })
  assert.ok(empty.ok)
  assert.deepEqual(empty.entries, [])
  const failed = searchAnthropicCatalog('pdf', {
    spawn: () => ({ status: 1, stdout: '', stderr: '' }),
  })
  assert.equal(failed.ok, false)
})

test('searchGithubSkills: code-search items become repo@name entries', () => {
  const fakeSpawn = () => ({
    status: 0,
    stdout: JSON.stringify({
      total_count: 2,
      items: [
        { repository: { full_name: 'antvis/L7' }, path: 'skills/l7/SKILL.md' },
        { repository: { full_name: 'joelhooks/joelclaw' }, path: 'skills/satellite-rig/SKILL.md' },
      ],
    }),
    stderr: '',
  })
  const result = searchGithubSkills('satellite imagery', { spawn: fakeSpawn })
  assert.ok(result.ok)
  assert.deepEqual(result.entries, [
    {
      skill: 'antvis/L7@l7',
      installs: null,
      url: 'https://github.com/antvis/L7/blob/main/skills/l7/SKILL.md',
      source: 'github',
    },
    {
      skill: 'joelhooks/joelclaw@satellite-rig',
      installs: null,
      url: 'https://github.com/joelhooks/joelclaw/blob/main/skills/satellite-rig/SKILL.md',
      source: 'github',
    },
  ])
  const bad = searchGithubSkills('pdf', { spawn: () => ({ status: 1, stdout: '', stderr: '' }) })
  assert.equal(bad.ok, false)
})

test('searchSkillSources: lexical relevance outranks the canonical boost (field bug beta.5)', () => {
  // Field report: 'contract testing' ranked anthropics/skills@webapp-testing
  // (one weak token hit) ABOVE petrkindlmann/qa-skills@contract-testing (the
  // literal two-token match, 1.3K installs). Relevance now sorts first; the
  // trust cascade is the tiebreaker.
  const fakeSpawn = (bin, args) => {
    if (bin === 'gh' && String(args[1]).startsWith('repos/')) {
      return { status: 0, stdout: 'pdf\ndocx\nwebapp-testing\n', stderr: '' }
    }
    if (bin === 'gh') {
      return {
        status: 0,
        stdout: '{"items":[{"repository":{"full_name":"o/r"},"path":"s/unrelated/SKILL.md"}]}',
        stderr: '',
      }
    }
    // skills.sh output: the literal match has 1300 installs
    return {
      status: 0,
      stdout:
        'petrkindlmann/qa-skills@contract-testing 1.3K installs\nsomeone/other@webapp-testing 12 installs',
      stderr: '',
    }
  }
  const result = searchSkillSources('contract testing', { limit: 5, spawn: fakeSpawn })
  assert.ok(result.ok)
  assert.equal(
    result.entries[0].skill,
    'petrkindlmann/qa-skills@contract-testing',
    'the literal match leads',
  )
  assert.equal(
    result.entries[1].skill,
    'anthropics/skills@webapp-testing',
    'the canonical weak match follows',
  )
  // Trust cascade still wins on EQUAL relevance (the pdf case):
  const tieSpawn = (bin, args) => {
    if (bin === 'gh' && String(args[1]).startsWith('repos/')) {
      return { status: 0, stdout: 'pdf\n', stderr: '' }
    }
    if (bin === 'gh') {
      return { status: 0, stdout: '{"items":[]}', stderr: '' }
    }
    return { status: 0, stdout: 'someone/other@pdf-tools 900 installs', stderr: '' }
  }
  const tie = searchSkillSources('pdf', { limit: 3, spawn: tieSpawn })
  assert.equal(tie.entries[0].skill, 'anthropics/skills@pdf', 'equal relevance: canonical first')
  assert.equal(tie.entries[1].skill, 'someone/other@pdf-tools', 'then installs desc')
})

test('searchSkillSources: tier order preserved, one failed source tolerated', () => {
  const fakeSpawn = (bin, args) => {
    if (bin === 'gh' && String(args[1]).startsWith('repos/')) {
      return { status: 0, stdout: 'pdf\n', stderr: '' }
    }
    if (bin === 'gh') {
      return {
        status: 0,
        stdout: '{"items":[{"repository":{"full_name":"o/r"},"path":"s/k/SKILL.md"}]}',
        stderr: '',
      }
    }
    return { status: 0, stdout: 'x/repo@pdf-tool 5 installs', stderr: '' }
  }
  const result = searchSkillSources('pdf table', { limit: 4, spawn: fakeSpawn })
  assert.ok(result.ok)
  assert.deepEqual(
    result.entries.map((e) => e.source),
    ['anthropic', 'skills-sh', 'github'],
  )
  assert.equal(result.entries[0].skill, 'anthropics/skills@pdf')
  // Every tier failing surfaces the failures but never throws.
  const allFail = searchSkillSources('pdf', {
    sources: ['anthropic', 'skills-sh'],
    spawn: () => ({ status: 1, stdout: '', stderr: '' }),
  })
  assert.equal(allFail.ok, false)
  assert.deepEqual(allFail.entries, [])
  assert.equal(allFail.failures.length, 2)
})
