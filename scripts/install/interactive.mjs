#!/usr/bin/env node

import { emitKeypressEvents } from 'node:readline'
import { colors, icons } from './cli-ui.mjs'

const cursorHide = () => process.stdout.write('\x1b[?25l')
const cursorShow = () => process.stdout.write('\x1b[?25h')
const cursorUp = (n) => process.stdout.write(`\x1b[${n}A`)
const clearDown = () => process.stdout.write('\x1b[J')

function setupStdin() {
  if (!process.stdin.isTTY) return false
  if (!process.stdout.isTTY) return false
  emitKeypressEvents(process.stdin)
  try {
    process.stdin.setRawMode(true)
  } catch {
    return false
  }
  process.stdin.resume()
  return true
}

function teardownStdin() {
  try {
    process.stdin.setRawMode(false)
    process.stdin.removeAllListeners('keypress')
    process.stdin.pause()
  } catch {
    /* safe to ignore */
  }
}

export async function promptMultiSelect(
  options,
  { title = '', selected = new Set(), pageSize = 6 } = {},
) {
  if (options.length === 0) return new Set()

  const preSelected = selected instanceof Set ? selected : new Set(selected)
  const items = options.map((o) => ({
    name: o.name,
    value: o.value,
    description: o.description || '',
    checked: o.checked || preSelected.has(o.value),
  }))

  let cursor = 0
  let scroll = 0
  const maxVisible = Math.min(pageSize, options.length)
  let previousLineCount = 0

  const isTTY = setupStdin()
  if (!isTTY) {
    return new Set(items.filter((i) => i.checked).map((i) => i.value))
  }
  cursorHide()

  function render() {
    if (cursor < scroll) scroll = cursor
    if (cursor >= scroll + maxVisible) scroll = cursor - maxVisible + 1

    const visible = items.slice(scroll, scroll + maxVisible)
    const lines = []

    if (title) lines.push(colors.bold(title))

    const hasMoreAbove = scroll > 0
    const hasMoreBelow = scroll + maxVisible < options.length

    if (hasMoreAbove) lines.push(colors.dim('  ...'))

    for (let i = 0; i < visible.length; i++) {
      const item = visible[i]
      const idx = scroll + i
      const active = idx === cursor
      const box = item.checked ? '[x]' : '[ ]'
      const ptr = active ? `${colors.cyan('>')} ` : '  '
      const name = active ? colors.cyan(item.name) : item.name
      const desc = item.description ? colors.dim(` — ${item.description}`) : ''
      lines.push(`${ptr}${colors.bold(box)} ${name}${desc}`)
    }

    if (hasMoreBelow) lines.push(colors.dim('  ...'))

    const count = items.filter((i) => i.checked).length
    const total = items.length
    const noun = count === 1 ? 'selected' : 'selected'
    lines.push(
      colors.dim(
        `(${count}/${total} ${noun}) — ${colors.cyan('↑')}${colors.dim('/')}${colors.cyan('↓')} navigate · ${colors.cyan('Space')}${colors.dim(' toggle · ')}${colors.cyan('Enter')}${colors.dim(' confirm')}`,
      ),
    )

    const lineCount = lines.length
    if (previousLineCount > 0) cursorUp(previousLineCount)
    clearDown()
    process.stdout.write(lines.join('\n') + '\n')
    previousLineCount = lineCount
  }

  return new Promise((resolve, reject) => {
    let settled = false

    function finalize(result) {
      if (settled) return
      settled = true
      cursorShow()
      teardownStdin()
      if (previousLineCount > 0) cursorUp(previousLineCount)
      clearDown()
      resolve(result)
    }

    function cancel() {
      if (settled) return
      settled = true
      cursorShow()
      teardownStdin()
      if (previousLineCount > 0) cursorUp(previousLineCount)
      clearDown()
      reject(new Error('Canceled'))
    }

    function handler(str, key) {
      if (!key) return
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
        cancel()
        return
      }
      if (key.name === 'return' || key.name === 'enter') {
        const result = new Set(items.filter((i) => i.checked).map((i) => i.value))
        finalize(result)
        return
      }
      if (key.name === 'up') {
        cursor = (cursor - 1 + items.length) % items.length
        render()
        return
      }
      if (key.name === 'down') {
        cursor = (cursor + 1) % items.length
        render()
        return
      }
      if (key.name === 'space') {
        items[cursor].checked = !items[cursor].checked
        render()
        return
      }
    }

    process.stdin.on('keypress', handler)
    render()
  })
}

export async function promptConfirm(message, { default: def = true } = {}) {
  const label = def ? 'Y/n' : 'y/N'
  const isTTY = setupStdin()
  if (!isTTY) return def

  cursorHide()
  process.stdout.write(`${colors.bold('?')} ${message} ${colors.cyan(label)} `)

  return new Promise((resolve, reject) => {
    let settled = false

    function finalize(result) {
      if (settled) return
      settled = true
      cursorShow()
      teardownStdin()
      process.stdout.write(`${result ? 'Yes' : 'No'}\n`)
      resolve(result)
    }

    function cancel() {
      if (settled) return
      settled = true
      cursorShow()
      teardownStdin()
      process.stdout.write('\n')
      reject(new Error('Canceled'))
    }

    function handler(str, key) {
      if (!key) return
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
        cancel()
        return
      }
      if (key.name === 'return' || key.name === 'enter') {
        finalize(def)
        return
      }
      if (str) {
        const ch = str.toLowerCase()
        if (ch === 'y' || ch === 'yes') {
          finalize(true)
        } else if (ch === 'n' || ch === 'no') {
          finalize(false)
        }
      }
    }

    process.stdin.on('keypress', handler)
  })
}

