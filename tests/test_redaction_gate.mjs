import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = 'scripts/redaction-gate.mjs'
const dir = mkdtempSync(join(tmpdir(), 'pantheon-redaction-'))
const clean = join(dir, 'clean.txt')
const callback = join(dir, 'callback.txt')
const token = join(dir, 'token.txt')
writeFileSync(clean, 'callback_url=[REDACTED] token=<redacted>')
writeFileSync(callback, 'redirect_uri=https://example.invalid/callback?code=fixture')
writeFileSync(token, 'Authorization: Bearer abcdefghijklmnop')

const run = (path) => {
  try {
    execFileSync(process.execPath, [script, path], { encoding: 'utf8', stdio: 'pipe' })
    return 0
  } catch (error) {
    return error.status
  }
}

assert.equal(run(clean), 0)
assert.equal(run(callback), 1)
assert.equal(run(token), 1)
console.log('✅ redaction gate contract passed')
