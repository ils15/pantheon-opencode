/**
 * doctor-section-summary.test.mjs — every doctor section accounts for itself.
 *
 * Passing checks are suppressed unless --verbose, which used to leave whole
 * sections printing a header and nothing else: indistinguishable from a check
 * that never ran. Each section must at least report how many checks passed.
 *
 * Run: node --test tests/doctor-section-summary.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function runDoctor(extraArgs = []) {
  return spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'doctor.mjs'), ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    timeout: 300_000,
  })
}

/** Split doctor output into `{title, body}` per section banner. */
function sections(stdout) {
  return stdout.split(/^={60}$/m).reduce((acc, chunk, index, all) => {
    if (index % 2 === 1) {
      const title = chunk.trim()
      const body = (all[index + 1] ?? '').split(/^={60}$/m)[0]
      acc.push({ title, body })
    }
    return acc
  }, [])
}

test('without --verbose every section reports how many checks passed', () => {
  const child = runDoctor()
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`)

  const all = sections(child.stdout)
  const agentSection = all.find((section) => section.title.startsWith('A. Agent Files'))
  assert.ok(agentSection, 'the Agent Files section must be present')
  assert.match(agentSection.body, /\d+ checks? passed/, agentSection.body)

  const tally = child.stdout.match(/\d+ check(s)? passed/g) ?? []
  assert.ok(tally.length >= 2, `at least two sections report a tally, got ${tally.length}`)
})

test('--verbose still lists the individual passing checks', () => {
  const child = runDoctor(['--verbose'])
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`)
  const agentSection = sections(child.stdout).find((section) =>
    section.title.startsWith('A. Agent Files'),
  )
  assert.ok(agentSection, 'the Agent Files section must be present')
  assert.match(agentSection.body, /\u2705 14 canonical agents found/i, agentSection.body)
  assert.doesNotMatch(
    agentSection.body,
    /\d+ checks? passed/,
    'the tally exists only where individual lines are suppressed',
  )
})
