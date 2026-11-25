import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  appendBoardMessage,
  createBoardTool,
  getBoardStatus,
  readBoardMessages,
  upsertBoardChannel,
} from '../../src/pantheon/board-messages.ts'
import { getSharedBus } from '../../src/pantheon/bus.ts'
import { readCockpitBusEvents, wireCockpitBusRecorder } from '../../src/pantheon/cockpit-events.ts'

test('appendBoardMessage assigns monotonic #seq, extracts @mentions/[tag], persists NDJSON, and emits board:message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-board-msg-'))
  const bus = getSharedBus()
  const received: Array<{ seq: number; tag?: string; mentions: readonly string[] }> = []
  const off = bus.on('board:message', (ev) => {
    received.push({
      seq: ev.seq,
      ...(ev.tag !== undefined ? { tag: ev.tag } : {}),
      mentions: ev.mentions,
    })
  })
  try {
    await upsertBoardChannel(dir, {
      channel: 'council',
      threadId: 'arch-1',
      goal: 'Ship v2.3 board',
      workstream: 'runtime',
    })
    const m1 = await appendBoardMessage(dir, {
      channel: 'council',
      threadId: 'arch-1',
      from: 'zeus',
      body: '[claim] Starting synthesis for @athena and @themis',
      stepKey: 'step-1',
    })
    const m2 = await appendBoardMessage(dir, {
      channel: 'council',
      threadId: 'arch-1',
      from: 'themis',
      replyToSeq: m1.seq,
      body: '@zeus [done] Verified contract',
    })

    assert.equal(m1.seq, 1)
    assert.equal(m1.tag, 'claim')
    assert.deepEqual(m1.mentions, ['athena', 'themis'])
    assert.equal(m1.goal, 'Ship v2.3 board')
    assert.equal(m1.workstream, 'runtime')

    assert.equal(m2.seq, 2)
    assert.equal(m2.replyToSeq, 1)
    assert.equal(m2.tag, 'done')
    assert.deepEqual(m2.mentions, ['zeus'])

    const readAll = readBoardMessages(dir, { since: 0 })
    assert.equal(readAll.head, 2)
    assert.equal(readAll.messages.length, 2)

    const sinceOne = readBoardMessages(dir, { since: 1 })
    assert.equal(sinceOne.messages.length, 1)
    assert.equal(sinceOne.messages[0]?.seq, 2)

    const byMention = readBoardMessages(dir, { mention: 'themis' })
    assert.equal(byMention.messages.length, 1)
    assert.equal(byMention.messages[0]?.seq, 1)

    assert.equal(received.length, 2)
    assert.equal(received[1]?.seq, 2)
    assert.equal(received[1]?.tag, 'done')
  } finally {
    off()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('concurrent appendBoardMessage writes serialize cleanly without duplicate seq', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-board-race-'))
  try {
    const writes = await Promise.all(
      Array.from({ length: 12 }, (_, idx) =>
        appendBoardMessage(dir, {
          from: `agent-${idx}`,
          body: `[note] parallel write ${idx}`,
        }),
      ),
    )
    const seqs = writes.map((w) => w.seq).sort((a, b) => a - b)
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    const file = join(dir, '.pantheon', 'board', 'messages.ndjson')
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 12)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveSharedPantheonRoot shares board messages across linked git worktrees', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'pantheon-board-wt-'))
  const mainRepo = join(parent, 'repo')
  const wtDir = join(parent, 'wt-1')
  try {
    execFileSync('git', ['init', '-q', mainRepo])
    execFileSync('git', ['config', 'user.email', 'test@pantheon.dev'], { cwd: mainRepo })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: mainRepo })
    writeFileSync(join(mainRepo, 'README.md'), '# test\n')
    execFileSync('git', ['add', 'README.md'], { cwd: mainRepo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: mainRepo })
    execFileSync('git', ['worktree', 'add', '--detach', wtDir], { cwd: mainRepo })

    const posted = await appendBoardMessage(wtDir, {
      from: 'hermes',
      body: '[handoff] @themis check worktree change',
    })
    assert.equal(posted.seq, 1)
    assert.equal(existsSync(join(mainRepo, '.pantheon', 'board', 'messages.ndjson')), true)
    const fromMain = readBoardMessages(mainRepo, { since: 0 })
    assert.equal(fromMain.messages.length, 1)
    assert.equal(fromMain.messages[0]?.from, 'hermes')
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('pantheon_board tool handles channel, post, read, status and cockpit-events bridge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-board-tool-'))
  const stopCockpit = wireCockpitBusRecorder(dir)
  try {
    const tool = createBoardTool(dir)
    assert.equal(tool.name, 'pantheon_board')

    const chOut = JSON.parse(
      (
        await tool.execute(
          {
            action: 'channel',
            channel: 'council',
            threadId: 'agora-7',
            goal: 'Decide DB migration',
            workstream: 'schema',
          },
          { directory: dir, agent: 'zeus' },
        )
      ).output,
    ) as { ok: boolean; header?: { threadId: string } }
    assert.equal(chOut.ok, true)
    assert.equal(chOut.header?.threadId, 'agora-7')

    const postOut = JSON.parse(
      (
        await tool.execute(
          {
            action: 'post',
            channel: 'council',
            threadId: 'agora-7',
            body: '[deadlock] @zeus need decision on index strategy',
          },
          { directory: dir, agent: 'demeter' },
        )
      ).output,
    ) as { ok: boolean; message: { seq: number; from: string; tag?: string } }
    assert.equal(postOut.ok, true)
    assert.equal(postOut.message.seq, 1)
    assert.equal(postOut.message.from, 'demeter')
    assert.equal(postOut.message.tag, 'deadlock')

    const readOut = JSON.parse(
      (
        await tool.execute(
          { action: 'read', channel: 'council', threadId: 'agora-7' },
          { directory: dir },
        )
      ).output,
    ) as { ok: boolean; head: number; messages: Array<{ seq: number }> }
    assert.equal(readOut.ok, true)
    assert.equal(readOut.head, 1)
    assert.equal(readOut.messages.length, 1)

    const statusOut = JSON.parse(
      (await tool.execute({ action: 'status' }, { directory: dir })).output,
    ) as { ok: boolean; head: number; threads: unknown[] }
    assert.equal(statusOut.ok, true)
    assert.equal(statusOut.head, 1)
    assert.ok(statusOut.threads.length >= 1)

    const summary = getBoardStatus(dir)
    assert.equal(summary.head, 1)

    const cockpitEvents = readCockpitBusEvents(dir, 20)
    const boardEv = cockpitEvents.find((ev) => ev.kind === 'board:message')
    assert.ok(boardEv)
    assert.equal(boardEv.seq, 1)
    assert.equal(boardEv.threadId, 'agora-7')
    assert.equal(boardEv.attentionCategory, 'decision')
    assert.equal(boardEv.severity, 'warn')
  } finally {
    stopCockpit()
    rmSync(dir, { recursive: true, force: true })
  }
})
