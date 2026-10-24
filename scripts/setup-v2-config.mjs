import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as clack from '@clack/prompts'
import { migrateV1toV2 } from './install/config-migration.mjs'

const CONFIG_NAMES = ['opencode.json', 'opencode.jsonc']
const MCP_SERVER_NAME = /^[a-zA-Z0-9._-]+$/
const EFFECTS = new Set(['allow', 'ask', 'deny'])

/** Resolve the same global config target used by the existing init installer. */
export function resolveGlobalConfigDirectory(_env = process.env, home = os.homedir()) {
  return path.join(home, '.config', 'opencode')
}

function readString(source, cursor) {
  const start = cursor
  cursor += 1
  let escaped = false
  while (cursor < source.length) {
    const char = source[cursor]
    if (escaped) {
      escaped = false
    } else if (char === '\\') {
      escaped = true
    } else if (char === '"') {
      const end = cursor + 1
      return { value: JSON.parse(source.slice(start, end)), start, end, cursor: end }
    }
    cursor += 1
  }
  throw new SyntaxError(`Unterminated string at offset ${start}`)
}

/** Parse JSON/JSONC while retaining source spans so edits can preserve unrelated text. */
function parseConfig(source, jsonc) {
  let cursor = 0
  const comments = []

  function skipTrivia() {
    while (cursor < source.length) {
      if (/\s/.test(source[cursor])) {
        cursor += 1
        continue
      }
      if (source.startsWith('//', cursor)) {
        if (!jsonc) throw new SyntaxError(`Comments are not allowed at offset ${cursor}`)
        const start = cursor
        const newline = source.indexOf('\n', cursor + 2)
        cursor = newline < 0 ? source.length : newline
        comments.push({ start, end: cursor })
        continue
      }
      if (source.startsWith('/*', cursor)) {
        if (!jsonc) throw new SyntaxError(`Comments are not allowed at offset ${cursor}`)
        const start = cursor
        const close = source.indexOf('*/', cursor + 2)
        if (close < 0) throw new SyntaxError(`Unterminated comment at offset ${start}`)
        cursor = close + 2
        comments.push({ start, end: cursor })
        continue
      }
      break
    }
  }

  function parseValue() {
    skipTrivia()
    const start = cursor
    const char = source[cursor]

    if (char === '"') {
      const token = readString(source, cursor)
      cursor = token.cursor
      return { value: token.value, start, end: cursor, type: 'scalar' }
    }
    if (char === '{') {
      cursor += 1
      const value = {}
      const properties = []
      const keys = new Set()
      skipTrivia()
      if (source[cursor] === '}') {
        cursor += 1
        return { value, properties, start, end: cursor, closeStart: cursor - 1, type: 'object' }
      }
      let previousProperty = null
      while (cursor < source.length) {
        skipTrivia()
        if (source[cursor] !== '"') throw new SyntaxError(`Expected object key at offset ${cursor}`)
        const key = readString(source, cursor)
        cursor = key.cursor
        if (keys.has(key.value))
          throw new SyntaxError(`Duplicate object key ${JSON.stringify(key.value)}`)
        keys.add(key.value)
        skipTrivia()
        if (source[cursor] !== ':') throw new SyntaxError(`Expected ':' at offset ${cursor}`)
        cursor += 1
        const parsedValue = parseValue()
        Object.defineProperty(value, key.value, {
          value: parsedValue.value,
          enumerable: true,
          configurable: true,
          writable: true,
        })
        const property = {
          key: key.value,
          keyStart: key.start,
          keyEnd: key.end,
          valueStart: parsedValue.start,
          valueEnd: parsedValue.end,
          value: parsedValue.value,
          valueNode: parsedValue,
          commaBefore: previousProperty?.commaAfter ?? null,
          commaAfter: null,
        }
        properties.push(property)
        skipTrivia()
        if (source[cursor] === ',') {
          property.commaAfter = cursor
          cursor += 1
          skipTrivia()
          if (source[cursor] === '}') {
            if (!jsonc)
              throw new SyntaxError(
                `Trailing commas are not allowed at offset ${property.commaAfter}`,
              )
            cursor += 1
            return { value, properties, start, end: cursor, closeStart: cursor - 1, type: 'object' }
          }
          previousProperty = property
          continue
        }
        if (source[cursor] === '}') {
          cursor += 1
          return { value, properties, start, end: cursor, closeStart: cursor - 1, type: 'object' }
        }
        throw new SyntaxError(`Expected ',' or '}' at offset ${cursor}`)
      }
      throw new SyntaxError(`Unterminated object at offset ${start}`)
    }
    if (char === '[') {
      cursor += 1
      const value = []
      skipTrivia()
      if (source[cursor] === ']') {
        cursor += 1
        return { value, start, end: cursor, type: 'array' }
      }
      while (cursor < source.length) {
        value.push(parseValue().value)
        skipTrivia()
        if (source[cursor] === ',') {
          const comma = cursor
          cursor += 1
          skipTrivia()
          if (source[cursor] === ']') {
            if (!jsonc) throw new SyntaxError(`Trailing commas are not allowed at offset ${comma}`)
            cursor += 1
            return { value, start, end: cursor, type: 'array' }
          }
          continue
        }
        if (source[cursor] === ']') {
          cursor += 1
          return { value, start, end: cursor, type: 'array' }
        }
        throw new SyntaxError(`Expected ',' or ']' at offset ${cursor}`)
      }
      throw new SyntaxError(`Unterminated array at offset ${start}`)
    }

    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      source.slice(cursor),
    )
    if (!literal) throw new SyntaxError(`Expected JSON value at offset ${cursor}`)
    cursor += literal[0].length
    return { value: JSON.parse(literal[0]), start, end: cursor, type: 'scalar' }
  }

  const ast = parseValue()
  skipTrivia()
  if (cursor !== source.length) throw new SyntaxError(`Unexpected content at offset ${cursor}`)
  if (ast.type !== 'object') throw new SyntaxError('The config root must be a JSON object')
  return { ...ast, comments }
}

