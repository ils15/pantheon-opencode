import assert from 'node:assert/strict'
import test from 'node:test'

import { slugify, stripTags } from '../scripts/docs-link-check.mjs'

test('stripTags removes tags in one pass without leaving fragments', () => {
  // Normal paired tags.
  assert.equal(stripTags('<b>Title</b>'), 'Title')
  assert.equal(slugify('<b>Title</b>'), 'title')

  // A nested `<` makes the construct malformed; it is dropped whole, so no
  // fragment of the attempted tag name survives.
  assert.equal(stripTags('<scr<b>ipt>'), '')
  assert.doesNotMatch(stripTags('<scr<b>ipt>'), /ipt/)

  // An unbalanced `<` is literal text, not an opening tag.
  assert.equal(stripTags('a < b'), 'a < b')
  assert.equal(stripTags('<unclosed'), '<unclosed')

  // A `>` inside a quoted attribute does not close the tag.
  assert.equal(stripTags('<a title="x>y">T</a>'), 'T')
  assert.equal(slugify('<a title="x>y">T</a>'), 't')

  assert.equal(stripTags(''), '')
})
