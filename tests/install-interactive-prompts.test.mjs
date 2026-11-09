/**
 * install-interactive-prompts.test.mjs — the lean `init` flow (beta.5).
 *
 * The wizard was REMOVED: a TTY `init` is banner → plan preview → ONE
 * authorization (`Apply these N changes?`, default NO) → apply. Everything
 * the wizard used to ask lives in `/pantheon-settings` (gates, decision
 * router, preset, TUI personalization) or in explicit flags (`--components`,
 * `--project`, `--decision-model`). These tests pin the new contract:
 * defaults resolve without prompts, the review gate is the only prompt, and
 * the gate's cancel/decline/no-TTY semantics are intact.
 *
 * Run: node --test tests/install-interactive-prompts.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { resolveComponentSelection } from '../scripts/install/component-selection.mjs'
import {
  PROMPT_CANCELED,
  promptReview,
} from '../scripts/install/interactive.mjs'

// The host gate must confirm a supported 2.x generation for these installs.
process.env.OPENCODE_VERSION = 'v2'

const ROOT = process.cwd()

/** Minimal clack-shaped fake: records calls, answers `confirmed`. */
function fakePrompts({ confirmed = true, cancel = false } = {}) {
  const calls = []
  const prompts = {
    calls,
    confirm: async (options) => {
      calls.push(['confirm', options])
      if (cancel) {
        calls.push(['cancel', 'canceled'])
        return Symbol('clack.cancel')
      }
      return confirmed
    },
    isCancel: (value) => typeof value === 'symbol',
    cancel: (message) => {
      calls.push(['cancel', message])
    },
  }
  return prompts
}

// ── Component defaults (no prompt needed — flags + defaults cover it) ──

test('defaults are the five core components; runtime/prompts stay opt-in', () => {
  const selection = resolveComponentSelection([])
  assert.deepEqual(selection.components, [
    'agents',
    'skills',
    'instructions',
    'commands',
    'plugins',
  ])
  assert.equal(selection.requestedComponentsForPrompt, null)
})

test('explicit --components replaces the defaults and never widens', () => {
  const selection = resolveComponentSelection(['--components', 'agents,commands'])
  assert.deepEqual(selection.components, ['agents', 'commands'])
  assert.deepEqual(selection.requestedComponentsForPrompt, ['agents', 'commands'])
})

test('unknown components refuse with the allowed list', () => {
  assert.throws(
    () => resolveComponentSelection(['--components', 'agents,nope']),
    /Invalid --components/i,
  )
})

test('--no-mcp excludes the runtime component', () => {
  const selection = resolveComponentSelection(['--components', 'agents,runtime', '--no-mcp'])
  assert.equal(selection.components.includes('runtime'), false)
})

// ── The review gate seam (cancel vs decline vs accept) ─────────────────

test('review prompt preserves cancellation separately from an explicit decline', async () => {
  const prompts = fakePrompts({ cancel: true })
  assert.equal(
    await promptReview('Apply this reviewed plan?', { prompts, isTTY: true }),
    PROMPT_CANCELED,
  )
  assert.equal(prompts.calls[0][0], 'confirm')
  assert.equal(prompts.calls[0][1].initialValue, false, 'the gate defaults to NO')

  const declinePrompts = fakePrompts({ confirmed: false })
  assert.equal(
    await promptReview('Apply this reviewed plan?', { prompts: declinePrompts, isTTY: true }),
    false,
  )
})

test('an accepted review authorizes the apply', async () => {
  const prompts = fakePrompts({ confirmed: true })
  assert.equal(await promptReview('Apply?', { prompts, isTTY: true }), true)
  assert.equal(prompts.calls.length, 1)
})

// ── The lean TTY flow: defaults apply after exactly ONE prompt ─────────

const tempDirs = []
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

test('a TTY run with no wizard applies the defaults after only the review gate', async () => {
  const { installOpenCode } = await import('../scripts/install/opencode.mjs')
  const target = mkdtempSync(join(tmpdir(), 'pantheon-lean-init-'))
  tempDirs.push(target)
  const calls = []
  const result = await installOpenCode(target, false, false, undefined, {
    interactive: true,
    deps: {
      isTTY: true,
      prompts: fakePrompts({ confirmed: true }),
      promptReview: async (message) => {
        calls.push(['review', message])
        return true
      },
    },
  })
  assert.equal(result.applied, true, 'defaults apply after the single authorization')
  assert.equal(result.decisionModelActivation ?? null, null, 'no wizard activation anymore')
  assert.equal(calls.length, 1, 'exactly one prompt: the review gate')
  assert.match(calls[0][1], /Apply these \d+ changes\?/)
  // The core component files landed (defaults, no selection needed).
  assert.ok(readdirSync(join(target, 'agents')).length > 0, 'agents copied')
})

test('a declined gate on the lean flow writes nothing', async () => {
  const { installOpenCode } = await import('../scripts/install/opencode.mjs')
  const target = mkdtempSync(join(tmpdir(), 'pantheon-lean-decline-'))
  tempDirs.push(target)
  const result = await installOpenCode(target, false, false, undefined, {
    interactive: true,
    deps: {
      isTTY: true,
      promptReview: async () => false,
    },
  })
  assert.equal(result.applied, false)
  assert.equal(result.reason, 'declined')
  assert.deepEqual(readdirSync(target), [], 'a declined run must write nothing')
})

test('no TTY and no --yes stays unauthorized (the gate never guesses)', async () => {
  const { installOpenCode } = await import('../scripts/install/opencode.mjs')
  const target = mkdtempSync(join(tmpdir(), 'pantheon-lean-notty-'))
  tempDirs.push(target)
  const result = await installOpenCode(target, false, false, undefined, {
    headless: true,
  })
  assert.equal(result.applied, false)
  assert.equal(result.reason, 'not-authorized')
  assert.deepEqual(readdirSync(target), [], 'an unauthorized run must write nothing')
})

test('the package still ships the review seam (interactive.mjs)', async () => {
  const { statSync } = await import('node:fs')
  const stat = statSync(join(ROOT, 'scripts', 'install', 'interactive.mjs'))
  assert.ok(stat.isFile(), 'interactive.mjs keeps promptReview for the gate')
})