/** Inspect both global config filenames independently; neither file is canonicalized. */
export function inspectConfigFiles(configDir, filesystem = fs) {
  return CONFIG_NAMES.map((name) => {
    const filePath = path.join(configDir, name)
    if (!filesystem.existsSync(filePath)) {
      return {
        name,
        path: filePath,
        exists: false,
        format: name.endsWith('.jsonc') ? 'jsonc' : 'json',
      }
    }
    const stat = filesystem.lstatSync(filePath)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return {
        name,
        path: filePath,
        exists: true,
        format: name.endsWith('.jsonc') ? 'jsonc' : 'json',
        parseError:
          'Only regular config files are supported; symbolic links and special files are preview-only.',
      }
    }
    const content = filesystem.readFileSync(filePath, 'utf8')
    const format = name.endsWith('.jsonc') ? 'jsonc' : 'json'
    try {
      const ast = parseConfig(content, format === 'jsonc')
      return {
        name,
        path: filePath,
        exists: true,
        format,
        content,
        config: ast.value,
        ast,
      }
    } catch (error) {
      return { name, path: filePath, exists: true, format, content, parseError: error.message }
    }
  })
}

function policySources(files) {
  return files.flatMap((file) => {
    if (!file.exists || file.parseError) return []
    const properties = new Map(file.ast.properties.map((property) => [property.key, property]))
    return ['permission', 'permissions']
      .filter((key) => properties.has(key))
      .map((key) => ({
        id: `${file.path}#${key}`,
        file,
        key,
        value: properties.get(key).value,
        property: properties.get(key),
      }))
  })
}

