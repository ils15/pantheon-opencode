import { basename, dirname, join, resolve } from 'node:path'
import { spinner as clackSpinner } from '@clack/prompts'
import { strings } from './strings.mjs'

export const icons = {
  success: '[OK]',
  warning: '[WARN]',
  error: '[ERROR]',
  info: '[INFO]',
  progress: '[RUNNING]',
  done: '[DONE]',
  bullet: '*',
  rocket: '[OK]',
}

export const colors = {
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
}

let _quiet = false
let _dryRun = false

export function configure(opts = {}) {
  if (opts.quiet !== undefined) _quiet = opts.quiet
  if (opts.dryRun !== undefined) _dryRun = opts.dryRun
}

/**
 * Prefix a message with the `[DRY-RUN]` marker while a dry run is configured.
 * Exported so callers that print through raw `console.log` (e.g. the per-file
 * change plan) stay consistent with every other dry-run line.
 */
export function tag(msg) {
  return _dryRun ? `[DRY-RUN] ${msg}` : msg
}

function tty() {
  return process.stdout.isTTY
}

export function section(title) {
  if (_quiet) return
  const width = Math.min(process.stdout.columns || 60, 72)
  const text = `\u2500\u2500 ${title} `
  const line = text + '\u2500'.repeat(Math.max(0, width - text.length + 1))
  console.log(tag(line))
}

function progress(message) {
  if (tty() && !_quiet) {
    const indicator = clackSpinner()
    indicator.start(tag(message))
    return (ok = true) => {
      const doneText = tag(`${message} — ${ok ? 'complete' : 'failed'}`)
      if (ok) indicator.stop(doneText)
      else indicator.error(doneText)
    }
  }

  if (!_quiet) console.log(tag(`${icons.progress} ${message}`))
  return (ok = true) => {
    const doneText = tag(`${ok ? icons.done : icons.error} ${message}`)
    if (_quiet && !ok) console.warn(doneText)
    else if (!_quiet) console.log(doneText)
  }
}

export function step(message) {
  return progress(message)
}

export function success(message) {
  console.log(tag(`${icons.success} ${message}`))
}

export function warning(message) {
  console.warn(tag(`${icons.warning} ${message}`))
}

export function error(message) {
  console.error(tag(`${icons.error} ${message}`))
}

export function info(message) {
  if (_quiet) return
  console.log(tag(`${icons.info} ${message}`))
}

export function bullet(text, indent = 0) {
  if (_quiet) return
  const pad = '  '.repeat(indent)
  console.log(tag(`${pad}${icons.bullet} ${text}`))
}

export function summaryTable(items) {
  if (_quiet || items.length === 0) return

  const nameWidth = Math.max(...items.map((i) => i.name.length), 15)
  const statusWidth = Math.max(...items.map((i) => String(i.status).length), 8)

  const top = `\u250c${'\u2500'.repeat(nameWidth + 2)}\u252c${'\u2500'.repeat(statusWidth + 2)}\u2510`
  const sep = `\u251c${'\u2500'.repeat(nameWidth + 2)}\u253c${'\u2500'.repeat(statusWidth + 2)}\u2524`
  const bot = `\u2514${'\u2500'.repeat(nameWidth + 2)}\u2534${'\u2500'.repeat(statusWidth + 2)}\u2518`

  console.log(tag(top))
  console.log(
    tag(`\u2502 ${'Componente'.padEnd(nameWidth)} \u2502 ${'Status'.padEnd(statusWidth)} \u2502`),
  )
  console.log(tag(sep))
  for (const item of items) {
    console.log(
      tag(
        `\u2502 ${item.name.padEnd(nameWidth)} \u2502 ${String(item.status).padEnd(statusWidth)} \u2502`,
      ),
    )
  }
  console.log(tag(bot))
}

export function spinner(message) {
  return progress(message)
}

export function printSummary(target, _platforms, stats) {
  if (_quiet) return

  const S = strings()
  const line = '\u2500'.repeat(Math.min(process.stdout.columns || 60, 60))
  const hasErrors = stats && stats.errors > 0
  console.log(
    tag(
      hasErrors
        ? `${icons.warning} ${S.summaryWithErrors(target)}`
        : `${icons.rocket} ${S.summaryInstalled(target)}`,
    ),
  )
  console.log(tag(line))
  console.log('')

  if (stats) {
    console.log(tag(S.summaryComponents(stats.created, stats.skipped)))
    if (stats.errors > 0) {
      console.warn(tag(S.summaryErrors(stats.errors)))
    }
    if (stats.warnings > 0) {
      console.warn(tag(S.summaryWarnings(stats.warnings)))
    }
    console.log('')
  }

  console.log(tag(`  ${S.summaryNext.trim()}`))
  console.log(tag(S.summaryNextAgents))
  console.log(tag(S.summaryNextMcp))
  console.log(tag(S.summaryNextDoctor))
}

/**
 * Build a persistent worktree location outside the project directory.
 *
 * @param {string} projectRoot - Project directory whose exact basename, including spaces, is retained.
 * @returns {{ pattern: string, example: string }} Recommended paths for future worktrees.
 */
export function getWorktreeRecommendation(projectRoot = process.cwd()) {
  const resolvedProject = resolve(projectRoot)
  const projectName = basename(resolvedProject)
  const repositoryWorktreeRoot = resolve(
    dirname(resolvedProject),
    '.pantheon-worktrees',
    projectName || 'project',
  )

  return {
    pattern: join(repositoryWorktreeRoot, '<task>'),
    example: join(repositoryWorktreeRoot, 'feature-name'),
  }
}

/**
 * Show the suggested external worktree location in a real interactive TTY setup.
 * Pantheon provides guidance only; it never creates a worktree or its directory.
 *
 * @param {object} [options]
 * @param {string} [options.projectRoot=process.cwd()] - Project path for the recommendation.
 * @param {boolean} [options.interactive=false] - Whether setup is interactive.
 * @param {boolean} [options.dryRun=false] - Whether setup is preview-only.
 * @returns {void}
 */
export function printWorktreeGuidance({
  projectRoot = process.cwd(),
  interactive = false,
  dryRun = false,
} = {}) {
  if (!interactive || dryRun || !tty()) return

  const recommendation = getWorktreeRecommendation(projectRoot)
  const rows = [
    { label: 'Default: ', value: recommendation.pattern, color: colors.green },
    { label: 'Example: ', value: recommendation.example, color: colors.cyan },
    {
      label: 'Use: ',
      value:
        'Persistent location; preserve the exact project directory basename, including spaces.',
      color: colors.dim,
    },
    {
      label: 'Note: ',
      value: 'Pantheon does not create Git worktrees or directories automatically.',
      color: colors.yellow,
    },
  ]
  const contentWidth = Math.max(
    'Worktrees'.length,
    ...rows.map(({ label, value }) => label.length + value.length),
  )
  const border = colors.cyan

  console.log('')
  console.log(`  ${border(`┌${'─'.repeat(contentWidth + 2)}┐`)}`)
  console.log(`  ${border('│')} ${colors.bold('Worktrees'.padEnd(contentWidth))} ${border('│')}`)
  console.log(`  ${border(`├${'─'.repeat(contentWidth + 2)}┤`)}`)
  for (const { label, value, color } of rows) {
    const padding = ' '.repeat(contentWidth - label.length - value.length)
    console.log(`  ${border('│')} ${colors.bold(label)}${color(value)}${padding} ${border('│')}`)
  }
  console.log(`  ${border(`└${'─'.repeat(contentWidth + 2)}┘`)}`)
  console.log('')
}
