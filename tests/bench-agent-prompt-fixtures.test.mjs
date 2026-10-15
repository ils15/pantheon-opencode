import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { preparePairedAgentPromptFixtures } from '../bench/lib/agent-prompt-fixtures.mjs'

test('paired prompt fixtures freeze only Zeus while other generated prompts match', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-f5-agent-fixtures-'))
  const source = join(root, 'source-agents')
  const output = join(root, 'paired')
  const baseline = join(root, 'control-zeus.md')
  mkdirSync(source)
  writeFileSync(join(source, 'zeus.md'), '# Candidate Zeus\n')
  writeFileSync(join(source, 'apollo.md'), '# Apollo\n')
  writeFileSync(baseline, '# Frozen control Zeus\n')

  try {
    const fixtures = preparePairedAgentPromptFixtures({
      sourceAgentsDir: source,
      controlZeusPromptPath: baseline,
      outputRoot: output,
    })
    const controlZeus = readFileSync(join(fixtures.control.path, 'zeus.md'), 'utf8')
    const candidateZeus = readFileSync(join(fixtures.candidate.path, 'zeus.md'), 'utf8')
    assert.equal(controlZeus, '# Frozen control Zeus\n')
    assert.notEqual(candidateZeus, controlZeus)
    assert.match(candidateZeus, /Candidate Zeus/)
    assert.equal(
      readFileSync(join(fixtures.control.path, 'apollo.md'), 'utf8'),
      readFileSync(join(fixtures.candidate.path, 'apollo.md'), 'utf8'),
    )
    assert.notEqual(fixtures.control.sha256, fixtures.candidate.sha256)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
