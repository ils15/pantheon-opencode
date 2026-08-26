/** Regression tests for the zero-chat-noise delegation policy. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const files = [
  'src/plugins/pantheon-hooks.ts',
  'src/pantheon/chat-reminders.ts',
  'src/pantheon/compaction-assert.ts',
]

test('delegation completion paths never register chat injection or system reminders', () => {
  for (const file of files) {
    let source = ''
    try {
      source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    } catch (error) {
      if (file.endsWith('chat-reminders.ts')) continue
      throw error
    }
    assert.doesNotMatch(source, /chat\.message/, `${file} references a chat.message delivery path`)
    assert.doesNotMatch(source, /system-reminder/, `${file} injects a system-reminder`)
    assert.doesNotMatch(
      source,
      /enqueueChatReminder|drainFreshChatReminders/,
      `${file} queues chat delivery`,
    )
  }
})
