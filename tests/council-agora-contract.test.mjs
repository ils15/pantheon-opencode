/**
 * council-agora-contract.test.mjs — v2.3 Council/Agora, Peer Handoff,
 * Watchdog Integration, and Ephemeral Worker instruction contracts.
 *
 * Run: node --test tests/council-agora-contract.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { load } from 'js-yaml'

const ROOT = process.cwd()
const read = (relPath) => readFileSync(join(ROOT, relPath), 'utf8')

test('v2.3 council-agora skill exists, fits budget, and is wired to zeus + routing + README', () => {
  const skillPath = join(ROOT, 'src/skills/council-agora/SKILL.md')
  assert.equal(existsSync(skillPath), true, 'src/skills/council-agora/SKILL.md must exist')

  const skill = read('src/skills/council-agora/SKILL.md')
  assert.ok(skill.split('\n').length <= 120, 'council-agora SKILL.md must stay <= 120 lines')
  assert.match(skill, /^name:\s*council-agora$/m)
  assert.match(skill, /pantheon_board/)
  assert.match(skill, /replyToSeq/)
  assert.match(skill, /\[consensus\]/)
  assert.match(skill, /\[deadlock\]/)
  assert.match(skill, /spawn_ephemeral/)

  const skillsReadme = read('src/skills/README.md')
  assert.match(skillsReadme, /\*\*26 skills\*\*/)
  assert.match(skillsReadme, /council-agora/)

  const routing = load(read('src/routing.yml'))
  assert.ok(
    routing.agents?.zeus?.skills?.includes('council-agora'),
    'src/routing.yml zeus.skills must include council-agora',
  )

  const zeusMd = read('src/agents/zeus.md')
  assert.match(zeusMd, /pantheon_board:\s*allow/)
  assert.match(zeusMd, /^\s*- council-agora$/m)

  const roster = JSON.parse(read('src/agents/roster.json'))
  assert.equal(roster.agents?.zeus?.permission?.pantheon_board, 'allow')
  assert.ok(roster.agents?.zeus?.skills?.includes('council-agora'))
})

test('commands/pantheon.md and zeus-council-synthesis define #seq Agora protocol', () => {
  const cmd = read('commands/pantheon.md')
  assert.match(cmd, /pantheon_board/)
  assert.match(cmd, /#seq|replyToSeq/)
  assert.match(cmd, /\[consensus\]/)
  assert.match(cmd, /\[deadlock\]/)

  const synthesis = read('src/instructions/zeus-council-synthesis.instructions.md')
  assert.match(synthesis, /pantheon_board\(action="channel", channel="council"/)
  assert.match(synthesis, /#seq/)
  assert.match(synthesis, /replyToSeq/)
  assert.match(synthesis, /\[consensus\]/)
  assert.match(synthesis, /\[deadlock\]/)
  assert.match(synthesis, /attention|Cockpit/i)
  assert.match(synthesis, /question`? tool|native `question`/i)
})

test('agent-coordination, zeus-anti-stall, agent-return-format, and zeus cover peer handoffs, watchdog, and ephemeral workers', () => {
  const coordination = read('src/skills/agent-coordination/SKILL.md')
  assert.ok(
    coordination.split('\n').length <= 120,
    'agent-coordination SKILL.md must stay <= 120 lines',
  )
  assert.match(coordination, /pantheon_board/)
  assert.match(coordination, /replyToSeq|#seq/)
  assert.match(coordination, /spawn_ephemeral/)
  assert.match(coordination, /\[alert\]|watchdog/i)

  const antiStall = read('src/instructions/zeus-anti-stall.instructions.md')
  assert.match(antiStall, /swarm:stall:detected/)
  assert.match(antiStall, /pantheon_board/)
  assert.match(antiStall, /\[alert\]/)
  assert.match(antiStall, /replyToSeq|#seq/)
  assert.match(antiStall, /spawn_ephemeral/)

  const returnFormat = read('src/instructions/agent-return-format.instructions.md')
  assert.match(returnFormat, /#seq|replyToSeq/)
  assert.match(returnFormat, /\[consensus\].*\[deadlock\]|\[deadlock\].*\[consensus\]/)

  const zeusMd = read('src/agents/zeus.md')
  assert.match(zeusMd, /pantheon_board/)
  assert.match(zeusMd, /spawn_ephemeral/)
  assert.match(zeusMd, /swarm:stall:detected|watchdog/i)
})
