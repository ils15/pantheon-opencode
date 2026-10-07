#!/usr/bin/env node
/** Pure fail-closed validation shared by release workflows and contract tests. */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const VALIDATION_WORKFLOW = '.github/workflows/release-validation.yml'
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const BETA_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.[1-9]\d*$/
const SHA = /^[0-9a-f]{40}$/
const DIGEST = /^[0-9a-f]{64}$/

function fail(message) {
  throw new Error(message)
}

function normalizedSha(value, field) {
  const result = String(value ?? '')
    .trim()
    .toLowerCase()
  if (!SHA.test(result)) fail(`${field} must be a full 40-character hexadecimal SHA.`)
  return result
}

function positiveId(value, field) {
  const raw = String(value ?? '')
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    fail(`${field} must be a positive integer ID.`)
  }
  return Number(raw)
}

function assertDispatchPolicy({ ref, actor, triggeringActor, runAttempt }) {
  if (ref !== 'refs/heads/main') fail('Workflow dispatch is allowed only from refs/heads/main.')
  if (actor !== 'ils15') fail('Workflow dispatch actor must be ils15.')
  if (triggeringActor !== 'ils15') fail('Workflow triggering actor must be ils15.')
  if (String(runAttempt) !== '1')
    fail('Workflow must run on the first attempt; reruns are forbidden.')
}

/** Guard the destructive dist-tag operator path without reading credentials. */
export function validateOperatorDispatch(input) {
  assertDispatchPolicy(input)
  const rawTag = String(input.distTag ?? '')
  const tag = rawTag.trim()
  if (rawTag !== tag) fail('Dist-tag must not have surrounding whitespace.')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tag))
    fail('Dist-tag must be a valid 1-64 character npm tag.')
  if (tag === 'latest') fail("refusing to remove protected tag 'latest'.")
  if (tag === 'beta') fail("refusing to remove protected tag 'beta'.")
  if (input.confirm !== 'REMOVE') fail('confirm must be exactly REMOVE.')
  return tag
}

/** Validate the JSON body returned for an existing GitHub git ref. */
export function validateExistingTagRef(response) {
  if (!response || typeof response !== 'object' || !response.object) {
    fail('Existing GitHub tag response is missing its git object.')
  }
  const type = response.object.type
  if (!['commit', 'tag'].includes(type)) fail('Existing GitHub tag object type is invalid.')
  const sha = normalizedSha(response.object.sha, 'existing tag object SHA')
  return { type, sha }
}

function compareStableVersions(left, right) {
  const leftParts = left.split('.').map(BigInt)
  const rightParts = right.split('.').map(BigInt)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1
    if (leftParts[index] < rightParts[index]) return -1
  }
  return 0
}

/** Reject a stable candidate that would move the published npm latest tag back. */
export function validateStableVersionProgress({ candidateVersion, latestPublishedStable }) {
  if (typeof candidateVersion !== 'string' || !VERSION.test(candidateVersion)) {
    fail('Stable release candidate must be an exact X.Y.Z stable version.')
  }
  if (typeof latestPublishedStable !== 'string' || !VERSION.test(latestPublishedStable)) {
    fail('Could not determine the latest published stable version; refusing stable release.')
  }
  if (compareStableVersions(candidateVersion, latestPublishedStable) < 0) {
    fail(
      `Stable downgrade refused: candidate ${candidateVersion} is older than latest published stable ${latestPublishedStable}.`,
    )
  }
  return { candidateVersion, latestPublishedStable }
}

/** Validate the phase-one manual dispatch and return its normalized source SHA. */
export function validateValidationDispatch(input) {
  assertDispatchPolicy(input)
  return normalizedSha(input.sourceCommit, 'source commit')
}

/** Validate phase-two manual inputs before any API request or artifact download. */
export function validateReleaseDispatch(input) {
  assertDispatchPolicy(input)
  positiveId(input.validationRunId, 'validation run ID')
  positiveId(input.packageArtifactId, 'package artifact ID')
  positiveId(input.manifestArtifactId, 'manifest artifact ID')
  if (String(input.packageArtifactId) === String(input.manifestArtifactId)) {
    fail('Package and provenance manifest artifact IDs must be distinct.')
  }
  normalizedSha(input.sourceCommit, 'source commit')
  const digest = String(input.expectedDigest ?? '')
    .trim()
    .toLowerCase()
  if (!DIGEST.test(digest))
    fail('Expected tarball SHA-256 must be 64 lowercase hexadecimal characters.')
  if (!['stable', 'beta'].includes(input.releaseChannel))
    fail('Release channel must be stable or beta.')
  const recoveryVersion = String(input.recoveryVersion ?? '').trim()
  if (recoveryVersion && input.releaseChannel !== 'beta')
    fail('Recovery is allowed only for the beta channel.')
  if (recoveryVersion && !BETA_VERSION.test(recoveryVersion))
    fail('Invalid recovery version; expected X.Y.Z-beta.N.')
  return {
    runId: positiveId(input.validationRunId, 'validation run ID'),
    packageArtifactId: positiveId(input.packageArtifactId, 'package artifact ID'),
    manifestArtifactId: positiveId(input.manifestArtifactId, 'manifest artifact ID'),
    sourceCommit: normalizedSha(input.sourceCommit, 'source commit'),
    expectedDigest: digest,
    releaseChannel: input.releaseChannel,
    recoveryVersion,
  }
}

