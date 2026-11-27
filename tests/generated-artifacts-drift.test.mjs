/**
 * generated-artifacts-drift.test.mjs — the committed generators must be
 * validated on every PR, not only when someone runs `npm pack`.
 *
 * Incident class this pins: `src/agents/*.md` are generated from
 * `src/agents/roster.json`, and AGENTS.md / AGENTS.global.md are generated from
 * `src/instructions/*`. Their only historical enforcer was `prepack`, which
 * runs at release time — so drift could sit on `main` indefinitely and was
 * discovered only when a packaging test happened to pack the tarball.
 *
 * This file is a static contract: it asserts the fast CI lane and the local
 * commit hook both fail on drift, and that the generators themselves still
 * compare the right things (rebuild + `git diff`, not a lossy `--check`).
 *
 * Run: node --test tests/generated-artifacts-drift.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const read = (relPath) =>
  readFileSync(fileURLToPath(new URL(`../${relPath}`, import.meta.url)), 'utf8')

const packageJson = JSON.parse(read('package.json'))
const ci = read('.github/workflows/ci.yml')
const preCommit = load(read('.pre-commit-config.yaml'))

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Return the body of the named step in ci.yml (its `env:`/`run:` lines),
 * stopping at the next step or at the next top-level job key.
 */
function ciStep(label) {
  const pattern = new RegExp(
    `^ {6}- name: ${escapeRegExp(label)}\\n([\\s\\S]*?)(?=^ {6}- |^ {2}[a-z][a-z0-9-]*:)`,
    'm',
  )
  const match = ci.match(pattern)
  assert.ok(match, `ci.yml must define the step "${label}"`)
  return match[1]
}

test('package.json exposes one generated-artifacts gate that covers every generator', () => {
  const script = packageJson.scripts['check:generated']
  assert.ok(script, 'package.json must define "check:generated" so CI and hooks share one command')
  assert.match(script, /npm run check:roster/, 'check:generated must verify the agent roster')
  assert.match(
    script,
    /npm run check:decision-router/,
    'check:generated must verify the committed decision-router bundles',
  )
  assert.match(
    script,
    /node scripts\/build-agents-md\.mjs --check/,
    'check:generated must verify AGENTS.md / AGENTS.global.md',
  )
})

test('package:validate (already on the CI fast lane) runs check:generated', () => {
  const validate = packageJson.scripts['package:validate']
  assert.ok(validate, 'package.json must keep package:validate')
  assert.match(
    validate,
    /&& npm run check:generated\s*$/,
    'package:validate must end with check:generated so drift fails the existing CI step',
  )
})

test('prepack still enforces the roster: drift is fixed, never bypassed', () => {
  const prepack = packageJson.scripts.prepack
  assert.ok(prepack, 'package.json must keep prepack')
  assert.match(
    prepack,
    /check:roster/,
    'prepack must keep check:roster; removing the gate hides drift instead of fixing it',
  )
})

test('CI rebuilds the roster and fails on any diff, not on a lossy --check', () => {
  const step = ciStep('Generated artifacts are in sync')
  assert.match(step, /npm run build:roster/, 'the step must rebuild src/agents from roster.json')
  assert.match(
    step,
    /git diff --exit-code src\/agents/,
    'the step must diff the rebuilt files: --check trims whitespace and misses formatter rewrites',
  )
  assert.doesNotMatch(step, /continue-on-error:\s*true/, 'drift must fail the job')

  const stepIndex = ci.indexOf('- name: Generated artifacts are in sync')
  assert.ok(
    stepIndex > ci.indexOf('run: npm run package:validate'),
    'the rebuild must run after package:validate, where the fast lane already validated manifests',
  )
  assert.ok(
    stepIndex < ci.indexOf('\n  test-suite:'),
    'the rebuild must stay in the validate job, before the parallel test job',
  )
})

test('CI rebuilds the plugin bundle and fails on any diff', () => {
  const step = ciStep('Plugin bundle freshness')
  assert.match(step, /npm run build:plugin/, 'the step must rebuild src/plugin/index.js')
  assert.match(
    step,
    /git diff --exit-code src\/plugin/,
    'the step must diff the rebuilt bundle so a stale or concurrently-mutated bundle fails CI',
  )
  assert.doesNotMatch(step, /continue-on-error:\s*true/, 'a stale bundle must fail the job')
})

test('pre-commit runs the roster check before a drifted commit can be created', () => {
  const localHooks = (preCommit.repos ?? []).flatMap((repo) =>
    repo.repo === 'local' ? (repo.hooks ?? []) : [],
  )
  const hook = localHooks.find((candidate) => candidate.id === 'generated-artifacts')
  assert.ok(hook, 'pre-commit must define a local hook with id "generated-artifacts"')
  assert.equal(hook.language, 'system', 'the hook must run the repository Node toolchain')
  assert.equal(
    hook.pass_filenames,
    false,
    'the hook must check the whole generated set, not only staged filenames',
  )
  assert.match(
    String(hook.entry),
    /build-roster\.mjs\s+--check/,
    'the hook entry must run build-roster.mjs --check',
  )
})
