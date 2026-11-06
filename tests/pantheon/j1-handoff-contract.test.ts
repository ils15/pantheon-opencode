import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('the J1 enforce block is a handoff contract, not a bare error', () => {
  // The message is assembled from concatenated string chunks in the source;
  // each requirement is asserted as its own fragment (drift here regresses
  // the field requirement: risk hands off to the human, never a workaround).
  const source = readFileSync(
    fileURLToPath(new URL('../../src/plugin-v2.ts', import.meta.url)),
    'utf8',
  )
  assert.ok(source.includes('ENTREGUE AO USUÁRIO'), 'hands the decision to the human')
  assert.ok(source.includes('executa manualmente'), 'names the manual-execution path')
  assert.ok(/sem execut[áa]-la nem contorn/i.test(source), 'forbids executing or working around')
})
