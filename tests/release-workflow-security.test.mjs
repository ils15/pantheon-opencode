import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  validateExistingTagRef,
  validateManifest,
  validateOperatorDispatch,
  validatePackageEvidence,
  validateReleaseDispatch,
  validateStableVersionProgress,
  validateValidationDispatch,
  validateValidationRun,
} from '../scripts/release-guard.mjs'

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const validation = read('../.github/workflows/release-validation.yml')
const release = read('../.github/workflows/release.yml')
const distTag = read('../.github/workflows/npm-dist-tag-remove.yml')
const readme = read('../README.md')
const releasing = read('../docs/RELEASING.md')
const releaseGuard = read('../scripts/release-guard.mjs')
const guardPath = fileURLToPath(new URL('../scripts/release-guard.mjs', import.meta.url))

const sha = 'a'.repeat(40)
const digest = 'b'.repeat(64)
const baseDispatch = {
  ref: 'refs/heads/main',
  actor: 'ils15',
  triggeringActor: 'ils15',
  runAttempt: '1',
  sourceCommit: sha,
}
const validationRun = {
  id: 123,
  workflow_id: 456,
  path: '.github/workflows/release-validation.yml',
  event: 'workflow_dispatch',
  head_branch: 'main',
  head_sha: 'c'.repeat(40),
  status: 'completed',
  conclusion: 'success',
  run_attempt: 1,
  actor: { login: 'ils15' },
  triggering_actor: { login: 'ils15' },
  head_repository: { full_name: 'ils15/pantheon-opencode' },
}
const validationArtifacts = [
  { id: 789, name: 'release-package-123', expired: false, workflow_run: { id: 123 } },
  { id: 790, name: 'release-provenance-123', expired: false, workflow_run: { id: 123 } },
]
const manifest = {
  schemaVersion: 1,
  sourceCommit: sha,
  version: '1.7.0-beta.7',
  workflowId: 456,
  workflowPath: '.github/workflows/release-validation.yml',
  runId: 123,
  artifactId: 789,
  tarball: 'pantheon-opencode-1.7.0-beta.7.tgz',
  tarballSha256: digest,
}
const expected = {
  runId: '123',
  validationRunId: '123',
  workflowId: 456,
  packageArtifactId: '789',
  manifestArtifactId: '790',
  sourceCommit: sha,
  expectedDigest: digest,
  releaseChannel: 'beta',
  recoveryVersion: '',
  repository: 'ils15/pantheon-opencode',
}

// Dispatch guards: each rejection is exercised independently so policy
// regressions cannot be masked by an earlier invalid field.
test('validation dispatch accepts the authorized main actor and full source SHA', () => {
  assert.equal(validateValidationDispatch(baseDispatch), sha)
})
test('validation dispatch rejects a non-main ref', () => {
  assert.throws(
    () => validateValidationDispatch({ ...baseDispatch, ref: 'refs/heads/feature' }),
    /main/,
  )
})
test('validation dispatch rejects an unauthorized actor', () => {
  assert.throws(() => validateValidationDispatch({ ...baseDispatch, actor: 'mallory' }), /actor/)
})
test('validation dispatch rejects a different triggering actor', () => {
  assert.throws(
    () => validateValidationDispatch({ ...baseDispatch, triggeringActor: 'mallory' }),
    /triggering actor/,
  )
})
test('validation dispatch rejects reruns', () => {
  assert.throws(
    () => validateValidationDispatch({ ...baseDispatch, runAttempt: '2' }),
    /first attempt/,
  )
})
test('validation dispatch rejects missing source SHA', () => {
  assert.throws(
    () => validateValidationDispatch({ ...baseDispatch, sourceCommit: '' }),
    /full 40-character/,
  )
})
test('validation dispatch rejects abbreviated or malformed source SHA', () => {
  assert.throws(
    () => validateValidationDispatch({ ...baseDispatch, sourceCommit: 'abc1234' }),
    /full 40-character/,
  )
})
test('release dispatch rejects missing or malformed validation run IDs', () => {
  for (const runId of ['', 'abc', '0', '1.5']) {
    assert.throws(
      () => validateReleaseDispatch({ ...baseDispatch, ...expected, validationRunId: runId }),
      /validation run ID/,
    )
  }
})
test('release dispatch rejects missing or malformed artifact IDs', () => {
  for (const id of ['', 'NaN', '0', '1e4']) {
    assert.throws(
      () => validateReleaseDispatch({ ...baseDispatch, ...expected, packageArtifactId: id }),
      /artifact ID/,
    )
  }
})
test('release dispatch rejects missing or malformed expected digest', () => {
  for (const sha256 of ['', 'not-a-digest', 'c'.repeat(63), 'g'.repeat(64)]) {
    assert.throws(
      () => validateReleaseDispatch({ ...baseDispatch, ...expected, expectedDigest: sha256 }),
      /SHA-256/,
    )
  }
})
test('release dispatch rejects unsupported channels and incoherent recovery inputs', () => {
  assert.throws(
    () => validateReleaseDispatch({ ...baseDispatch, ...expected, releaseChannel: 'nightly' }),
    /channel/,
  )
  assert.throws(
    () =>
      validateReleaseDispatch({
        ...baseDispatch,
        ...expected,
        releaseChannel: 'stable',
        recoveryVersion: '1.7.0-beta.7',
      }),
    /beta channel/,
  )
  assert.throws(
    () => validateReleaseDispatch({ ...baseDispatch, ...expected, recoveryVersion: 'bad-version' }),
    /recovery version/,
  )
})

