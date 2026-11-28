/**
 * Contract test for the `Reconcile and assert npm dist-tags` step in
 * `.github/workflows/release.yml`.
 *
 * Run 46120900422 published successfully and then failed at this step with
 * `E401` **five times** — an authentication failure was classified as a
 * propagation race and retried for ~20 s before reporting the same thing.
 * Retrying a deterministic auth failure is not resilience; it hides the cause.
 *
 * These tests pin the honest contract:
 *   - retry only transient conditions (propagation, E404, 5xx, timeouts);
 *   - E401 / E403 / EOTP fail immediately, naming the cause and the remedy;
 *   - the end-state assertion survives and prints the tags it actually read.
 *
 * Anti-vacuity: every behavioural test depends on the extractor finding the
 * step and its helper functions. If the step is deleted the extractor returns
 * null and these tests fail rather than passing an empty string.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const WORKFLOW = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url))
const STEP_NAME = 'Reconcile and assert npm dist-tags'
const workflow = readFileSync(WORKFLOW, 'utf8')

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Extract one workflow step (header + body, indentation preserved) by its
 * `- name:`. Returns null when the step is absent, so a deleted step is a
 * visible failure instead of an empty-string pass.
 */
export function extractStep(source, name) {
  const lines = source.split('\n')
  const header = new RegExp(`^(\\s*)- name: ${escapeRegex(name)}\\s*$`)
  let start = -1
  let indent = -1
  for (let index = 0; index < lines.length; index += 1) {
    const match = header.exec(lines[index])
    if (match) {
      start = index
      indent = match[1].length
      break
    }
  }
  if (start === -1) return null

  const body = [lines[start]]
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() !== '' && line.search(/\S/) <= indent) break
    body.push(line)
  }
  return body.join('\n')
}

/**
 * The comment block attached immediately above a step.
 *
 * Workflow rationale lives in YAML comments above the `- name:` line, so a
 * contract assertion has to read both to keep the proof next to the pin.
 */
export function extractLeadingComments(source, name) {
  const lines = source.split('\n')
  const header = new RegExp(`^\\s*- name: ${escapeRegex(name)}\\s*$`)
  const start = lines.findIndex((line) => header.test(line))
  if (start === -1) return null
  const block = []
  for (let index = start - 1; index >= 0; index -= 1) {
    if (!/^\s*#/.test(lines[index])) break
    block.unshift(lines[index])
  }
  return block.join('\n')
}

/** Remove the common leading indentation so shell functions sit at column 0. */
function dedent(text) {
  const lines = text.split('\n')
  const widths = lines.filter((line) => line.trim() !== '').map((line) => line.search(/\S/))
  const min = widths.length > 0 ? Math.min(...widths) : 0
  return lines.map((line) => (line.trim() === '' ? line : line.slice(min))).join('\n')
}

/**
 * Extract every shell function defined before the first heredoc in a step.
 *
 * The `env:` block and `run: |` header are stripped first: they are shallower
 * than the shell body, so leaving them in would defeat the dedent. Only the
 * preamble is scanned, because the embedded `node <<'NODE'` programs contain
 * bare `}` lines that would otherwise terminate a function body early.
 */
export function extractShellFunctions(stepBody) {
  const lines = stepBody.split('\n')
  const runIndex = lines.findIndex((line) => /^\s*run:\s*\|/.test(line))
  const shell = runIndex === -1 ? stepBody : lines.slice(runIndex + 1).join('\n')
  const preamble = dedent(shell).split(/^\s*\S.*<<'NODE'\s*$/m)[0]
  const shellLines = preamble.split('\n')
  const functions = []
  for (let index = 0; index < shellLines.length; index += 1) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*\(\)\s*\{$/.test(shellLines[index])) continue
    const block = [shellLines[index]]
    let closed = false
    for (let cursor = index + 1; cursor < shellLines.length; cursor += 1) {
      block.push(shellLines[cursor])
      if (shellLines[cursor] === '}') {
        closed = true
        index = cursor
        break
      }
    }
    if (!closed) throw new Error(`unterminated shell function: ${shellLines[index]}`)
    functions.push(block.join('\n'))
  }
  return functions
}

