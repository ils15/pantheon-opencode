/**
 * skill-fast-path-guardrails.test.mjs — the five rules are structural, not prose.
 *
 * Scope of the claim, stated up front so nobody mistakes this file for a
 * behavioural gate: it greps ONE prose artifact (src/skills/fast-path-execution/
 * SKILL.md). A grep over markdown can only prove that the required structure is
 * present and that the rules no longer live where a fact is allowed to live. It
 * cannot prove an agent obeys them — that is what the verifiers named inside the
 * rules (scripts/guardrails.mjs, tests/hooks-worktree.test.mjs, the CI step)
 * are for. Grep-shaped is acceptable here precisely because the artifact under
 * test IS prose: there is no behaviour to execute.
 *
 * What it locks down: a read-only audit graded the old file WEAK because the
 * rules sat in "Recorded environment facts" with no TRIGGER, no VERIFY and no
 * failure mode — present, unfalsifiable, and green while broken.
 *
 * Run: node --test tests/skill-fast-path-guardrails.test.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKILL = join(REPO_ROOT, 'src', 'skills', 'fast-path-execution', 'SKILL.md')
const source = readFileSync(SKILL, 'utf8')

const GUARDRAILS_HEADING = '### Execution Guardrails (TRIGGER / VERIFY / ON FAILURE)'
const FACTS_HEADING = '### Recorded environment facts'

function section(startHeading, endHeading) {
  const start = source.indexOf(startHeading)
  assert.notEqual(start, -1, `missing heading: ${startHeading}`)
  const end = endHeading ? source.indexOf(endHeading, start + startHeading.length) : source.length
  assert.notEqual(end, -1, `missing heading after ${startHeading}: ${endHeading}`)
  return source.slice(start, end)
}

/** Split the guardrails section into `#### G<n>` rule blocks. */
function rules() {
  const body = section(GUARDRAILS_HEADING, FACTS_HEADING)
  const blocks = body.split(/^#### /m).slice(1)
  return blocks.map((block) => {
    const [title] = block.split('\n')
    return { title: title.trim(), body: block }
  })
}

test('the five rules live under the execution guardrails, not in environment facts', () => {
  const facts = section(FACTS_HEADING)
  assert.doesNotMatch(
    facts,
    /\*\*(?:TRIGGER|VERIFY|ON FAILURE):\*\*/,
    'the facts section must not carry gate structure — gates belong in G1–G5',
  )
  for (const pattern of [
    /branch protection/i,
    /required status checks/i,
    /one worktree per specialist/i,
    /REQUIRED_CHECKS/,
    /--test-name-pattern/,
  ]) {
    assert.doesNotMatch(
      facts,
      pattern,
      `"${pattern}" is a gate, not an environment fact — a fact cannot fail`,
    )
  }

  const guardrails = section(GUARDRAILS_HEADING, FACTS_HEADING)
  assert.match(guardrails, /Prose cannot fail/, 'the section must say why the rules are executable')
  assert.equal(rules().length, 5, 'exactly the five audited rules are rewritten')
})

test('each rule has TRIGGER, VERIFY and ON FAILURE, in that order', () => {
  for (const rule of rules()) {
    const trigger = rule.body.indexOf('**TRIGGER:**')
    const verify = rule.body.indexOf('**VERIFY:**')
    const onFailure = rule.body.indexOf('**ON FAILURE:**')
    assert.notEqual(trigger, -1, `${rule.title} has no TRIGGER`)
    assert.notEqual(verify, -1, `${rule.title} has no VERIFY`)
    assert.notEqual(onFailure, -1, `${rule.title} has no ON FAILURE`)
    assert.ok(
      trigger < verify && verify < onFailure,
      `${rule.title}: TRIGGER → VERIFY → ON FAILURE order is what makes it actionable`,
    )
  }
  const body = section(GUARDRAILS_HEADING, FACTS_HEADING)
  assert.equal((body.match(/\*\*TRIGGER:\*\*/g) ?? []).length, 5)
  assert.equal((body.match(/\*\*VERIFY:\*\*/g) ?? []).length, 5)
  assert.equal((body.match(/\*\*ON FAILURE:\*\*/g) ?? []).length, 5)
})

test('every VERIFY names a command that produces evidence, not an adjective', () => {
  for (const rule of rules()) {
    const verify = rule.body.slice(rule.body.indexOf('**VERIFY:**'))
    const line = verify.split('\n')[0]
    assert.match(
      line,
      /`[^`]+`/,
      `${rule.title}: VERIFY must contain a runnable command in backticks (got: ${line.trim()})`,
    )
  }
})

test('the five rules keep their original meaning (the specific verifiers survive)', () => {
  const [g1, g2, g3, g4, g5] = rules()
  assert.match(g1.title, /required status checks or branch protection/i)
  assert.match(g1.body, /gh run list --branch main --workflow CI/)
  assert.match(g1.body, /success/)

  assert.match(g2.title, /One worktree per specialist/i)
  assert.match(g2.body, /git rev-parse --show-toplevel/)
  assert.match(g2.body, /never show the same path/)

  assert.match(g3.title, /config you do not control/i)
  assert.match(g3.body, /denies by default/)
  assert.match(g3.body, /no `\.gitignore`/)

  assert.match(g4.title, /reachability test/i)
  assert.match(g4.body, /git worktree add/)
  assert.match(g4.body, /scripts\/guardrails\.mjs/)

  assert.match(g5.title, /mapping \+ message contract \+ whole file/i)
  assert.match(g5.body, /npx commitlint --from origin\/main --to HEAD/)
  assert.match(g5.body, /never a `--test-name-pattern`/)
  assert.match(g5.body, /entire\*\* test file/)
})

test('the squash-merge cleanup caveat is recorded next to the rules', () => {
  const body = section(GUARDRAILS_HEADING, FACTS_HEADING)
  assert.match(
    body,
    /Squash merges make `git branch --merged` useless/,
    'a squashed head is not an ancestor of main, so merged-listing cleanup is wrong',
  )
})
