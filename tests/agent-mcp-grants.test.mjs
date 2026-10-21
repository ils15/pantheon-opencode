/** Machine-check the canonical per-agent MCP grant declarations. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const AGENTS_DIR = join(ROOT, 'src', 'agents')
const MCP_DIR = join(ROOT, 'src', 'mcp')
const MCP_REGISTRY = join(ROOT, '.pantheon', 'mcp-registry.yml')

// These map installed server IDs to their canonical decorator-bearing sources;
// tool and resource names themselves are discovered from Python AST below.
const SERVER_SOURCES = {
  'pantheon-resources': 'mcp_resources.py',
  'pantheon-code-mode': 'code_mode.py',
  'pantheon-memory': 'memory_mcp.py',
  'pantheon-persistence': 'mcp_persistence.py',
  'pantheon-vision': 'pantheon_vision.py',
}

// Exact grants by bundled agent. Arrays are tool-name sets; `all` is retained
// for the resource-only server so changing that declaration is also reviewed.
// Keep this matrix branch-specific: only Zeus can use Persistence goal tools,
// because goals are scoped to the caller's session and cannot cross sessions.
const EXPECTED_AGENT_MCP_GRANTS = {
  aphrodite: {
    'pantheon-code-mode': ['execute_code_script'],
    'pantheon-memory': ['memory_search'],
    'pantheon-resources': 'all',
    'pantheon-vision': ['vision_analyze', 'vision_describe', 'vision_ocr'],
  },
  apollo: {
    'pantheon-memory': ['code_neighbors', 'code_query', 'memory_search'],
    'pantheon-resources': 'all',
  },
  athena: {
    'pantheon-memory': ['code_neighbors', 'code_query', 'memory_search'],
    'pantheon-resources': 'all',
  },
  demeter: {
    'pantheon-code-mode': ['execute_code_script'],
    'pantheon-memory': ['memory_search'],
    'pantheon-resources': 'all',
  },
  gaia: {
    'pantheon-memory': ['memory_recall'],
    'pantheon-resources': 'all',
    'pantheon-vision': ['vision_analyze', 'vision_describe', 'vision_ocr'],
  },
  hephaestus: {
    'pantheon-code-mode': ['execute_code_script'],
    'pantheon-memory': ['memory_search'],
    'pantheon-resources': 'all',
  },
  hermes: {
    'pantheon-code-mode': ['execute_code_script'],
    'pantheon-memory': ['memory_search'],
    'pantheon-resources': 'all',
  },
  iris: {
    'pantheon-memory': ['memory_recall'],
    'pantheon-resources': 'all',
  },
  mnemosyne: {
    'pantheon-code-mode': ['execute_code_script'],
    'pantheon-memory': [
      'memory_forget',
      'memory_list',
      'memory_recall',
      'memory_search',
      'memory_stats',
      'memory_store',
    ],
    'pantheon-resources': 'all',
  },
  nyx: {
    'pantheon-code-mode': ['execute_code_script'],
    'pantheon-memory': ['memory_search'],
    'pantheon-resources': 'all',
  },
  prometheus: {
    'pantheon-code-mode': ['execute_code_script'],
    'pantheon-memory': ['memory_search'],
    'pantheon-resources': 'all',
  },
  talos: {
    'pantheon-code-mode': ['execute_code_script'],
    'pantheon-memory': ['memory_recall'],
    'pantheon-resources': 'all',
  },
  themis: {
    'pantheon-code-mode': ['execute_code_script'],
    'pantheon-memory': ['memory_search'],
    'pantheon-resources': 'all',
  },
  zeus: {
    'pantheon-memory': ['memory_search'],
    'pantheon-persistence': [
      'context_get',
      'context_save',
      'goal_create',
      'goal_done',
      'goal_get',
      'goal_update',
    ],
    'pantheon-resources': 'all',
    'pantheon-vision': ['vision_describe'],
  },
}

// This is the intentional exception list. A newly exposed ungranted tool must
// be reviewed and added here explicitly; the test also rejects stale entries.
const UNREACHABLE_BY_ANY_AGENT = {
  'pantheon-code-mode': ['approve_code_script'],
  'pantheon-memory': ['code_index'],
}

const PYTHON_REGISTRATION_SCANNER = `
import ast
import json
import sys

sources = json.load(sys.stdin)
registrations = []
for filename, source in sources.items():
    tree = ast.parse(source, filename=filename)
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            call = decorator if isinstance(decorator, ast.Call) else None
            target = call.func if call else decorator
            if not isinstance(target, ast.Attribute) or target.attr not in {"tool", "resource"}:
                continue
            if not isinstance(target.value, ast.Name) or target.value.id != "mcp":
                raise ValueError(
                    f"{filename}:{node.lineno}: @{target.attr} decorator uses receiver "
                    f"{ast.dump(target.value, include_attributes=False)}; expected the literal mcp instance."
                )
            if target.attr == "tool":
                name_node = next(
                    (kw.value for kw in call.keywords if kw.arg == "name"), None
                ) if call else None
                if name_node is None and call and call.args:
                    name_node = call.args[0]
                name = ast.literal_eval(name_node) if name_node is not None else node.name
            else:
                if call is None or not call.args:
                    raise ValueError(f"{filename}:{node.lineno}: resource URI is not literal")
                name = ast.literal_eval(call.args[0])
            if not isinstance(name, str) or not name:
                raise ValueError(f"{filename}:{node.lineno}: registration name is not a non-empty string")
            registrations.append({
                "file": filename,
                "kind": target.attr,
                "name": name,
                "function": node.name,
                "line": node.lineno,
            })

print(json.dumps(registrations))
`

function discoverRuntimeRegistrations() {
  const sources = Object.fromEntries(
    readdirSync(MCP_DIR)
      .filter((filename) => filename.endsWith('.py'))
      .sort()
      .map((filename) => [filename, readFileSync(join(MCP_DIR, filename), 'utf8')]),
  )
  const result = spawnSync('python3', ['-c', PYTHON_REGISTRATION_SCANNER], {
    encoding: 'utf8',
    input: JSON.stringify(sources),
  })
  assert.equal(
    result.status,
    0,
    `Could not derive MCP registrations from src/mcp/*.py:\n${result.stderr || result.stdout}`,
  )

  const registry = Object.fromEntries(
    Object.keys(SERVER_SOURCES).map((server) => [server, { tools: [], resources: [] }]),
  )
  const serverForSource = new Map(
    Object.entries(SERVER_SOURCES).map(([server, filename]) => [filename, server]),
  )
  for (const registration of JSON.parse(result.stdout)) {
    const filename = basename(registration.file)
    const server = serverForSource.get(filename)
    assert.ok(
      server,
      `Unmapped @mcp.${registration.kind} registration ${registration.name} at ` +
        `src/mcp/${filename}:${registration.line}; add its server/source mapping to this test.`,
    )
    const names = registry[server][registration.kind === 'tool' ? 'tools' : 'resources']
    assert.ok(
      !names.some((entry) => entry.name === registration.name),
      `Duplicate runtime @mcp.${registration.kind} name ${registration.name} on ${server} ` +
        `(src/mcp/${filename}:${registration.line}).`,
    )
    names.push(registration)
  }

  for (const [server, source] of Object.entries(SERVER_SOURCES)) {
    assert.ok(
      registry[server].tools.length + registry[server].resources.length > 0,
      `${server} has no discoverable runtime registrations in src/mcp/${source}.`,
    )
  }
  return registry
}

function parseMcpToolsFrontmatter(markdown, filename) {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  assert.ok(frontmatter, `src/agents/${filename} has no YAML frontmatter.`)
  const lines = frontmatter[1].split(/\r?\n/)
  const start = lines.findIndex((line) => /^mcp_tools:\s*$/.test(line))
  assert.notEqual(start, -1, `Agent file src/agents/${filename} must declare mcp_tools.`)

  const grants = {}
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) continue
    if (!/^\s/.test(line)) break

    const entry = line.match(/^ {2}([A-Za-z0-9._-]+):(?:\s*(.*))?$/)
    if (entry) {
      const [, server, value = ''] = entry
      if (value === 'all') {
        grants[server] = 'all'
      } else if (value === '[]') {
        grants[server] = []
      } else if (/^\[.*\]$/.test(value)) {
        const values = value.slice(1, -1).trim()
        grants[server] = values ? values.split(',').map((tool) => tool.trim()) : []
      } else if (value === '') {
        grants[server] = []
        for (let item = index + 1; item < lines.length; item += 1) {
          const listItem = lines[item].match(/^ {4}- ([A-Za-z0-9._-]+)\s*$/)
          if (listItem) {
            grants[server].push(listItem[1])
            index = item
            continue
          }
          if (!lines[item].trim()) continue
          break
        }
      } else {
        assert.fail(
          `Unsupported mcp_tools.${server} YAML value in src/agents/${filename}: ${value}`,
        )
      }
      continue
    }

    assert.fail(`Unsupported mcp_tools YAML syntax in src/agents/${filename}: ${line}`)
  }
  return grants
}

function readBundledAgents() {
  return readdirSync(AGENTS_DIR)
    .filter((filename) => filename.endsWith('.md') && filename.toLowerCase() !== 'readme.md')
    .sort()
    .map((filename) => {
      const text = readFileSync(join(AGENTS_DIR, filename), 'utf8')
      const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
      assert.ok(frontmatter, `src/agents/${filename} has no YAML frontmatter.`)
      const name =
        frontmatter[1].match(/^name:\s*([^\r\n#]+)\s*$/m)?.[1] ?? filename.replace(/\.md$/i, '')
      return {
        name: name.replace(/^['"]|['"]$/g, ''),
        filename,
        mcpTools: parseMcpToolsFrontmatter(text, filename),
      }
    })
}

function normalizeMcpTools(grants) {
  return Object.fromEntries(
    Object.entries(grants)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([server, tools]) => [server, tools === 'all' ? 'all' : [...tools].sort()]),
  )
}

function formatUnreachableDocs(unreachable) {
  const rows = Object.entries(unreachable)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([server, tools]) => `| ${server} | ${tools.map((tool) => `\`${tool}\``).join(', ')} |`)
  return [
    '## Unreachable by any agent',
    '',
    'These tools are registered by the runtime sources but no bundled agent grants them. This is intentional pending a future evidence-based grant; the list is verified against the MCP decorators and agent frontmatter by `tests/agent-mcp-grants.test.mjs`.',
    '',
    '| Server | Exposed tools with no agent grant |',
    '|--------|-----------------------------------|',
    ...rows,
  ].join('\n')
}

test('bundled agent MCP grants match runtime registrations and documented unreachable tools', () => {
  assert.equal(
    existsSync(MCP_REGISTRY),
    false,
    '.pantheon/mcp-registry.yml must not exist: src/agents/*.md mcp_tools is the sole MCP grant source.',
  )

  const registry = discoverRuntimeRegistrations()
  const agents = readBundledAgents()
  const agentNames = new Set()
  const grantedByServer = new Map(Object.keys(SERVER_SOURCES).map((server) => [server, new Set()]))

  assert.deepEqual(
    agents.map(({ name }) => name).sort(),
    Object.keys(EXPECTED_AGENT_MCP_GRANTS).sort(),
    'Bundled agent set changed; review and update EXPECTED_AGENT_MCP_GRANTS before changing MCP grants.',
  )

  for (const agent of agents) {
    assert.ok(!agentNames.has(agent.name), `Duplicate bundled agent name ${agent.name}.`)
    agentNames.add(agent.name)

    const expectedGrants = EXPECTED_AGENT_MCP_GRANTS[agent.name]
    assert.ok(expectedGrants, `Agent ${agent.name} has no tracked MCP grant matrix entry.`)
    for (const [server, tools] of Object.entries(agent.mcpTools)) {
      if (Array.isArray(tools)) {
        assert.equal(
          new Set(tools).size,
          tools.length,
          `Agent ${agent.name} repeats a tool in mcp_tools.${server}; remove the duplicate grant.`,
        )
      }
    }
    assert.deepEqual(
      normalizeMcpTools(agent.mcpTools),
      expectedGrants,
      `Agent ${agent.name} MCP grants differ from EXPECTED_AGENT_MCP_GRANTS. ` +
        `Review the individual grant change and update this matrix only when intended.`,
    )

    for (const [server, grant] of Object.entries(agent.mcpTools)) {
      const runtime = registry[server]
      assert.ok(
        runtime,
        `Agent ${agent.name} declares mcp_tools.${server}, but no bundled runtime MCP server/source is registered for that server.`,
      )
      assert.ok(
        grant === 'all' || Array.isArray(grant),
        `Agent ${agent.name} mcp_tools.${server} must be "all" or an array of registered tool names.`,
      )

      if (grant === 'all') {
        assert.ok(
          runtime.tools.length + runtime.resources.length > 0,
          `Agent ${agent.name} grants all on ${server}, but its runtime source exposes no tools or resources.`,
        )
        for (const { name } of runtime.tools) grantedByServer.get(server).add(name)
        continue
      }

      for (const tool of grant) {
        assert.equal(
          typeof tool,
          'string',
          `Agent ${agent.name} mcp_tools.${server} contains a non-string grant: ${JSON.stringify(tool)}.`,
        )
        const exposed = runtime.tools.some((entry) => entry.name === tool)
        assert.ok(
          exposed,
          `Agent ${agent.name} grants ${server}/${tool}, but src/mcp/${SERVER_SOURCES[server]} has no matching @mcp.tool registration.`,
        )
        grantedByServer.get(server).add(tool)
      }
    }
  }

  const actualUnreachable = {}
  for (const [server, runtime] of Object.entries(registry)) {
    const granted = grantedByServer.get(server)
    const unreachable = runtime.tools
      .map(({ name }) => name)
      .filter((name) => !granted.has(name))
      .sort()
    if (unreachable.length > 0) actualUnreachable[server] = unreachable
  }

  assert.deepEqual(
    actualUnreachable,
    UNREACHABLE_BY_ANY_AGENT,
    `Runtime tools with no bundled-agent grant differ from the tracked unreachable-by-any-agent allowlist.\n` +
      `Actual: ${JSON.stringify(actualUnreachable, null, 2)}\n` +
      `Allowlist: ${JSON.stringify(UNREACHABLE_BY_ANY_AGENT, null, 2)}\n` +
      'Review the evidence before changing the allowlist or any agent grant.',
  )

  const docs = readFileSync(join(ROOT, 'docs', 'mcp-tools.md'), 'utf8')
  const expectedSection = formatUnreachableDocs(actualUnreachable)
  const sectionStart = docs.indexOf('## Unreachable by any agent\n')
  assert.notEqual(sectionStart, -1, 'docs/mcp-tools.md is missing the unreachable-tools section.')
  const followingHeading = docs.indexOf('\n## ', sectionStart + 1)
  const documentedSection = docs
    .slice(sectionStart, followingHeading === -1 ? undefined : followingHeading)
    .trimEnd()
  assert.equal(
    documentedSection,
    expectedSection,
    'docs/mcp-tools.md unreachable-tools section must exactly match the source-derived grant reality.',
  )
})

test('Python AST registration scanner accepts supported decorators and rejects renamed MCP receivers', () => {
  const accepted = spawnSync('python3', ['-c', PYTHON_REGISTRATION_SCANNER], {
    encoding: 'utf8',
    input: JSON.stringify({
      'decorator-fixtures.py': [
        '@mcp.tool',
        'def bare_form(): pass',
        '@mcp.tool()',
        'def no_args_form(): pass',
        '@mcp.tool("positional_name")',
        'def positional_form(): pass',
        '@mcp.tool(name="keyword_name")',
        'def keyword_form(): pass',
      ].join('\n'),
    }),
  })
  assert.equal(
    accepted.status,
    0,
    `AST scanner rejected a supported @mcp.tool form:\n${accepted.stderr || accepted.stdout}`,
  )
  assert.deepEqual(
    JSON.parse(accepted.stdout).map(({ name }) => name),
    ['bare_form', 'no_args_form', 'positional_name', 'keyword_name'],
  )

  const renamed = spawnSync('python3', ['-c', PYTHON_REGISTRATION_SCANNER], {
    encoding: 'utf8',
    input: JSON.stringify({
      'renamed-mcp.py': 'other = object()\n@other.tool()\ndef hidden_tool(): pass\n',
    }),
  })
  assert.notEqual(
    renamed.status,
    0,
    'AST scanner must reject a non-literal mcp decorator receiver.',
  )
  assert.match(
    renamed.stderr,
    /expected the literal mcp instance/,
    'Receiver error should explain that the canonical FastMCP instance must be named mcp.',
  )
})
