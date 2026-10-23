/**
 * Doc contract for the `pantheon-code-mode` section of docs/mcp-tools.md.
 *
 * The section must list exactly the tools registered in src/mcp/code_mode.py —
 * names and parameter lists — and exactly the agents whose frontmatter grants
 * `pantheon-code-mode`. Adding or removing a tool, changing a signature, or
 * changing an agent grant therefore fails until the doc is updated.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { test } from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const DOC = join(ROOT, 'docs', 'mcp-tools.md')
const CODE_MODE_SOURCE = join(ROOT, 'src', 'mcp', 'code_mode.py')
const AGENTS_DIR = join(ROOT, 'src', 'agents')

const TOOL_SCANNER = `
import ast
import json
import sys

tree = ast.parse(sys.stdin.read())
tools = []
for node in ast.walk(tree):
    if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        continue
    for decorator in node.decorator_list:
        if not (isinstance(decorator, ast.Call) and isinstance(decorator.func, ast.Attribute)):
            continue
        if decorator.func.attr != "tool":
            continue
        if not isinstance(decorator.func.value, ast.Name) or decorator.func.value.id != "mcp":
            raise SystemExit(f"line {node.lineno}: @tool decorator must use the mcp instance")
        name = next((kw.value for kw in decorator.keywords if kw.arg == "name"), None)
        if name is None and decorator.args:
            name = decorator.args[0]
        positional = [*node.args.posonlyargs, *node.args.args]
        defaults = [None] * (len(positional) - len(node.args.defaults))
        defaults += list(node.args.defaults)
        params = [
            {"name": arg.arg, "required": default is None}
            for arg, default in zip(positional, defaults)
        ]
        for arg, default in zip(node.args.kwonlyargs, node.args.kw_defaults):
            params.append({"name": arg.arg, "required": default is None})
        tools.append({
            "name": ast.literal_eval(name) if name is not None else node.name,
            "params": params,
        })
tools.sort(key=lambda tool: tool["name"])
print(json.dumps(tools))
`

/** Registered tools as `{name, params: [{name, required}]}`, sorted by name. */
function registeredTools() {
  const result = spawnSync('python3', ['-c', TOOL_SCANNER], {
    encoding: 'utf8',
    input: readFileSync(CODE_MODE_SOURCE, 'utf8'),
  })
  assert.equal(
    result.status,
    0,
    `Could not scan src/mcp/code_mode.py for @mcp.tool registrations:\n${result.stderr || result.stdout}`,
  )
  return JSON.parse(result.stdout)
}

function codeModeSection() {
  const doc = readFileSync(DOC, 'utf8')
  const start = doc.indexOf('### pantheon-code-mode')
  assert.notEqual(start, -1, 'docs/mcp-tools.md is missing the pantheon-code-mode section.')
  const end = doc.indexOf('\n### ', start + 1)
  return doc.slice(start, end === -1 ? undefined : end)
}

