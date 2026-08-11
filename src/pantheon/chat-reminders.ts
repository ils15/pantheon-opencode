/**
 * Chat Reminders (release-134 Phase 4) — the SHARED <system-reminder> buffer.
 *
 * WHY a shared module (not owned by pantheon-hooks.ts):
 *   1. opencode's legacy plugin loader (verified in the 1.18.16 source,
 *      packages/opencode/src/plugin/index.ts getLegacyPlugins) does
 *      `Object.values(mod)` and treats EVERY export as a plugin factory —
 *      a non-function export throws `TypeError("Plugin export is not a
 *      function")` and a function export is invoked with a PluginInput.
 *      pantheon-hooks.ts therefore cannot EXPORT the enqueue API.
 *   2. src/plugin.ts (a separate plugin file) must ENQUEUE into the SAME
 *      buffer the pantheon-hooks `chat.message` hook drains — a local copy
 *      would enqueue into a buffer that is never delivered.
 *   3. opencode loads plugins via plain `await import(entry)` (PluginLoader),
 *      so both plugin files importing this module resolve to ONE module
 *      instance (Bun/Node module cache) → one shared buffer.
 *
 * release-134 Phase 4 uses this buffer for the post-compaction state
 * re-assertion: `reassertAfterCompaction` (compaction-assert.ts) enqueues a
 * fresh-state block here, and the existing chat.message delivery path
 * (pantheon-hooks.ts) injects it as a <system-reminder> into the session's
 * next message. Zero new delivery code — the P0 messageID guard already
 * protects subagent promptAsync fires.
 *
 * Bounded: at most CHAT_REMINDER_MAX entries, each expiring
 * CHAT_REMINDER_TTL_MS after enqueue. Full-buffer enqueues are SKIPPED,
 * never unbounded. No background timers — expiry is only checked on enqueue
 * and on delivery (drainFreshChatReminders).
 *
 * @module chat-reminders
 */

/**
 * Hard cap on queued reminder entries (anti-spam philosophy, matching the
 * "throttled signals are skipped, never backlogged" rule).
 */
export const CHAT_REMINDER_MAX = 10

/** How long a queued reminder stays deliverable (pruned after ~60s). */
export const CHAT_REMINDER_TTL_MS = 60_000

/** One queued reminder: the text plus its enqueue timestamp. */
export interface ChatReminderEntry {
  text: string
  at: number
}

/** The shared buffer — module-level state, consumed by the chat.message hook. */
export const pendingChatReminders: ChatReminderEntry[] = []

/**
 * Queue one chat-reminder entry, pruning expired entries first. Never throws.
 * A full buffer skips the push (bounded, never backlogged).
 */
export function enqueueChatReminder(text: string): void {
  const now = Date.now()
  for (let i = pendingChatReminders.length - 1; i >= 0; i--) {
    const r = pendingChatReminders[i]
    if (r !== undefined && now - r.at > CHAT_REMINDER_TTL_MS) pendingChatReminders.splice(i, 1)
  }
  if (pendingChatReminders.length >= CHAT_REMINDER_MAX) return
  pendingChatReminders.push({ text, at: now })
}

/**
 * Deliver (drain) every FRESH reminder as one joined block: expired entries
 * are dropped, the buffer is cleared in all cases (no leak). Returns
 * undefined when nothing fresh remains — the caller skips injection.
 *
 * This is the delivery helper the pantheon-hooks `chat.message` hook calls
 * AFTER its P0 messageID guard (empty messageID → early return, buffer kept).
 */
export function drainFreshChatReminders(): string | undefined {
  const now = Date.now()
  const fresh = pendingChatReminders.filter((r) => now - r.at <= CHAT_REMINDER_TTL_MS)
  pendingChatReminders.length = 0
  if (fresh.length === 0) return undefined
  return fresh.map((r) => r.text).join('\n')
}