/** Validate GitHub REST metadata and immutable artifacts for a prior run. */
export function validateValidationRun({ run, artifacts, expected }) {
  if (!run || typeof run !== 'object') fail('Validation run metadata is missing.')
  if (Number(run.id) !== positiveId(expected.runId, 'validation run ID'))
    fail('Validation run ID does not match the requested ID.')
  const runPath = String(run.path ?? '').replace(/@refs\/heads\/main$/, '')
  if (runPath !== VALIDATION_WORKFLOW)
    fail('Validation run workflow path is not the exact release-validation workflow on main.')
  const workflowId = positiveId(run.workflow_id, 'validation workflow ID')
  if (
    expected.workflowId !== undefined &&
    Number(run.workflow_id) !== Number(expected.workflowId)
  ) {
    fail('Validation workflow ID does not match the manifest.')
  }
  if (run.head_branch !== 'main' || run.event !== 'workflow_dispatch')
    fail('Validation run must be a main-branch workflow_dispatch.')
  if (run.status !== 'completed' || run.conclusion !== 'success')
    fail('Validation run must have completed successfully.')
  if (Number(run.run_attempt) !== 1)
    fail('Validation run must be the first attempt; reruns are forbidden.')
  if (run.actor?.login !== 'ils15') fail('Validation run actor must be ils15.')
  if (run.triggering_actor?.login !== 'ils15')
    fail('Validation run triggering actor must be ils15.')
  if (run.head_repository?.full_name !== expected.repository)
    fail('Validation run repository does not match this repository.')
  normalizedSha(run.head_sha, 'validation run head SHA')

  const list = Array.isArray(artifacts) ? artifacts : artifacts?.artifacts
  if (!Array.isArray(list)) fail('Validation run artifact list is missing.')
  const packageId = positiveId(expected.packageArtifactId, 'package artifact ID')
  const manifestId = positiveId(expected.manifestArtifactId, 'manifest artifact ID')
  const packageArtifact = list.find((item) => Number(item.id) === packageId)
  const manifestArtifact = list.find((item) => Number(item.id) === manifestId)
  if (!packageArtifact || !manifestArtifact || packageArtifact === manifestArtifact) {
    fail('Expected package and manifest artifact IDs were not both found in the validation run.')
  }
  const runId = Number(run.id)
  for (const [artifact, expectedName] of [
    [packageArtifact, `release-package-${runId}`],
    [manifestArtifact, `release-provenance-${runId}`],
  ]) {
    if (artifact.expired !== false) fail('Validation artifact is missing or expired.')
    if (artifact.name !== expectedName)
      fail('Validation artifact name does not match its immutable role.')
    if (Number(artifact.workflow_run?.id) !== runId)
      fail('Artifact is not owned by the named validation run.')
  }
  return { workflowId, runId }
}

/** Validate the detached provenance manifest against all phase-two inputs. */
export function validateManifest(manifest, expected) {
  if (!manifest || typeof manifest !== 'object' || manifest.schemaVersion !== 1) {
    fail('Provenance manifest is missing or has an unsupported schema.')
  }
  const sourceCommit = normalizedSha(expected.sourceCommit, 'expected source commit')
  if (normalizedSha(manifest.sourceCommit, 'manifest source commit') !== sourceCommit) {
    fail('Provenance manifest source commit does not match the requested source SHA.')
  }
  if (manifest.workflowPath !== VALIDATION_WORKFLOW)
    fail('Provenance manifest has the wrong validation workflow path.')
  if (Number(manifest.runId) !== positiveId(expected.runId, 'validation run ID'))
    fail('Provenance manifest run ID does not match.')
  if (Number(manifest.workflowId) !== Number(expected.workflowId))
    fail('Provenance manifest workflow ID does not match.')
  const artifactId = positiveId(manifest.artifactId, 'manifest package artifact ID')
  if (artifactId !== positiveId(expected.packageArtifactId, 'package artifact ID')) {
    fail('Provenance manifest package artifact ID does not match.')
  }
  const digest = String(manifest.tarballSha256 ?? '').toLowerCase()
  if (!DIGEST.test(digest) || digest !== String(expected.expectedDigest ?? '').toLowerCase()) {
    fail('Provenance manifest tarball digest does not match the explicitly approved digest.')
  }
  const version = String(manifest.version ?? '')
  const isStable = VERSION.test(version)
  const isBeta = BETA_VERSION.test(version)
  if (!(expected.releaseChannel === 'stable' ? isStable : isBeta)) {
    fail(`Provenance version does not match the ${expected.releaseChannel} release channel.`)
  }
  if (expected.recoveryVersion && version !== expected.recoveryVersion) {
    fail('Provenance version does not match the requested recovery version.')
  }
  if (
    typeof manifest.tarball !== 'string' ||
    !/^pantheon-opencode-[A-Za-z0-9.+-]+\.tgz$/.test(manifest.tarball)
  ) {
    fail('Provenance manifest tarball filename is invalid.')
  }
  return { ...manifest, sourceCommit, version, artifactId, tarballSha256: digest }
}

