import { strict as assert } from 'node:assert'
import { allowlistedFiles, scanText, scanVersionableFiles } from '../scripts/secret-scan.mjs'

// Pattern names built from parts (never the real secret value).
const bifrostHeader = ['x', '-bf-', 'vk'].join('')
const apiKeyName = ['api', 'Key'].join('')
const authorizationName = ['Author', 'ization'].join('')
const dummyBifrostValue = ['sk', '-bf-', 'test-do-not-use'].join('')

// Working tree must be clean: no versionable file contains a Bifrost/API credential.
assert.deepEqual(scanVersionableFiles(), [])

// Allowlist must cover files that reference provider credential pattern names
// (not values): gitleaks config and the security policy document them.
for (const file of ['.gitleaks.toml', 'SECURITY.md']) {
  assert.ok(allowlistedFiles.has(file), `${file} must be allowlisted`)
}

// Scan must flag a test dummy occurrence of the Bifrost header name.
assert.ok(scanText(`headers: { "${bifrostHeader}": "<redacted>" }`, 'fixture').length > 0)

// Scan must flag a test dummy occurrence of the Bifrost token value pattern.
assert.ok(scanText(`token: ${dummyBifrostValue}`, 'fixture').length > 0)

// Sanity: scan also flags the generic API key / bearer patterns.
assert.ok(scanText(`"${apiKeyName}": "fixture-api-key-value"`, 'fixture').length > 0)
assert.ok(scanText(`"${authorizationName}": "Bearer fixture-bearer-value"`, 'fixture').length > 0)

// Regression guard for the Bifrost header/prefix: scanVersionableFiles()
// asserted above is the real guard — it scans EVERY versionable file, so a
// per-file assertion was a manual duplicate of it.

console.log('✅ versionable-file secret scan passed')
