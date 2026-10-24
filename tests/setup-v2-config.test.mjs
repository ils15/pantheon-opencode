import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runSetup } from '../scripts/setup.mjs'
import {
  applyConfigChanges,
  inspectConfigFiles,
  prepareV2Config,
  resolveGlobalConfigDirectory,
} from '../scripts/setup-v2-config.mjs'

const CANCEL = Symbol('cancel')

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-setup-v2-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function createPrompts({ targets = [], source, ask = {}, review = true, apply = false } = {}) {
  return {
    multiselect: async () => targets,
    select: async ({ message, options }) => {
      if (message.includes('MCP')) {
        const answer = Object.values(ask)[0]
        return answer && options.some(({ value }) => value === answer) ? answer : CANCEL
      }
      return source ?? CANCEL
    },
    confirm: async ({ message }) => (message.includes('Review and prepare') ? review : apply),
    isCancel: (value) => value === CANCEL,
    cancel() {},
  }
}

function captureOutput() {
  const lines = []
  return { lines, write: (text) => lines.push(String(text)) }
}

test('setup wrapper preserves init --yes and only offers V2 preparation on a detected V2 host', async () => {
  const calls = []
  const runInit = async (args) => {
    calls.push(args)
    return { status: 0 }
  }
  const prepared = []
  await runSetup({
    args: ['--yes'],
    env: { OPENCODE_VERSION: 'v1' },
    interactive: true,
    runInit,
    prepare: async (options) => prepared.push(options),
    output: { write() {} },
  })
  assert.deepEqual(calls, [['init', '--yes', '--yes']])
  assert.deepEqual(prepared, [])

  await runSetup({
    args: [],
    env: { OPENCODE_VERSION: 'v2' },
    interactive: true,
    runInit,
    prepare: async (options) => prepared.push(options),
    output: { write() {} },
  })
  assert.equal(prepared.length, 1)
  assert.equal(prepared[0].interactive, true)
})

test('setup wrapper uses init version precedence for explicit CLI selections over environment', async () => {
  const prepared = []
  const run = async (args, env) =>
    runSetup({
      args,
      env,
      interactive: true,
      runInit: async () => ({ status: 0 }),
      prepare: async (options) => prepared.push(options),
      output: { write() {} },
    })

  await run(['--opencode-version', 'v2'], { OPENCODE_VERSION: 'v1' })
  assert.equal(prepared.length, 1)
  await run(['--version=v1'], { OPENCODE_VERSION: 'v2' })
  assert.equal(prepared.length, 1)
  await run(['--version', 'v2'], { OPENCODE_VERSION: 'v1' })
  assert.equal(prepared.length, 2)
})

test('headless setup previews V2 config even with --yes and never applies it', async () => {
  const prepared = []
  await runSetup({
    args: ['--yes'],
    env: { OPENCODE_VERSION: 'v2', CI: 'true' },
    interactive: true,
    runInit: async () => ({ status: 0 }),
    prepare: async (options) => prepared.push(options),
    output: { write() {} },
  })
  assert.equal(prepared.length, 1)
  assert.equal(prepared[0].interactive, false)
})

test('config inspection handles JSON only, JSONC only, both files, and neither', (t) => {
  const root = fixture(t)
  const json = join(root, 'opencode.json')
  const jsonc = join(root, 'opencode.jsonc')
  writeFileSync(json, '{"permission":{"edit":"deny"}}\n')
  let files = inspectConfigFiles(root)
  assert.deepEqual(
    files.filter(({ exists }) => exists).map(({ name }) => name),
    ['opencode.json'],
  )
  assert.equal(files[0].config.permission.edit, 'deny')

  rmSync(json)
  writeFileSync(
    jsonc,
    '{\n  // keep this note\n  "permissions": [{"action":"edit","resource":"*","effect":"deny"}],\n}\n',
  )
  files = inspectConfigFiles(root)
  assert.deepEqual(
    files.filter(({ exists }) => exists).map(({ name }) => name),
    ['opencode.jsonc'],
  )
  assert.equal(files[1].config.permissions[0].effect, 'deny')

  writeFileSync(json, '{"permission":{"edit":"allow"}}\n')
  files = inspectConfigFiles(root)
  assert.deepEqual(
    files.filter(({ exists }) => exists).map(({ name }) => name),
    ['opencode.json', 'opencode.jsonc'],
  )
  rmSync(json)
  rmSync(jsonc)
  assert.equal(
    inspectConfigFiles(root).some(({ exists }) => exists),
    false,
  )
})

