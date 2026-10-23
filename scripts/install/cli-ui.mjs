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
// Step-by-step detail (section/step/info/bullet/success) is ON by default so
// every pre-existing caller (doctor, migrate, direct setupRuntimePhase calls)
// keeps its output. `init` opts OUT in favor of the gauge, unless --verbose.
let _verbose = true

/**
 * Update the UI channel state and return the PREVIOUS state so a caller can
 * restore it (the installer flips verbose off for the duration of one run).
 *
 * @param {{ quiet?: boolean, dryRun?: boolean, verbose?: boolean }} [opts]
 * @returns {{ quiet: boolean, dryRun: boolean, verbose: boolean }}
 */
export function configure(opts = {}) {
  const previous = { quiet: _quiet, dryRun: _dryRun, verbose: _verbose }
  if (opts.quiet !== undefined) _quiet = opts.quiet
  if (opts.dryRun !== undefined) _dryRun = opts.dryRun
  if (opts.verbose !== undefined) _verbose = opts.verbose
  return previous
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
  if (_quiet || !_verbose) return
  const width = Math.min(process.stdout.columns || 60, 72)
  const text = `\u2500\u2500 ${title} `
  const line = text + '\u2500'.repeat(Math.max(0, width - text.length + 1))
  console.log(line)
}

