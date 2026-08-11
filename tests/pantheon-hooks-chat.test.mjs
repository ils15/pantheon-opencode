/**
 * pantheon-hooks-chat.test.mjs — TDD regression tests for the chat.message
 * reminder-injection guard (RELEASE BLOCKER, 2026-08-11).
 *
 * BUG (live E2E): `pantheon_delegate` queues a chat reminder ("🚀 … em
 * execução") → the plugin calls `client.session.promptAsync` on the CHILD
 * session → the `chat.message` hook ALSO fires for the child's promptAsync
 * (the old "subagent prompts use a different path" comment was empirically
 * FALSE on opencode 1.18.13) → the handler injected the pending reminder with
 * `messageID: input.messageID ?? ''` (EMPTY on the promptAsync path) →
 * opencode's schema rejected the part (SchemaError: Expected a string
 * starting with "msg", got "") → prompt_async failed → every delegation
 * died in ~20ms.
 *
 * GUARD: when chat.message receives EMPTY/undefined `messageID` (the subagent
 * promptAsync path), injection is skipped ENTIRELY — an early return BEFORE
 * the reminder buffer is drained — so the reminder survives to land on the
 * parent's next REAL message. The valid-msg_ path is a regression guard
 * (normal behavior unchanged).
 *
 * The reminder queue is seeded through the real pipeline: the `event` hook
 * (session.error) → notifyToast → enqueueChatReminder (the session.error
 * producer is instant and spawns no hook scripts; the mechanism under test is
 * the chat.message injection, producer-agnostic).
 *
 * Run: node --test tests/pantheon-hooks-chat.test.mjs
 * (Node >= 22.18 imports the .ts module natively via type stripping.)
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const PLUGIN_URL = new URL('../src/plugins/pantheon-hooks.ts', import.meta.url).href

/**
 * Load a fresh plugin instance. `?phase=N` busts the ESM cache so the
 * module-level reminder queue and env-derived gates (PANTHEON_TOASTS) are
 * re-read per phase; a temp directory keeps hooks.log out of the repo.
 */
async function loadPlugin(phase) {
  process.env.PANTHEON_TOASTS = 'all' // open the chat-reminder gate (errors+delegations+council)
  const mod = await import(`${PLUGIN_URL}?phase=${phase}`)
  const logDir = mkdtempSync(join(tmpdir(), `hooks-chat-${phase}-`))
  const appLogs = []
  const hooks = await mod.default({
    directory: logDir,
    client: {
      app: { log: async ({ body }) => appLogs.push(body) },
      tui: { showToast: async () => {} },
    },
  })
  return { hooks, logDir, appLogs }
}

/** Queue one chat reminder through the real event → toast → reminder path. */
async function seedReminder(hooks) {
  // session.error's documented error shape is { message } (see the event hook).
  await hooks.event({
    event: {
      type: 'session.error',
      properties: { error: { message: 'test reminder signal' } },
    },
  })
}

test('chat.message with UNDEFINED messageID (subagent promptAsync path) injects nothing and keeps the buffer', async () => {
  const { hooks, logDir } = await loadPlugin('undefined-mid')
  try {
    await seedReminder(hooks)

    // Child promptAsync fire — messageID is undefined (the crash shape:
    // `?? ''` produced "" and opencode's schema rejected the part).
    const childOutput = { parts: [] }
    await hooks['chat.message']({ sessionID: 'child-ses-1', messageID: undefined }, childOutput)
    assert.equal(
      childOutput.parts.length,
      0,
      'no part may be injected on the subagent promptAsync path (empty messageID)',
    )

    // The guard must NOT drain the buffer — the parent's next real message
    // still receives the reminder.
    const parentOutput = { parts: [] }
    await hooks['chat.message'](
      { sessionID: 'parent-ses-1', messageID: 'msg_parent_001' },
      parentOutput,
    )
    assert.equal(
      parentOutput.parts.length,
      1,
      'reminder must survive the empty-messageID fire and inject on the parent message',
    )
    const part = parentOutput.parts[0]
    assert.equal(part.type, 'text')
    assert.equal(
      part.messageID,
      'msg_parent_001',
      'parent messageID must be preserved (never empty)',
    )
    assert.match(part.text, /<system-reminder>/)
    assert.match(part.text, /test reminder signal/)
  } finally {
    rmSync(logDir, { recursive: true, force: true })
  }
})

test("chat.message with EMPTY-STRING messageID ('') — same promptAsync path — injects nothing", async () => {
  const { hooks, logDir } = await loadPlugin('empty-mid')
  try {
    await seedReminder(hooks)

    const output = { parts: [] }
    await hooks['chat.message']({ sessionID: 'child-ses-2', messageID: '' }, output)
    assert.equal(
      output.parts.length,
      0,
      "no part may be injected when messageID is '' (the exact SchemaError value)",
    )
  } finally {
    rmSync(logDir, { recursive: true, force: true })
  }
})

test('chat.message with a valid msg_ messageID still injects the reminder (regression guard)', async () => {
  const { hooks, logDir } = await loadPlugin('valid-mid')
  try {
    await seedReminder(hooks)

    const output = { parts: [] }
    await hooks['chat.message']({ sessionID: 'parent-ses-2', messageID: 'msg_parent_002' }, output)
    assert.equal(output.parts.length, 1, 'valid parent message must still receive the reminder')
    const part = output.parts[0]
    assert.equal(part.type, 'text')
    assert.equal(part.messageID, 'msg_parent_002', 'messageID must be preserved verbatim')
    assert.match(part.text, /<system-reminder>\n/)
    assert.match(part.text, /test reminder signal/)
  } finally {
    rmSync(logDir, { recursive: true, force: true })
  }
})

test('idle-flush logs a SUMMARY, not the duplicated joined content (chat-reminder delivery is the single content source)', async () => {
  // 1.3.4 dedup: the SAME line ("🚀 … | ❌ session error") appeared 2× in the
  // log — flushIdleReminders echoed the reminder body joined with " | " while
  // the chat.message delivery echoed the same body joined with "\n". The
  // idle-flush entry must stay an audit summary (count only); the reminder
  // CONTENT is logged exactly once, at chat-reminder delivery.
  const { hooks, logDir, appLogs } = await loadPlugin('idle-dedup')
  try {
    await seedReminder(hooks)

    // session.idle fires → flushIdleReminders logs + re-queues ONE aggregate.
    await hooks.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-ses-3' } },
    })
    const idleEntry = appLogs.find((l) => l.extra?.script === 'idle-flush')
    assert.ok(idleEntry, 'idle-flush entry expected in the app log')
    assert.match(idleEntry.message, /flushed/i)
    assert.ok(
      !idleEntry.message.includes('test reminder signal'),
      `idle-flush must NOT duplicate the joined reminder content, got: ${idleEntry.message}`,
    )

    // The single content-bearing log entry arrives at chat-reminder delivery.
    const output = { parts: [] }
    await hooks['chat.message']({ sessionID: 'parent-ses-3', messageID: 'msg_parent_003' }, output)
    const delivery = appLogs.find((l) => l.extra?.script === 'chat-reminder')
    assert.ok(delivery, 'chat-reminder delivery entry expected in the app log')
    assert.ok(delivery.message.includes('test reminder signal'))
  } finally {
    rmSync(logDir, { recursive: true, force: true })
  }
})
