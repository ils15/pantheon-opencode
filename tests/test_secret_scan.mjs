import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { scanText, scanVersionableFiles, allowlistedFiles } from '../scripts/secret-scan.mjs'

// Pattern names built from parts (never the real secret value).
const bifrostHeader = ['x', '-bf-', 'vk'].join('')
const bifrostTokenPrefix = ['sk', '-bf-'].join('')
const apiKeyName = ['api', 'Key'].join('')
const authorizationName = ['Author', 'ization'].join('')
const dummyBifrostValue = ['sk', '-bf-', 'test-do-not-use'].join('')

// Working tree must be clean: no versionable file contains a Bifrost/API credential.
assert.deepEqual(scanVersionableFiles(), [])

// Allowlist must cover files that reference pattern NAMES (not values):
// gitleaks config and security policy document the x-bf-vk / sk-bf-* patterns.
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

// Regression: opencode.json must contain 0 occurrences of the header/prefix (masked scan).
const opencodeText = readFileSync('opencode.json', 'utf8')
assert.ok(!opencodeText.includes(bifrostHeader), 'opencode.json must not contain the Bifrost header name')
assert.ok(!opencodeText.includes(bifrostTokenPrefix), 'opencode.json must not contain the Bifrost token prefix')

console.log('✅ versionable-file secret scan passed')