function getMcpAskEntries(source) {
  const policy = source.value
  if (source.key === 'permission' && isRecord(policy) && isRecord(policy.mcp)) {
    return Object.entries(policy.mcp)
      .filter(([, effect]) => effect === 'ask')
      .map(([server]) => ({
        id: `${source.id}#mcp:${server}`,
        label: `MCP server "${server}" (legacy permission.mcp.${server})`,
        server,
        kind: 'legacy',
      }))
  }
  if (source.key === 'permissions' && Array.isArray(policy)) {
    return policy
      .map((rule, index) => ({ rule, index }))
      .filter(
        ({ rule }) =>
          isRecord(rule) &&
          rule.effect === 'ask' &&
          typeof rule.action === 'string' &&
          /^[a-zA-Z0-9._-]+_\*$/.test(rule.action),
      )
      .map(({ rule, index }) => ({
        id: `${source.id}#mcp:${rule.action}:${rule.resource}:${index}`,
        label: `MCP action "${rule.action}" resource ${JSON.stringify(rule.resource)}`,
        action: rule.action,
        resource: rule.resource,
        index,
        kind: 'v2',
      }))
  }
  return []
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateLegacyPolicy(value) {
  if (!isRecord(value)) throw new Error('Legacy "permission" must be an object.')
  for (const [action, rule] of Object.entries(value)) {
    if (action === 'mcp') {
      if (!isRecord(rule))
        throw new Error('Legacy permission.mcp must be a server-to-effect object.')
      for (const [server, effect] of Object.entries(rule)) {
        if (!MCP_SERVER_NAME.test(server) || !EFFECTS.has(effect)) {
          throw new Error(
            `Unsupported MCP permission for ${JSON.stringify(server)}; no policy was changed.`,
          )
        }
      }
      continue
    }
    if (typeof rule === 'string') {
      if (!EFFECTS.has(rule)) throw new Error(`Unsupported effect for permission.${action}.`)
      continue
    }
    if (!isRecord(rule)) throw new Error(`Unsupported value for permission.${action}.`)
    for (const effect of Object.values(rule)) {
      if (!EFFECTS.has(effect))
        throw new Error(`Unsupported effect for permission.${action}; no policy was changed.`)
    }
  }
  const migratedAction = (action) =>
    ({ bash: 'shell', task: 'subagent', write: 'edit' })[action] ?? action
  const seen = new Map()
  for (const [action, rule] of Object.entries(value)) {
    if (action === 'mcp') {
      for (const [server, effect] of Object.entries(rule)) {
        const key = `${server}_*\u0000*`
        const previous = seen.get(key)
        if (previous !== undefined && previous !== effect) {
          throw new Error(
            `Conflicting permission rules map to MCP action ${JSON.stringify(`${server}_*`)}; choose a policy manually.`,
          )
        }
        seen.set(key, effect)
      }
      continue
    }
    const actionName = migratedAction(action)
    const rules = typeof rule === 'string' ? [['*', rule]] : Object.entries(rule)
    for (const [resource, effect] of rules) {
      const key = `${actionName}\u0000${resource}`
      const previous = seen.get(key)
      if (previous !== undefined && previous !== effect) {
        throw new Error(
          `Conflicting legacy permission rules map to ${actionName} for ${JSON.stringify(resource)}; choose a policy manually.`,
        )
      }
      seen.set(key, effect)
    }
  }
}

function validateV2Policy(value) {
  if (!Array.isArray(value)) throw new Error('V2 "permissions" must be an array.')
  for (const rule of value) {
    if (
      !isRecord(rule) ||
      typeof rule.action !== 'string' ||
      typeof rule.resource !== 'string' ||
      !EFFECTS.has(rule.effect)
    ) {
      throw new Error('A V2 permissions entry is malformed; no policy was changed.')
    }
  }
}

function applyAskChoices(source, choices) {
  const resolved = structuredClone(source.value)
  for (const ask of getMcpAskEntries(source)) {
    const choice = choices[ask.id]
    if (choice !== 'allow' && choice !== 'deny') {
      throw new Error(
        `${ask.label} is "ask", which OpenCode V2 cannot enforce for MCP. Choose allow or deny.`,
      )
    }
    if (ask.kind === 'legacy') resolved.mcp[ask.server] = choice
    else resolved[ask.index].effect = choice
  }
  return resolved
}

function makeV2Policy(source, askChoices) {
  if (source.key === 'permission') {
    validateLegacyPolicy(source.value)
    const permission = applyAskChoices(source, askChoices)
    const converted = migrateV1toV2({ permission })
    const policy = converted.permissions ?? []
    validateV2Policy(policy)
    return policy
  }
  validateV2Policy(source.value)
  return applyAskChoices(source, askChoices)
}

function commentsWithin(ast, start, end) {
  return ast.comments.some((comment) => comment.start >= start && comment.end <= end)
}

function indentAt(source, offset) {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1
  return /^[\t ]*/.exec(source.slice(lineStart, offset))[0]
}

function formatValue(value, indent) {
  return JSON.stringify(value, null, 2)
    .split('\n')
    .map((line, index) => (index === 0 ? line : `${indent}${line}`))
    .join('\n')
}

function applyTextEdits(source, edits) {
  let result = source
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`
  }
  return result
}

function editConfig(file, policy) {
  const { ast, content } = file
  const properties = new Map(ast.properties.map((property) => [property.key, property]))
  const legacy = properties.get('permission')
  const native = properties.get('permissions')
  const edits = []

  if (legacy && commentsWithin(ast, legacy.valueStart, legacy.valueEnd)) {
    throw new Error(
      `${file.name} has comments inside the legacy permission value; it is preview-only to preserve comments.`,
    )
  }
  if (native && commentsWithin(ast, native.valueStart, native.valueEnd)) {
    throw new Error(
      `${file.name} has comments inside the permissions value; it is preview-only to preserve comments.`,
    )
  }

  if (native) {
    const indent = indentAt(content, native.keyStart)
    edits.push({
      start: native.valueStart,
      end: native.valueEnd,
      text: formatValue(policy, indent),
    })
    if (legacy) {
      if (commentsWithin(ast, legacy.keyStart, legacy.valueEnd)) {
        throw new Error(
          `${file.name} has comments attached to both permission keys; it is preview-only.`,
        )
      }
      if (legacy.commaAfter !== null) {
        if (commentsWithin(ast, legacy.keyStart, legacy.commaAfter + 1)) {
          throw new Error(
            `${file.name} has comments next to the legacy permission key; it is preview-only.`,
          )
        }
        edits.push({ start: legacy.keyStart, end: legacy.commaAfter + 1, text: '' })
      } else if (legacy.commaBefore !== null) {
        if (commentsWithin(ast, legacy.commaBefore, legacy.valueEnd)) {
          throw new Error(
            `${file.name} has comments next to the legacy permission key; it is preview-only.`,
          )
        }
        edits.push({ start: legacy.commaBefore, end: legacy.valueEnd, text: '' })
      } else {
        edits.push({ start: legacy.keyStart, end: legacy.valueEnd, text: '' })
      }
    }
  } else if (legacy) {
    const indent = indentAt(content, legacy.keyStart)
    edits.push({ start: legacy.keyStart, end: legacy.keyEnd, text: '"permissions"' })
    edits.push({
      start: legacy.valueStart,
      end: legacy.valueEnd,
      text: formatValue(policy, indent),
    })
  } else {
    const last = ast.properties.at(-1)
    const indent = last ? indentAt(content, last.keyStart) : '  '
    const beforeClose = content.slice(last?.valueEnd ?? ast.start + 1, ast.closeStart)
    if (commentsWithin(ast, last?.valueEnd ?? ast.start + 1, ast.closeStart)) {
      throw new Error(`${file.name} has trailing comments at the root; it is preview-only.`)
    }
    const hasTrailingComma = last?.commaAfter !== null && last?.commaAfter !== undefined
    const prefix = last ? (hasTrailingComma ? '' : ',') : ''
    const linePrefix = beforeClose.includes('\n') || content.includes('\n') ? '\n' : ' '
    const suffix = linePrefix
    const insertion = `${prefix}${linePrefix}${indent}"permissions": ${formatValue(policy, indent)}${suffix}`
    edits.push({ start: ast.closeStart, end: ast.closeStart, text: insertion })
  }

  const updated = applyTextEdits(content, edits)
  parseConfig(updated, file.format === 'jsonc')
  return updated
}

function formatDiff(name, before, after) {
  const oldLines = before.replace(/\n$/, '').split('\n')
  const newLines = after.replace(/\n$/, '').split('\n')
  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix)
  const newChanged = newLines.slice(prefix, newLines.length - suffix)
  return [
    `--- ${name}`,
    `+++ ${name} (proposed)`,
    ...oldLines.slice(Math.max(0, prefix - 2), prefix).map((line) => ` ${line}`),
    ...oldChanged.map((line) => `-${line}`),
    ...newChanged.map((line) => `+${line}`),
    ...oldLines
      .slice(oldLines.length - suffix, oldLines.length - suffix + 2)
      .map((line) => ` ${line}`),
  ].join('\n')
}

function emit(output, text = '') {
  if (typeof output === 'function') output(text)
  else if (typeof output.write === 'function') output.write(`${text}\n`)
  else output.log?.(text)
}

function describeValue(value) {
  return JSON.stringify(value)
}

function printInspection(files, sources, output) {
  emit(output, 'V2 config review (read-only until a separate apply confirmation):')
  emit(
    output,
    'OpenCode V2 loads opencode.json and opencode.jsonc as layers: .jsonc scalar values win and arrays are unioned. This review keeps them separate; no file is canonicalized or merged.',
  )
  for (const file of files) {
    if (!file.exists) {
      emit(output, `- ${file.name}: not present`)
      continue
    }
    if (file.parseError) {
      emit(output, `- ${file.name}: cannot safely parse (${file.parseError})`)
      continue
    }
    const relevant = ['permission', 'permissions']
      .filter((key) => Object.hasOwn(file.config, key))
      .map((key) => `${key}=${describeValue(file.config[key])}`)
    emit(
      output,
      `- ${file.name}: ${relevant.length ? relevant.join('; ') : 'no permission policy keys'}`,
    )
  }
  if (sources.length > 1) {
    emit(
      output,
      `Conflict: ${sources.length} policy sources are present. They will not be merged; choose one source and select every affected layer before writing.`,
    )
  }
  for (const source of sources) {
    for (const ask of getMcpAskEntries(source)) {
      emit(
        output,
        `MCP policy warning: ${ask.label} is "ask". OpenCode V2 cannot enforce ask for MCP; no allow/deny change is implied.`,
      )
    }
  }
}

function terminalPrompts() {
  return clack
}

/**
 * Review and optionally prepare V2 permission config in user-selected files.
 * Non-interactive calls only render a preview; they never write host config.
 */
export async function prepareV2Config({
  configDir,
  interactive = false,
  prompts = terminalPrompts(),
  output = console,
  filesystem = fs,
} = {}) {
  const files = inspectConfigFiles(configDir, filesystem)
  const parseFailure = files.find((file) => file.exists && file.parseError)
  const sources = policySources(files)
  printInspection(files, sources, output)

  if (parseFailure)
    return {
      status: 'blocked',
      reason: `${parseFailure.name} is not valid ${parseFailure.format.toUpperCase()}.`,
      changes: [],
    }
  if (sources.length === 0) {
    emit(output, 'No legacy permission policy needs V2 preparation; no files were changed.')
    return { status: 'unchanged', changes: [] }
  }

  if (!interactive) {
    const askEntries = sources.flatMap((source) => getMcpAskEntries(source))
    if (sources.length > 1 || askEntries.length > 0) {
      emit(
        output,
        'Preview only: source conflicts or MCP ask choices need an interactive review. No files were changed.',
      )
      return { status: 'preview', changes: [] }
    }
    const source = sources[0]
    if (source.key !== 'permission') {
      emit(
        output,
        'Preview only: the available policy is already in V2 form. No files were changed.',
      )
      return { status: 'preview', changes: [] }
    }
    try {
      const policy = makeV2Policy(source, {})
      const proposed = editConfig(source.file, policy)
      emit(output, formatDiff(source.file.name, source.file.content, proposed))
      emit(
        output,
        'Preview only: rerun interactively to choose target files and separately confirm apply. No files were changed.',
      )
      return {
        status: 'preview',
        changes: [{ path: source.file.path, original: source.file.content, contents: proposed }],
      }
    } catch (error) {
      emit(output, `Preview blocked: ${error.message}`)
      return { status: 'blocked', reason: error.message, changes: [] }
    }
  }

  if (sources.length === 1 && sources[0].key === 'permissions') {
    emit(output, 'The only policy source is already V2-native; no config changes are needed.')
    return { status: 'unchanged', changes: [] }
  }

  const reviewNow = await prompts.confirm({
    message:
      'Review and prepare V2 permission config now? No changes are made until a later apply confirmation.',
    initialValue: false,
  })
  if (prompts.isCancel?.(reviewNow) || reviewNow !== true) {
    prompts.cancel?.('V2 config preparation skipped; files were not changed.')
    return { status: 'skipped', changes: [] }
  }

  const targetOptions = files
    .filter((file) => file.exists)
    .map((file) => ({
      value: file.path,
      label: file.name,
      hint: 'Select explicitly to allow this file to be changed.',
    }))
  if (targetOptions.length === 0) {
    emit(
      output,
      'No existing config file was found. This stage does not create either filename automatically.',
    )
    return { status: 'unchanged', changes: [] }
  }
  const targetAnswer = await prompts.multiselect({
    message: 'Which existing config file(s) may be changed?',
    options: targetOptions,
    initialValues: [],
    required: false,
  })
  if (
    prompts.isCancel?.(targetAnswer) ||
    !Array.isArray(targetAnswer) ||
    targetAnswer.length === 0
  ) {
    prompts.cancel?.('Config preparation canceled; files were not changed.')
    return { status: 'canceled', changes: [] }
  }
  const targets = files.filter((file) => targetAnswer.includes(file.path))

  let selectedSource = sources[0]
  if (sources.length > 1) {
    const selected = await prompts.select({
      message:
        'Which single policy source should become the V2 permissions value? No policies will be merged.',
      options: sources.map((source) => ({
        value: source.id,
        label: `${source.file.name} → ${source.key}`,
        hint: describeValue(source.value),
      })),
    })
    if (prompts.isCancel?.(selected) || !selected) {
      prompts.cancel?.('Policy source not selected; files were not changed.')
      return { status: 'canceled', changes: [] }
    }
    selectedSource = sources.find((source) => source.id === selected)
    if (!selectedSource)
      return { status: 'blocked', reason: 'The selected policy source is invalid.', changes: [] }
    const policyFiles = new Set(sources.map((source) => source.file.path))
    if ([...policyFiles].some((filePath) => !targetAnswer.includes(filePath))) {
      const reason =
        'All files containing conflicting permission sources must be selected to resolve the layers; no files were changed.'
      emit(output, reason)
      return { status: 'blocked', reason, changes: [] }
    }
  }

  const askEntries = getMcpAskEntries(selectedSource)
  const askChoices = {}
  for (const ask of askEntries) {
    const selected = await prompts.select({
      message: `MCP permission ${ask.label} is "ask", which V2 cannot enforce. Choose the policy explicitly:`,
      options: [
        { value: 'allow', label: 'Allow all tools for this MCP server' },
        { value: 'deny', label: 'Deny all tools for this MCP server' },
      ],
    })
    if (prompts.isCancel?.(selected) || !['allow', 'deny'].includes(selected)) {
      prompts.cancel?.('MCP policy choice missing; files were not changed.')
      return { status: 'canceled', changes: [] }
    }
    askChoices[ask.id] = selected
  }

  let policy
  try {
    policy = makeV2Policy(selectedSource, askChoices)
  } catch (error) {
    emit(output, `Preview blocked: ${error.message}`)
    return { status: 'blocked', reason: error.message, changes: [] }
  }

  const changes = []
  try {
    for (const target of targets) {
      const contents = editConfig(target, policy)
      if (contents !== target.content)
        changes.push({ path: target.path, original: target.content, contents })
    }
  } catch (error) {
    emit(output, `Preview blocked: ${error.message}`)
    return { status: 'blocked', reason: error.message, changes: [] }
  }

  if (changes.length === 0) {
    emit(
      output,
      'The selected files already match the chosen V2 permissions policy; no files were changed.',
    )
    return { status: 'unchanged', changes: [] }
  }
  for (const change of changes) {
    const name = path.basename(change.path)
    emit(output, formatDiff(name, change.original, change.contents))
  }
  const accepted = await prompts.confirm({
    message: `Apply the reviewed changes to ${changes.length} file(s)? Backups will be created beside each file.`,
    initialValue: false,
  })
  if (prompts.isCancel?.(accepted) || accepted !== true) {
    prompts.cancel?.('Apply not confirmed; files were not changed.')
    return { status: 'canceled', changes }
  }

  try {
    const backups = applyConfigChanges(changes, { filesystem })
    for (const backup of backups) {
      emit(output, `Backup: ${backup.path}`)
      emit(output, `Rollback: copy ${backup.path} back to ${backup.target} after closing OpenCode.`)
    }
    return { status: 'applied', changes, backups }
  } catch (error) {
    emit(output, `Apply failed and rollback was attempted: ${error.message}`)
    return { status: 'failed', reason: error.message, changes: [] }
  }
}

function writeAtomic(filesystem, target, contents, mode) {
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`,
  )
  let descriptor
  try {
    descriptor = filesystem.openSync(temp, 'wx', mode)
    filesystem.writeFileSync(descriptor, contents, 'utf8')
    filesystem.fsyncSync(descriptor)
    filesystem.closeSync(descriptor)
    descriptor = undefined
  } catch (error) {
    if (descriptor !== undefined) filesystem.closeSync(descriptor)
    filesystem.rmSync(temp, { force: true })
    throw error
  }
  return temp
}

