/**
 * Native On-Demand Specialist Agent Forge (`agent-forge-tool.ts`).
 *
 * Allows users and `@zeus` to keep the core Pantheon roster 100% polyglot and
 * language-agnostic while effortlessly forging custom, project-scoped domain
 * specialists in `<workspace>/.opencode/agents/<name>.md`.
 *
 * Capabilities:
 * - `create`: Generates a complete, schema-valid OpenCode 2.x agent definition
 *   (`.opencode/agents/<name>.md`) from a domain archetype (`backend`, `frontend`,
 *   `data`, `security`, `ml-pipeline`, `geospatial`, `custom`) with tailored
 *   permissions, stack conventions, and sub-10s test-slicing gates.
 * - `list`: Lists all custom project specialists in `.opencode/agents/`.
 * - `inspect`: Reads a custom project specialist definition.
 * - `remove`: Deletes a custom project specialist from `.opencode/agents/`.
 *
 * @module pantheon/agent-forge-tool
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { PANTHEON_AGENTS } from './delegation-policy.ts'
import { resolveToolCwd } from './tool-context.ts'
import type { PantheonToolDef, PantheonToolResult } from './tools.ts'

export type ForgeArchetype =
  | 'backend'
  | 'frontend'
  | 'data'
  | 'security'
  | 'ml-pipeline'
  | 'geospatial'
  | 'custom'

const SAFE_AGENT_NAME_RE = /^[a-z][a-z0-9-]{1,48}$/

function isValidAgentSlug(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    SAFE_AGENT_NAME_RE.test(value) &&
    !value.includes('..') &&
    !value.includes('/') &&
    !value.includes('\\')
  )
}

function resolveAgentsDir(workspaceDir: string): string {
  const dir = join(workspaceDir, '.opencode', 'agents')
  mkdirSync(dir, { recursive: true })
  return realpathSync(dir)
}

function resolveConfinedAgentFile(agentsDir: string, name: string): string {
  const filePath = resolve(agentsDir, `${name}.md`)
  const prefix = agentsDir.endsWith(sep) ? agentsDir : `${agentsDir}${sep}`
  if (!filePath.startsWith(prefix)) {
    throw new Error('Path traversal denied: agent file escapes .opencode/agents')
  }
  return filePath
}

function buildAgentMarkdown(params: {
  name: string
  description: string
  archetype: ForgeArchetype
  stack: string[]
  readOnly: boolean
  testCommand: string
  conventions: string[]
}): string {
  const { name, description, archetype, stack, readOnly, testCommand, conventions } = params
  const stackLine = stack.length > 0 ? stack.join(', ') : 'Polyglot project stack'
  const permEdit = readOnly ? 'deny' : 'allow'
  const permShell = readOnly ? 'deny' : 'allow'
  const roleKind = readOnly
    ? 'READ-ONLY ANALYSIS & AUDIT SPECIALIST'
    : 'DOMAIN IMPLEMENTATION SPECIALIST'

  const conventionBullets =
    conventions.length > 0
      ? conventions.map((c) => `- ${c}`).join('\n')
      : [
          `- Adapt idiomatic patterns to the active stack (${stackLine}).`,
          '- Follow strict TDD (RED -> GREEN -> REFACTOR) for behavioral changes.',
          '- Never introduce mock servers on real service ports; fail fast on missing dependencies.',
        ].join('\n')

  return [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    'mode: subagent',
    `temperature: ${readOnly ? '0.1' : '0.2'}`,
    'permission:',
    '  read: allow',
    '  grep: allow',
    '  glob: allow',
    `  edit: ${permEdit}`,
    `  hashline_edit: ${permEdit}`,
    `  bash: ${permShell}`,
    `  shell: ${permShell}`,
    `  execute: ${permShell}`,
    '  todowrite: allow',
    '  todoread: allow',
    '  task:',
    '    "*": deny',
    '---',
    '',
    `# @${name} — ${description}`,
    '',
    `- **Archetype:** \`${archetype}\` (${roleKind})`,
    `- **Target Stack & Domain:** ${stackLine}`,
    `- **Default Verification Slice:** \`${testCommand}\``,
    '',
    '## Role & Execution Boundaries',
    '',
    readOnly
      ? 'You are a **READ-ONLY** domain specialist. Inspect files, analyze patterns, and return structured findings with file:line references. Never modify files or run mutating commands.'
      : 'You are a **bounded domain implementer**. Inspect relevant files directly, apply surgical edits using `hashline_edit` or `edit`, and verify every change using the narrowest test slice (<10s).',
    '',
    '## Domain Conventions & Quality Gates',
    '',
    conventionBullets,
    '',
    '## Strict Test Slicing & Return Contract',
    '',
    `- Run only the targeted slice (\`${testCommand}\`); never run unconstrained full-repository suites during iterative loops.`,
    '- Return a concise `## subtask_summary` with `files_changed`, `summary`, `tests` (`[PASS|WARN|FAIL] <cmd>`), `status`, and `blockers`.',
    '',
  ].join('\n')
}

function jsonResult(payload: unknown): PantheonToolResult {
  return { output: JSON.stringify(payload) }
}

export function createAgentForgeTool(fallbackDir?: string): PantheonToolDef {
  return {
    name: 'pantheon_agent_forge',
    description:
      'Create, list, inspect, or remove custom project-scoped domain specialist agents in .opencode/agents/<name>.md. Always list first; when a project needs deep stack-specific conventions beyond the agnostic canonical roster, proactively use the question tool to ask before creating.',
    input: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'inspect', 'remove'],
          description: 'Forge operation to execute',
        },
        name: {
          type: 'string',
          description: 'Lowercase kebab-case agent identifier (e.g. rust-embedded, prisma-dba)',
        },
        description: {
          type: 'string',
          description: 'One-line role summary used for routing and @mention discovery',
        },
        archetype: {
          type: 'string',
          enum: ['backend', 'frontend', 'data', 'security', 'ml-pipeline', 'geospatial', 'custom'],
          description: 'Base specialist template',
        },
        stack: {
          type: 'array',
          items: { type: 'string' },
          description: 'Technologies, frameworks, or domain libraries this specialist owns',
        },
        readOnly: {
          type: 'boolean',
          description:
            'When true, denies file edits and shell execution (investigation/audit only)',
        },
        testCommand: {
          type: 'string',
          description: 'Default targeted verification slice command (<10s)',
        },
        conventions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Domain-specific rules and invariants enforced by this agent',
        },
        allowOverrideCanonical: {
          type: 'boolean',
          description: 'Allow creating a project override for a built-in Pantheon agent name',
        },
      },
    },
    output: {},
    execute: async (input, context) => {
      try {
        const action = typeof input.action === 'string' ? input.action : 'list'
        const cwd = resolveToolCwd(context, fallbackDir)
        const agentsDir = resolveAgentsDir(cwd)

        if (action === 'list') {
          const files = readdirSync(agentsDir)
            .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
            .sort()
          const agents = files.map((file) => {
            const id = file.replace(/\.md$/, '')
            const raw = readFileSync(join(agentsDir, file), 'utf8')
            const descMatch = raw.match(/^description:\s*(.+)$/m)
            return {
              name: id,
              path: `.opencode/agents/${file}`,
              description: descMatch?.[1]?.replace(/^["']|["']$/g, '') ?? '',
            }
          })
          return jsonResult({ ok: true, count: agents.length, agents })
        }

        const name = typeof input.name === 'string' ? input.name.trim().toLowerCase() : ''
        if (!isValidAgentSlug(name)) {
          return jsonResult({
            ok: false,
            error: 'name must be a lowercase kebab-case identifier (2..49 chars, [a-z0-9-])',
          })
        }

        const filePath = resolveConfinedAgentFile(agentsDir, name)

        if (action === 'inspect') {
          if (!existsSync(filePath)) {
            return jsonResult({ ok: false, error: 'agent_not_found', name })
          }
          return jsonResult({
            ok: true,
            name,
            path: `.opencode/agents/${name}.md`,
            content: readFileSync(filePath, 'utf8'),
          })
        }

        if (action === 'remove') {
          if (!existsSync(filePath)) {
            return jsonResult({ ok: false, error: 'agent_not_found', name })
          }
          rmSync(filePath, { force: true })
          return jsonResult({ ok: true, removed: true, name })
        }

        if (action === 'create') {
          if (PANTHEON_AGENTS.has(name) && input.allowOverrideCanonical !== true) {
            return jsonResult({
              ok: false,
              error: `"${name}" is a canonical Pantheon agent. Pass allowOverrideCanonical: true only if you intentionally want a project-local override.`,
            })
          }
          const description =
            typeof input.description === 'string' && input.description.trim()
              ? input.description.trim()
              : `Custom ${name} specialist`
          const archetype: ForgeArchetype =
            typeof input.archetype === 'string' &&
            [
              'backend',
              'frontend',
              'data',
              'security',
              'ml-pipeline',
              'geospatial',
              'custom',
            ].includes(input.archetype)
              ? (input.archetype as ForgeArchetype)
              : 'custom'
          const readOnly =
            typeof input.readOnly === 'boolean'
              ? input.readOnly
              : archetype === 'security' || archetype === 'geospatial'
          const stack = Array.isArray(input.stack) ? input.stack.map(String) : []
          const testCommand =
            typeof input.testCommand === 'string' && input.testCommand.trim()
              ? input.testCommand.trim()
              : 'npm run test:slice'
          const conventions = Array.isArray(input.conventions) ? input.conventions.map(String) : []

          const markdown = buildAgentMarkdown({
            name,
            description,
            archetype,
            stack,
            readOnly,
            testCommand,
            conventions,
          })
          writeFileSync(filePath, markdown, 'utf8')
          return jsonResult({
            ok: true,
            created: true,
            name,
            path: `.opencode/agents/${name}.md`,
            readOnly,
            archetype,
          })
        }

        return jsonResult({ ok: false, error: `Unsupported action: ${action}` })
      } catch (err) {
        return jsonResult({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
}
