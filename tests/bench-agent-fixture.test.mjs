import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const { agentFixtureIdentity, contentDirectoryIdentity } = await import(
  '../bench/lib/agent-fixture.mjs'
)

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-agent-fixture-'))
  try {
    const agents = join(root, 'agents')
    mkdirSync(agents)
    writeFileSync(join(agents, 'zeus.md'), '# Zeus\n')
    writeFileSync(join(agents, 'talos.md'), '# Talos\n')
    return run(root, agents)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('agent fixture identity records only requested agent file hashes in stable order', () => {
  withFixture((_root, agents) => {
    const identity = agentFixtureIdentity(agents, ['talos', 'zeus'])
    assert.deepEqual(
      identity.files.map(({ name }) => name),
      ['talos', 'zeus'],
    )
    assert.equal(identity.path, agents)
    assert.equal(identity.files.length, 2)
    assert.match(identity.files[0].sha256, /^[a-f0-9]{64}$/)
    assert.match(identity.sha256, /^[a-f0-9]{64}$/)
    assert.equal(JSON.stringify(identity).includes('# Talos'), false)
  })
})

test('agent fixture identity changes when a requested prompt changes', () => {
  withFixture((_root, agents) => {
    const before = agentFixtureIdentity(agents, ['talos', 'zeus'])
    writeFileSync(join(agents, 'talos.md'), '# Talos updated\n')
    const after = agentFixtureIdentity(agents, ['talos', 'zeus'])
    assert.notEqual(before.files[0].sha256, after.files[0].sha256)
    assert.notEqual(before.sha256, after.sha256)
  })
})

test('agent fixture identity rejects a missing agent or symlinked prompt file', () => {
  withFixture((root, agents) => {
    assert.throws(() => agentFixtureIdentity(agents, ['missing']), /does not define missing/)
    const outside = join(root, 'outside.md')
    writeFileSync(outside, '# injected\n')
    symlinkSync(outside, join(agents, 'apollo.md'))
    assert.throws(() => agentFixtureIdentity(agents, ['talos']), /regular files only/)
  })
})

test('content fixture identity records nested files and changes with skill content', () => {
  withFixture((root) => {
    const skills = join(root, 'skills')
    mkdirSync(join(skills, 'incremental-implementation'), { recursive: true })
    writeFileSync(join(skills, 'incremental-implementation', 'SKILL.md'), '# Skill\n')
    const before = contentDirectoryIdentity(skills)
    assert.equal(before.files.length, 1)
    assert.equal(before.files[0].path, 'incremental-implementation/SKILL.md')
    assert.match(before.sha256, /^[a-f0-9]{64}$/)

    writeFileSync(join(skills, 'incremental-implementation', 'SKILL.md'), '# Updated skill\n')
    const after = contentDirectoryIdentity(skills)
    assert.notEqual(before.sha256, after.sha256)
  })
})
