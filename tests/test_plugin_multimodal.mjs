import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'

const file = new URL(import.meta.url)
if (!process.execArgv.includes('--experimental-strip-types')) {
  const child = spawnSync(process.execPath, ['--experimental-strip-types', file.pathname], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  process.stdout.write(child.stdout)
  process.stderr.write(child.stderr)
  process.exit(child.status ?? 1)
}

const {
  default: plugin,
  isImageFilePart,
  parseImageResponse,
  replaceImagePartInPlace,
} = await import('../src/plugin.ts')

const image = (id = 'image-1', url = 'data:image/png;base64,ZmFrZQ==') => ({
  id,
  sessionID: 'session-1',
  messageID: `message-${id}`,
  type: 'file',
  mime: 'image/png',
  filename: `${id}.png`,
  url,
})

const userMessage = (parts, sessionID = 'session-1') => ({
  info: { id: 'message-1', sessionID, role: 'user' },
  parts,
})

function makeClient(responseText = '<item id="1"><description>uma tela</description></item>') {
  const calls = { create: 0, prompt: 0, deleted: 0, models: [] }
  let transform
  const client = {
    session: {
      create: async () => {
        calls.create += 1
        return { data: { id: `aux-${calls.create}` } }
      },
      prompt: async ({ body, path }) => {
        calls.prompt += 1
        calls.models.push(body.model)
        assert.ok(path.id.startsWith('aux-'))
        if (typeof responseText === 'function') await responseText(body, transform)
        return {
          data: {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: typeof responseText === 'string' ? responseText : 'ok' }],
          },
        }
      },
      delete: async () => {
        calls.deleted += 1
        return { data: true }
      },
    },
  }
  return { client, calls, setTransform: (value) => (transform = value) }
}

async function makeTransform(client) {
  const hooks = await plugin({ client, directory: '/tmp', project: {}, worktree: '/tmp' })
  return hooks['experimental.chat.messages.transform']
}

function withPreset(preset, fn) {
  const previous = process.env.PANTHEON_MODEL_PRESET
  if (preset === undefined) delete process.env.PANTHEON_MODEL_PRESET
  else process.env.PANTHEON_MODEL_PRESET = preset
  return Promise.resolve(fn()).finally(() => {
    if (previous === undefined) delete process.env.PANTHEON_MODEL_PRESET
    else process.env.PANTHEON_MODEL_PRESET = previous
  })
}

assert.equal(isImageFilePart(image()), true)
assert.equal(isImageFilePart({ type: 'file', mime: 'text/plain', url: 'file:///tmp/a' }), false)
assert.equal(isImageFilePart({ type: 'text', text: 'normal' }), false)

const parsed = parseImageResponse('<item id="1"><description>  mapa </description></item>')
assert.equal(parsed.descriptions.get(1), 'mapa')
assert.equal(parsed.context, '')

const directParts = [image()]
replaceImagePartInPlace(directParts, 0, 'descrição')
assert.equal(directParts[0].type, 'text')
assert.equal(directParts[0].text, 'descrição')
assert.equal('url' in directParts[0], false)
assert.equal('mime' in directParts[0], false)

await withPreset('none', async () => {
  const { client, calls, setTransform } = makeClient()
  const transform = await makeTransform(client)
  setTransform(transform)
  assert.ok(transform)

  const output = { messages: [userMessage([image(), { type: 'text', text: 'Analise a imagem' }])] }
  await transform({}, output)
  assert.equal(calls.prompt, 1)
  assert.equal(calls.models[0].providerID, 'opencode-go')
  assert.equal(calls.models[0].modelID, 'mimo-v2.5')
  assert.equal(output.messages[0].parts[0].type, 'text')
  assert.equal('url' in output.messages[0].parts[0], false)
  assert.equal(output.messages[0].parts[1].text, 'Analise a imagem')

  // An image in an earlier turn is also normalized before the next textual turn.
  const nextTurn = {
    messages: [
      userMessage([image()], 'session-1'),
      userMessage([{ type: 'text', text: 'Agora continue sem imagem' }], 'session-1'),
    ],
  }
  await transform({}, nextTurn)
  assert.equal(nextTurn.messages[0].parts[0].type, 'text')
  assert.equal(nextTurn.messages[1].parts[0].text, 'Agora continue sem imagem')
  assert.equal(JSON.stringify(nextTurn).includes('image_url'), false)
})

await withPreset('none', async () => {
  const { client, calls } = makeClient()
  const transform = await makeTransform(client)
  const first = { messages: [userMessage([image(), { type: 'text', text: 'mesmo prompt' }])] }
  const second = { messages: [userMessage([image(), { type: 'text', text: 'mesmo prompt' }])] }
  await transform({}, first)
  await transform({}, second)
  assert.equal(calls.prompt, 1, 'same session/prompt/image must use the cache')
})

await withPreset('none', async () => {
  const { client, calls, setTransform } = makeClient(async (_body, transform) => {
    await transform({}, { messages: [userMessage([image('recursive')], 'aux-1')] })
  })
  const transform = await makeTransform(client)
  setTransform(transform)
  await transform({}, { messages: [userMessage([image(), { type: 'text', text: 'recursion' }])] })
  assert.equal(calls.prompt, 1, 'auxiliary session must not recurse into another call')
})

await withPreset('none', async () => {
  const { client } = makeClient('not structured')
  const transform = await makeTransform(client)
  const output = { messages: [userMessage([image(), { type: 'text', text: 'unstructured' }])] }
  await transform({}, output)
  assert.equal(output.messages[0].parts[0].type, 'text')
  assert.equal(output.messages[0].parts[0].text, 'not structured')
})

await withPreset('none', async () => {
  const { client } = makeClient()
  client.session.prompt = async () => {
    throw new Error('auxiliary unavailable')
  }
  const transform = await makeTransform(client)
  const output = { messages: [userMessage([image(), { type: 'text', text: 'error path' }])] }
  await assert.doesNotReject(() => transform({}, output))
  assert.equal(output.messages[0].parts[0].type, 'file')
})

await withPreset('go-deepseek', async () => {
  const { client, calls } = makeClient()
  const transform = await makeTransform(client)
  await transform(
    {},
    { messages: [userMessage([image(), { type: 'text', text: 'preset vision' }])] },
  )
  assert.deepEqual(calls.models[0], { providerID: 'opencode-go', modelID: 'minimax-m3' })
})

console.log('✅ multimodal plugin tests passed')
