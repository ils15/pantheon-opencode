export const icons = {
  success: '\u2705',
  warning: '\u26a0\ufe0f ',
  error: '\u274c',
  info: '\u2139\ufe0f ',
  progress: '\u23f3',
  done: '\u2705',
  arrow: '\u2192',
  bullet: '\u2022',
  star: '\u2b50',
  wrench: '\U0001f527',
  rocket: '\U0001f680',
  package: '\U0001f4e6',
  gear: '\u2699\ufe0f',
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

function tag(msg) {
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

export function step(message) {
  const text = tag(`${icons.progress} ${message}...`)
  if (!_quiet) process.stdout.write(text)
  return (ok = true) => {
    const icon = ok ? icons.success : icons.error
    const doneText = tag(`${icon} ${message}`)
    if (_quiet && !ok) {
      console.warn(doneText)
    } else if (!_quiet) {
      process.stdout.write(`\r${doneText}\n`)
    }
  }
}

export function success(message) {
  console.log(tag(`${icons.success} ${message}`))
}

export function warning(message) {
  console.warn(tag(`${icons.warning}${message}`))
}

export function error(message) {
  console.error(tag(`${icons.error} ${message}`))
}

export function info(message) {
  if (_quiet) return
  console.log(tag(`${icons.info}${message}`))
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
  console.log(tag(`\u2502 ${'Componente'.padEnd(nameWidth)} \u2502 ${'Status'.padEnd(statusWidth)} \u2502`))
  console.log(tag(sep))
  for (const item of items) {
    console.log(tag(`\u2502 ${item.name.padEnd(nameWidth)} \u2502 ${String(item.status).padEnd(statusWidth)} \u2502`))
  }
  console.log(tag(bot))
}

export function spinner(message) {
  const frames = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f']
  let i = 0
  let running = true

  if (tty() && !_quiet) {
    const interval = setInterval(() => {
      if (!running) { clearInterval(interval); return }
      process.stdout.write(`\r${frames[i % frames.length]} ${tag(message)}...`)
      i++
    }, 80)
    process.stdout.write(`\r${frames[0]} ${tag(message)}...`)

    return (ok = true) => {
      running = false
      clearInterval(interval)
      const icon = ok ? icons.success : icons.error
      process.stdout.write(`\r${icon} ${tag(message)}\n`)
    }
  } else {
    const text = tag(`${icons.progress} ${message}...`)
    if (!_quiet) process.stdout.write(text)
    return (ok = true) => {
      const icon = ok ? icons.success : icons.error
      const doneText = tag(`${icon} ${message}`)
      if (_quiet && !ok) {
        console.warn(doneText)
      } else if (!_quiet) {
        process.stdout.write(`\r${doneText}\n`)
      }
    }
  }
}

export function printSummary(target, platforms, stats) {
  if (_quiet) return

  const line = '\u2500'.repeat(Math.min(process.stdout.columns || 60, 60))
  console.log(tag(`${icons.rocket} OpenCode instalado em ${target}`))
  console.log(tag(line))
  console.log('')

  if (stats) {
    console.log(tag(`  Componentes:\t${stats.created} instalados, ${stats.skipped} pulados`))
    if (stats.errors > 0) {
      console.warn(tag(`  ${icons.warning}${stats.errors} erro(s) encontrados`))
    }
    console.log('')
  }

  console.log(tag(`  ${icons.star} Próximos passos:`))
  console.log(tag(`    ${icons.bullet} Configure seus agentes em opencode.json`))
  console.log(tag(`    ${icons.bullet} Adicione MCP servers em mcp.json`))
  console.log(tag(`    ${icons.bullet} Rode 'opencode doctor' para verificar a instalação`))
}
