import { strict as assert } from 'node:assert'
import { scanText, scanVersionableFiles } from '../scripts/secret-scan.mjs'

const bifrostHeader = ['x', '-bf-', 'vk'].join('')
const bifrostTokenPrefix = ['sk', '-bf-'].join('')
const apiKeyName = ['api', 'Key'].join('')
const authorizationName = ['Author', 'ization'].join('')

assert.deepEqual(scanVersionableFiles(), [])
assert.ok(scanText(`header: ${bifrostHeader}`, 'fixture').length > 0)
assert.ok(scanText(`token: ${bifrostTokenPrefix}fixture-value`, 'fixture').length > 0)
assert.ok(scanText(`"${apiKeyName}": "fixture-api-key-value"`, 'fixture').length > 0)
assert.ok(scanText(`"${authorizationName}": "Bearer fixture-bearer-value"`, 'fixture').length > 0)

console.log('✅ versionable-file secret scan passed')
