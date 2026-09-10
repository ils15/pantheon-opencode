import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const WORKFLOW = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url))
const workflow = readFileSync(WORKFLOW, 'utf8')
const validate = workflow.slice(workflow.indexOf('  validate:'), workflow.indexOf('  release:'))
const release = workflow.slice(workflow.indexOf('  release:'))
const githubTokenMarker = 'GH_TOKEN: $' + '{{ github.token }}'
const npmTokenMarker = 'NODE_AUTH_TOKEN: $' + '{{ secrets.NPM_TOKEN }}'

function validatePrNumber(raw) {
  if (!/^\d+$/.test(raw)) return false
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0
}

function resolveTagCommit(ref, objects) {
  let current = objects.ref[ref]
  for (let depth = 0; current?.type === 'tag' && depth < 4; depth += 1) {
    current = objects.tag[current.sha]?.object ?? objects.tag[current.sha]
  }
  return current?.type === 'commit' ? current.sha : null
}

function normalizeSha(value) {
  const sha = String(value ?? '')
    .trim()
    .toLowerCase()
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null
}

function recoveryTagApiPath(repo, tagRef) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo)) return null
  // Current committed beta (vX.Y.Z-beta.N) and legacy PR+SHA (vX.Y.Z-beta.<pr>.<sha7>).
  // Recovery is beta-only; a stable tag ref must never resolve.
  if (!/^v\d+\.\d+\.\d+-beta\.[1-9]\d*(?:\.[0-9a-f]{7})?$/.test(tagRef)) return null
  return `repos/${repo}/git/ref/tags/${tagRef}`
}

function validateRecoveryInputs({ version = '', sha = '', pr = '' }) {
  const supplied = [version, sha, pr].filter(Boolean).length
  if (!supplied) return true
  // Every recovery needs at least version + full SHA.
  if (!version || !sha) return false
  const modern = /^(\d+\.\d+\.\d+)-beta\.([1-9]\d*)$/.exec(version)
  const legacy = /^(\d+\.\d+\.\d+)-beta\.(\d+)\.([0-9a-f]{7})$/.exec(version)
  if (!modern && !legacy) return false
  if (!/^[0-9a-fA-F]{40}$/.test(sha)) return false
  if (legacy) {
    const value = Number(pr)
    return (
      Number.isSafeInteger(value) &&
      value > 0 &&
      legacy[2] === pr &&
      legacy[3] === sha.slice(0, 7).toLowerCase()
    )
  }
  // The committed scheme encodes no PR; recovery_pr_number must be absent.
  return pr === ''
}

function interpretApiStatus(statusLine) {
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/.exec(statusLine)
  if (!match) throw new Error('malformed or unavailable HTTP status')
  if (match[1] === '200') return 'present'
  if (match[1] === '404') return 'missing'
  throw new Error(`blocking HTTP status ${match[1]}`)
}

function shellBlocks(source) {
  const lines = source.split('\n')
  const blocks = []
  for (let index = 0; index < lines.length; index += 1) {
    const run = /^(\s*)run: \|$/.exec(lines[index])
    if (!run) continue
    const indent = run[1].length
    const body = []
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      if (line.trim() && line.search(/\S/) <= indent) break
      body.push(line)
    }
    blocks.push(body.join('\n'))
  }
  return blocks
}

test('release is workflow_dispatch-only and validates its event inputs first', () => {
  const trigger = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('concurrency:'))
  assert.match(trigger, /workflow_dispatch:/)
  assert.doesNotMatch(trigger, /(?:^|\n)\s*(?:push|pull_request|schedule):/)
  assert.match(validate, /Validate release inputs before checkout/)
  assert.match(validate, /EVENT_NAME !== 'workflow_dispatch'/)
  assert.match(validate, /release_channel must be 'stable' or 'beta'/)
})