test('dist-tag guard accepts only confirmed, non-protected npm tags', () => {
  const operator = { ...baseDispatch, distTag: 'next-1', confirm: 'REMOVE' }
  assert.equal(validateOperatorDispatch(operator), 'next-1')
  assert.throws(
    () => validateOperatorDispatch({ ...operator, distTag: ' next-1 ' }),
    /surrounding whitespace/,
  )
  for (const distTag of ['latest', 'beta']) {
    assert.throws(() => validateOperatorDispatch({ ...operator, distTag }), /protected tag/)
  }
  assert.throws(() => validateOperatorDispatch({ ...operator, confirm: 'no' }), /exactly REMOVE/)
  assert.throws(
    () => validateOperatorDispatch({ ...operator, distTag: 'tag with spaces' }),
    /valid 1-64 character/,
  )
})

// Validation run and artifact API contract.
test('validation run metadata accepts only the exact successful first-attempt main workflow', () => {
  assert.equal(
    validateValidationRun({ run: validationRun, artifacts: validationArtifacts, expected })
      .workflowId,
    456,
  )
  assert.equal(
    validateValidationRun({
      run: { ...validationRun, path: `${validationRun.path}@refs/heads/main` },
      artifacts: validationArtifacts,
      expected,
    }).workflowId,
    456,
  )
})
test('validation run rejects another workflow path or workflow ID', () => {
  assert.throws(
    () =>
      validateValidationRun({
        run: { ...validationRun, path: '.github/workflows/release.yml' },
        artifacts: validationArtifacts,
        expected,
      }),
    /workflow path/,
  )
  assert.throws(
    () =>
      validateValidationRun({
        run: { ...validationRun, workflow_id: 999 },
        artifacts: validationArtifacts,
        expected,
      }),
    /workflow ID/,
  )
})
test('validation run rejects wrong run ID, branch, or event', () => {
  assert.throws(
    () =>
      validateValidationRun({
        run: { ...validationRun, id: 124 },
        artifacts: validationArtifacts,
        expected,
      }),
    /run ID/,
  )
  assert.throws(
    () =>
      validateValidationRun({
        run: { ...validationRun, head_branch: 'topic' },
        artifacts: validationArtifacts,
        expected,
      }),
    /main/,
  )
  assert.throws(
    () =>
      validateValidationRun({
        run: { ...validationRun, event: 'push' },
        artifacts: validationArtifacts,
        expected,
      }),
    /workflow_dispatch/,
  )
})
test('validation run rejects unsuccessful, incomplete, or rerun executions', () => {
  for (const changed of [
    { conclusion: 'failure' },
    { status: 'in_progress' },
    { run_attempt: 2 },
  ]) {
    assert.throws(
      () =>
        validateValidationRun({
          run: { ...validationRun, ...changed },
          artifacts: validationArtifacts,
          expected,
        }),
      /success|first attempt|completed/,
    )
  }
})
test('validation run rejects wrong actor, triggering actor, or repository', () => {
  assert.throws(
    () =>
      validateValidationRun({
        run: { ...validationRun, actor: { login: 'other' } },
        artifacts: validationArtifacts,
        expected,
      }),
    /actor/,
  )
  assert.throws(
    () =>
      validateValidationRun({
        run: { ...validationRun, triggering_actor: { login: 'other' } },
        artifacts: validationArtifacts,
        expected,
      }),
    /triggering actor/,
  )
  assert.throws(
    () =>
      validateValidationRun({
        run: { ...validationRun, head_repository: { full_name: 'attacker/repo' } },
        artifacts: validationArtifacts,
        expected,
      }),
    /repository/,
  )
})
test('validation run rejects wrong, expired, or cross-run package and manifest artifacts', () => {
  for (const changed of [
    [{ ...validationArtifacts[0], id: 791 }, validationArtifacts[1]],
    [{ ...validationArtifacts[0], workflow_run: { id: 999 } }, validationArtifacts[1]],
    [{ ...validationArtifacts[0], expired: true }, validationArtifacts[1]],
    [validationArtifacts[0], { ...validationArtifacts[1], name: 'unexpected' }],
  ]) {
    assert.throws(
      () => validateValidationRun({ run: validationRun, artifacts: changed, expected }),
      /[Aa]rtifact/,
    )
  }
})