/** Back up, stage, and atomically replace reviewed config files, rolling back a partial apply. */
export function applyConfigChanges(changes, { filesystem = fs } = {}) {
  const backups = []
  const staged = []
  const applied = []
  let applying = false
  const stamp = `${new Date()
    .toISOString()
    .replaceAll(/[^0-9]/g, '')
    .slice(0, 14)}-${process.pid}`
  try {
    for (const change of changes) {
      const stat = filesystem.lstatSync(change.path)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Refusing to replace non-regular config file ${change.path}.`)
      }
      if (filesystem.readFileSync(change.path, 'utf8') !== change.original) {
        throw new Error(`Config changed after review (${change.path}); no files were changed.`)
      }
    }
    for (const change of changes) {
      const stat = filesystem.statSync(change.path)
      const backupPath = `${change.path}.setup-backup-${stamp}-${randomBytes(3).toString('hex')}`
      filesystem.copyFileSync(change.path, backupPath, fs.constants.COPYFILE_EXCL)
      backups.push({ target: change.path, path: backupPath })
      filesystem.chmodSync(backupPath, stat.mode & 0o777)
      const temp = writeAtomic(filesystem, change.path, change.contents, stat.mode & 0o777)
      staged.push({ ...change, temp, mode: stat.mode & 0o777 })
    }
    applying = true
    for (const item of staged) {
      filesystem.renameSync(item.temp, item.path)
      applied.push(item)
    }
    return backups
  } catch (error) {
    let rollbackFailed = false
    for (const item of applied.reverse()) {
      const backup = backups.find(({ target }) => target === item.path)
      if (!backup) continue
      let restoreTemp
      try {
        restoreTemp = writeAtomic(
          filesystem,
          item.path,
          filesystem.readFileSync(backup.path),
          item.mode,
        )
        filesystem.renameSync(restoreTemp, item.path)
      } catch (rollbackError) {
        rollbackFailed = true
        error.message += `; rollback failed for ${item.path}: ${rollbackError.message}; restore from ${backup.path}`
        if (restoreTemp) filesystem.rmSync(restoreTemp, { force: true })
      }
    }
    if (!applying || applied.length === 0 || !rollbackFailed) {
      for (const backup of backups) {
        try {
          filesystem.rmSync(backup.path, { force: true })
        } catch {
          // No config was changed; keep the original error as the visible cause.
        }
      }
    }
    throw error
  } finally {
    for (const item of staged) {
      try {
        filesystem.rmSync(item.temp, { force: true })
      } catch {
        // A failed cleanup must not mask the apply/rollback result.
      }
    }
  }
}