test('validation checks out and confirms the exact TARGET_SHA before release credentials', () => {
  const checkout = validate.indexOf('actions/checkout@v4')
  const confirmation = validate.indexOf('Confirm checkout matches TARGET_SHA')
  const evidence = validate.indexOf('npm run package:evidence')

  assert.ok(checkout >= 0)
  assert.ok(confirmation > checkout)
  assert.ok(evidence > confirmation)
  assert.match(validate, /ref: \$\{\{ env\.TARGET_SHA \}\}/)
  assert.match(validate, /ACTUAL_SHA="\$\(git rev-parse HEAD\)"/)
  assert.match(validate, /\[ "\$ACTUAL_SHA" = "\$EXPECTED_SHA" \]/)
  assert.match(validate, /persist-credentials: false/)
  assert.doesNotMatch(validate, /secrets\./)
  assert.doesNotMatch(validate, /(?:NODE_AUTH_TOKEN|NPM_TOKEN|RELEASE_TOKEN):\s*\$\{\{/)
})

test('validate creates package evidence and enforces one immutable tarball plus metadata checksum', () => {
  assert.match(validate, /npm run package:evidence -- --output-dir=.*--target-sha="\$TARGET_SHA"/)
  assert.match(validate, /TARBALLS=\("\$RUNNER_TEMP\/release-artifact"\/\*\.tgz\)/)
  assert.match(validate, /\[ "\$\{#TARBALLS\[@\]\}" -eq 1 \]/)
  assert.match(validate, /metadata\.json/)
  assert.match(validate, /metadata\.version/)
  assert.match(validate, /metadata\.targetSha/)
  assert.match(validate, /metadata\.tarballSha256/)
  assert.match(validate, /createHash\('sha256'\)/)
  assert.match(validate, /\^\[0-9a-f\]\{64\}\$/)
})

test('release consumes exactly one downloaded tarball and validates all evidence before credentials', () => {
  const download = release.indexOf('actions/download-artifact@v4')
  const metadata = release.indexOf('Validate immutable artifact metadata')
  const firstCredential = Math.min(
    release.indexOf(githubTokenMarker),
    release.indexOf(npmTokenMarker),
  )

  assert.ok(download >= 0)
  assert.ok(metadata > download)
  assert.ok(firstCredential > metadata)
  assert.match(release, /TARBALLS=\(release-artifact\/\*\.tgz\)/)
  assert.match(release, /\[ "\$\{#TARBALLS\[@\]\}" -eq 1 \]/)
  assert.match(release, /METADATA_PATH=release-artifact\/metadata\.json/)
  assert.match(release, /metadata\.version/)
  assert.match(release, /metadata\.targetSha/)
  assert.match(release, /metadata\.tarballSha256/)
  assert.match(release, /createHash\('sha256'\).*readFileSync\(process\.env\.PACKAGE\)/s)
  assert.match(release, /\^\[0-9a-f\]\{64\}\$/)
  assert.match(release, /packageJson\.name !== 'pantheon-opencode'/)
  assert.match(release, /packageJson\.version !== metadata\.version/)
  assert.match(release, /Downloaded tarball SHA-256 does not match metadata/)
})

test('release never checks out, packs, repacks, or installs after artifact handoff', () => {
  assert.doesNotMatch(release, /actions\/checkout@v4/)
  assert.doesNotMatch(release, /\bnpm pack\b/)
  assert.doesNotMatch(release, /\brepack\b/)
  assert.doesNotMatch(release, /\bnpm install\b/)
  const publish = release.indexOf('Publish immutable artifact to npm')
  assert.ok(publish > 0)
  assert.doesNotMatch(
    release.slice(publish),
    /actions\/checkout|npm ci|npm install|npm pack|tar -czf/,
  )
  assert.match(release, /npm publish "\$PACKAGE" --ignore-scripts/)
})

test('credentials and mutations occur only after immutable validation', () => {
  const metadata = release.indexOf('Validate immutable artifact metadata')
  const token = release.indexOf(npmTokenMarker)
  const tagMutation = release.indexOf('gh api --method POST')
  const releaseMutation = release.indexOf('gh release create')
  const publish = release.indexOf('npm publish')

  assert.ok(metadata >= 0)
  assert.ok(token > metadata)
  assert.ok(tagMutation > metadata)
  assert.ok(releaseMutation > metadata)
  assert.ok(publish > metadata)
  assert.doesNotMatch(validate, /secrets\./)
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/)
  assert.doesNotMatch(workflow, /\|\|\s*(?:true|:)(?:\s|$)/m)
  assert.doesNotMatch(workflow, /\b(?:SKIP|WARNING|WARN)\b/i)
  assert.doesNotMatch(workflow, /\bfallback\b/i)
})

test('all multiline shell steps protect pipelines with pipefail', () => {
  const blocks = shellBlocks(workflow)
  assert.ok(blocks.length > 0)
  for (const block of blocks) assert.match(block, /set -euo pipefail/)
})

test('GitHub API lookups interpret only 200 and 404 and fail closed otherwise', () => {
  assert.match(release, /TAG_STATUS=.*\$\(.*awk/)
  assert.match(release, /\[ "\$TAG_STATUS" = 200 \]/)
  assert.match(release, /if \[ "\$STATUS" = 404 \]; then/)
  assert.match(release, /RELEASE_STATUS=.*awk/)
  assert.match(release, /\[ "\$RELEASE_STATUS" = 200 \]/)
  assert.match(release, /Could not determine whether GitHub release exists/)
  assert.match(release, /Could not determine whether release tag exists/)

  for (const status of ['403', '409', '422', '429', '500']) {
    assert.throws(() => interpretApiStatus(`HTTP/2.0 ${status} Error`), /blocking HTTP status/)
  }
  for (const malformed of ['', 'network failure', 'HTTP/2.0 malformed']) {
    assert.throws(() => interpretApiStatus(malformed), /malformed or unavailable HTTP status/)
  }
  assert.equal(interpretApiStatus('HTTP/2.0 200 OK'), 'present')
  assert.equal(interpretApiStatus('HTTP/2.0 404 Not Found'), 'missing')
})

test('beta gate trusts the committed X.Y.Z-beta.N and notes come from the changelog', () => {
  // Runtime version computation and the npm-baseline lookup were removed.
  assert.doesNotMatch(validate, /Query published stable version/)
  assert.doesNotMatch(validate, /Compute and apply beta version/)
  assert.doesNotMatch(validate, /valid semver baseline/)
  assert.doesNotMatch(validate, /FULL_TARGET_SHA/)
  assert.doesNotMatch(validate, /--sha="\$FULL_TARGET_SHA"/)
  assert.doesNotMatch(validate, /rev-parse --short HEAD/)
  assert.doesNotMatch(workflow, /release-notes\.mjs/)
  // The gate requires a committed sequential beta version.
  assert.match(validate, /Expected a committed X\.Y\.Z-beta\.N version/)
  // Both channels extract release notes from the committed CHANGELOG section.
  assert.match(validate, /node scripts\/changelog-extract\.mjs "\$BASE_VERSION"/)
})

test('tag and release provenance remains bound to TARGET_SHA', () => {
  assert.match(
    workflow,
    /TARGET_SHA: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.recovery_target_sha \|\| github\.sha \}\}/,
  )
  assert.match(validate, /ref: \$\{\{ env\.TARGET_SHA \}\}/)
  assert.match(release, /metadata\.targetSha !== expectedTarget/)
  assert.match(release, /release\.target_commitish !== process\.env\.TARGET_SHA/)
  assert.match(release, /-f "sha=\$TARGET_SHA"/)
  assert.match(release, /--target "\$TARGET_SHA"/)
  assert.match(release, /npm publish .*--provenance/)
})