// Manifest and package verification contract.
test('provenance manifest binds source, workflow/run, artifact ID, version, and digest', () => {
  assert.equal(validateManifest(manifest, expected).artifactId, 789)
})
test('manifest rejects wrong source SHA, artifact ID, run ID, or workflow ID', () => {
  for (const changed of [
    { sourceCommit: 'd'.repeat(40) },
    { artifactId: 791 },
    { runId: 124 },
    { workflowId: 999 },
  ]) {
    assert.throws(
      () => validateManifest({ ...manifest, ...changed }, expected),
      /source|artifact|run ID|workflow ID/,
    )
  }
})
test('manifest rejects digest mismatch, invalid version, and channel mismatch', () => {
  assert.throws(
    () => validateManifest({ ...manifest, tarballSha256: 'c'.repeat(64) }, expected),
    /digest/,
  )
  assert.throws(() => validateManifest({ ...manifest, version: 'not-semver' }, expected), /version/)
  assert.throws(() => validateManifest({ ...manifest, version: '1.7.0' }, expected), /beta/)
})
test('recovery requires the exact beta version already present in the package manifest', () => {
  assert.throws(
    () => validateManifest(manifest, { ...expected, recoveryVersion: '1.7.0-beta.8' }),
    /recovery version/,
  )
  assert.equal(
    validateManifest(manifest, { ...expected, recoveryVersion: '1.7.0-beta.7' }).version,
    '1.7.0-beta.7',
  )
})
test('package verification rejects tarball digest and package version mismatch', () => {
  const tarballBytes = Buffer.from('test package bytes')
  const actualDigest = createHash('sha256').update(tarballBytes).digest('hex')
  const packageManifest = { ...manifest, tarballSha256: actualDigest }
  const valid = {
    manifest: packageManifest,
    metadata: {
      version: manifest.version,
      targetSha: sha,
      tarball: manifest.tarball,
      tarballSha256: actualDigest,
    },
    tarballBytes,
    packageJson: { name: 'pantheon-opencode', version: manifest.version },
    tarballName: manifest.tarball,
    expectedDigest: actualDigest,
  }
  assert.match(validatePackageEvidence(valid), /^[0-9a-f]{64}$/)
  assert.throws(
    () => validatePackageEvidence({ ...valid, expectedDigest: 'c'.repeat(64) }),
    /digest/,
  )
  assert.throws(
    () =>
      validatePackageEvidence({
        ...valid,
        packageJson: { ...valid.packageJson, version: '1.0.0' },
      }),
    /package version/,
  )
})

test('existing GitHub tag response is parsed as JSON and validated as a git ref', () => {
  const existingTag = { object: { type: 'commit', sha } }
  assert.deepEqual(validateExistingTagRef(existingTag), { type: 'commit', sha })
  assert.match(release, /tag-body\.json/)
  assert.match(release, /release-guard\.mjs tag-ref/)
  assert.doesNotMatch(release, /require\(process\.argv\[1\]\).*tag-body/)
  assert.throws(() => validateExistingTagRef({ object: { type: 'commit', sha: 'bad' } }), /SHA/)
})

