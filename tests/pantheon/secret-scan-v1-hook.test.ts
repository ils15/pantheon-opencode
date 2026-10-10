import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

type BeforeHook = (
  input: { tool: string; sessionID: string; callID: string },
  output: { args: unknown },
) => Promise<void>

const directory = mkdtempSync(join(tmpdir(), 'pantheon-v1-secret-scan-'))
const appLogs: string[] = []

process.env.PANTHEON_PLUGIN_ONCE = 'off'
process.env.PANTHEON_TOASTS = 'off'

const { default: pantheonHooks } = await import('../../src/plugins/pantheon-hooks.ts')
const factory = pantheonHooks as unknown as (input: unknown) => Promise<Record<string, unknown>>
const hooks = await factory({
  directory,
  client: {
    app: { log: async ({ body }: { body: unknown }) => appLogs.push(JSON.stringify(body)) },
    tui: { showToast: async () => {} },
  },
})
const before = hooks['tool.execute.before'] as BeforeHook

async function runBefore(
  args: unknown,
): Promise<{ denied: boolean; bodyRan: boolean; message: string }> {
  let bodyRan = false
  try {
    await before(
      { tool: 'write', sessionID: 'ses_v1_secret_scan', callID: `call-${Date.now()}` },
      { args },
    )
    bodyRan = true
    return { denied: false, bodyRan, message: '' }
  } catch (error: unknown) {
    return {
      denied: true,
      bodyRan,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

test('V1 tool.execute.before blocks high-confidence input before the tool body', async () => {
  const token = `sk${'-'}bf${'-'}abcdef1234567890ABCD`
  const outcome = await runBefore({ filePath: 'notes.md', content: token })
  assert.equal(outcome.denied, true)
  assert.equal(outcome.bodyRan, false)
  assert.match(outcome.message, /segredo de alta confiança/)

  const hooksLog = join(directory, '.pantheon', 'logs', 'hooks.log')
  const log = existsSync(hooksLog) ? readFileSync(hooksLog, 'utf8') : ''
  const allLogs = `${log}\n${appLogs.join('\n')}`
  assert.doesNotMatch(allLogs, new RegExp(token))
  assert.match(allLogs, /\*\*\*\*/)
})

test('V1 malformed args fail closed without echoing the invalid input', async () => {
  const canary = 'MALFORMED_ARGS_CANARY_NEVER_LOG'
  const outcome = await runBefore(canary)
  assert.equal(outcome.denied, true)
  assert.equal(outcome.bodyRan, false)
  assert.match(outcome.message, /fail-closed/)
  assert.doesNotMatch(`${outcome.message}\n${appLogs.join('\n')}`, new RegExp(canary))
})

test('V1 safe input passes through execute.before', async () => {
  const outcome = await runBefore({ filePath: 'notes.md', content: 'ordinary safe text' })
  assert.equal(outcome.denied, false)
  assert.equal(outcome.bodyRan, true)
})

after(() => rmSync(directory, { recursive: true, force: true }))
