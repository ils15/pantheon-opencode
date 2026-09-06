/**
 * V2 Tool Definitions — the 9 Pantheon orchestration tools adapted for the
 * V2 plugin API. Each tool wraps existing V1 infrastructure (delegation,
 * goal-loop, hashline, cost-command, model-command) into a unified
 * `{ name, description, input, execute }` shape compatible with V2's
 * `ctx.tool.transform()`.
 *
 * These definitions are PURE — they don't import any V1 plugin types.
 * The execute functions use a structural `ToolContextLike` surface that
 * both V1 and V2 can satisfy.
 *
 * @module pantheon/v2-tool-definitions
 */

import type { z } from 'zod'
import type { CostCommand } from './cost-command.ts'
import type { DelegationToolset } from './delegation.ts'
import type { GoalToolset } from './goal-loop.ts'
import type { ModelToolset } from './model-command.ts'

// ─── Structural Context ──────────────────────────────────────────────────

/**
 * Minimal structural context passed to V2 tool execute functions.
 * Matches V1's ToolContextLike but avoids importing V1 types.
 */
export interface V2ToolContext {
  sessionID: string
  directory?: string
  worktree?: string
  agent?: string
}

/**
 * A V2-compatible tool definition: name + description + JSON-Schema input
 * + async execute function.
 */
export interface V2ToolDefinition {
  name: string
  description: string
  input: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  execute: (input: Record<string, unknown>, context: V2ToolContext) => Promise<string>
}

// ─── Zod → JSON-Schema Helpers ──────────────────────────────────────────

/**
 * Convert a zod ZodRawShape to a minimal JSON-Schema properties object.
 * Uses safe introspection: checks for `.describe()` and basic shape keys.
 * Falls back to `{ type: "string" }` for unrecognizable schemas.
 */
function zodShapeToJsonSchema(
  shape: z.ZodRawShape,
  required: string[] = [],
): { properties: Record<string, unknown>; required?: string[] } {
  const properties: Record<string, unknown> = {}
  for (const [key, schema] of Object.entries(shape)) {
    const prop: Record<string, unknown> = {}

    // Get description via .describe() if available
    try {
      const schemaAsObj = schema as unknown as Record<string, unknown>
      const describeFn = schemaAsObj.describe
      if (typeof describeFn === 'function') {
        const desc = (describeFn as () => string).call(schemaAsObj)
        if (typeof desc === 'string' && desc !== '') {
          prop.description = desc
        }
      }
    } catch {
      // Some zod types may throw on describe()
    }

    // Detect type from constructor name or _def.type (works across zod versions)
    const typeName = schema.constructor?.name ?? ''
    const defObj = (schema as unknown as { _def?: Record<string, unknown> })?._def
    const defType = (defObj?.typeName as string) ?? ''

    if (typeName.includes('ZodString') || defType === 'ZodString') {
      prop.type = 'string'
    } else if (typeName.includes('ZodNumber') || defType === 'ZodNumber') {
      prop.type = 'number'
    } else if (typeName.includes('ZodBoolean') || defType === 'ZodBoolean') {
      prop.type = 'boolean'
    } else if (typeName.includes('ZodEnum') || defType === 'ZodEnum') {
      prop.type = 'string'
      // Safely extract enum values
      try {
        const schemaObj = schema as unknown as Record<string, unknown>
        const defObj = schemaObj._def as Record<string, unknown> | undefined
        const values = (schemaObj.options ?? defObj?.values) as string[] | undefined
        if (Array.isArray(values)) prop.enum = values
      } catch {
        /* ignore */
      }
    } else if (typeName.includes('ZodArray') || defType === 'ZodArray') {
      prop.type = 'array'
    } else if (typeName.includes('ZodOptional') || defType === 'ZodOptional') {
      // Optional wrappers — treat as string by default
      prop.type = 'string'
    } else {
      prop.type = 'string'
    }

    properties[key] = prop
  }

  const result: { properties: Record<string, unknown>; required?: string[] } = { properties }
  if (required.length > 0) {
    result.required = required
  }
  return result
}

// ─── V2 Tool Factory ────────────────────────────────────────────────────

export interface V2ToolFactoryDeps {
  delegation: DelegationToolset
  goalTools: GoalToolset
  costCommand: CostCommand
  modelCommand: ModelToolset
}

/**
 * Create all 9 V2 tool definitions from the V1 infrastructure.
 * These can be registered via `ctx.tool.transform()` or used directly.
 */