test('config preparation resolves the same default HOME and XDG targets as init', (t) => {
  const home = fixture(t)
  assert.equal(resolveGlobalConfigDirectory({}, home), join(home, '.config', 'opencode'))
  assert.equal(
    resolveGlobalConfigDirectory({ XDG_CONFIG_HOME: join(home, 'xdg') }, home),
    join(home, 'xdg', 'opencode'),
  )
})

test('setup passes init XDG selection through to V2 preparation', async (t) => {
  const home = fixture(t)
  const xdg = join(home, 'xdg')
  let selected
  await runSetup({
    args: [],
    env: { OPENCODE_VERSION: 'v2', XDG_CONFIG_HOME: xdg },
    home,
    interactive: true,
    runInit: async () => ({ status: 0 }),
    prepare: async ({ configDir }) => {
      selected = configDir
    },
    output: { write() {} },
  })
  assert.equal(selected, join(xdg, 'opencode'))
})

test('symlinked config directory is blocked without reading or writing outside it', async (t) => {
  const root = fixture(t)
  const outside = join(root, 'outside')
  const selected = join(root, 'selected')
  fs.mkdirSync(outside)
  const target = join(outside, 'opencode.json')
  const original = '{"permission":{"edit":"deny"}}\n'
  writeFileSync(target, original)
  symlinkSync(outside, selected, 'dir')

  const output = captureOutput()
  const result = await prepareV2Config({
    configDir: selected,
    interactive: true,
    prompts: createPrompts({ targets: [join(selected, 'opencode.json')], apply: true }),
    output,
  })
  assert.equal(result.status, 'blocked')
  assert.equal(readFileSync(target, 'utf8'), original)
  assert.deepEqual(fs.readdirSync(outside), ['opencode.json'])
})

test('symlinked config ancestor is blocked without outside writes', async (t) => {
  const root = fixture(t)
  const outside = join(root, 'outside')
  const selectedParent = join(root, '.config')
  const selected = join(selectedParent, 'opencode')
  fs.mkdirSync(outside)
  fs.mkdirSync(join(outside, 'opencode'))
  const target = join(outside, 'opencode', 'opencode.json')
  const original = '{"permission":{"edit":"deny"}}\n'
  writeFileSync(target, original)
  symlinkSync(outside, selectedParent, 'dir')

  const result = await prepareV2Config({
    configDir: selected,
    interactive: false,
    output: captureOutput(),
  })
  assert.equal(result.status, 'blocked')
  assert.equal(readFileSync(target, 'utf8'), original)
  assert.deepEqual(fs.readdirSync(join(outside, 'opencode')), ['opencode.json'])
})

test('preview and interactive review never print credential or unrelated config values', async (t) => {
  const root = fixture(t)
  const secrets = [
    'sk-secret-preview-credential',
    'unrelated-password-value',
    'sk-secret-conflict-credential',
  ]
  const target = join(root, 'opencode.json')
  const conflictTarget = join(root, 'opencode.jsonc')
  const original = JSON.stringify({
    provider: { openai: { options: { apiKey: secrets[0], password: secrets[1] } } },
    theme: 'private-theme-value',
    permission: { edit: 'deny' },
  })
  writeFileSync(target, original)
  writeFileSync(
    conflictTarget,
    JSON.stringify({
      provider: { openai: { options: { apiKey: secrets[2] } } },
      permissions: [{ action: 'edit', resource: '*', effect: 'allow' }],
    }),
  )

  const previewOutput = captureOutput()
  await prepareV2Config({ configDir: root, interactive: false, output: previewOutput })
  const interactiveOutput = captureOutput()
  const promptLines = []
  const prompts = createPrompts({
    targets: [target, conflictTarget],
    source: `${target}#permission`,
    apply: false,
  })
  const select = prompts.select
  prompts.select = async (prompt) => {
    promptLines.push(JSON.stringify({ message: prompt.message, options: prompt.options }))
    return select(prompt)
  }
  await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts,
    output: interactiveOutput,
  })
  for (const text of [
    previewOutput.lines.join('\n'),
    interactiveOutput.lines.join('\n'),
    promptLines.join('\n'),
  ]) {
    for (const secret of secrets) assert.equal(text.includes(secret), false)
    assert.equal(text.includes('private-theme-value'), false)
  }
})

