#!/usr/bin/env node
/**
 * check-pantheon-runtime-staged.mjs — pre-commit guard against committing
 * `.pantheon/` runtime state.
 *
 * Why: `.pantheon/*` has been ignored since v1.0, yet `ecebfbb` (2026-08-05)
 * force-added a release-audit snapshot, and the only way to remove it was a
 * history rewrite. The project decided not to rewrite history, so the class is
 * closed at the commit boundary instead: a staged runtime path is rejected
 * before it can enter a commit.
 *
 * Policy = deny-by-default under `.pantheon/`, with an allowlist **derived from
 * the `.gitignore` un-ignore rules** (never a second hand-maintained list):
 * the versioned ADR series and the `code-mode` npm payload. A path that is
 * already in `HEAD` is grandfathered (pre-existing tracked files must not break
 * `pre-commit run --all-files`), and pre-commit passes the candidate filenames
 * as argv; without argv the staged set is used.
 *
 * Exit codes: 0 = clean/grandfathered, 1 = staged runtime state.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** True for `.pantheon` itself and anything under it (exact name included). */
function isPantheonRuntimePath(path) {
  return path === '.pantheon' || path.startsWith('.pantheon/')
}

/** gitignore pattern -> RegExp (subset: `**`, `*`, trailing `/`). */
function gitignorePatternToRegExp(pattern) {
  let body = pattern
  let dirOnly = false
  if (body.endsWith('/**')) {
    body = body.slice(0, -3)
  } else if (body.endsWith('/')) {
    dirOnly = true
    body = body.slice(0, -1)
  }
  let source = ''
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]
    if (char === '*' && body[i + 1] === '*') {
      source += '.*'
      i += 1
    } else if (char === '*') {
      source += '[^/]*'
    } else if ('.+^$(){}|[]\\'.includes(char)) {
      source += `\\${char}`
    } else {
      source += char
    }
  }
  return new RegExp(`^${source}${dirOnly ? '(/.*)?' : '(/.*)?'}$`)
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function splitNull(text) {
  return text.split('\u0000').filter(Boolean)
}

const cwd = process.cwd()
const root = git(['rev-parse', '--show-toplevel'], cwd).trim()

// Allowlist derived from the repository's own un-ignore rules.
const gitignorePath = join(root, '.gitignore')
const allowPatterns = existsSync(gitignorePath)
  ? readFileSync(gitignorePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('!') && line.includes('.pantheon'))
      .map((line) => line.slice(1).replace(/^\.\//, ''))
      .map(gitignorePatternToRegExp)
  : []

const candidates =
  process.argv.length > 2
    ? process.argv.slice(2)
    : splitNull(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], root))

const tracked = new Set(splitNull(git(['ls-tree', '-r', '--name-only', '-z', 'HEAD'], root)))

const allowlisted = (path) => allowPatterns.some((pattern) => pattern.test(path))

const blocked = []
const grandfathered = []
for (const path of candidates) {
  const normalised = path.replace(/\\/g, '/')
  if (!isPantheonRuntimePath(normalised)) continue
  if (allowlisted(normalised)) continue
  if (tracked.has(normalised)) {
    grandfathered.push(normalised)
    continue
  }
  blocked.push(normalised)
}

for (const path of grandfathered) {
  console.error(
    `[pantheon-runtime-state] note: ${path} is already tracked; left alone (remove it deliberately if it is runtime state)`,
  )
}

if (blocked.length > 0) {
  console.error('[pantheon-runtime-state] refusing to commit .pantheon/ runtime state:')
  for (const path of blocked) console.error(`[pantheon-runtime-state]   - ${path}`)
  console.error(
    '[pantheon-runtime-state] .pantheon/ holds live state (ledger, board, memory DB, deepwork, session state, checkpoints).',
  )
  console.error(
    '[pantheon-runtime-state] It never belongs in history — it is ignored by .gitignore and only reappears through a force-add.',
  )
  console.error('[pantheon-runtime-state] Unstage with: git restore --staged <path>')
  console.error(
    '[pantheon-runtime-state] Versioned exceptions: .pantheon/memory-bank/adr/** and .pantheon/code-mode/** (from .gitignore un-ignore rules).',
  )
  process.exit(1)
}