export function createV2ToolDefinitions(deps: V2ToolFactoryDeps): V2ToolDefinition[] {
  const { delegation, goalTools, costCommand, modelCommand } = deps

  return [
    // 1. pantheon_delegate
    {
      name: 'pantheon_delegate',
      description: delegation.pantheon_delegate.description,
      input: {
        type: 'object',
        ...zodShapeToJsonSchema(delegation.pantheon_delegate.args as z.ZodRawShape, [
          'prompt',
          'agent',
        ]),
      },
      execute: async (input, ctx) => {
        return delegation.pantheon_delegate.execute(
          input as Parameters<typeof delegation.pantheon_delegate.execute>[0],
          ctx,
        )
      },
    },

    // 2. pantheon_delegation_read
    {
      name: 'pantheon_delegation_read',
      description: delegation.pantheon_delegation_read.description,
      input: {
        type: 'object',
        ...zodShapeToJsonSchema(delegation.pantheon_delegation_read.args as z.ZodRawShape, ['id']),
      },
      execute: async (input, ctx) => {
        return delegation.pantheon_delegation_read.execute(
          input as Parameters<typeof delegation.pantheon_delegation_read.execute>[0],
          ctx,
        )
      },
    },

    // 3. pantheon_delegation_list
    {
      name: 'pantheon_delegation_list',
      description: delegation.pantheon_delegation_list.description,
      input: {
        type: 'object',
        properties: {},
      },
      execute: async (input, ctx) => {
        return delegation.pantheon_delegation_list.execute(
          input as Parameters<typeof delegation.pantheon_delegation_list.execute>[0],
          ctx,
        )
      },
    },

    // 4. hashline_edit
    {
      name: 'hashline_edit',
      description:
        'Edit a file anchored by hashline refs (LINE#TAG) instead of raw line numbers. ' +
        'Ops: replace (ref..endRef or single ref → lines), append/prepend (anchor ref → content), ' +
        'delete (ref..endRef). ALL refs must be validated against the ORIGINAL file before anything ' +
        'is written; on mismatch the tool returns an error with a re-tagged excerpt and a ' +
        'Did-you-mean suggestion, and nothing is modified.',
      input: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Absolute path to the file to edit.' },
          edits: {
            type: 'array',
            description: 'List of edit operations to apply.',
            items: {
              type: 'object',
              properties: {
                op: {
                  type: 'string',
                  enum: ['replace', 'append', 'prepend', 'delete'],
                  description: 'The edit operation.',
                },
                ref: {
                  type: 'string',
                  description: 'Anchor ref "LINE#TAG" against the ORIGINAL snapshot.',
                },
                endRef: {
                  type: 'string',
                  description: 'Optional range end for replace/delete ("LINE#TAG").',
                },
                lines: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Replacement lines (replace).',
                },
                content: {
                  type: 'string',
                  description: 'Text to insert (append/prepend; split on newlines).',
                },
              },
              required: ['op', 'ref'],
            },
          },
        },
        required: ['file', 'edits'],
      },
      execute: async (input, ctx) => {
        // hashline_edit uses a different execute signature — it takes (args, toolContext)
        // where toolContext includes sessionID, directory, worktree
        const { createHashlineEditTool } = await import('./hashline/tool.ts')
        const tool = createHashlineEditTool()
        const result = await tool.execute(
          input as Parameters<typeof tool.execute>[0],
          ctx as Parameters<typeof tool.execute>[1],
        )
        if (typeof result === 'string') return result
        return result.output
      },
    },

    // 5. pantheon_goal_create
    {
      name: 'pantheon_goal_create',
      description: goalTools.pantheon_goal_create.description,
      input: {
        type: 'object',
        ...zodShapeToJsonSchema(goalTools.pantheon_goal_create.args as z.ZodRawShape, [
          'objective',
        ]),
      },
      execute: async (input, ctx) => {
        return goalTools.pantheon_goal_create.execute(
          input as Parameters<typeof goalTools.pantheon_goal_create.execute>[0],
          ctx,
        )
      },
    },

    // 6. pantheon_goal_get
    {
      name: 'pantheon_goal_get',
      description: goalTools.pantheon_goal_get.description,
      input: {
        type: 'object',
        properties: {},
      },
      execute: async (input, ctx) => {
        return goalTools.pantheon_goal_get.execute(
          input as Parameters<typeof goalTools.pantheon_goal_get.execute>[0],
          ctx,
        )
      },
    },

    // 7. pantheon_goal_update
    {
      name: 'pantheon_goal_update',
      description: goalTools.pantheon_goal_update.description,
      input: {
        type: 'object',
        ...zodShapeToJsonSchema(goalTools.pantheon_goal_update.args as z.ZodRawShape),
      },
      execute: async (input, ctx) => {
        return goalTools.pantheon_goal_update.execute(
          input as Parameters<typeof goalTools.pantheon_goal_update.execute>[0],
          ctx,
        )
      },
    },

    // 8. pantheon_cost
    {
      name: 'pantheon_cost',
      description: costCommand.pantheon_cost.description,
      input: {
        type: 'object',
        ...zodShapeToJsonSchema(costCommand.pantheon_cost.args as z.ZodRawShape),
      },
      execute: async (input, ctx) => {
        return costCommand.pantheon_cost.execute(
          input as Parameters<typeof costCommand.pantheon_cost.execute>[0],
          ctx,
        )
      },
    },

    // 9. pantheon_model
    {
      name: 'pantheon_model',
      description: modelCommand.pantheon_model.description,
      input: {
        type: 'object',
        ...zodShapeToJsonSchema(modelCommand.pantheon_model.args as z.ZodRawShape),
      },
      execute: async (input, ctx) => {
        return modelCommand.pantheon_model.execute(
          input as Parameters<typeof modelCommand.pantheon_model.execute>[0],
          ctx,
        )
      },
    },
  ]
}
