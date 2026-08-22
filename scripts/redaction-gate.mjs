#!/usr/bin/env node

/** Fail closed when validation artifacts contain callback URLs or credentials. */

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const callbackUrl = /https?:\/\/[^\s"'<>]+(?:callback|redirect|return|webhook)[^\s"'<>]*/iu
const bearer = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/u
const jwt = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u
const apiSecret =
  /\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*["'](?!\$\{|process\.env|os\.getenv|env:|<redacted>|\[redacted\]|fixture)[^"']{12,}["']/iu

function isText(buffer) {
  return !buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0)
}

function findings(text) {
  const result = []
  if (callbackUrl.test(text)) result.push('callback URL')
  if (bearer.test(text) || jwt.test(text) || apiSecret.test(text)) result.push('credential/token')
  return result
}

function scanFile(path) {
  if (!existsSync(path) || !lstatSync(path).isFile()) return []
  const content = readFileSync(path)
  return isText(content) ? findings(content.toString('utf8')) : []
}

function scanTarball(path) {
  const entries = execFileSync('tar', ['-tzf', path], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  const result = []
  for (const entry of entries) {
    const content = execFileSync('tar', ['-xOzf', path, entry])
    if (isText(content)) result.push(...findings(content.toString('utf8')))
  }
  return [...new Set(result)]
}

function scanPath(path) {
  if (path.endsWith('.tgz') || path.endsWith('.tar.gz')) return scanTarball(path)
  if (!existsSync(path)) throw new Error(`path does not exist: ${path}`)
  if (lstatSync(path).isDirectory()) {
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
      scanPath(join(path, entry.name)),
    )
  }
  return scanFile(path)
}

const paths = process.argv.slice(2)
if (paths.length === 0) {
  console.error(`Usage: ${basename(process.argv[1])} <file|directory|tarball> [...]`)
  process.exit(2)
}

try {
  const hits = [...new Set(paths.flatMap(scanPath))]
  if (hits.length > 0) {
    for (const hit of hits) console.error(`[REDACTION GATE] ${hit} detected`)
    process.exit(1)
  }
  console.log('Redaction gate passed: no callback URLs or credentials detected.')
} catch (error) {
  console.error(`[REDACTION GATE] failed to inspect input: ${error.message}`)
  process.exit(2)
}