const step = extractStep(workflow, STEP_NAME)

/** Every helper the step defines, or a hard failure that names what is missing. */
function stepShell() {
  assert.ok(step, `the workflow no longer defines the "${STEP_NAME}" step`)
  const functions = extractShellFunctions(step)
  assert.ok(functions.length > 0, `the "${STEP_NAME}" step defines no shell functions`)
  return { step, functions, source: functions.join('\n\n') }
}

/**
 * Run a shell snippet with the step's helpers sourced into it.
 *
 * stderr is folded into stdout so the `::error::` annotations the step emits
 * can be asserted on, exactly as the Actions log shows them.
 */
function runWithHelpers(body, { overrides = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-dist-tag-'))
  try {
    const script = join(dir, 'probe.sh')
    const { source } = stepShell()
    writeFileSync(
      script,
      ['#!/usr/bin/env bash', 'set -uo pipefail', 'exec 2>&1', source, overrides, body, ''].join(
        '\n',
      ),
      'utf8',
    )
    return execFileSync('bash', [script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Classify one registry failure string through the step's own classifier. */
function classify(message) {
  const output = runWithHelpers(`failure_class ${JSON.stringify(message)}\n`, {
    overrides: "REGISTRY='https://registry.npmjs.org'\nTARGET_VER='2.4.0'",
  }).trim()
  const [kind, ...rest] = output.split(' ')
  return { kind, detail: rest.join(' ') }
}

test('the dist-tag step is extracted, so the assertions below cannot pass vacuously', () => {
  assert.ok(step, `expected a "${STEP_NAME}" step in release.yml`)
  assert.match(step, /dist-tag add/, 'the extracted step must be the dist-tag reconciler')

  // Negative control: the extractor must report absence for an unknown step,
  // otherwise a renamed/deleted step would satisfy every test with ''.
  assert.equal(extractStep(workflow, 'Reconcile and assert npm dist-tags (deleted)'), null)
  assert.equal(extractStep(workflow, 'No such step'), null)
})

test('E401, E403 and EOTP are classified as fatal auth, never as retryable', () => {
  const failures = [
    'npm error code E401\nnpm error Incorrect or missing password.',
    'npm error code ENEEDAUTH\nnpm error need auth This command requires you to be logged in.',
    'npm error code E403\nnpm error 403 Forbidden - PUT https://registry.npmjs.org/-/package/pantheon-opencode/dist-tags',
    'npm error code EOTP\nnpm error This operation requires a one-time password.',
  ]
  for (const failure of failures) {
    const { kind, detail } = classify(failure)
    assert.equal(kind, 'auth', `${failure.split('\n')[0]} must not be retryable`)
    assert.doesNotMatch(kind, /transient|propagation/)
    assert.ok(detail.length > 0, 'an auth failure must name its cause')
  }
})

test('auth failures name the cause and the remediation', () => {
  assert.match(classify('npm error code E401').detail, /NPM_TOKEN/)
  assert.match(classify('npm error code E401').detail, /[Rr]otate|expired|revoked/)
  assert.match(classify('npm error code E403').detail, /publish|read-write|permission/)
  assert.match(classify('npm error code EOTP').detail, /[Aa]utomation token|2FA/)
})

test('propagation, 5xx and timeouts stay retryable', () => {
  assert.equal(classify('npm error code E404\nnpm error 404 Not Found').kind, 'propagation')
  assert.equal(
    classify('npm error code E500\nnpm error 500 Internal Server Error').kind,
    'transient',
  )
  assert.equal(classify('npm error 503 Service Unavailable').kind, 'transient')
  assert.equal(classify('npm error code ETIMEDOUT').kind, 'transient')
  assert.equal(classify('npm error code ECONNRESET').kind, 'transient')
  assert.equal(classify('npm error socket hang up').kind, 'transient')
})

test('an unclassified failure is fatal instead of retried forever', () => {
  assert.equal(classify('npm error code E409\nnpm error 409 Conflict').kind, 'fatal')
  assert.equal(classify('npm error something new and unexplained').kind, 'fatal')
})

/**
 * Drive `dist_tag_write` with a fake npm command.
 *
 * The fake records its invocation in a file: `dist_tag_write` runs commands in
 * a command substitution, so an in-shell counter would never survive.
 */
function probeWrite({ emit, exitCode, versionPresent }) {
  const output = runWithHelpers(
    [
      'COUNTER=$(mktemp)',
      `fake() { echo x >> "$COUNTER"; ${emit}; return ${exitCode}; }`,
      "sleep() { echo 'SLEPT' >&2; }",
      `version_present() { return ${versionPresent}; }`,
      'read_dist_tags() { echo \'{"latest":"2.3.4"}\'; }',
      "if dist_tag_write fake; then echo 'RESULT=success'; else echo 'RESULT=failure'; fi",
      'echo "CALLS=$(wc -l < "$COUNTER" | tr -d \' \')"',
      '',
    ].join('\n'),
  )
  const match = /CALLS=(\d+)/.exec(output)
  return { output, calls: match ? Number(match[1]) : -1 }
}

test('dist_tag_write attempts an E401 failure exactly once', () => {
  const { output, calls } = probeWrite({
    emit: "echo 'npm error code E401' >&2",
    exitCode: 1,
    versionPresent: 0,
  })
  assert.match(output, /RESULT=failure/, 'an auth failure must fail the step')
  assert.equal(calls, 1, `E401 must not be retried (saw ${output.trim()})`)
  assert.doesNotMatch(output, /SLEPT/, 'E401 must not reach a retry sleep')
  assert.equal(
    /SLEPT/.test(output),
    false,
    'no retry delay may elapse before an auth failure is reported',
  )
  assert.match(output, /::error::[^\n]*authentication[^\n]*/i)
  assert.match(output, /NPM_TOKEN/)
})

test('dist_tag_write still retries a transient failure up to the 5-attempt cap', () => {
  const { output, calls } = probeWrite({
    emit: "echo 'npm error 503 Service Unavailable' >&2",
    exitCode: 1,
    versionPresent: 0,
  })
  assert.match(output, /RESULT=failure/)
  assert.equal(calls, 5, 'a transient failure keeps the bounded retry')
  assert.match(output, /SLEPT/)
})

test('dist_tag_write stops retrying a 404 once the version is not present', () => {
  const { output, calls } = probeWrite({
    emit: "echo 'npm error code E404' >&2",
    exitCode: 1,
    versionPresent: 1,
  })
  assert.match(output, /RESULT=failure/)
  assert.equal(calls, 1, 'a missing version is not a propagation race')
})

test('dist_tag_write succeeds without retrying when the write works', () => {
  const { output, calls } = probeWrite({
    emit: 'true',
    exitCode: 0,
    versionPresent: 0,
  })
  assert.match(output, /RESULT=success/)
  assert.equal(calls, 1)
})

test('the end-state assertion survives and prints the dist-tags it actually read', () => {
  const afterIndex = step.indexOf('AFTER_JSON=')
  assert.ok(afterIndex > 0, 'the step must read the end-state dist-tags')
  const endState = step.slice(afterIndex)
  assert.match(endState, /Expected dist-tags\.latest=\$\{target\}, got \$\{tags\.latest\}/)
  assert.match(endState, /Expected dist-tags\.beta=\$\{target\}, got \$\{tags\.beta\}/)
  assert.match(endState, /Expected dist-tags\.next=\$\{target\}, got \$\{tags\.next\}/)
  // Every end-state assertion must report the full object it read, not just
  // the single field that happened to differ.
  const assertionLines = endState.split('\n').filter((line) => /::error::.*dist-tags/.test(line))
  assert.ok(assertionLines.length >= 4, 'expected the dist-tag assertions to remain')
  for (const line of assertionLines) {
    assert.match(
      line,
      /JSON\.stringify\(tags\)/,
      `assertion must print the actual tags: ${line.trim()}`,
    )
  }
  assert.match(endState, /Verified npm dist-tags:/)
})

test('beta and next are asserted by exact equality, not by an ordering guess', () => {
  const endState = step.slice(step.indexOf('AFTER_JSON='))
  // A stale or unparseable tag must fail: `lt()` returned false for anything
  // it could not parse, and `dist-tag add` short-circuits before the PUT when
  // the tag already holds the target version.
  assert.doesNotMatch(endState, /\blt\(tags\.(?:beta|next)/)
  assert.match(
    endState,
    /if \(tags\.beta !== target\) \{[\s\S]*?Expected dist-tags\.beta=\$\{target\}, got \$\{tags\.beta\}/,
  )
  assert.match(
    endState,
    /if \(tags\.next !== target\) \{[\s\S]*?Expected dist-tags\.next=\$\{target\}, got \$\{tags\.next\}/,
  )
})

test('a stale next tag is advanced with dist-tag add, never removed', () => {
  // DELETE .../dist-tags/next answers 403 for this credential class
  // (2FA-bypass GAT restriction, 2026-07-31) while PUT succeeds, so the only
  // working reconciliation is to advance the tag.
  assert.match(step, /cmds\.push\('next'\)/)
  assert.doesNotMatch(step, /dist-tag rm/)
  assert.doesNotMatch(step, /'rm'/)
  assert.match(step, /dist_tag_write npm dist-tag add "pantheon-opencode@\$\{TARGET_VER\}"/)
})

test('the release job pins an npm whose dist-tag performs the OIDC exchange', () => {
  const pinStep = extractStep(workflow, 'Pin npm for OIDC-capable dist-tag')
  assert.ok(pinStep, 'expected the release job to pin its npm version')
  // The rationale lives in the YAML comment block attached to the step; assert
  // against both so the proof cannot drift away from the pin.
  const pinRegion = `${extractLeadingComments(workflow, 'Pin npm for OIDC-capable dist-tag')}${pinStep}`

  const pinned = /npm i -g npm@(\d+)\.(\d+)\.(\d+)/.exec(pinStep)
  assert.ok(pinned, `the pin step must install an exact npm version: ${pinStep.slice(0, 200)}`)
  const [major, minor, patch] = pinned.slice(1).map(Number)
  // 11.21.0 is the first release whose lib/commands/dist-tag.js calls
  // `await this.#oidc(spec, opts)`; anything below it sends NODE_AUTH_TOKEN.
  assert.ok(
    major > 11 || (major === 11 && (minor > 21 || (minor === 21 && patch >= 0))),
    `npm ${major}.${minor}.${patch} predates the dist-tag OIDC exchange`,
  )

  // The pin must carry its own proof and verify itself at runtime.
  assert.match(pinRegion, /#oidc\(spec, opts\)/)
  assert.match(pinRegion, /11\.21\.0/)
  assert.match(pinRegion, /11\.20\.0/)
  assert.match(pinRegion, /lib\/commands\/dist-tag\.js/)
  assert.match(pinStep, /grep -q 'this\.#oidc\(spec, opts\)'/)

  // ci.yml and local dev keep the npm that ships with Node.
  const ci = readFileSync(
    fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)),
    'utf8',
  )
  assert.doesNotMatch(ci, /npm i(?:nstall)? -g npm@/)
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf('  release:')), /npm i(?:nstall)? -g npm@/)
})

test('a failed write also reports the dist-tags it read', () => {
  const { output } = probeWrite({
    emit: "echo 'npm error code E401' >&2",
    exitCode: 1,
    versionPresent: 0,
  })
  assert.match(
    output,
    /::error::dist-tags read immediately after the failure: \{"latest":"2\.3\.4"\}/,
  )
})

test('the retry path is gated by the classifier and the version probe', () => {
  assert.match(step, /failure_class "\$output"/)
  assert.match(step, /case "\$class" in/)
  assert.match(step, /version_present/)
  // The old blanket retryable set is gone: it retried auth failures.
  assert.doesNotMatch(step, /retryable_error/)
  // The only classes that can set retry='yes' are transient and propagation.
  const gate = /case "\$class" in([\s\S]*?)\n\s*esac/.exec(step)
  assert.ok(gate, 'expected the retry gate case statement')
  const arms = gate[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-z_]+\)/.test(line))
    .map((line) => line.split(')')[0])
  assert.deepEqual(
    arms,
    ['transient', 'propagation'],
    'no auth/fatal class may reach the retry branch',
  )
})
