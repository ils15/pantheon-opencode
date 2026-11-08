/**
 * behavior-overrides.test.ts — the named-behavior override layer.
 *
 * Pure-module contract: parse (schema, caps), merge (project wins per id),
 * unknown-id detection against the registry, and the install/runtime
 * decisions the installer and plugin consume.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  OVERRIDE_CONTENT_MAX,
  installDecision,
  isRuntimeDisabled,
  mergeOverrides,
  parseOverridesFile,
  unknownBehaviorIds,
  type BehaviorSpec,
} from '../../src/pantheon/behavior-overrides.ts'

const REGISTRY: BehaviorSpec[] = [
  { id: 'skill-tdd-with-agents', kind: 'install', owner: 'src/skills/tdd-with-agents/SKILL.md' },
  { id: 'gate-j1-risk-gate', kind: 'runtime', owner: 'src/pantheon/jev-risk-gate.ts' },
]

describe('parseOverridesFile', () => {
  it('keeps valid entries and reports nothing', () => {
    const r = parseOverridesFile(
      JSON.stringify({
        'skill-tdd-with-agents': { action: 'disable', reason: 'team runs its own TDD doctrine' },
        'gate-j1-risk-gate': { action: 'replace', content: 'custom gate', reason: 'stricter' },
      }),
    )
    assert.deepEqual(r.errors, [])
    assert.equal(r.entries['skill-tdd-with-agents']?.action, 'disable')
    assert.equal(r.entries['gate-j1-risk-gate']?.content, 'custom gate')
  })

  it('rejects invalid JSON with a clear error', () => {
    const r = parseOverridesFile('{ nope', 'project overrides')
    assert.deepEqual(r.entries, {})
    assert.ok(r.errors[0].startsWith('project overrides: invalid JSON'))
  })

  it('rejects unknown keys, bad actions, missing/oversized content and oversized reasons', () => {
    const r = parseOverridesFile(
      JSON.stringify({
        a: { action: 'disable', rogue: true },
        b: { action: 'toggle' },
        c: { action: 'replace' },
        d: { action: 'replace', content: 'x'.repeat(OVERRIDE_CONTENT_MAX + 1) },
        e: { action: 'disable', reason: 'r'.repeat(500) },
      }),
    )
    assert.deepEqual(Object.keys(r.entries), [], 'every entry in this fixture is invalid')
    assert.ok(r.errors.some((e) => e.includes('"a"') && e.includes('unknown key')))
    assert.ok(r.errors.some((e) => e.includes('"b"') && e.includes('disable" or "replace')))
    assert.ok(r.errors.some((e) => e.includes('"c"') && e.includes('content is required')))
    assert.ok(r.errors.some((e) => e.includes('"d"') && e.includes('char cap')))
    assert.ok(r.errors.some((e) => e.includes('"e"') && e.includes('reason')))
  })

  it('rejects non-object tops and non-object entries', () => {
    assert.ok(parseOverridesFile('[]', 'f').errors[0].includes('top level'))
    assert.ok(parseOverridesFile('{"x": 3}', 'f').errors[0].includes('"x"'))
  })
})

describe('mergeOverrides', () => {
  it('project wins per id and both files\' errors are collected', () => {
    const g = JSON.stringify({ shared: { action: 'disable' }, 'g-only': { action: 'disable' } })
    const p = JSON.stringify({
      shared: { action: 'replace', content: 'project version' },
      broken: { action: 'nope' },
    })
    const r = mergeOverrides(g, p)
    assert.equal(r.entries['shared']?.action, 'replace')
    assert.equal(r.entries['g-only']?.action, 'disable')
    assert.ok(r.errors.some((e) => e.includes('project overrides') && e.includes('"broken"')))
  })
})

describe('registry decisions', () => {
  it('unknownBehaviorIds lists override ids absent from the registry', () => {
    const r = parseOverridesFile(
      JSON.stringify({ 'gate-j1-risk-gate': { action: 'disable' }, ghost: { action: 'disable' } }),
    )
    assert.deepEqual(unknownBehaviorIds(r.entries, REGISTRY), ['ghost'])
  })

  it('installDecision: content object for replace, undefined for runtime/unknown/absent ids', () => {
    const r = parseOverridesFile(
      JSON.stringify({
        'skill-tdd-with-agents': { action: 'replace', content: 'my own doctrine' },
        'gate-j1-risk-gate': { action: 'disable' },
      }),
    )
    assert.deepEqual(installDecision(r.entries, REGISTRY, 'skill-tdd-with-agents'), {
      content: 'my own doctrine',
    })
    assert.deepEqual(installDecision(r.entries, REGISTRY, 'gate-j1-risk-gate'), undefined)
    assert.deepEqual(installDecision(r.entries, REGISTRY, 'not-registered'), undefined)
  })

  it('isRuntimeDisabled: only a registered RUNTIME behavior with disable counts', () => {
    const r = parseOverridesFile(
      JSON.stringify({
        'gate-j1-risk-gate': { action: 'disable' },
        'skill-tdd-with-agents': { action: 'disable' },
      }),
    )
    assert.equal(isRuntimeDisabled(r.entries, REGISTRY, 'gate-j1-risk-gate'), true)
    assert.equal(
      isRuntimeDisabled(r.entries, REGISTRY, 'skill-tdd-with-agents'),
      false,
      'an install behavior is never a runtime gate, whatever its action',
    )
    assert.equal(isRuntimeDisabled(r.entries, REGISTRY, 'ghost'), false)
  })
})
