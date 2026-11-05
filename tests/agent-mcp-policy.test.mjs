import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const agent = (name) => readFileSync(fileURLToPath(new URL(`../src/agents/${name}.md`, import.meta.url)), 'utf8')
const agentsDir = new URL('../src/agents/', import.meta.url)
const AGENT_NAMES = [
  'zeus',
  'apollo',
  'athena',
  'themis',
  'hermes',
  'prometheus',
  'hephaestus',
  'demeter',
  'gaia',
  'iris',
  'aphrodite',
  'mnemosyne',
  'nyx',
  'talos',
]

test('zeus carries the measured usage policy markers', () => {
  // Agent prose is hard-wrapped; contracts match on whitespace-normalized text.
  const zeus = agent('zeus').replaceAll(/\s+/g, ' ')
  assert.ok(zeus.includes('durable, reusable facts ONLY'), 'memory store policy present')
  assert.ok(zeus.includes('Session narration never stores'), 'narrative-store ban present')
  assert.ok(zeus.includes('`default` is for'), 'namespace hygiene present')
  assert.ok(zeus.includes('milestones only'), 'checkpoint milestone policy present')
  assert.ok(zeus.includes('never re-save the same key unless'), 'checkpoint re-save ban present')
  assert.ok(zeus.includes('One pass per image'), 'vision one-pass policy present')
})

test('the contradictory store phrases are gone from zeus', () => {
  const zeus = agent('zeus')
  // The 2026-11-05 audit traced the narrative-store excess to these two
  // phrases pulling in opposite directions; the unified policy replaced both.
  assert.ok(!zeus.includes('only when explicitly requested or authorized'))
  assert.ok(!zeus.includes('when YOU judge it prudent'))
})

test('aphrodite carries the vision one-pass rule', () => {
  assert.ok(agent('aphrodite').replaceAll(/\s+/g, ' ').includes('One pass per image'))
})

test('no agent instructs always-on memory or persistence usage', () => {
  for (const name of AGENT_NAMES) {
    const text = agent(name)
    assert.ok(
      !/use\b[^.]{0,60}(memory|persistence|memory_store|context_save)[^.]{0,60}(whenever possible|as much as possible|sempre que possível)/i.test(
        text,
      ),
      `${name} must not instruct always-on MCP usage`,
    )
  }
})

test('the docs baseline section that justifies the policy exists', () => {
  const docs = readFileSync(fileURLToPath(new URL('../docs/mcp-tools.md', import.meta.url)), 'utf8')
  assert.ok(docs.includes('## Measured usage baseline'))
  assert.ok(docs.includes('bench/mcp-usage-audit.mjs'))
})