function progress(message) {
  const startedAt = Date.now()
  const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`

  // The gauge owns the terminal while it is active: per-step lines would fight
  // with the single rewritten line. A FAILED step still surfaces as a warning
  // (silently dropping a failure would be dishonest), exactly like quiet mode.
  if (!_verbose) {
    return (ok = true) => {
      if (!ok) {
        console.warn(`${icons.error} ${message} — failed in ${elapsed()}`)
      }
    }
  }

  if (tty() && !_quiet) {
    const indicator = clackSpinner()
    indicator.start(message)
    return (ok = true) => {
      const doneText = `${message} — ${ok ? 'complete' : 'failed'} in ${elapsed()}`
      if (ok) indicator.stop(doneText)
      else indicator.error(doneText)
    }
  }

  if (!_quiet) console.log(`${icons.progress} ${message}`)
  return (ok = true) => {
    const doneText = `${ok ? icons.done : icons.error} ${message} — ${ok ? 'complete' : 'failed'} in ${elapsed()}`
    if (_quiet && !ok) console.warn(doneText)
    else if (!_quiet) console.log(doneText)
  }
}

export function step(message) {
  return progress(message)
}

export function success(message) {
  if (_quiet || !_verbose) return
  console.log(`${icons.success} ${message}`)
}

export function warning(message) {
  if (_quiet) return
  endGaugeLine()
  console.warn(tag(`${icons.warning} ${message}`))
}

export function error(message) {
  if (_quiet) return
  endGaugeLine()
  console.error(tag(`${icons.error} ${message}`))
}

export function info(message) {
  if (_quiet || !_verbose) return
  console.log(`${icons.info} ${message}`)
}

/**
 * A message that must survive the gauge (gate outcomes: declined, plan-only,
 * canceled). It is suppressed only by `--quiet`/JSON, never by the progress
 * mode: losing "re-run with --yes" would leave the user with a dead end.
 */
export function notice(message) {
  if (_quiet) return
  endGaugeLine()
  console.log(`${icons.info} ${message}`)
}

export function bullet(text, indent = 0) {
  if (_quiet || !_verbose) return
  const pad = '  '.repeat(indent)
  console.log(`${pad}${icons.bullet} ${text}`)
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

const GAUGE_BAR_WIDTH = 10

// A TTY gauge owns the current line (no trailing newline). Any regular output
// must terminate that line first or it would be appended to the gauge text.
let _gaugeLineOpen = false

/** Close an in-flight TTY gauge line so normal output starts on its own line. */
export function endGaugeLine() {
  if (!_gaugeLineOpen) return
  process.stdout.write('\n')
  _gaugeLineOpen = false
}

/** Render the progress bar, with a half block for the fractional cell. */
function gaugeBar(ratio, width = GAUGE_BAR_WIDTH) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0))
  const exact = clamped * width
  const full = Math.floor(exact)
  const half = exact - full >= 0.5 && full < width
  const empty = Math.max(0, width - full - (half ? 1 : 0))
  return '\u2588'.repeat(full) + (half ? '\u258c' : '') + '\u2591'.repeat(empty)
}

/**
 * Build one gauge line: `[████████░░] 80% 12/15  Installing TUI dependencies`.
 * The label is truncated to the terminal width so the gauge can never wrap.
 */
function gaugeText({ current, total, label, columns }) {
  const ratio = total > 0 ? current / total : 1
  const percent = Math.min(100, Math.round(ratio * 100))
  const prefix = `[${gaugeBar(ratio)}] ${percent}% ${current}/${total}`
  const available = Math.max(0, (columns || 80) - prefix.length - 2)
  const text =
    label.length > available ? `${label.slice(0, Math.max(0, available - 1))}\u2026` : label
  return text ? `${prefix}  ${text}` : prefix
}

/**
 * Progress gauge for the installer: ONE line of output per phase, never one
 * line per file.
 *
 *   * TTY — a single line rewritten in place with `\r` + clear, so the user
 *     sees motion instead of a log. `done()` leaves `✔ 15/15 em 41.2s`.
 *   * non-TTY/CI — one line per COMPLETED phase:
 *     `[12/15] Installing TUI dependencies — 13.0s`. It deliberately adds no
 *     separate `done()` line so the log size stays proportional to the number
 *     of phases (the final `✔` line is a TTY affordance).
 *
 * `_quiet` (JSON output, doctor's internal preview) makes the gauge silent:
 * nothing it writes may contaminate a structured stream.
 *
 * @param {{ total: number, label?: string }} options
 * @returns {{
 *   total: number,
 *   readonly current: number,
 *   readonly finished: boolean,
 *   advance: (n?: number, label?: string) => void,
 *   done: () => void,
 *   fail: (message: string) => void,
 *   cancel: () => void,
 * }}
 */
export function gauge({ total: rawTotal, label: initialLabel = '' } = {}) {
  const total = Math.max(0, Math.trunc(Number(rawTotal) || 0))
  const startedAt = Date.now()
  const interactive = Boolean(process.stdout.isTTY)
  const silent = _quiet

  let current = 0
  let label = initialLabel
  let phaseStartedAt = startedAt
  let rendered = false
  let finished = false

  const seconds = (from) => ((Date.now() - from) / 1000).toFixed(1)
  const write = (text) => process.stdout.write(text)

  const render = () => {
    write(
      `\r\x1b[2K${gaugeText({
        current,
        total,
        label,
        columns: process.stdout.columns,
      })}`,
    )
    rendered = true
    _gaugeLineOpen = true
  }

  return {
    total,
    get current() {
      return current
    },
    get finished() {
      return finished
    },
    advance(n = 1, nextLabel) {
      if (finished) return
      const steps = Math.max(1, Math.trunc(Number(n) || 1))
      if (typeof nextLabel === 'string' && nextLabel.length > 0) label = nextLabel
      if (interactive) {
        current = Math.min(total, current + steps)
        phaseStartedAt = Date.now()
        if (!silent) render()
        return
      }
      // non-TTY: one line per completed phase, each with its own duration.
      for (let index = 0; index < steps; index += 1) {
        current = Math.min(total, current + 1)
        const phaseSeconds = seconds(phaseStartedAt)
        phaseStartedAt = Date.now()
        if (!silent) write(`[${current}/${total}] ${label} — ${phaseSeconds}s\n`)
      }
    },
    done() {
      if (finished) return
      finished = true
      if (silent || !interactive) return
      write(`\r\x1b[2K\u2714 ${total}/${total} em ${seconds(startedAt)}s\n`)
      _gaugeLineOpen = false
    },
    fail(message) {
      if (finished) return
      finished = true
      if (silent) return
      const reason = String(message ?? 'failed')
      const suffix = label ? ` ${label} — ${reason}` : ` — ${reason}`
      if (interactive) {
        write(`\r\x1b[2K\u2716 ${current}/${total}${suffix}\n`)
        _gaugeLineOpen = false
      } else {
        write(`\u2716 ${current}/${total}${suffix}\n`)
      }
    },
    cancel() {
      if (finished) return
      finished = true
      if (!silent && interactive && rendered) {
        write('\r\x1b[2K')
        _gaugeLineOpen = false
      }
    },
  }
}

export function printSummary(target, _platforms, stats) {
  if (_quiet) return
  endGaugeLine()

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
