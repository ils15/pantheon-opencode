/**
 * Shell-write path extraction & file-lease enforcement (`shell-write-guard.ts`).
 *
 * Extracts target file paths from POSIX shell, PowerShell, and cmd commands
 * (`>`, `>>`, `tee`, `sed -i`, `cp`, `mv`, `rm`, `touch`, `Set-Content`,
 * `Out-File`, `Add-Content`, `Remove-Item`, nested `bash -c`/`sh -c`/`cmd /c`)
 * and validates them against `checkFileLease`.
 *
 * @module pantheon/shell-write-guard
 */

import { checkFileLease, type FileLeaseCheckResult, getFileLease } from './file-leases.ts'

type TokenKind = 'word' | 'redir' | 'sep'

interface ShellToken {
  readonly kind: TokenKind
  readonly value: string
  readonly quoted: boolean
}

const REDIR_PREFIXES = ['1>>', '2>>', '&>>', '1>', '2>', '&>', '>>', '>|', '<>', '>'] as const
const IGNORED_TARGETS = new Set(['/dev/null', 'nul'])
const SUBSHELL_RUNNERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd'])
const POWERSHELL_WRITE_CMDS = new Set(['set-content', 'out-file', 'add-content', 'remove-item'])

function isSeparatorChar(ch: string): boolean {
  return ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '\r'
}

function matchRedirAt(cmd: string, idx: number): string | undefined {
  for (const op of REDIR_PREFIXES) {
    if (cmd.startsWith(op, idx)) return op
  }
  return undefined
}

/**
 * Quote-aware shell tokenizer splitting words, redirections, and command separators.
 */
function tokenizeShellCommand(command: string): ShellToken[] {
  const tokens: ShellToken[] = []
  let i = 0
  const len = command.length

  while (i < len) {
    const ch = command[i] ?? ''
    if (ch === ' ' || ch === '\t') {
      i++
      continue
    }

    if (isSeparatorChar(ch)) {
      const next = command[i + 1] ?? ''
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
        tokens.push({ kind: 'sep', value: ch + next, quoted: false })
        i += 2
      } else if (ch === '&' && command.slice(i, i + 2) === '&>') {
        // Handled by redir below
      } else {
        tokens.push({ kind: 'sep', value: ch, quoted: false })
        i++
        continue
      }
      if (ch !== '&' || next === '&') continue
    }

    const redir = matchRedirAt(command, i)
    if (redir !== undefined) {
      tokens.push({ kind: 'redir', value: redir, quoted: false })
      i += redir.length
      continue
    }

    let word = ''
    let quoted = false
    let hasContent = false

    while (i < len) {
      const c = command[i] ?? ''
      if (c === ' ' || c === '\t' || isSeparatorChar(c)) break
      if (matchRedirAt(command, i) !== undefined) break

      if (c === "'") {
        quoted = true
        hasContent = true
        i++
        while (i < len && command[i] !== "'") {
          word += command[i] ?? ''
          i++
        }
        if (i < len && command[i] === "'") i++
        continue
      }

      if (c === '"') {
        quoted = true
        hasContent = true
        i++
        while (i < len && command[i] !== '"') {
          const inner = command[i] ?? ''
          if (inner === '\\' && i + 1 < len) {
            const esc = command[i + 1] ?? ''
            if (esc === '"' || esc === '\\' || esc === '$') {
              word += esc
              i += 2
              continue
            }
          }
          word += inner
          i++
        }
        if (i < len && command[i] === '"') i++
        continue
      }

      if (c === '\\' && i + 1 < len) {
        hasContent = true
        word += command[i + 1] ?? ''
        i += 2
        continue
      }

      hasContent = true
      word += c
      i++
    }

    if (hasContent) {
      tokens.push({ kind: 'word', value: word, quoted })
    }
  }

  return tokens
}

