import assert from 'node:assert/strict'
import { test } from 'node:test'
import { load } from 'js-yaml'

import { parseFrontmatter, serializeFm } from '../scripts/install/shared.mjs'

test('installer serializes quoted frontmatter using the js-yaml v5 API', () => {
  const serialized = serializeFm({ description: 'value: needs quoting' })

  assert.match(serialized, /description: "value: needs quoting"/)
  assert.deepEqual(load(serialized), { description: 'value: needs quoting' })
})

test('installer parses empty frontmatter as an empty object and preserves its body', () => {
  assert.deepEqual(parseFrontmatter('---\n---\nagent body'), {
    fm: {},
    body: 'agent body',
  })
})