test('canceling the target review leaves config unchanged', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const original = '{\n  "permission": {"edit": "deny"}\n}\n'
  writeFileSync(target, original)
  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [] }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'canceled')
  assert.equal(readFileSync(target, 'utf8'), original)
})

test('skipping the optional V2 review leaves config unchanged', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const original = '{"permission":{"edit":"deny"}}\n'
  writeFileSync(target, original)
  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ review: false }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'skipped')
  assert.equal(readFileSync(target, 'utf8'), original)
})

test('headless preview never writes, even when the legacy policy has no conflicts', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const original = '{"permission":{"edit":"deny"}}\n'
  writeFileSync(target, original)
  const output = captureOutput()
  const result = await prepareV2Config({ configDir: root, interactive: false, output })
  assert.equal(result.status, 'preview')
  assert.equal(readFileSync(target, 'utf8'), original)
  assert.match(output.lines.join('\n'), /permissions/)
})

test('multiple policy sources are an explicit conflict and missing choice makes no writes', async (t) => {
  const root = fixture(t)
  const json = join(root, 'opencode.json')
  const jsonc = join(root, 'opencode.jsonc')
  const originalJson = '{"permission":{"edit":"deny"}}\n'
  const originalJsonc = '{"permissions":[{"action":"edit","resource":"*","effect":"allow"}]}\n'
  writeFileSync(json, originalJson)
  writeFileSync(jsonc, originalJsonc)
  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [json, jsonc] }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'canceled')
  assert.equal(readFileSync(json, 'utf8'), originalJson)
  assert.equal(readFileSync(jsonc, 'utf8'), originalJsonc)
})

test('conflicting layers require every source file as a selected target and use one chosen value without merging', async (t) => {
  const root = fixture(t)
  const json = join(root, 'opencode.json')
  const jsonc = join(root, 'opencode.jsonc')
  const originalJson = '{"permission":{"edit":"deny"}}\n'
  const originalJsonc =
    '{\n  // unrelated layer note\n  "permissions": [{"action":"edit","resource":"*","effect":"allow"}]\n}\n'
  writeFileSync(json, originalJson)
  writeFileSync(jsonc, originalJsonc)
  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({
      targets: [json, jsonc],
      source: `${json}#permission`,
      apply: true,
    }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'applied')
  const jsonPolicy = JSON.parse(readFileSync(json, 'utf8')).permissions
  const jsoncAfter = readFileSync(jsonc, 'utf8')
  assert.deepEqual(inspectConfigFiles(root)[1].config.permissions, jsonPolicy)
  assert.deepEqual(jsonPolicy, [{ action: 'edit', resource: '*', effect: 'deny' }])
  assert.match(jsoncAfter, /\/\/ unrelated layer note/)
})

test('conflicting legacy aliases are blocked rather than silently merged', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const original = '{"permission":{"bash":{"git":"allow"},"shell":{"git":"deny"}}}\n'
  writeFileSync(target, original)
  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [target], apply: true }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'blocked')
  assert.equal(readFileSync(target, 'utf8'), original)
})

test('an MCP ask rule requires an explicit allow or deny choice before it can be changed', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const original = '{"permission":{"mcp":{"research":"ask"}}}\n'
  writeFileSync(target, original)
  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [target], apply: true }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'canceled')
  assert.equal(readFileSync(target, 'utf8'), original)
})

test('an explicit MCP ask choice is previewed and requires a separate apply confirmation', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const original = '{"permission":{"mcp":{"research":"ask"}}}\n'
  writeFileSync(target, original)
  const output = captureOutput()
  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({
      targets: [target],
      ask: { [`${target}#permission#mcp:research`]: 'deny' },
      apply: false,
    }),
    output,
  })
  assert.equal(result.status, 'canceled')
  assert.match(output.lines.join('\n'), /permission\.mcp\.research/)
  assert.equal(readFileSync(target, 'utf8'), original)
})