function splitSegments(tokens: readonly ShellToken[]): ShellToken[][] {
  const segments: ShellToken[][] = []
  let current: ShellToken[] = []
  for (const tok of tokens) {
    if (tok.kind === 'sep') {
      if (current.length > 0) {
        segments.push(current)
        current = []
      }
    } else {
      current.push(tok)
    }
  }
  if (current.length > 0) segments.push(current)
  return segments
}

function isUsableTarget(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('&')) return false
  if (IGNORED_TARGETS.has(trimmed.toLowerCase())) return false
  return true
}

function extractSedInPlaceTargets(args: readonly ShellToken[]): string[] {
  let hasInPlace = false
  let expectInPlaceSuffix = false
  let hasExplicitScript = false
  let skipNextArg = false
  let sawImplicitScript = false
  const files: string[] = []

  for (let i = 0; i < args.length; i++) {
    const tok = args[i]
    if (!tok) continue
    const val = tok.value

    if (skipNextArg) {
      skipNextArg = false
      continue
    }

    if (expectInPlaceSuffix) {
      expectInPlaceSuffix = false
      if (val === '') continue
    }

    if (!tok.quoted && val.startsWith('-') && val !== '-') {
      if (val === '--in-place' || val.startsWith('--in-place=')) {
        hasInPlace = true
      } else if (val === '-i') {
        hasInPlace = true
        const nextTok = args[i + 1]
        if (nextTok?.quoted && nextTok.value === '') {
          expectInPlaceSuffix = true
        }
      } else if (val.startsWith('-i')) {
        hasInPlace = true
      } else if (val === '-e' || val === '-f' || val === '--expression' || val === '--file') {
        hasExplicitScript = true
        skipNextArg = true
      } else if (val.startsWith('--expression=') || val.startsWith('--file=')) {
        hasExplicitScript = true
      } else if (val.includes('i') && !val.startsWith('--')) {
        hasInPlace = true
      }
      continue
    }

    if (!hasExplicitScript && !sawImplicitScript) {
      sawImplicitScript = true
      continue
    }
    files.push(val)
  }

  return hasInPlace ? files : []
}

function extractCopyOrMoveTargets(cmdName: string, args: readonly ShellToken[]): string[] {
  const positional: string[] = []
  let targetDir: string | undefined
  let skipNext = false

  for (let i = 0; i < args.length; i++) {
    const tok = args[i]
    if (!tok) continue
    const val = tok.value
    if (skipNext) {
      skipNext = false
      continue
    }
    if (!tok.quoted && val.startsWith('-') && val !== '-') {
      if (val === '-t' || val === '--target-directory') {
        targetDir = args[i + 1]?.value
        skipNext = true
      } else if (val.startsWith('--target-directory=')) {
        targetDir = val.slice('--target-directory='.length)
      } else if (val === '-S' || val === '--suffix') {
        skipNext = true
      }
      continue
    }
    positional.push(val)
  }

  const out: string[] = []
  if (cmdName === 'mv') {
    out.push(...positional)
  } else if (targetDir !== undefined) {
    out.push(targetDir)
  } else if (positional.length >= 2) {
    const dest = positional[positional.length - 1]
    if (dest !== undefined) out.push(dest)
  } else if (positional.length === 1 && positional[0] !== undefined) {
    out.push(positional[0])
  }
  if (targetDir !== undefined && cmdName === 'mv') {
    out.push(targetDir)
  }
  return out
}

function extractPositionalTargets(
  args: readonly ShellToken[],
  flagsWithValue: ReadonlySet<string>,
): string[] {
  const out: string[] = []
  let skipNext = false
  for (const tok of args) {
    const val = tok.value
    if (skipNext) {
      skipNext = false
      continue
    }
    if (!tok.quoted && val.startsWith('-') && val !== '-') {
      if (flagsWithValue.has(val)) skipNext = true
      continue
    }
    out.push(val)
  }
  return out
}

