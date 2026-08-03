#!/usr/bin/env node

/** Scan versionable files without printing secret values. */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const bifrostHeader = ['x', '-bf-', 'vk'].join('')
const bifrostTokenPrefix = ['sk', '-bf-'].join('')
const apiKeyName = ['api', 'Key'].join('')
const authorizationName = ['Author', 'ization'].join('')

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const patterns = [
  { label: 'Bifrost credential header', regex: new RegExp(escapeRegExp(bifrostHeader), 'i') },
  {
    label: 'Bifrost credential value',
    regex: new RegExp(`${escapeRegExp(bifrostTokenPrefix)}[A-Za-z0-9_-]{8,}`, 'i'),
  },
  {
    label: 'literal API key value',
    regex: new RegExp(
      `["']${escapeRegExp(apiKeyName)}["']\\s*[:=]\\s*["'](?!\\$\\{|process\\.env|os\\.getenv|env:)[^"']{12,}["']`,
      'i',
    ),
  },
  {
    label: 'literal Authorization bearer value',
    regex: new RegExp(
      `["']${escapeRegExp(authorizationName)}["']\\s*[:=]\\s*["']Bearer\\s+[A-Za-z0-9._-]{12,}["']`,
      'i',
    ),
  },
]

export function scanText(text, file = '<text>') {
  return patterns.filter(({ regex }) => regex.test(text)).map(({ label }) => ({ file, label }))
}

export function versionableFiles() {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'buffer',
  })
    .toString()
    .split('\0')
    .filter(Boolean)
}

export function scanVersionableFiles() {
  const findings = []
  for (const file of versionableFiles()) {
    let text
    try {
      const content = readFileSync(file)
      if (content.includes(0)) continue
      text = content.toString('utf8')
    } catch {
      continue
    }
    findings.push(...scanText(text, file))
  }
  return findings
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const findings = scanVersionableFiles()
  if (findings.length > 0) {
    for (const finding of findings) console.error(`[SECRET SCAN] ${finding.file}: ${finding.label}`)
    process.exitCode = 1
  } else {
    console.log('Secret scan passed: no versionable Bifrost/API credentials detected.')
  }
}
