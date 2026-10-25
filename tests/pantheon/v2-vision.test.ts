import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, get as httpGet } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildV2ImagePrompt,
  buildV2VisionPromptContext,
  createPinnedLookup,
  createV2VisionTool,
  selectV2VisionModel,
  type V2VisionModel,
} from '../../src/pantheon/v2-vision.ts'

const MODELS: V2VisionModel[] = [
  {
    id: 'mimo-v2.6-flash-free',
    providerID: 'opencode',
    capabilities: { input: { text: true, image: true } },
  },
  {
    id: 'mimo-v2.6-flash',
    providerID: 'opencode-go',
    capabilities: { input: { text: true, image: true } },
  },
  {
    id: 'claude-sonnet',
    providerID: 'anthropic',
    capabilities: { input: ['text', 'image'] },
  },
  {
    id: 'text-only',
    providerID: 'opencode-go',
    capabilities: { input: { text: true, image: false } },
  },
  {
    id: 'disabled-vision',
    providerID: 'opencode-go',
    enabled: false,
    capabilities: { input: ['image'] },
  },
  {
    id: 'cost-zero-vision',
    providerID: 'opencode-go',
    cost: { input: 0 },
    capabilities: { input: ['image'] },
  },
]

async function main(): Promise<void> {
  const server = createServer((_request, response) => response.end('ok'))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const body = await new Promise<string>((resolve, reject) => {
      const request = httpGet(
        `http://pantheon.test:${address.port}`,
        {
          lookup: createPinnedLookup({ address: '127.0.0.1', family: 4 }),
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer | string) =>
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
          )
          response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        },
      )
      request.on('error', reject)
    })
    assert.equal(body, 'ok', 'pinned DNS lookup must honor Node autoSelectFamily all=true')
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }

  const visualContext = buildV2VisionPromptContext([
    { uri: 'file:///workspace/design.png', mime: 'image/png', filename: 'design.png' },
    { uri: 'data:image/jpeg;base64,PRIVATE_IMAGE_BYTES', mime: 'image/jpeg', name: 'inline.jpg' },
    { uri: 'https://example.test/readme.txt', mime: 'text/plain', filename: 'readme.txt' },
  ])
  assert.match(visualContext ?? '', /design\.png/)
  assert.match(visualContext ?? '', /file:\/\/\/workspace\/design\.png/)
  assert.match(visualContext ?? '', /inline\.jpg/)
  assert.doesNotMatch(visualContext ?? '', /PRIVATE_IMAGE_BYTES/)
  assert.match(visualContext ?? '', /preserve|preserve alterações/i)
  assert.equal(buildV2VisionPromptContext([{ uri: 'file:///workspace/readme.txt' }]), undefined)

  // ── Anexo clipboard/inline (shape REAL do TUI V2) ─────────────────────────
  // O anexo clipboard não tem arquivo em disco: os bytes vêm como data URI e o
  // display name é "clipboard". O contexto precisa materializar os bytes num
  // temp file real e referenciar o CAMINHO (o modelo passava "clipboard" como
  // path e o tool falhava com `ENOENT: .../clipboard`).
  const clipboardBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5])
  const clipboardContext = buildV2VisionPromptContext([
    {
      uri: `data:image/png;base64,${clipboardBytes.toString('base64')}`,
      mime: 'image/png',
      name: 'clipboard',
    },
  ])
  assert.match(clipboardContext ?? '', /"clipboard"/)
  assert.doesNotMatch(
    clipboardContext ?? '',
    new RegExp(clipboardBytes.toString('base64')),
    'payload inline não é copiado para o texto do prompt',
  )
  const tempMatch = /em ("[^"]+\.png")/.exec(clipboardContext ?? '')
  assert.ok(tempMatch, 'o contexto referencia um caminho de arquivo real')
  const tempPath = JSON.parse(tempMatch?.[1] ?? '""') as string
  assert.ok(existsSync(tempPath), 'temp file do anexo inline existe em disco')
  assert.equal(
    (await readFile(tempPath)).equals(clipboardBytes),
    true,
    'temp file contém exatamente os bytes do anexo',
  )

  // Sem bytes utilizáveis → cai no formato antigo (sem caminho, payload omitido).
  const emptyInline = buildV2VisionPromptContext([
    { uri: 'data:image/png;base64,', mime: 'image/png', name: 'clipboard' },
  ])
  assert.match(emptyInline ?? '', /URI codificada omitida/, 'sem bytes → marcado como omitido')

  // ── Fase 2: o contexto visual propaga a pergunta do usuário ───────────────
  // A pergunta do turno entra no contexto (mesma imagem + pergunta nova =
  // análise nova); o modelo principal é instruído a repassá-la no `prompt`
  // da ferramenta vision_describe.
  const questionContext = buildV2VisionPromptContext(
    [{ uri: 'file:///workspace/log.png', mime: 'image/png', filename: 'log.png' }],
    'qual o erro no log?',
  )
  assert.match(questionContext ?? '', /qual o erro no log\?/, 'pergunta presente no contexto')
  assert.match(
    questionContext ?? '',
    /vision_describe/,
    'contexto instrui o repasse da pergunta à ferramenta',
  )
  assert.match(questionContext ?? '', /preserve alterações/i, 'guia de preservação mantido')

  // ── Relay do session id para o MCP (paridade com generateInjectionPrompt) ──
  // O MCP roda em outro processo sem session id; sem o repasse o gateway Zen
  // rejeita com HTTP 400 MissingSessionID (bug relatado no reteste V2).
  const sessionContext = buildV2VisionPromptContext(
    [{ uri: 'file:///workspace/design.png', mime: 'image/png', filename: 'design.png' }],
    'implemente isso',
    'ses_abc123',
  )
  assert.match(
    sessionContext ?? '',
    /session_id="ses_abc123"/,
    'session id repassado ao MCP (JSON-quoted)',
  )
  assert.match(sessionContext ?? '', /pantheon-vision/, 'instrução nomeia o MCP')
  assert.match(sessionContext ?? '', /MissingSessionID/, 'instrução explica o erro evitado')
  assert.match(sessionContext ?? '', /vision_describe/, 'instrução cita a ferramenta nativa/MCP')
  // sessionID vazio/whitespace → nenhuma instrução de repasse.
  assert.equal(
    (
      buildV2VisionPromptContext(
        [{ uri: 'file:///workspace/design.png', mime: 'image/png', filename: 'design.png' }],
        'implemente isso',
        '   ',
      ) ?? ''
    ).includes('session_id='),
    false,
    'sessionID em branco não emite instrução de repasse',
  )
  // Sem sessionID → nenhuma instrução de repasse (não inventa um id).
  assert.equal(
    (questionContext ?? '').includes('session_id='),
    false,
    'sem sessionID → nenhuma instrução de repasse',
  )

  // userText vazio/whitespace → contexto genérico inalterado.
  const phase2Files = [
    { uri: 'file:///workspace/design.png', mime: 'image/png', filename: 'design.png' },
  ]
  assert.equal(
    buildV2VisionPromptContext(phase2Files, '   '),
    buildV2VisionPromptContext(phase2Files),
    'userText vazio → contexto genérico idêntico',
  )
  assert.equal(
    buildV2VisionPromptContext(phase2Files, '   ')?.includes('qual o erro'),
    false,
    'whitespace não vira pergunta',
  )

  // IMAGE_PROMPT fixo virou template com {userText}: sem pergunta → prompt
  // genérico byte-a-byte; com pergunta → interpolação single-pass (literais
  // {…} no texto do usuário ficam inertes) e teto de 2000 chars.
  assert.equal(
    buildV2ImagePrompt(),
    'Descreva fielmente a imagem anexada. Inclua conteúdo, texto visível, layout e objetos; ' +
      'declare incerteza em vez de adivinhar e responda em português claro.',
    'sem pergunta → prompt genérico inalterado',
  )
  const questionPrompt = buildV2ImagePrompt('qual o erro no log?')
  assert.match(questionPrompt, /qual o erro no log\?/, 'pergunta interpolada no prompt')
  const probePrompt = buildV2ImagePrompt('veja {imageList} e {toolName}')
  assert.ok(
    probePrompt.includes('veja {imageList} e {toolName}'),
    'literais de template no userText permanecem verbatim',
  )
  const longV2Prompt = buildV2ImagePrompt('x'.repeat(5000))
  assert.ok(
    longV2Prompt.includes(`${'x'.repeat(1999)}…`),
    'v2 prompt truncado no teto de 2000 chars (1999 + "…")',
  )
  assert.ok(
    !longV2Prompt.includes('x'.repeat(2000)),
    'v2 prompt não excede o teto de 2000 chars de userText (marcador conta)',
  )

  // Free-tier models are excluded from the native describe path (the direct
  // gateway rejects them with HTTP 403 "free tier can only be used from within
  // OpenCode"); the Go default wins.
  assert.equal(selectV2VisionModel({ data: MODELS })?.id, 'mimo-v2.6-flash')
  assert.equal(
    selectV2VisionModel(MODELS, 'anthropic/claude-sonnet')?.id,
    undefined,
    'an explicit unsupported-provider pin must not be silently substituted',
  )
  assert.equal(
    selectV2VisionModel(MODELS, 'opencode-go/text-only'),
    undefined,
    'an explicit text-only pin must not be silently substituted',
  )
  assert.equal(selectV2VisionModel(MODELS.slice(2)), undefined)
  assert.equal(
    selectV2VisionModel({
      data: [
        {
          id: 'only-free',
          providerID: 'opencode-go',
          capabilities: { input: ['image'] },
        },
      ],
    }),
    undefined,
    'a free-tier-only catalog yields no native model',
  )
  assert.equal(
    selectV2VisionModel({ data: [MODELS[5], MODELS[1]] })?.id,
    'mimo-v2.6-flash',
    'cost.input === 0 is treated as free-tier and skipped',
  )
  // An EXPLICIT pin wins even when free-tier (the env/config/preset value is the
  // user's decision); free-tier is excluded only from AUTOMATIC selection. The
  // gateway's HTTP 403 then surfaces with its actionable message instead of a
  // silent substitution back to the default.
  assert.equal(
    selectV2VisionModel({ data: MODELS }, 'opencode/mimo-v2.6-flash-free')?.id,
    'mimo-v2.6-flash-free',
    'an explicit free-tier pin must be honored, not dropped',
  )
  assert.equal(
    selectV2VisionModel({ data: MODELS }, 'opencode-go/cost-zero-vision')?.id,
    'cost-zero-vision',
    'an explicit cost-0 pin must be honored too',
  )
  // Auto (no explicit pin) still never chooses a free-tier model.
  assert.equal(
    selectV2VisionModel({ data: MODELS })?.id,
    'mimo-v2.6-flash',
    'automatic selection must not pick a free-tier model',
  )

  const priorApiKey = process.env.PANTHEON_OPENCODE_API_KEY
  const priorOpenCodeApiKey = process.env.OPENCODE_API_KEY
  const priorDataHome = process.env.XDG_DATA_HOME
  const priorVisionModel = process.env.PANTHEON_VISION_MODEL
  process.env.PANTHEON_OPENCODE_API_KEY = 'canary-key'
  // Pin the model explicitly so the tool never depends on the developer's
  // ambient active preset (which may pin a free-tier model — honored now).
  process.env.PANTHEON_VISION_MODEL = 'opencode-go/mimo-v2.6-flash'
  const originalFetch = globalThis.fetch
  let requestURL = ''
  let requestAuthorization = ''
  let requestSession = ''
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (input, init) => {
    requestURL = String(input)
    const headers = new Headers(init?.headers)
    requestAuthorization = headers.get('authorization') ?? ''
    requestSession = headers.get('x-opencode-session') ?? ''
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'A imagem mostra uma cena de teste.' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch

  try {
    const runtime = { model: { list: async () => ({ data: MODELS }) } }
    const tool = createV2VisionTool(runtime)
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')
    const result = await tool.execute(
      { path: `data:image/png;base64,${png}`, prompt: 'Descreva esta imagem.' },
      { sessionID: 'ses_parent_session', directory: '/project' },
    )

    assert.equal(tool.name, 'vision_describe')
    assert.equal(result.output, 'A imagem mostra uma cena de teste.')
    assert.equal(result.metadata?.model, 'opencode-go/mimo-v2.6-flash')
    assert.equal(requestURL, 'https://opencode.ai/zen/go/v1/chat/completions')
    assert.equal(requestAuthorization, 'Bearer canary-key')
    // Zen-only session header: the tool context's sessionID reaches the gateway.
    assert.equal(requestSession, 'ses_parent_session', 'x-opencode-session sent for Zen')
    assert.equal(requestBody?.model, 'mimo-v2.6-flash')
    // 2048 (not the former 500): a reasoning model spends max_tokens on
    // reasoning tokens FIRST — 500 truncated EVERY call (content null,
    // finish_reason "length"). See NATIVE_MAX_TOKENS in vision.ts.
    assert.equal(requestBody?.max_tokens, 2048)
    const messages = requestBody?.messages as Array<{ content: Array<Record<string, unknown>> }>
    assert.equal(messages[0]?.content[0]?.text, 'Descreva esta imagem.')
    assert.equal(messages[0]?.content[1]?.type, 'image_url')
    assert.match(
      String((messages[0]?.content[1]?.image_url as Record<string, unknown>)?.url),
      /^data:image\/png;base64,/,
    )

    const projectDir = await mkdtemp(join(tmpdir(), 'pantheon-v2-vision-project-'))
    try {
      await writeFile(join(projectDir, 'relative.png'), Buffer.from(png, 'base64'))
      const relativeResult = await tool.execute(
        { path: 'relative.png' },
        { sessionID: 'ses_valid123', directory: projectDir },
      )
      assert.equal(relativeResult.output, 'A imagem mostra uma cena de teste.')
      const relativeMessages = requestBody?.messages as Array<{
        content: Array<Record<string, unknown>>
      }>
      assert.match(
        String((relativeMessages[0]?.content[1]?.image_url as Record<string, unknown>)?.url),
        /^data:image\/png;base64,/,
        'relative image paths resolve from the project directory',
      )
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }

    // Path inexistente (ex.: o modelo chuta o display name "clipboard") →
    // mensagem acionável em vez do ENOENT cru.
    const notFound = await tool.execute(
      { path: '/nonexistent/clipboard' },
      { sessionID: 'ses_valid123', directory: '/project' },
    )
    assert.match(notFound.output, /image file not found/i)
    assert.match(notFound.output, /base64 image data URI/i)

    // Gateway rejeita (ex.: credencial/modelo) → status HTTP visível e acionável,
    // sem expor chave nem payload.
    const okFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('{}', { status: 401 })) as typeof fetch
    try {
      const rejected = await tool.execute(
        { path: `data:image/png;base64,${png}` },
        { sessionID: 'ses_valid123', directory: '/project' },
      )
      assert.match(rejected.output, /HTTP 401/)
      assert.match(rejected.output, /Zen gateway/i)
    } finally {
      globalThis.fetch = okFetch
    }

    // Missing/invalid sessions fail before remote image fetch, catalog lookup,
    // or Zen gateway calls.
    let imageRequests = 0
    const imageServer = createServer((_request, response) => {
      imageRequests += 1
      response.end('image')
    })
    await new Promise<void>((resolve, reject) => {
      imageServer.once('error', reject)
      imageServer.listen(0, '127.0.0.1', resolve)
    })
    const imageAddress = imageServer.address()
    assert.ok(imageAddress && typeof imageAddress === 'object')
    let catalogCalls = 0
    let zenCalls = 0
    const guardedTool = createV2VisionTool({
      model: {
        list: async () => {
          catalogCalls += 1
          return { data: MODELS }
        },
      },
    })
    globalThis.fetch = (async () => {
      zenCalls += 1
      return new Response('{}')
    }) as typeof fetch
    try {
      for (const context of [{}, { sessionID: 'not-a-session' }]) {
        const rejected = await guardedTool.execute(
          { path: `http://127.0.0.1:${imageAddress.port}/image.png` },
          context,
        )
        assert.match(rejected.output, /valid OpenCode session/i)
      }
      assert.equal(imageRequests, 0)
      assert.equal(catalogCalls, 0)
      assert.equal(zenCalls, 0)
    } finally {
      globalThis.fetch = okFetch
      await new Promise<void>((resolve, reject) =>
        imageServer.close((error) => (error ? reject(error) : resolve())),
      )
    }

    // 403 → free-tier / sem acesso pago é nomeado.
    globalThis.fetch = (async () => new Response('{}', { status: 403 })) as typeof fetch
    try {
      const denied = await tool.execute(
        { path: `data:image/png;base64,${png}` },
        { sessionID: 'ses_parent_session', directory: '/project' },
      )
      assert.match(denied.output, /HTTP 403/)
      assert.match(denied.output, /free-tier/)
    } finally {
      globalThis.fetch = okFetch
    }

    // An explicit FREE-tier pin is honored, never silently swapped for the
    // default: the call targets the pinned model and its 403 surfaces with the
    // actionable message.
    process.env.PANTHEON_VISION_MODEL = 'opencode/mimo-v2.6-flash-free'
    let pinnedURL = ''
    let pinnedModel = ''
    globalThis.fetch = (async (input, init) => {
      pinnedURL = String(input)
      pinnedModel = String((JSON.parse(String(init?.body)) as Record<string, unknown>).model ?? '')
      return new Response('{}', { status: 403 })
    }) as typeof fetch
    try {
      const pinnedDenied = await tool.execute(
        { path: `data:image/png;base64,${png}` },
        { sessionID: 'ses_parent_session', directory: '/project' },
      )
      assert.equal(
        pinnedModel,
        'mimo-v2.6-flash-free',
        'the explicit free-tier pin must be the model actually sent',
      )
      assert.match(pinnedURL, /^https:\/\/opencode\.ai\/zen\//)
      assert.match(pinnedDenied.output, /HTTP 403/)
      assert.match(pinnedDenied.output, /free-tier/)
    } finally {
      process.env.PANTHEON_VISION_MODEL = 'opencode-go/mimo-v2.6-flash'
      globalThis.fetch = okFetch
    }

    // Modelo de reasoning cortado por max_tokens (content: null + finish_reason
    // length) → finish_reason aparece na mensagem para ação clara.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: null }, finish_reason: 'length' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch
    try {
      const truncated = await tool.execute(
        { path: `data:image/png;base64,${png}` },
        { sessionID: 'ses_parent_session', directory: '/project' },
      )
      assert.match(truncated.output, /finish_reason: length/)
      assert.match(truncated.output, /max_tokens/)
    } finally {
      globalThis.fetch = okFetch
    }

    const dataHome = await mkdtemp(join(tmpdir(), 'pantheon-v2-vision-auth-'))
    try {
      const authDirectory = join(dataHome, 'opencode')
      await mkdir(authDirectory, { recursive: true })
      await writeFile(
        join(authDirectory, 'auth.json'),
        JSON.stringify({ opencode: { access: 'stored-key', expires: 0 } }),
      )
      delete process.env.PANTHEON_OPENCODE_API_KEY
      delete process.env.OPENCODE_API_KEY
      process.env.XDG_DATA_HOME = dataHome
      const storedAuthResult = await tool.execute(
        { path: `data:image/png;base64,${png}` },
        { sessionID: 'ses_valid123', directory: '/project' },
      )
      assert.equal(storedAuthResult.output, 'A imagem mostra uma cena de teste.')
      assert.equal(requestAuthorization, 'Bearer stored-key')
    } finally {
      await rm(dataHome, { recursive: true, force: true })
      if (priorApiKey === undefined) delete process.env.PANTHEON_OPENCODE_API_KEY
      else process.env.PANTHEON_OPENCODE_API_KEY = priorApiKey
      if (priorOpenCodeApiKey === undefined) delete process.env.OPENCODE_API_KEY
      else process.env.OPENCODE_API_KEY = priorOpenCodeApiKey
      if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = priorDataHome
    }
  } finally {
    globalThis.fetch = originalFetch
    if (priorApiKey === undefined) delete process.env.PANTHEON_OPENCODE_API_KEY
    else process.env.PANTHEON_OPENCODE_API_KEY = priorApiKey
    if (priorVisionModel === undefined) delete process.env.PANTHEON_VISION_MODEL
    else process.env.PANTHEON_VISION_MODEL = priorVisionModel
  }

  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')
  const priorHome = process.env.HOME
  const priorConfigHome = process.env.XDG_CONFIG_HOME
  const priorModelPreset = process.env.PANTHEON_MODEL_PRESET
  const priorExplicitVisionModel = process.env.PANTHEON_VISION_MODEL
  const isolatedHome = await mkdtemp(join(tmpdir(), 'pantheon-v2-vision-prefs-'))
  process.env.HOME = isolatedHome
  process.env.XDG_CONFIG_HOME = join(isolatedHome, 'config')
  delete process.env.PANTHEON_MODEL_PRESET
  delete process.env.PANTHEON_VISION_MODEL
  try {
    const missingModelTool = createV2VisionTool({
      model: { list: async () => ({ data: MODELS.slice(2, 3) }) },
    })
    const unavailable = await missingModelTool.execute(
      { path: `data:image/png;base64,${png}` },
      { sessionID: 'ses_valid123', directory: isolatedHome },
    )
    assert.match(unavailable.output, /no available OpenCode Zen multimodal model/i)
  } finally {
    await rm(isolatedHome, { recursive: true, force: true })
    if (priorHome === undefined) delete process.env.HOME
    else process.env.HOME = priorHome
    if (priorConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = priorConfigHome
    if (priorModelPreset === undefined) delete process.env.PANTHEON_MODEL_PRESET
    else process.env.PANTHEON_MODEL_PRESET = priorModelPreset
    if (priorExplicitVisionModel === undefined) delete process.env.PANTHEON_VISION_MODEL
    else process.env.PANTHEON_VISION_MODEL = priorExplicitVisionModel
  }

  const priorPinnedModel = process.env.PANTHEON_VISION_MODEL
  const priorPinnedApiKey = process.env.PANTHEON_OPENCODE_API_KEY
  const priorPinnedFetch = globalThis.fetch
  process.env.PANTHEON_VISION_MODEL = 'anthropic/claude-sonnet'
  process.env.PANTHEON_OPENCODE_API_KEY = 'test-key'
  let badPinCatalogCalls = 0
  let badPinGatewayCalls = 0
  globalThis.fetch = (async () => {
    badPinGatewayCalls += 1
    return new Response('{}')
  }) as typeof fetch
  try {
    const badPinTool = createV2VisionTool({
      model: {
        list: async () => {
          badPinCatalogCalls += 1
          return { data: MODELS }
        },
      },
    })
    const badPin = await badPinTool.execute(
      { path: `data:image/png;base64,${png}` },
      { sessionID: 'ses_valid123', directory: '/project' },
    )
    assert.match(badPin.output, /explicit.*model.*unavailable|pinned.*model.*unavailable/i)
    assert.match(badPin.output, /update or remove.*model pin|choose.*Zen.*model/i)
    assert.equal(badPinCatalogCalls, 1)
    assert.equal(badPinGatewayCalls, 0)
  } finally {
    globalThis.fetch = priorPinnedFetch
    if (priorPinnedModel === undefined) delete process.env.PANTHEON_VISION_MODEL
    else process.env.PANTHEON_VISION_MODEL = priorPinnedModel
    if (priorPinnedApiKey === undefined) delete process.env.PANTHEON_OPENCODE_API_KEY
    else process.env.PANTHEON_OPENCODE_API_KEY = priorPinnedApiKey
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