function extractPowerShellTargets(cmdLower: string, args: readonly ShellToken[]): string[] {
  const out: string[] = []
  const positional: string[] = []
  let i = 0
  while (i < args.length) {
    const tok = args[i]
    if (!tok) break
    const val = tok.value
    const lower = val.toLowerCase()
    if (!tok.quoted && lower.startsWith('-')) {
      if (lower === '-path' || lower === '-literalpath' || lower === '-filepath') {
        const next = args[i + 1]
        if (next) {
          for (const part of next.value.split(',')) {
            const p = part.trim()
            if (p) out.push(p)
          }
        }
        i += 2
        continue
      }
      if (
        lower === '-value' ||
        lower === '-encoding' ||
        lower === '-width' ||
        lower === '-filter' ||
        lower === '-include' ||
        lower === '-exclude'
      ) {
        i += 2
        continue
      }
      i++
      continue
    }
    positional.push(val)
    i++
  }

  if (out.length === 0 && positional.length > 0) {
    if (cmdLower === 'remove-item') {
      out.push(...positional)
    } else if (positional[0] !== undefined) {
      out.push(positional[0])
    }
  }
  return out
}

function extractSubshellCommand(cmdLower: string, args: readonly ShellToken[]): string | undefined {
  if (!SUBSHELL_RUNNERS.has(cmdLower)) return undefined
  for (let i = 0; i < args.length; i++) {
    const val = args[i]?.value.toLowerCase()
    if (val === '-c' || val === '-lc' || val === '-command' || val === '/c') {
      return args[i + 1]?.value
    }
  }
  return undefined
}

/**
 * Extract file paths that a POSIX, PowerShell, or cmd command may write/modify/delete.
 */
export function extractShellWriteTargets(command: string): string[] {
  if (!command.trim()) return []
  const tokens = tokenizeShellCommand(command)
  const segments = splitSegments(tokens)
  const rawTargets: string[] = []

  for (const segment of segments) {
    const words: ShellToken[] = []
    for (let i = 0; i < segment.length; i++) {
      const tok = segment[i]
      if (!tok) continue
      if (tok.kind === 'redir') {
        const next = segment[i + 1]
        if (next && next.kind === 'word') {
          rawTargets.push(next.value)
          i++
        }
        continue
      }
      words.push(tok)
    }

    const head = words[0]
    if (!head) continue
    const cmdBase = head.value.split('/').pop() ?? head.value
    const cmdLower = cmdBase.toLowerCase()
    const args = words.slice(1)

    const nested = extractSubshellCommand(cmdLower, args)
    if (nested !== undefined) {
      rawTargets.push(...extractShellWriteTargets(nested))
      continue
    }

    if (cmdLower === 'tee') {
      rawTargets.push(...extractPositionalTargets(args, new Set()))
    } else if (cmdLower === 'sed') {
      rawTargets.push(...extractSedInPlaceTargets(args))
    } else if (cmdLower === 'cp' || cmdLower === 'mv') {
      rawTargets.push(...extractCopyOrMoveTargets(cmdLower, args))
    } else if (cmdLower === 'rm' || cmdLower === 'unlink') {
      rawTargets.push(...extractPositionalTargets(args, new Set()))
    } else if (cmdLower === 'touch') {
      rawTargets.push(...extractPositionalTargets(args, new Set(['-d', '-r', '-t'])))
    } else if (POWERSHELL_WRITE_CMDS.has(cmdLower)) {
      rawTargets.push(...extractPowerShellTargets(cmdLower, args))
    }
  }

  const seen = new Set<string>()
  const deduped: string[] = []
  for (const target of rawTargets) {
    if (!isUsableTarget(target)) continue
    if (!seen.has(target)) {
      seen.add(target)
      deduped.push(target)
    }
  }
  return deduped
}

/**
 * Validate all write targets extracted from `command` against `sessionID`'s active file lease.
 */
export function checkShellWriteLease(sessionID: string, command: string): FileLeaseCheckResult {
  if (!sessionID || !getFileLease(sessionID)) return { allowed: true }
  const targets = extractShellWriteTargets(command)
  for (const target of targets) {
    const verdict = checkFileLease(sessionID, target)
    if (!verdict.allowed) return verdict
  }
  return { allowed: true }
}