/** Split `(a: int, b?: list[str])` into ordered `{name, required}` parameters. */
function parseSignature(signature) {
  const inner = signature.trim().replace(/^\(/, '').replace(/\)$/, '').trim()
  if (!inner) return []
  const parts = []
  let depth = 0
  let current = ''
  for (const char of inner) {
    if ('[('.includes(char)) depth += 1
    if (')]'.includes(char)) depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.map((part) => {
    const match = part.trim().match(/^([a-z_][a-z0-9_]*)(\?)?:/)
    assert.ok(match, `Unparsable parameter in documented signature "${signature}": ${part.trim()}`)
    return { name: match[1], required: match[2] !== '?' }
  })
}

/** Tool rows of the code-mode table as `{name, params}`, sorted by name. */
function documentedTools(section) {
  return section
    .split('\n')
    .map((line) => line.match(/^\|\s*`([a-z0-9_]+)`\s*\|\s*`([^`]+)`\s*\|/))
    .filter(Boolean)
    .map((match) => ({ name: match[1], params: parseSignature(match[2]) }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function documentedAgents(section, label) {
  const line = section.match(new RegExp(`^\\*\\*${label}:\\*\\*\\s*(.+)$`, 'm'))
  assert.ok(line, `docs/mcp-tools.md code-mode section is missing the "${label}" list.`)
  return [...line[1].matchAll(/`([a-z0-9_-]+)`/g)].map((match) => match[1]).sort()
}

function documentedUseCaseAgents(section) {
  const start = section.indexOf('**Use cases by agent**')
  assert.notEqual(start, -1, 'docs/mcp-tools.md code-mode section is missing the use-cases table.')
  const end = section.indexOf('\n**', start + 1)
  const table = section.slice(start, end === -1 ? undefined : end)
  return [...table.matchAll(/^\|\s*([a-z][a-z0-9_-]*)\s*\|/gm)]
    .map((match) => match[1])
    .filter((name) => name !== 'agent')
    .sort()
}

function grantedTools(filename, allToolNames) {
  const text = readFileSync(join(AGENTS_DIR, filename), 'utf8')
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  assert.ok(frontmatter, `src/agents/${filename} has no YAML frontmatter.`)
  const lines = frontmatter[1].split(/\r?\n/)
  const prefix = '  pantheon-code-mode:'
  const index = lines.findIndex((line) => line.startsWith(prefix))
  if (index === -1) return []
  const value = lines[index].slice(prefix.length).trim()
  // `all` is a legal grant (see tests/agent-mcp-grants.test.mjs); it means every
  // tool the server registers.
  if (value === 'all') return [...allToolNames]
  if (/^\[.*\]$/.test(value)) {
    return value
      .slice(1, -1)
      .split(',')
      .map((tool) => tool.trim())
      .filter(Boolean)
  }
  if (value === '') {
    const tools = []
    for (let item = index + 1; item < lines.length; item += 1) {
      const listItem = lines[item].match(/^ {4}- ([A-Za-z0-9._-]+)\s*$/)
      if (!listItem) break
      tools.push(listItem[1])
    }
    return tools
  }
  assert.fail(`Unsupported mcp_tools.pantheon-code-mode value in src/agents/${filename}: ${value}`)
}

function bundledAgents(allToolNames) {
  return readdirSync(AGENTS_DIR)
    .filter((filename) => filename.endsWith('.md') && filename.toLowerCase() !== 'readme.md')
    .sort()
    .map((filename) => ({
      name: basename(filename, '.md'),
      tools: grantedTools(filename, allToolNames),
    }))
}

test('docs/mcp-tools.md lists exactly the tools and parameters registered by pantheon-code-mode', () => {
  assert.deepEqual(
    documentedTools(codeModeSection()),
    registeredTools(),
    'docs/mcp-tools.md code-mode tool table must list exactly the @mcp.tool names and ' +
      'parameters registered in src/mcp/code_mode.py (a parameter marked `?` is optional).',
  )
})

test('docs/mcp-tools.md code-mode agent grants match the bundled agent frontmatter', () => {
  const tools = registeredTools()
  const toolNames = tools.map(({ name }) => name)
  const agents = bundledAgents(toolNames)
  const section = codeModeSection()

  for (const agent of agents) {
    for (const tool of agent.tools) {
      assert.ok(
        toolNames.includes(tool),
        `src/agents/${agent.name}.md grants pantheon-code-mode/${tool}, but ` +
          'src/mcp/code_mode.py registers no such tool.',
      )
    }
  }

  const granted = agents
    .filter((agent) => agent.tools.length > 0)
    .map((agent) => agent.name)
    .sort()
  const withoutGrant = agents
    .filter((agent) => agent.tools.length === 0)
    .map((agent) => agent.name)
    .sort()

  assert.deepEqual(
    documentedAgents(section, 'Agents granted'),
    granted,
    'docs/mcp-tools.md "Agents granted" must equal the agents whose frontmatter grants ' +
      'pantheon-code-mode.',
  )
  assert.deepEqual(
    documentedAgents(section, 'Agents without a grant'),
    withoutGrant,
    'docs/mcp-tools.md "Agents without a grant" must equal the remaining bundled agents.',
  )
  assert.deepEqual(
    [...new Set([...granted, ...withoutGrant])].sort(),
    agents.map((agent) => agent.name).sort(),
    'Every bundled agent must appear on exactly one docs/mcp-tools.md code-mode grant list.',
  )
})

test('docs/mcp-tools.md code-mode use-case table only names granted agents', () => {
  const tools = registeredTools()
  const granted = new Set(
    bundledAgents(tools.map(({ name }) => name))
      .filter((agent) => agent.tools.length > 0)
      .map((agent) => agent.name),
  )
  const documented = documentedUseCaseAgents(codeModeSection())
  assert.deepEqual(
    documented.filter((name) => !granted.has(name)),
    [],
    'Every agent in the docs/mcp-tools.md code-mode use-case table must hold a ' +
      'pantheon-code-mode grant; unlisted agents cannot run execute_code_script.',
  )
})