/** Verify exact tarball bytes plus npm package metadata; return computed SHA-256. */
export function validatePackageEvidence({
  manifest,
  metadata,
  tarballBytes,
  packageJson,
  tarballName,
  expectedDigest,
}) {
  if (!Buffer.isBuffer(tarballBytes)) fail('Tarball bytes must be a Buffer.')
  const actualDigest = createHash('sha256').update(tarballBytes).digest('hex')
  if (actualDigest !== String(expectedDigest ?? '').toLowerCase())
    fail('Downloaded tarball digest differs from the explicitly approved digest.')
  if (actualDigest !== manifest.tarballSha256)
    fail('Downloaded tarball digest differs from the provenance manifest.')
  if (tarballName !== manifest.tarball || metadata?.tarball !== tarballName)
    fail('Tarball filename differs from package evidence.')
  if (metadata?.version !== manifest.version || metadata?.targetSha !== manifest.sourceCommit) {
    fail('Package evidence version or source SHA differs from the provenance manifest.')
  }
  if (metadata?.tarballSha256 !== actualDigest)
    fail('Package evidence digest differs from the downloaded tarball.')
  if (packageJson?.name !== 'pantheon-opencode' || packageJson?.version !== manifest.version) {
    fail('npm package name or package version differs from the validated provenance.')
  }
  return actualDigest
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function cli() {
  const [command, ...args] = process.argv.slice(2)
  const env = process.env
  const policy = {
    ref: env.GITHUB_REF,
    actor: env.GITHUB_ACTOR,
    triggeringActor: env.GITHUB_TRIGGERING_ACTOR,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
  }
  if (command === 'validation-dispatch') {
    writeJson({
      sourceCommit: validateValidationDispatch({ ...policy, sourceCommit: env.SOURCE_COMMIT }),
    })
  } else if (command === 'release-dispatch') {
    writeJson(
      validateReleaseDispatch({
        ...policy,
        validationRunId: env.VALIDATION_RUN_ID,
        packageArtifactId: env.PACKAGE_ARTIFACT_ID,
        manifestArtifactId: env.MANIFEST_ARTIFACT_ID,
        sourceCommit: env.SOURCE_COMMIT,
        expectedDigest: env.EXPECTED_DIGEST,
        releaseChannel: env.RELEASE_CHANNEL,
        recoveryVersion: env.RECOVERY_VERSION,
      }),
    )
  } else if (command === 'dist-tag-dispatch') {
    writeJson({
      distTag: validateOperatorDispatch({
        ...policy,
        distTag: env.DIST_TAG,
        confirm: env.CONFIRM,
      }),
    })
  } else if (command === 'tag-ref') {
    const result = validateExistingTagRef(readJson(args[0]))
    process.stdout.write(`${result.type}\t${result.sha}\n`)
  } else if (command === 'stable-version-check') {
    const result = validateStableVersionProgress({
      candidateVersion: env.VERSION,
      latestPublishedStable: readJson(args[0]),
    })
    writeJson(result)
  } else if (command === 'validation-run') {
    const run = readJson(args[0])
    const artifacts = readJson(args[1])
    const result = validateValidationRun({
      run,
      artifacts,
      expected: {
        runId: env.VALIDATION_RUN_ID,
        workflowId: env.EXPECTED_WORKFLOW_ID,
        packageArtifactId: env.PACKAGE_ARTIFACT_ID,
        manifestArtifactId: env.MANIFEST_ARTIFACT_ID,
        repository: env.GITHUB_REPOSITORY,
      },
    })
    writeJson(result)
  } else if (command === 'manifest') {
    const result = validateManifest(readJson(args[0]), {
      runId: env.VALIDATION_RUN_ID,
      workflowId: env.EXPECTED_WORKFLOW_ID,
      packageArtifactId: env.PACKAGE_ARTIFACT_ID,
      sourceCommit: env.SOURCE_COMMIT,
      expectedDigest: env.EXPECTED_DIGEST,
      releaseChannel: env.RELEASE_CHANNEL,
      recoveryVersion: env.RECOVERY_VERSION,
    })
    writeJson(result)
  } else if (command === 'package') {
    const manifest = readJson(args[0])
    const metadata = readJson(args[1])
    const tarballPath = args[2]
    const packageJson = readJson(args[3])
    const digest = validatePackageEvidence({
      manifest,
      metadata,
      tarballBytes: readFileSync(tarballPath),
      packageJson,
      tarballName: tarballPath.split('/').at(-1),
      expectedDigest: env.EXPECTED_DIGEST,
    })
    writeJson({ digest, version: manifest.version, tarball: tarballPath })
  } else {
    fail(
      'Usage: release-guard.mjs <validation-dispatch|release-dispatch|dist-tag-dispatch|tag-ref|stable-version-check|validation-run|manifest|package> [files...]',
    )
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    cli()
  } catch (error) {
    console.error(`release-guard: ${error.message}`)
    process.exitCode = 1
  }
}