export async function promptList(options, { title = '' } = {}) {
  if (options.length === 0) throw new Error('No options provided')
  if (options.length === 1) return options[0].value

  const items = options.map((o) => ({
    name: o.name,
    value: o.value,
    description: o.description || '',
  }))

  let cursor = 0
  const pageSize = Math.min(8, options.length)
  let scroll = 0
  const maxVisible = Math.min(pageSize, options.length)
  let previousLineCount = 0

  const isTTY = setupStdin()
  if (!isTTY) return items[0].value
  cursorHide()

  function render() {
    if (cursor < scroll) scroll = cursor
    if (cursor >= scroll + maxVisible) scroll = cursor - maxVisible + 1

    const visible = items.slice(scroll, scroll + maxVisible)
    const lines = []

    if (title) lines.push(colors.bold(title))

    const hasMoreAbove = scroll > 0
    const hasMoreBelow = scroll + maxVisible < options.length

    if (hasMoreAbove) lines.push(colors.dim('  ...'))

    for (let i = 0; i < visible.length; i++) {
      const item = visible[i]
      const idx = scroll + i
      const active = idx === cursor
      const ptr = active ? `${colors.cyan('>')} ` : '  '
      const name = active ? colors.cyan(item.name) : item.name
      const desc = item.description ? colors.dim(` — ${item.description}`) : ''
      lines.push(`${ptr}${colors.bold('◉')} ${name}${desc}`)
    }

    if (hasMoreBelow) lines.push(colors.dim('  ...'))

    lines.push(
      colors.dim(
        `(${colors.cyan('↑')}${colors.dim('/')}${colors.cyan('↓')} navigate · ${colors.cyan('Enter')}${colors.dim(' select')}`,
      ),
    )

    const lineCount = lines.length
    if (previousLineCount > 0) cursorUp(previousLineCount)
    clearDown()
    process.stdout.write(lines.join('\n') + '\n')
    previousLineCount = lineCount
  }

  return new Promise((resolve, reject) => {
    let settled = false

    function finalize(result) {
      if (settled) return
      settled = true
      cursorShow()
      teardownStdin()
      if (previousLineCount > 0) cursorUp(previousLineCount)
      clearDown()
      resolve(result)
    }

    function cancel() {
      if (settled) return
      settled = true
      cursorShow()
      teardownStdin()
      if (previousLineCount > 0) cursorUp(previousLineCount)
      clearDown()
      reject(new Error('Canceled'))
    }

    function handler(str, key) {
      if (!key) return
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
        cancel()
        return
      }
      if (key.name === 'return' || key.name === 'enter') {
        finalize(items[cursor].value)
        return
      }
      if (key.name === 'up') {
        cursor = (cursor - 1 + items.length) % items.length
        render()
        return
      }
      if (key.name === 'down') {
        cursor = (cursor + 1) % items.length
        render()
        return
      }
    }

    process.stdin.on('keypress', handler)
    render()
  })
}

export async function runInteractiveInstall({ components = [], defaultComponents = [] } = {}) {
  const defaultSet = new Set(defaultComponents.length > 0 ? defaultComponents : components)

  const componentOptions = [
    {
      name: 'agents',
      value: 'agents',
      description: `Agent configurations and routing (${14} agents)`,
    },
    {
      name: 'skills',
      value: 'skills',
      description: `Reusable skill workflows (${21} skills)`,
    },
    {
      name: 'instructions',
      value: 'instructions',
      description: 'AGENTS.md and instructional files',
    },
    {
      name: 'prompts',
      value: 'prompts',
      description: 'Prompt templates for agents',
    },
    {
      name: 'commands',
      value: 'commands',
      description: 'OpenCode command shortcuts',
    },
    {
      name: 'plugins',
      value: 'plugins',
      description: 'TUI sidebar plugin',
    },
    {
      name: 'runtime',
      value: 'runtime',
      description: 'Python venv + MCP server scripts',
    },
  ]

  process.stdout.write('\n')
  process.stdout.write(`${colors.bold(colors.cyan('📦 OpenCode Installer'))}\n\n`)

  const selectedComponents = await promptMultiSelect(componentOptions, {
    title: 'Select components to install:',
    selected: defaultSet,
    pageSize: 7,
  })

  process.stdout.write('\n')

  if (selectedComponents.size === 0) {
    process.stdout.write(`${colors.yellow('No components selected — using defaults\n')}`)
    defaultSet.forEach((v) => {
      selectedComponents.add(v)
    })
  }

  const targetOptions = [
    {
      name: 'Global directory',
      value: 'global',
      description: '~/.config/opencode (shared across projects)',
    },
    {
      name: 'Current project',
      value: 'project',
      description: './.opencode (scoped to this project)',
    },
  ]

  const target = await promptList(targetOptions, {
    title: 'Install location:',
  })

  process.stdout.write('\n')

  const confirmed = await promptConfirm(
    `Install ${selectedComponents.size} component(s) in ${target === 'global' ? 'global config' : 'current project'}?`,
    { default: true },
  )

  process.stdout.write('\n')

  return { components: selectedComponents, target, confirmed }
}