test('an explicit MCP deny choice is applied only after the separate confirmation', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const original = '{"permission":{"mcp":{"research":"ask"}}}\n'
  writeFileSync(target, original)
  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({
      targets: [target],
      ask: { [`${target}#permission#mcp:research`]: 'deny' },
      apply: true,
    }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'applied')
  const updated = JSON.parse(readFileSync(target, 'utf8'))
  assert.deepEqual(updated.permissions, [{ action: 'research_*', resource: '*', effect: 'deny' }])
  assert.equal(Object.hasOwn(updated, 'permission'), false)
  assert.equal(readFileSync(result.backups[0].path, 'utf8'), original)
})

test('JSONC comments and unrelated settings survive a reviewed application', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.jsonc')
  const original =
    '{\n  // retain the host note\n  "theme": "dark",\n  "permission": {"edit": "deny"}\n}\n'
  writeFileSync(target, original)
  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [target], apply: true }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'applied')
  const updated = readFileSync(target, 'utf8')
  assert.match(updated, /\/\/ retain the host note/)
  assert.match(updated, /"theme": "dark"/)
  assert.match(updated, /"permissions"/)
  assert.doesNotMatch(updated, /"permission"\s*:/)
  assert.ok(result.backups[0].path)
})

test('a JSONC comment inside a value that would be rewritten blocks writes', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.jsonc')
  const original = '{"permission": { /* keep */ "edit": "deny"}}\n'
  writeFileSync(target, original)
  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [target], apply: true }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'blocked')
  assert.equal(readFileSync(target, 'utf8'), original)
})

test('apply creates clear backups and rollback restores earlier files on partial failure', (t) => {
  const root = fixture(t)
  const first = join(root, 'opencode.json')
  const second = join(root, 'opencode.jsonc')
  const originalFirst = '{"theme":"dark"}\n'
  const originalSecond = '{"theme":"light"}\n'
  writeFileSync(first, originalFirst)
  writeFileSync(second, originalSecond)
  const { renameSync, ...baseFs } = fs
  let failed = false
  const filesystem = {
    ...baseFs,
    renameSync(from, to) {
      if (!failed && to === second && String(from).includes('.tmp-')) {
        failed = true
        throw new Error('simulated second rename failure')
      }
      return renameSync(from, to)
    },
  }
  assert.throws(
    () =>
      applyConfigChanges(
        [
          { path: first, original: originalFirst, contents: '{"theme":"new"}\n' },
          { path: second, original: originalSecond, contents: '{"theme":"new"}\n' },
        ],
        { filesystem },
      ),
    /simulated second rename failure/,
  )
  assert.equal(readFileSync(first, 'utf8'), originalFirst)
  assert.equal(readFileSync(second, 'utf8'), originalSecond)
  assert.deepEqual(fs.readdirSync(root).sort(), ['opencode.json', 'opencode.jsonc'])
})

test('apply aborts on review drift before creating backups or replacing config', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const reviewed = '{"permission":{"edit":"deny"}}\n'
  const external = '{"permission":{"edit":"allow"}}\n'
  writeFileSync(target, reviewed)
  const prompts = createPrompts({ targets: [target], apply: true })
  prompts.confirm = async () => {
    writeFileSync(target, external)
    return true
  }
  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts,
    output: captureOutput(),
  })
  assert.equal(result.status, 'failed')
  assert.equal(readFileSync(target, 'utf8'), external)
  assert.deepEqual(fs.readdirSync(root), ['opencode.json'])
})

test('apply detects target drift during staging and does not overwrite the newer content', (t) => {
  const root = fixture(t)
  const first = join(root, 'opencode.json')
  const second = join(root, 'opencode.jsonc')
  const originalFirst = '{"theme":"dark"}\n'
  const originalSecond = '{"theme":"light"}\n'
  const external = '{"theme":"external"}\n'
  writeFileSync(first, originalFirst)
  writeFileSync(second, originalSecond)
  const { openSync, ...baseFs } = fs
  let changed = false
  const filesystem = {
    ...baseFs,
    openSync(target, ...args) {
      if (!changed && String(target).includes('.opencode.json.tmp-')) {
        changed = true
        writeFileSync(first, external)
      }
      return openSync(target, ...args)
    },
  }

  assert.throws(
    () =>
      applyConfigChanges(
        [
          { path: first, original: originalFirst, contents: '{"theme":"stale"}\n' },
          { path: second, original: originalSecond, contents: '{"theme":"new"}\n' },
        ],
        { filesystem },
      ),
    /changed after review/,
  )
  assert.equal(readFileSync(first, 'utf8'), external)
  assert.equal(readFileSync(second, 'utf8'), originalSecond)
  assert.deepEqual(fs.readdirSync(root).sort(), ['opencode.json', 'opencode.jsonc'])
})

