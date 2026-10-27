import assert from 'node:assert/strict'
import { sanitizeVisionHistory } from '../../src/pantheon/vision.ts'

/**
 * Regression test for the host crash `r.inline is not a function`: the
 * sanitizer used to deep-copy EVERY object, stripping prototypes from
 * host-owned instances (bundled media parts carry an `.inline()` method).
 * The sanitize pass must return unchanged subtrees by original reference.
 */
async function main(): Promise<void> {
  // (a) An image-bearing part is replaced by a synthetic text part.
  const sessionText = new Map<string, Map<string, string>>([
    ['ses-1', new Map([['part-1', 'descrição da imagem']])],
  ])
  const withImage = {
    info: { sessionID: 'ses-1', id: 'msg-1' },
    parts: [
      { id: 'part-1', type: 'image', mime: 'image/png', url: 'data:image/png;base64,...' },
      { id: 'part-2', type: 'text', text: 'keep me' },
    ],
  }
  const outputA = { messages: [withImage] }
  sanitizeVisionHistory(outputA, sessionText)
  const parts = outputA.messages[0].parts as Array<Record<string, unknown>>
  assert.equal(parts[0].type, 'text', 'image part must become text')
  assert.equal(parts[0].text, 'descrição da imagem')
  assert.equal((parts[1] as { text: string }).text, 'keep me')

  // (b) Objects with methods (host instances) keep their prototype/reference
  //     across the sanitize pass.
  const inlinePart = { id: 'media-part-1', payload: 'bytes' }
  inlinePart.inline = () => 'x'
  const hostMessage = {
    info: { sessionID: 'ses-2', id: 'msg-2' },
    parts: [inlinePart, { id: 'p', type: 'text', text: 'hi' }],
  }
  const outputB = { messages: [hostMessage] }
  sanitizeVisionHistory(outputB, sessionText)
  const kept = (outputB.messages[0].parts as Array<unknown>)[0] as typeof inlinePart
  assert.equal(kept, inlinePart, 'non-image parts must be the ORIGINAL object reference')
  assert.equal(typeof kept.inline, 'function', 'methods must survive sanitization')
  assert.equal(kept.inline(), 'x', 'the host must still be able to call r.inline()')

  // (c) A message with NOTHING to replace is left untouched (no copy at all).
  const untouched = {
    info: { sessionID: 'ses-1', id: 'msg-3' },
    parts: [{ id: 'p', type: 'text', text: 'plain' }],
  }
  const outputC = { messages: [untouched] }
  sanitizeVisionHistory(outputC, sessionText)
  assert.ok(outputC.messages[0] === untouched, 'unchanged message keeps its reference')
  assert.ok(
    (untouched.parts as Array<unknown>)[0] === untouched.parts[0],
    'unchanged parts keep their references',
  )

  console.log('vision-sanitize.test.ts: all assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
