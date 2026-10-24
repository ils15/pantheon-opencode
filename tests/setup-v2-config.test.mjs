import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('config preparation uses the existing installer global target under temporary HOME', (t) => {
  const home = fixture(t)
  assert.equal(
    resolveGlobalConfigDirectory({ XDG_CONFIG_HOME: join(home, 'xdg') }, home),
    join(home, '.config', 'opencode'),
  )
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
  assert.match(output.lines.join('\n'), /"research_\*"/)
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
