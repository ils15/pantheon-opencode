import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const WORKFLOW = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url))
const workflow = readFileSync(WORKFLOW, 'utf8')

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
  if (!/^v\d+\.\d+\.\d+-beta\.\d+\.[0-9a-f]{7}$/.test(tagRef)) return null
  return `repos/${repo}/git/ref/tags/${tagRef}`
}

function validateRecoveryInputs({ version = '', sha = '', pr = '' }) {
  const supplied = [version, sha, pr].filter(Boolean).length
  if (supplied !== 0 && supplied !== 3) return false
  if (!supplied) return true
  const match = /^(\d+\.\d+\.\d+)-beta\.(\d+)\.([0-9a-f]{7})$/.exec(version)
  return (
    match !== null &&
    /^[0-9a-fA-F]{40}$/.test(sha) &&
    /^\d+$/.test(pr) &&
    Number.isSafeInteger(Number(pr)) &&
    Number(pr) > 0 &&
    match[2] === pr &&
    match[3] === sha.slice(0, 7).toLowerCase()
  )
}

function recoveryNpmAction(npmVersion, requestedVersion) {
  return npmVersion === requestedVersion ? 'skip' : 'publish'
}

function tagApiOutcome(status, resolvedSha, targetSha) {
  if (status !== 200) return 'fail-closed'
  return resolvedSha === targetSha ? 'match' : 'mismatch'
}

function dispatchReleaseTag({ eventName, recoveryVersion = '' }) {
  return recoveryVersion !== '' || eventName === 'pull_request' ? 'beta' : 'latest'
}