test('recovery inputs, hostile refs, and tag objects are rejected', () => {
  assert.equal(validatePrNumber('12'), true)
  for (const value of ['', '0', '1.5', '1e3', '9007199254740992', '1;gh release delete']) {
    assert.equal(validatePrNumber(value), false, value)
  }
  const target = 'a'.repeat(40)
  assert.equal(
    resolveTagCommit('v1.0.0', { ref: { 'v1.0.0': { type: 'commit', sha: target } }, tag: {} }),
    target,
  )
  assert.equal(
    resolveTagCommit('v1.0.1', {
      ref: { 'v1.0.1': { type: 'tag', sha: 'b'.repeat(40) } },
      tag: { ['b'.repeat(40)]: { object: { type: 'commit', sha: target } } },
    }),
    target,
  )
  assert.equal(normalizeSha(` ${target.toUpperCase()}\n`), target)
  assert.equal(normalizeSha('a'.repeat(39)), null)
  assert.equal(
    recoveryTagApiPath('owner/repo', 'v1.2.3-beta.4'),
    'repos/owner/repo/git/ref/tags/v1.2.3-beta.4',
  )
  assert.equal(
    recoveryTagApiPath('owner/repo', 'v1.2.3-beta.4.abcdef0'),
    'repos/owner/repo/git/ref/tags/v1.2.3-beta.4.abcdef0',
  )
  assert.equal(recoveryTagApiPath('owner/repo', 'refs/tags/v1.2.3'), null)
  assert.equal(recoveryTagApiPath('owner/repo', 'v1.2.3'), null)
  assert.equal(validateRecoveryInputs({}), true)
  // Current committed scheme: version + full SHA only.
  assert.equal(validateRecoveryInputs({ version: '1.2.3-beta.4', sha: target }), true)
  assert.equal(validateRecoveryInputs({ version: '1.2.3-beta.4', sha: target, pr: '4' }), false)
  assert.equal(validateRecoveryInputs({ version: '1.2.3-beta.4', sha: 'abc' }), false)
  // Legacy scheme requires the matching PR and 7-char SHA suffix.
  const legacyTarget = `abcdef0${'b'.repeat(33)}`
  assert.equal(
    validateRecoveryInputs({ version: '1.2.3-beta.4.abcdef0', sha: legacyTarget, pr: '4' }),
    true,
  )
  assert.equal(
    validateRecoveryInputs({ version: '1.2.3-beta.4.abcdef0', sha: legacyTarget }),
    false,
  )
  assert.equal(
    validateRecoveryInputs({ version: '1.2.3-beta.4.abcdef0', sha: target, pr: '4' }),
    false,
  )
  assert.equal(
    validateRecoveryInputs({ version: '1.2.3-beta.4.abcdef0', sha: legacyTarget, pr: '5' }),
    false,
  )
  // The workflow itself must reject recovery_pr_number for the modern format
  // (guard is present in both the pre-checkout and pre-mutation validators).
  assert.equal(workflow.match(/recovery_pr_number is only valid for the legacy/g)?.length, 2)
  assert.match(workflow, /Existing tag does not point to TARGET_SHA/)
  assert.match(workflow, /Could not resolve annotated tag object/)
})

test('validation job has no release credential injection', () => {
  assert.doesNotMatch(validate, /secrets\./)
  assert.match(validate, /NODE_AUTH_TOKEN:-\}/)
  assert.match(validate, /NPM_TOKEN:-\}/)
  assert.match(validate, /RELEASE_TOKEN:-\}/)
  assert.doesNotMatch(validate, /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\./)
})
