import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('the J1 enforce block is a handoff contract, not a bare error', () => {
  // The message is assembled from concatenated string chunks in the source;
  // each requirement is asserted as its own fragment (drift here regresses
  // the field requirement: risk hands off to the human, never a workaround).
  const source = readFileSync(
    fileURLToPath(new URL('../../src/plugin.ts', import.meta.url)),
    'utf8',
  )
  assert.ok(
    source.includes('APROVAÇÃO EXPLÍCITA NECESSÁRIA'),
    'demands explicit approval (field beta.20→21: the deny must be askable)',
  )
  assert.ok(source.includes('question com o nome'), 'names the question channel')
  assert.ok(/j1-approval-/, 'carries the approval marker')
  assert.ok(
    source.includes('sem executá-la nem contorná-la'),
    'forbids executing or working around',
  )
  assert.ok(source.includes('reintente a MESMA chamada'), 'the approved retry passes')
})
