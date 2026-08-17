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
    current = objects.tag[current.sha]
  }
  return current?.type === 'commit' ? current.sha : null
}

test('beta trigger requires the exact release:beta label', () => {
  assert.ok(
    workflow.includes(
      "github.event_name == 'pull_request' && github.event.label.name == 'release:beta'",
    ),
  )
  assert.doesNotMatch(workflow, /startsWith\(github\.event\.label\.name/)
  assert.match(workflow, /RELEASE_LABEL: \$\{\{ github\.event\.label\.name \}\}/)
})

test('ordinary pushes cannot start a release and stable remains explicit', () => {
  assert.doesNotMatch(workflow, /^\s*push:/m)
  assert.doesNotMatch(workflow, /github\.event_name\s*==\s*['"]push['"]\s*&&/)
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/)
  assert.match(workflow, /node scripts\/version-check\.mjs/)
  assert.match(workflow, /Existing tag does not point to TARGET_SHA/)
  assert.match(workflow, /--target "\$TARGET_SHA"/)
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
    /TARGET_SHA: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
  )
  assert.match(release, /gh release create[\s\S]*--target "\$TARGET_SHA"/)
  const publish = release.indexOf('- name: Publish immutable artifact to npm')
  assert.ok(publish > 0)
  assert.equal(release.slice(publish).match(/actions\/checkout|npm ci|npm install/g), null)
})

test('validation, artifact, and release use one immutable event target SHA', () => {
  assert.doesNotMatch(workflow, /CHECKOUT_REF|\|\| 'main'/)
  const targetExpression =
    'TARGET_SHA: $' +
    "{{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}"
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
  assert.match(workflow, /npm view pantheon-opencode version --tag "\$RELEASE_TAG" --json/)
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

test('stable and beta preserve TARGET_SHA provenance through tag, release, and artifact', () => {
  const targetExpression =
    'TARGET_SHA: $' +
    "{{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}"
  assert.equal(workflow.split(targetExpression).length - 1, 2)
  assert.match(workflow, /printf '%s\\n' "\$TARGET_SHA" > .*target-sha/)
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
    tag: { ['b'.repeat(40)]: { type: 'commit', sha: target } },
  }
  const mismatched = { ref: { 'v1.0.2': { type: 'commit', sha: 'c'.repeat(40) } }, tag: {} }
  assert.equal(resolveTagCommit('v1.0.0', matching), target)
  assert.equal(resolveTagCommit('v1.0.1', annotated), target)
  assert.equal(resolveTagCommit('v1.0.2', mismatched), 'c'.repeat(40))
  assert.notEqual(resolveTagCommit('v1.0.2', mismatched), target)
  assert.match(workflow, /Existing tag does not point to TARGET_SHA/)
  assert.match(workflow, /Could not determine whether release tag exists/)
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