test('apply detects a same-content target replacement by file identity', (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const replacement = join(root, 'replacement.json')
  const original = '{"theme":"dark"}\n'
  writeFileSync(target, original)
  const { openSync, ...baseFs } = fs
  let replaced = false
  const filesystem = {
    ...baseFs,
    openSync(temp, ...args) {
      if (!replaced && String(temp).includes('.opencode.json.tmp-')) {
        replaced = true
        writeFileSync(replacement, original)
        fs.renameSync(replacement, target)
      }
      return openSync(temp, ...args)
    },
  }

  assert.throws(
    () =>
      applyConfigChanges([{ path: target, original, contents: '{"theme":"new"}\n' }], {
        filesystem,
      }),
    /changed after review/,
  )
  assert.equal(readFileSync(target, 'utf8'), original)
  assert.deepEqual(fs.readdirSync(root), ['opencode.json'])
})

test('apply drift after one replacement rolls back earlier replacements', (t) => {
  const root = fixture(t)
  const first = join(root, 'opencode.json')
  const second = join(root, 'opencode.jsonc')
  const originalFirst = '{"theme":"dark"}\n'
  const originalSecond = '{"theme":"light"}\n'
  const externalSecond = '{"theme":"external"}\n'
  writeFileSync(first, originalFirst)
  writeFileSync(second, originalSecond)
  const { renameSync, ...baseFs } = fs
  let changed = false
  const filesystem = {
    ...baseFs,
    renameSync(from, to) {
      const result = renameSync(from, to)
      if (!changed && to === first && String(from).includes('.tmp-')) {
        changed = true
        writeFileSync(second, externalSecond)
      }
      return result
    },
  }

  assert.throws(
    () =>
      applyConfigChanges(
        [
          { path: first, original: originalFirst, contents: '{"theme":"new"}\n' },
          { path: second, original: originalSecond, contents: '{"theme":"stale"}\n' },
        ],
        { filesystem },
      ),
    /changed after review/,
  )
  assert.equal(readFileSync(first, 'utf8'), originalFirst)
  assert.equal(readFileSync(second, 'utf8'), externalSecond)
})

test('atomic apply preserves supported Linux extended attributes and ownership metadata', async (t) => {
  if (process.platform !== 'linux')
    return t.skip('Linux cp --preserve=all is the supported apply path')
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  writeFileSync(target, '{"permission":{"edit":"deny"}}\n')
  try {
    execFileSync('python3', [
      '-c',
      "import os,sys; os.setxattr(sys.argv[1], 'user.pantheon_test', b'preserve')",
      target,
    ])
  } catch {
    return t.skip('the temporary filesystem or Python runtime does not support user xattrs')
  }
  const before = fs.statSync(target)
  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [target], apply: true }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'applied')
  const after = fs.statSync(target)
  assert.equal(after.mode & 0o7777, before.mode & 0o7777)
  assert.equal(after.uid, before.uid)
  assert.equal(after.gid, before.gid)
  assert.equal(
    execFileSync(
      'python3',
      [
        '-c',
        "import os,sys; print(os.getxattr(sys.argv[1], 'user.pantheon_test').decode())",
        target,
      ],
      { encoding: 'utf8' },
    ).trim(),
    'preserve',
  )
})

test('apply refuses unsupported metadata platforms while preview remains available', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const original = '{"permission":{"edit":"deny"}}\n'
  writeFileSync(target, original)
  assert.throws(
    () =>
      applyConfigChanges([{ path: target, original, contents: '{"permissions":[]}\n' }], {
        platform: 'darwin',
      }),
    /unsupported on this platform/,
  )
  assert.equal(readFileSync(target, 'utf8'), original)
  assert.deepEqual(fs.readdirSync(root), ['opencode.json'])

  const preview = await prepareV2Config({
    configDir: root,
    interactive: false,
    output: captureOutput(),
  })
  assert.equal(preview.status, 'preview')
  assert.equal(readFileSync(target, 'utf8'), original)
})