test('beta trigger requires the exact release:beta label', () => {
  assert.ok(
    workflow.includes(
      "github.event_name == 'pull_request' && github.event.label.name == 'release:beta'",
    ),
  )
  assert.doesNotMatch(workflow, /startsWith\(github\.event\.label\.name/)
  assert.match(workflow, /RELEASE_LABEL: \$\{\{ github\.event\.label\.name \}\}/)
  assert.doesNotMatch(workflow, /release:beta:(?:minor|major)/)
  const releaseDocs = readFileSync(
    fileURLToPath(new URL('../docs/RELEASE.md', import.meta.url)),
    'utf8',
  )
  const releasingDocs = readFileSync(
    fileURLToPath(new URL('../docs/RELEASING.md', import.meta.url)),
    'utf8',
  )
  const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8')
  for (const docs of [releaseDocs, releasingDocs, readme]) {
    assert.doesNotMatch(docs, /release:beta:(?:minor|major)/)
    assert.match(docs, /release:beta/)
  }
  assert.match(releaseDocs, /único label que dispara o beta é exatamente `release:beta`/)
  assert.match(releasingDocs, /Only the exact `release:beta` label triggers this path/)
})

test('ordinary pushes cannot start a release and stable remains explicit', () => {
  assert.doesNotMatch(workflow, /^\s*push:/m)
  assert.doesNotMatch(workflow, /github\.event_name\s*==\s*['"]push['"]\s*&&/)
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/)
  assert.match(workflow, /node scripts\/version-check\.mjs/)
  assert.match(workflow, /Existing tag does not point to TARGET_SHA/)
  assert.match(workflow, /--target "\$TARGET_SHA"/)
})

test('recovery inputs are optional but all-or-nothing and strictly validated', () => {
  const sha = 'c75b04dd6e361c9e56be8c49dbb82c3d260e256b'
  assert.equal(validateRecoveryInputs({}), true)
  assert.equal(validateRecoveryInputs({ version: '1.3.5-beta.52.c75b04d' }), false)
  assert.equal(validateRecoveryInputs({ version: '1.3.5-beta.52.c75b04d', sha, pr: '52' }), true)
  for (const input of [
    { version: 'v1.3.5-beta.52.c75b04d', sha, pr: '52' },
    { version: '1.3.5', sha, pr: '52' },
    { version: '1.3.5-beta.52.deadbee', sha, pr: '52' },
    { version: '1.3.5-beta.51.c75b04d', sha, pr: '52' },
    { version: '1.3.5-beta.52.c75b04', sha, pr: '52' },
    { version: '1.3.5-beta.52.C75B04D', sha, pr: '52' },
    { version: '1.3.5-beta.52.$(touch /tmp/pwned)', sha, pr: '52' },
    { version: '1.3.5-beta.52.c75b04d', sha: 'x'.repeat(40), pr: '52' },
    { version: '1.3.5-beta.52.c75b04d', sha, pr: '0' },
    { version: '1.3.5-beta.52.c75b04d', sha, pr: '9007199254740992' },
  ])
    assert.equal(validateRecoveryInputs(input), false)
  assert.match(workflow, /Recovery inputs must be supplied together/)
  assert.match(workflow, /Recovery version must be <base>-beta\.<pr>\.<7-char-lowercase-sha>/)
  assert.match(workflow, /Recovery target SHA must be a full 40-hex SHA/)
  assert.match(workflow, /Recovery version SHA suffix must match recovery_target_sha/)
  assert.match(workflow, /release-beta-version\.mjs/)
})

test('recovery pair validation is before checkout, build, tag, release, npm, and credentials', () => {
  const firstValidation = workflow.indexOf('Validate release inputs before checkout')
  const checkout = workflow.indexOf('actions/checkout')
  const secondValidation = workflow.indexOf('Revalidate release inputs before mutations')
  const firstMutation = Math.min(
    workflow.indexOf('gh api --method POST'),
    workflow.indexOf('gh release create'),
    workflow.indexOf('npm publish'),
  )
  assert.ok(firstValidation < checkout)
  assert.ok(secondValidation < firstMutation)
  assert.ok(workflow.lastIndexOf('NODE_AUTH_TOKEN:') > firstMutation)
})

test('recovery uses the GitHub API tag ref without checkout or git ls-remote', () => {
  assert.equal(
    recoveryTagApiPath('owner/repo', 'v1.3.5-beta.52.c75b04d'),
    'repos/owner/repo/git/ref/tags/v1.3.5-beta.52.c75b04d',
  )
  assert.equal(recoveryTagApiPath('owner/repo', 'refs/tags/evil'), null)
  assert.equal(recoveryTagApiPath('owner;evil/repo', 'v1.3.5-beta.52.c75b04d'), null)
  assert.doesNotMatch(workflow, /git\s+ls-remote/)
  assert.match(workflow, /gh api "repos\/\$RELEASE_REPO\/git\/ref\/tags\/\$TAG_REF"/)
  assert.match(workflow, /RELEASE_REPO must be an owner\/name GitHub repository/)
  assert.match(workflow, /Release tag ref is invalid/)
  assert.match(workflow, /Recovery tag does not point to recovery target SHA/)
  assert.match(
    workflow,
    /TARGET_SHA=\$\(printf '%s' "\$TARGET_SHA" \| tr '\[:upper:\]' '\[:lower:\]'\)/,
  )
})

test('recovery is release-preserving, fail-closed, and npm-idempotent', () => {
  assert.equal(
    resolveTagCommit('v1.0.0', {
      ref: { 'v1.0.0': { type: 'commit', sha: 'a'.repeat(40) } },
      tag: {},
    }),
    'a'.repeat(40),
  )
  assert.equal(recoveryNpmAction('1.3.5-beta.52.c75b04d', '1.3.5-beta.52.c75b04d'), 'skip')
  assert.equal(recoveryNpmAction(null, '1.3.5-beta.52.c75b04d'), 'publish')
  assert.match(workflow, /Recovery requires the existing GitHub Release; it will not create one/)
  assert.match(workflow, /Could not determine whether GitHub release exists/)
  assert.match(workflow, /npm view "pantheon-opencode@\$\{VERSION#v\}" version --json/)
  assert.match(workflow, /npm view pantheon-opencode version --tag "\$RELEASE_TAG" --json/)
  assert.match(workflow, /inputs\.recovery_version == ''/)
})

test('tag API errors and SHA mismatches cannot enter recovery mutations', () => {
  const target = 'a'.repeat(40)
  assert.equal(tagApiOutcome(200, target, target), 'match')
  assert.equal(tagApiOutcome(200, 'b'.repeat(40), target), 'mismatch')
  assert.equal(tagApiOutcome(404, null, target), 'fail-closed')
  assert.equal(tagApiOutcome(500, null, target), 'fail-closed')
  assert.match(workflow, /Could not determine whether release tag exists/)
  assert.match(workflow, /if \[ "\$STATUS" = 404 \]; then/)
  assert.match(workflow, /else[\s\S]*Could not determine whether release tag exists/)
})

test('recovery workflow_dispatch is always beta while stable dispatch is latest', () => {
  assert.equal(
    dispatchReleaseTag({
      eventName: 'workflow_dispatch',
      recoveryVersion: '1.3.5-beta.52.c75b04d',
    }),
    'beta',
  )
  assert.equal(dispatchReleaseTag({ eventName: 'workflow_dispatch' }), 'latest')

  const release = workflow.slice(workflow.indexOf('  release:'))
  const recoveryFirstExpression =
    /inputs\.recovery_version != '' && 'beta' \|\| github\.event_name == 'pull_request' && 'beta' \|\| 'latest'/
  assert.equal((release.match(new RegExp(recoveryFirstExpression.source, 'g')) ?? []).length, 3)
  assert.doesNotMatch(
    release,
    /RELEASE_(?:TAG|CHANNEL): \$\{\{ github\.event_name == 'pull_request' && 'beta' \|\| 'latest'/,
  )
  assert.match(release, /npm publish "\$PACKAGE" --ignore-scripts --tag "\$RELEASE_TAG"/)
})

test('beta uses published npm latest and does not consult the current version tag gate', () => {
  const betaSection = workflow.slice(
    workflow.indexOf('- name: Query published stable version'),
    workflow.indexOf('- name: Validate release manifests'),
  )
  assert.match(betaSection, /npm view pantheon-opencode dist-tags\.latest/)
  assert.match(betaSection, /scripts\/release-beta-version\.mjs/)
  assert.doesNotMatch(betaSection, /git tag -l/)
  assert.doesNotMatch(betaSection, /Existing tag does not point to TARGET_SHA/)
})

test('validation and release are separate least-privilege jobs', () => {
  assert.ok(workflow.includes('jobs:\n  validate:'))
  assert.ok(workflow.includes('  release:\n    needs: validate'))
  assert.ok(workflow.includes('contents: read\n      pull-requests: read'))
  assert.ok(workflow.includes('contents: write\n      id-token: write'))
  assert.doesNotMatch(workflow.slice(workflow.indexOf('  release:')), /actions\/checkout/)
})

test('untrusted validation installation cannot enable lifecycle scripts or fall back', () => {
  assert.match(workflow, /npm ci --ignore-scripts/)
  assert.doesNotMatch(workflow, /npm ci[^\n]*\|\|\s*npm install/)
  assert.doesNotMatch(workflow, /run:\s+npm install(\s|$)/)
  assert.match(workflow, /npm pack --ignore-scripts/)
  assert.match(workflow, /npm publish .*--ignore-scripts/)
})

test('PR numbers accept only positive safe integers', () => {
  for (const value of ['1', '0009', '9007199254740991']) {
    assert.equal(validatePrNumber(value), true, value)
  }
  for (const value of [
    '',
    '0',
    '-1',
    '1.5',
    '1e3',
    'abc',
    '9007199254740992',
    '1;gh release delete v1.0.0',
  ]) {
    assert.equal(validatePrNumber(value), false, value)
  }
  assert.match(workflow, /Number\.isSafeInteger\(value\)/)
  assert.match(workflow, /value <= 0/)
})

test('PR validation is before every release mutation and publish credential', () => {
  const validation = workflow.indexOf('Revalidate release inputs before mutations')
  const firstMutation = Math.min(
    workflow.indexOf('gh api --method POST'),
    workflow.indexOf('gh release create'),
    workflow.indexOf('npm publish'),
  )
  const token = workflow.lastIndexOf('NODE_AUTH_TOKEN:')
  assert.ok(validation >= 0)
  assert.ok(firstMutation > validation)
  assert.ok(token > firstMutation)
  assert.equal(workflow.lastIndexOf('NODE_AUTH_TOKEN:'), token)
  assert.match(workflow, /PR_NUMBER="\$PR_NUMBER" node <<'NODE'/)
})

test('release consumes an immutable artifact and never executes PR code after token exposure', () => {
  const release = workflow.slice(workflow.indexOf('  release:'))
  assert.match(release, /actions\/download-artifact@v4/)
  assert.match(
    release,
    /TARGET_SHA: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.recovery_target_sha \|\| github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
  )
  assert.match(release, /gh release create[\s\S]*--target "\$TARGET_SHA"/)
  const publish = release.indexOf('- name: Publish immutable artifact to npm')
  assert.ok(publish > 0)
  assert.equal(release.slice(publish).match(/actions\/checkout|npm ci|npm install/g), null)
})

test('npm publish receives an explicit local, validated npm pack tarball', () => {
  const metadata = workflow.slice(
    workflow.indexOf('- name: Validate immutable artifact metadata'),
    workflow.indexOf(
      '- uses: actions/setup-node@v4',
      workflow.indexOf('- name: Validate immutable artifact metadata'),
    ),
  )
  const publish = workflow.slice(workflow.indexOf('- name: Publish immutable artifact to npm'))

  assert.match(metadata, /PACKAGE_REL=\$\(find release-artifact .* -name '\*\.tgz'/)
  assert.match(metadata, /PACKAGE=\$\(realpath -- "\$PACKAGE_REL"\)/)
  assert.match(metadata, /tar -tzf "\$PACKAGE"/)
  assert.match(metadata, /package\/package\.json/)
  assert.match(metadata, /packageJson\.name !== 'pantheon-opencode'/)
  assert.match(metadata, /packageJson\.version !== process\.env\.ARTIFACT_VERSION/)
  assert.match(publish, /npm publish "\$PACKAGE" --ignore-scripts/)
  assert.doesNotMatch(publish, /npm publish "?release-artifact\//)
})

test('release npm auth is configured for the public registry without exposing secrets', () => {
  const release = workflow.slice(workflow.indexOf('  release:'))
  const publish = release.slice(release.indexOf('- name: Publish immutable artifact to npm'))
  const setupNode = release.slice(0, release.indexOf('- name: Publish immutable artifact to npm'))

  assert.match(
    setupNode,
    /- uses: actions\/setup-node@v4[\s\S]*registry-url: https:\/\/registry\.npmjs\.org/,
  )
  assert.match(publish, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/)
  assert.match(publish, /npm publish "\$PACKAGE"[\s\S]*--registry https:\/\/registry\.npmjs\.org/)
  assert.doesNotMatch(publish, /(?:NPM_TOKEN|NODE_AUTH_TOKEN)\s*[:=]\s*['"][^$]/)
  assert.doesNotMatch(publish, /secrets\.[A-Z_]+\s*\|\|/)
})

test('validation, artifact, and release use one immutable event target SHA', () => {
  assert.doesNotMatch(workflow, /CHECKOUT_REF|\|\| 'main'/)
  const targetExpression =
    'TARGET_SHA: $' +
    "{{ github.event_name == 'workflow_dispatch' && inputs.recovery_target_sha || github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}"
  assert.equal(workflow.split(targetExpression).length - 1, 2)
  assert.match(workflow, /ref: \$\{\{ env\.TARGET_SHA \}\}/)
  assert.match(workflow, /target-sha/)
  assert.match(workflow, /ARTIFACT_SHA=.*release-artifact\/target-sha/)
  assert.match(workflow, /\[ "\$ARTIFACT_SHA" = "\$TARGET_SHA" \]/)
  assert.match(workflow, /-f "sha=\$TARGET_SHA"/)
  assert.match(workflow, /--target "\$TARGET_SHA"/)
})

test('stable and beta validate every manifest before release work', () => {
  assert.match(
    workflow,
    /- name: Validate release manifests[\s\S]*run: node scripts\/version-check\.mjs/,
  )
  const beta = workflow.slice(
    workflow.indexOf('- name: Compute and apply beta version'),
    workflow.indexOf('- name: Validate release manifests'),
  )
  assert.doesNotMatch(beta, /node scripts\/version-check\.mjs/)
  const validation = workflow.indexOf('- name: Validate release manifests')
  const artifact = workflow.indexOf('- name: Create release artifact and notes')
  assert.ok(validation > workflow.indexOf('- name: Determine release type'))
  assert.ok(validation < artifact)
})

test('metadata lookups distinguish confirmed absence from uncertainty and fail closed', () => {
  assert.match(workflow, /gh api --include "repos\/\$RELEASE_REPO\/releases\/tags\/\$VERSION"/)
  assert.match(workflow, /STATUS=\$\(awk/)
  assert.match(workflow, /RELEASE_RESPONSE=.*release-response/)
  assert.match(workflow, /Could not determine whether GitHub release exists/)
  assert.match(workflow, /npm view "pantheon-opencode@\$\{VERSION#v\}" version --json/)
  assert.match(
    workflow,
    /npm view pantheon-opencode dist-tags\.latest --json > "\$LATEST_RESPONSE"/,
  )
  assert.match(
    workflow,
    /Could not determine published npm metadata; refusing to compute a beta version/,
  )
  assert.match(workflow, /Could not determine npm package metadata; refusing to mutate or publish/)
  assert.match(workflow, /E404\|404\[\[:space:\]\]\+Not Found\|code\[\[:space:\]\]\+E404/)
  assert.match(workflow, /Existing GitHub release is not bound to VERSION and TARGET_SHA/)
})

test('release creation is repository-explicit and safe to rerun after an existing tag', () => {
  const createStep = workflow.slice(
    workflow.indexOf('- name: Create GitHub release'),
    workflow.indexOf('- name: Publish immutable artifact to npm'),
  )
  const createCommands = createStep.match(/gh release create[^\n]+/g) ?? []

  assert.equal(createCommands.length, 2)
  for (const command of createCommands) {
    assert.match(command, /--repo "\$RELEASE_REPO"/)
    assert.match(command, /--verify-tag/)
  }
  assert.match(createStep, /if: steps\.idem\.outputs\.released != 'true'/)
  assert.match(workflow, /echo 'tag_exists=true' >> "\$GITHUB_OUTPUT"/)
  assert.match(workflow, /echo 'released=false' >> "\$GITHUB_OUTPUT"/)
  assert.match(workflow, /if \[ "\$STATUS" = 404 \]; then[\s\S]*echo 'released=false'/)
  assert.match(
    workflow,
    /if: steps\.idem\.outputs\.released != 'true' && steps\.idem\.outputs\.tag_exists != 'true'/,
  )
  assert.match(workflow, /if: steps\.idem\.outputs\.npm_exists != 'true'/)
})

test('stable and beta preserve TARGET_SHA provenance through tag, release, and artifact', () => {
  const targetExpression =
    'TARGET_SHA: $' +
    "{{ github.event_name == 'workflow_dispatch' && inputs.recovery_target_sha || github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}"
  assert.equal(workflow.split(targetExpression).length - 1, 2)
  assert.match(
    workflow,
    /printf '%s\\n' "\$TARGET_SHA" \| tr '\[:upper:\]' '\[:lower:\]' > .*target-sha/,
  )
  assert.match(workflow, /\[ "\$ARTIFACT_SHA" = "\$TARGET_SHA" \]/)
  assert.match(workflow, /-f "sha=\$TARGET_SHA"/)
  assert.match(workflow, /--target "\$TARGET_SHA"/)
  assert.match(workflow, /release\.target_commitish !== process\.env\.TARGET_SHA/)
  assert.match(workflow, /npm publish .*--provenance/)
})

test('existing lightweight and annotated tags must resolve to TARGET_SHA', () => {
  const target = 'a'.repeat(40)
  const matching = { ref: { 'v1.0.0': { type: 'commit', sha: target } }, tag: {} }
  const annotated = {
    ref: { 'v1.0.1': { type: 'tag', sha: 'b'.repeat(40) } },
    tag: { ['b'.repeat(40)]: { object: { type: 'commit', sha: target } } },
  }
  const mismatched = { ref: { 'v1.0.2': { type: 'commit', sha: 'c'.repeat(40) } }, tag: {} }
  assert.equal(resolveTagCommit('v1.0.0', matching), target)
  assert.equal(resolveTagCommit('v1.0.1', annotated), target)
  assert.equal(resolveTagCommit('v1.0.2', mismatched), 'c'.repeat(40))
  assert.notEqual(resolveTagCommit('v1.0.2', mismatched), target)
  assert.match(workflow, /Existing tag does not point to TARGET_SHA/)
  assert.match(workflow, /Could not determine whether release tag exists/)
  assert.match(workflow, /Could not resolve annotated tag object/)
  assert.match(workflow, /TAG_OBJECT_SHA.*TARGET_SHA/)
  const normalizedTarget = 'a'.repeat(40)
  assert.equal(normalizeSha(`  ${normalizedTarget.toUpperCase()}\n`), normalizedTarget)
  assert.equal(normalizeSha(normalizedTarget), normalizedTarget)
  assert.equal(normalizeSha('a'.repeat(39)), null)
  assert.equal(normalizeSha(`${normalizedTarget}x`), null)
  assert.match(workflow, /String\(object\.sha \?\? ''\)\.trim\(\)\.toLowerCase\(\)/)
  assert.match(workflow, /process\.stdout\.write\(`\$\{object\.type\}\\t\$\{sha\}`\)/)
})

test('hostile refs and SHAs are rejected before release operations', () => {
  for (const value of [
    '',
    'refs/tags/v1;gh release delete v1.0.0',
    '$(touch /tmp/pwned)',
    'a'.repeat(39),
    'g'.repeat(40),
  ]) {
    assert.doesNotMatch(value, /^[0-9a-fA-F]{40}$/)
  }
  assert.match(workflow, /case "\$TARGET_SHA" in ''\|\*\[!0-9a-fA-F\]\*\)/)
  assert.match(workflow, /\[ "\$\{#TARGET_SHA\}" -eq 40 \]/)
  assert.match(workflow, /TAG_REF="\$VERSION"/)
})

test('validation job has no release credential injection and asserts a clean environment', () => {
  const validation = workflow.slice(workflow.indexOf('  validate:'), workflow.indexOf('  release:'))
  assert.doesNotMatch(validation, /secrets\./)
  assert.match(validation, /NODE_AUTH_TOKEN:-\}/)
  assert.match(validation, /NPM_TOKEN:-\}/)
  assert.match(validation, /RELEASE_TOKEN:-\}/)
  assert.doesNotMatch(validation, /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\./)
})