test('tag-ref CLI parses a mocked existing-tag body even when its file has no extension', () => {
  const directory = mkdtempSync(join(tmpdir(), 'release-tag-ref-'))
  const responsePath = join(directory, 'tag-body')
  try {
    writeFileSync(responsePath, JSON.stringify({ object: { type: 'commit', sha } }))
    const result = spawnSync(process.execPath, [guardPath, 'tag-ref', responsePath], {
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, `commit\t${sha}\n`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('stable release compares against mocked npm latest and fails closed on downgrades', () => {
  assert.deepEqual(
    validateStableVersionProgress({
      candidateVersion: '1.8.0',
      latestPublishedStable: '1.7.9',
    }),
    { candidateVersion: '1.8.0', latestPublishedStable: '1.7.9' },
  )
  assert.deepEqual(
    validateStableVersionProgress({
      candidateVersion: '1.7.9',
      latestPublishedStable: '1.7.9',
    }),
    { candidateVersion: '1.7.9', latestPublishedStable: '1.7.9' },
  )
  for (const latestPublishedStable of ['1.8.0', 'not-semver', '', null]) {
    assert.throws(
      () =>
        validateStableVersionProgress({
          candidateVersion: '1.7.9',
          latestPublishedStable,
        }),
      /latest published stable|downgrade/i,
    )
  }
  assert.throws(
    () =>
      validateStableVersionProgress({
        candidateVersion: '1.7.0-beta.1',
        latestPublishedStable: '1.6.9',
      }),
    /stable version/i,
  )
})

test('stable-version-check CLI consumes mocked npm JSON and rejects a backwards latest move', () => {
  const directory = mkdtempSync(join(tmpdir(), 'release-stable-check-'))
  const responsePath = join(directory, 'npm-latest.json')
  const invoke = (version) =>
    spawnSync(process.execPath, [guardPath, 'stable-version-check', responsePath], {
      encoding: 'utf8',
      env: { ...process.env, VERSION: version },
    })
  try {
    writeFileSync(responsePath, JSON.stringify('1.8.0'))
    const newer = invoke('1.9.0')
    assert.equal(newer.status, 0, newer.stderr)
    assert.equal(JSON.parse(newer.stdout).latestPublishedStable, '1.8.0')
    const older = invoke('1.7.9')
    assert.notEqual(older.status, 0)
    assert.match(older.stderr, /Stable downgrade refused/)
    writeFileSync(responsePath, JSON.stringify(null))
    const unknown = invoke('1.9.0')
    assert.notEqual(unknown.status, 0)
    assert.match(unknown.stderr, /Could not determine the latest published stable version/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

// Workflow integration: GitHub runtime guards, two-phase separation, least
// privilege, immutable artifact identity, and operator prerequisites.
test('validation workflow has a main-only explicit dispatch and exact source commit ancestry gate', () => {
  assert.match(validation, /workflow_dispatch:/)
  for (const context of [
    'github.ref',
    'github.actor',
    'github.triggering_actor',
    'github.run_attempt',
  ])
    assert.ok(validation.includes(context))
  assert.match(validation, /GITHUB_TRIGGERING_ACTOR !== 'ils15'/)
  assert.match(validation, /merge-base --is-ancestor/)
})
test('validation packages once from the pinned source and never exposes npm credentials', () => {
  assert.equal((validation.match(/npm run package:evidence/g) ?? []).length, 1)
  assert.doesNotMatch(validation, /(?:^|\n)\s*run:\s*npm pack\b/)
  assert.doesNotMatch(validation, /secrets\./)
  assert.match(validation, /persist-credentials: false/)
  assert.match(validation, /actions\/upload-artifact@[0-9a-f]{40}/)
  assert.match(validation, /artifact-id/)
  assert.match(validation, /tarballSha256/)
})
test('validation workflow uses read-only GitHub permissions and reports provenance IDs and digest', () => {
  const job = validation.slice(
    validation.indexOf('  validate:'),
    validation.indexOf('\n  ', validation.indexOf('  validate:') + 10),
  )
  assert.match(validation, /permissions:\n\s+contents: read\n\s+actions: read/)
  assert.doesNotMatch(validation, /(?:contents|actions): write/)
  assert.match(validation, /GITHUB_STEP_SUMMARY/)
  assert.match(validation, /PACKAGE_ARTIFACT_ID/)
  assert.match(validation, /MANIFEST_ARTIFACT_ID/)
  assert.ok(job.length > 0)
})
test('release workflow is phase two only and dispatch inputs bind run, both artifact IDs, SHA, and digest', () => {
  assert.match(release, /validation_run_id:/)
  assert.match(release, /package_artifact_id:/)
  assert.match(release, /manifest_artifact_id:/)
  assert.match(release, /source_commit:/)
  assert.match(release, /expected_tarball_sha256:/)
  assert.doesNotMatch(release, /npm run package:evidence|\bnpm pack\b/)
  assert.equal((release.match(/ref: \$\{\{ github\.sha \}\}/g) ?? []).length, 2)
  assert.doesNotMatch(release, /ref: \$\{\{ inputs\.source_commit \}\}/)
})
test('release hard-gates main, actor, triggering actor, and first attempt', () => {
  for (const context of [
    'github.ref',
    'github.actor',
    'github.triggering_actor',
    'github.run_attempt',
  ])
    assert.ok(release.includes(context))
  assert.equal((release.match(/GITHUB_REF !== 'refs\/heads\/main'/g) ?? []).length, 2)
  assert.equal((release.match(/GITHUB_RUN_ATTEMPT !== '1'/g) ?? []).length, 2)
})
test('release verifier uses read-only API to confirm validation run and artifact IDs', () => {
  assert.match(release, /actions\/runs\/\$VALIDATION_RUN_ID/)
  assert.match(release, /actions\/runs\/\$VALIDATION_RUN_ID\/artifacts/)
  assert.match(release, /release-guard\.mjs validation-run/)
  assert.match(release, /release-guard\.mjs manifest/)
  assert.match(release, /permissions:\n\s+contents: read\n\s+actions: read/)
  assert.doesNotMatch(
    release.slice(release.indexOf('  verify:'), release.indexOf('  publish:')),
    /secrets\./,
  )
})
test('protected publish depends on verifier and consumes the same immutable IDs without repacking', () => {
  assert.match(release, /needs: verify/)
  assert.match(release, /environment:\s*beta-release/)
  assert.match(release, /artifact-ids: \$\{\{ inputs\.package_artifact_id \}\}/)
  assert.match(release, /artifact-ids: \$\{\{ inputs\.manifest_artifact_id \}\}/)
  assert.match(release, /run-id: \$\{\{ inputs\.validation_run_id \}\}/)
  assert.doesNotMatch(release, /\bnpm pack\b|\brepack\b|npm run package:evidence/)
  const packageSummary = release.slice(
    release.indexOf('Verify immutable package and provenance before any mutation'),
    release.indexOf('Check whether exact npm version is already published'),
  )
  assert.match(packageSummary, /PACKAGE_ARTIFACT_ID: \$\{\{ inputs\.package_artifact_id \}\}/)
  assert.match(packageSummary, /Package artifact ID:.*PACKAGE_ARTIFACT_ID/)
  assert.doesNotMatch(
    packageSummary.slice(packageSummary.indexOf('run: |')),
    /\$\{\{ inputs\.package_artifact_id \}\}/,
  )
})
test('digest and manifest are reverified in protected publish before npm token or tag mutations', () => {
  const publish = release.slice(release.indexOf('  publish:'))
  const verification = publish.indexOf('Verify immutable package and provenance')
  const npmToken = publish.indexOf('secrets.BETA_RELEASE_NPM_TOKEN')
  const tagMutation = publish.indexOf('Create or verify immutable git tag')
  assert.ok(verification >= 0 && npmToken > verification && tagMutation > verification)
  assert.match(publish, /expected_tarball_sha256/)
  assert.match(publish, /release-guard\.mjs package/)
  assert.match(publish, /dist\.integrity/)
  assert.match(publish, /published tarball differs from the approved artifact/)
})
test('tarball listing checks consume the complete stream with pipefail enabled', () => {
  assert.doesNotMatch(release, /tar -tzf[^\n]*\|\s*grep -Fxq/)
  const tarListing = /tar -tzf [^\n]+ > "\$RUNNER_TEMP\/package-contents\.txt"/g
  const packageManifest =
    /grep -Fx 'package\/package\.json' "\$RUNNER_TEMP\/package-contents\.txt"/g
  assert.equal((release.match(tarListing) ?? []).length, 2)
  assert.equal((release.match(packageManifest) ?? []).length, 2)
})
test('npm token is only scoped to npm publish and release channels share one gate', () => {
  const tokenStep = release.slice(
    release.indexOf('secrets.BETA_RELEASE_NPM_TOKEN') - 180,
    release.indexOf('secrets.BETA_RELEASE_NPM_TOKEN') + 260,
  )
  assert.match(tokenStep, /name: Preflight npm publish credential before release mutations/)
  assert.match(tokenStep, /BETA_RELEASE_NPM_TOKEN: \$\{\{ secrets\.BETA_RELEASE_NPM_TOKEN \}\}/)
  assert.equal((release.match(/secrets\.BETA_RELEASE_NPM_TOKEN/g) ?? []).length, 2)
  assert.doesNotMatch(release, /secrets\.NPM_TOKEN\b/)
  const stableCheck = release.indexOf('Ensure stable release does not move npm latest backwards')
  const preflight = release.indexOf('Preflight npm publish credential before release mutations')
  const tagMutation = release.indexOf('Create or verify immutable git tag')
  const releaseMutation = release.indexOf('Create stable GitHub release if absent')
  const publishMutation = release.indexOf('Publish exact artifact to npm')
  assert.ok(stableCheck > release.indexOf('Check whether exact npm version is already published'))
  assert.ok(stableCheck < preflight && preflight < tagMutation)
  assert.ok(preflight < releaseMutation && preflight < publishMutation)
  assert.match(release.slice(stableCheck, tagMutation), /if: inputs\.release_channel == 'stable'/)
  assert.match(release, /stable/)
  assert.match(release, /beta/)
  assert.match(release, /recovery_version/)
  assert.match(release, /npm publish "\$PACKAGE" --ignore-scripts/)
  assert.match(release, /stable-version-check/)
})

test('missing or empty npm token fails before tag, GitHub release, or publish mutation', () => {
  const stepStart = release.indexOf(
    '      - name: Preflight npm publish credential before release mutations',
  )
  const stepEnd = release.indexOf('\n      - name:', stepStart + 1)
  const preflightStep = release.slice(stepStart, stepEnd)
  const runBlock = preflightStep.match(/\n\x20{8}run: \|\n((?:\x20{10}.*\n)+)/)?.[1]
  assert.ok(runBlock, 'credential preflight must have an executable shell body')
  const script = runBlock
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(10))
    .join('\n')
  assert.match(preflightStep, /BETA_RELEASE_NPM_TOKEN: \$\{\{ secrets\.BETA_RELEASE_NPM_TOKEN \}\}/)
  assert.doesNotMatch(preflightStep, /GITHUB_TOKEN|GH_TOKEN/)
  assert.match(script, /^set -euo pipefail\ntest -n "\$\{BETA_RELEASE_NPM_TOKEN:-\}"/)
  assert.doesNotMatch(script, /npm|gh api|gh release|git tag|GITHUB_STEP_SUMMARY|GITHUB_OUTPUT/)

  const envWithoutPublishToken = { ...process.env }
  delete envWithoutPublishToken.BETA_RELEASE_NPM_TOKEN
  for (const env of [
    envWithoutPublishToken,
    { ...envWithoutPublishToken, BETA_RELEASE_NPM_TOKEN: '' },
  ]) {
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
      encoding: 'utf8',
      env,
    })
    assert.notEqual(result.status, 0, 'absent and empty credentials must fail closed')
    assert.doesNotMatch(
      `${result.stdout}\n${result.stderr}`,
      /npm publish|gh release create|refs\/tags/,
    )
  }

  const preflight = release.indexOf('Preflight npm publish credential before release mutations')
  for (const mutation of [
    'Create or verify immutable git tag',
    'Create stable GitHub release if absent',
    'Publish exact artifact to npm',
  ]) {
    assert.ok(
      preflight >= 0 && preflight < release.indexOf(mutation),
      `${mutation} must follow preflight`,
    )
  }
})

test('npm credential is absent from summaries and log-producing commands', () => {
  const secretEnvBindings = [
    ...release.matchAll(/BETA_RELEASE_NPM_TOKEN:\s*\$\{\{ secrets\.BETA_RELEASE_NPM_TOKEN \}\}/g),
  ]
  assert.equal(
    secretEnvBindings.length,
    2,
    'only credential preflight and npm publish receive the secret',
  )
  const preflightStart = release.indexOf(
    '      - name: Preflight npm publish credential before release mutations',
  )
  const preflightEnd = release.indexOf('\n      - name:', preflightStart + 1)
  const publishStart = release.indexOf('      - name: Publish exact artifact to npm')
  for (const section of [
    release.slice(0, preflightStart),
    release.slice(preflightEnd, publishStart),
  ]) {
    assert.doesNotMatch(section, /BETA_RELEASE_NPM_TOKEN/)
  }
  const preflight = release.slice(preflightStart, preflightEnd)
  const publish = release.slice(publishStart)
  assert.doesNotMatch(
    preflight,
    /\$\{BETA_RELEASE_NPM_TOKEN[^}]*\}[^\n]*(?:echo|printf|GITHUB_STEP_SUMMARY|GITHUB_OUTPUT)/,
  )
  assert.doesNotMatch(
    publish,
    /(?:echo|GITHUB_STEP_SUMMARY|GITHUB_OUTPUT)[^\n]*BETA_RELEASE_NPM_TOKEN/,
  )
  assert.match(publish, /printf .*\$BETA_RELEASE_NPM_TOKEN.*> "\$npmrc"/)
  const expandedTokenCommands = release
    .split('\n')
    .filter(
      (line) =>
        line.includes('${BETA_RELEASE_NPM_TOKEN') || line.includes('$BETA_RELEASE_NPM_TOKEN'),
    )
    .map((line) => line.trim())
  assert.equal(expandedTokenCommands.length, 2)
  assert.match(expandedTokenCommands[0], /^test -n /)
  assert.match(expandedTokenCommands[1], /^printf .+ > "\$npmrc"$/)
  assert.doesNotMatch(
    expandedTokenCommands.join('\n'),
    /echo|GITHUB_STEP_SUMMARY|GITHUB_OUTPUT|cat/,
  )
  assert.doesNotMatch(
    release,
    /set -x|\$\{\{ secrets\.BETA_RELEASE_NPM_TOKEN \}\}.*(?:summary|output)/i,
  )
})
test('dist-tag removal is main/actor/rerun gated and summarizes before environment approval', () => {
  for (const context of [
    'github.ref',
    'github.actor',
    'github.triggering_actor',
    'github.run_attempt',
  ])
    assert.ok(distTag.includes(context))
  assert.equal((distTag.match(/GITHUB_REF !== 'refs\/heads\/main'/g) ?? []).length, 2)
  assert.equal((distTag.match(/GITHUB_RUN_ATTEMPT !== '1'/g) ?? []).length, 2)
  assert.match(distTag, /needs: preflight/)
  assert.match(distTag, /environment:\s*beta-release/)
  assert.ok(distTag.indexOf('GITHUB_STEP_SUMMARY') < distTag.indexOf('environment: beta-release'))
  assert.match(releaseGuard, /tag === 'latest'[\s\S]*refusing to remove/)
  assert.match(releaseGuard, /tag === 'beta'[\s\S]*refusing to remove/)
})
test('dist-tag token appears only in the exact removal step and protected tags stay refused', () => {
  assert.equal((distTag.match(/secrets\.BETA_RELEASE_NPM_TOKEN/g) ?? []).length, 1)
  assert.doesNotMatch(distTag, /secrets\.NPM_TOKEN\b/)
  const token = distTag.indexOf('secrets.BETA_RELEASE_NPM_TOKEN')
  assert.match(distTag.slice(token - 100, token + 250), /name: Remove dist-tag/)
  assert.match(distTag, /NODE_AUTH_TOKEN: \$\{\{ secrets\.BETA_RELEASE_NPM_TOKEN \}\}/)
  assert.match(distTag, /DIST_TAG: \$\{\{ inputs\.dist_tag \}\}/)
  assert.match(distTag, /npm dist-tag rm pantheon-opencode/)
})
test('release docs require unique environment secret and removal of broader-scope credentials', () => {
  for (const docs of [readme, releasing]) {
    assert.match(docs, /BETA_RELEASE_NPM_TOKEN/)
    assert.match(docs, /NPM_TOKEN/)
    assert.match(docs, /environment[\s\S]{0,40}secret/i)
    assert.match(docs, /repo-level|repository-level|organization-level/i)
    assert.match(docs, /BETA_RELEASE_NPM_TOKEN[\s\S]{0,180}(?:repository|organization)/i)
    assert.match(docs, /do not\s+(?:manually\s+)?dispatch|must not\s+dispatch|before\s+dispatch/i)
  }
})

test('CI runs pinned actionlint before merge', () => {
  const ci = read('../.github/workflows/ci.yml')
  assert.match(ci, /Validate GitHub Actions workflows/)
  assert.match(ci, /ACTIONLINT_VERSION: '[0-9.]+'/)
  assert.match(ci, /ACTIONLINT_SHA256: '[0-9a-f]{64}'/)
  assert.match(ci, /"\$RUNNER_TEMP\/actionlint" -color/)
})

test('release guard CLI paths validate dispatch, run, manifest, and package fixtures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'release-guard-contract-'))
  const runPath = join(directory, 'run.json')
  const artifactsPath = join(directory, 'artifacts.json')
  const manifestPath = join(directory, 'manifest.json')
  const metadataPath = join(directory, 'metadata.json')
  const tarballName = 'pantheon-opencode-1.7.0-beta.7.tgz'
  const tarballPath = join(directory, tarballName)
  const packageJsonPath = join(directory, 'package.json')
  const tarballBytes = Buffer.from('immutable fixture bytes')
  const actualDigest = createHash('sha256').update(tarballBytes).digest('hex')
  const fixtureManifest = {
    ...manifest,
    tarball: tarballName,
    tarballSha256: actualDigest,
  }
  const common = {
    GITHUB_REF: 'refs/heads/main',
    GITHUB_ACTOR: 'ils15',
    GITHUB_TRIGGERING_ACTOR: 'ils15',
    GITHUB_RUN_ATTEMPT: '1',
  }
  const invoke = (command, args = [], env = {}) =>
    spawnSync(process.execPath, [guardPath, command, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...common, ...env },
    })

  try {
    writeFileSync(runPath, JSON.stringify(validationRun))
    writeFileSync(artifactsPath, JSON.stringify({ artifacts: validationArtifacts }))
    writeFileSync(manifestPath, JSON.stringify(fixtureManifest))
    writeFileSync(
      metadataPath,
      JSON.stringify({
        version: fixtureManifest.version,
        targetSha: fixtureManifest.sourceCommit,
        tarball: fixtureManifest.tarball,
        tarballSha256: actualDigest,
      }),
    )
    writeFileSync(tarballPath, tarballBytes)
    writeFileSync(
      packageJsonPath,
      JSON.stringify({ name: 'pantheon-opencode', version: fixtureManifest.version }),
    )

    assert.equal(invoke('validation-dispatch', [], { SOURCE_COMMIT: sha }).status, 0)
    assert.equal(
      invoke('release-dispatch', [], {
        VALIDATION_RUN_ID: '123',
        PACKAGE_ARTIFACT_ID: '789',
        MANIFEST_ARTIFACT_ID: '790',
        SOURCE_COMMIT: sha,
        EXPECTED_DIGEST: actualDigest,
        RELEASE_CHANNEL: 'beta',
        RECOVERY_VERSION: '',
      }).status,
      0,
    )
    assert.equal(invoke('dist-tag-dispatch', [], { DIST_TAG: 'next', CONFIRM: 'REMOVE' }).status, 0)
    const runResult = invoke('validation-run', [runPath, artifactsPath], {
      VALIDATION_RUN_ID: '123',
      PACKAGE_ARTIFACT_ID: '789',
      MANIFEST_ARTIFACT_ID: '790',
      GITHUB_REPOSITORY: 'ils15/pantheon-opencode',
    })
    assert.equal(runResult.status, 0, runResult.stderr)
    assert.equal(JSON.parse(runResult.stdout).workflowId, 456)
    const manifestResult = invoke('manifest', [manifestPath], {
      VALIDATION_RUN_ID: '123',
      EXPECTED_WORKFLOW_ID: '456',
      PACKAGE_ARTIFACT_ID: '789',
      SOURCE_COMMIT: sha,
      EXPECTED_DIGEST: actualDigest,
      RELEASE_CHANNEL: 'beta',
      RECOVERY_VERSION: '',
    })
    assert.equal(manifestResult.status, 0, manifestResult.stderr)
    const packageResult = invoke(
      'package',
      [manifestPath, metadataPath, tarballPath, packageJsonPath],
      {
        EXPECTED_DIGEST: actualDigest,
      },
    )
    assert.equal(packageResult.status, 0, packageResult.stderr)
    assert.equal(JSON.parse(packageResult.stdout).digest, actualDigest)
    assert.notEqual(invoke('invalid-command').status, 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
