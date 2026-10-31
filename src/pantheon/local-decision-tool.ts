import { type ToolContext, tool } from '@opencode-ai/plugin'
import {
  LOCAL_DECISION_COMPLEXITY_DIMENSIONS,
  type LocalDecisionGateStatus,
} from './local-decision-router.ts'
import {
  type LocalDecisionPolicy,
  loadLocalDecisionPolicy,
  recommendLocalOrchestration,
} from './local-orchestration.ts'
import { evaluateComplexityPoint } from './v2-decision-points/p3-complexity.ts'
import type { ShadowSink } from './v2-decision-shadow.ts'

const TOOL_DESCRIPTION =
  'Zeus-only local advisory selector. Use selectively only when specialist routing is genuinely ' +
  'ambiguous; obvious work should go directly to native subagent without this tool. Accepts only ' +
  'structured candidate IDs, never task text. It does not dispatch, run a skill/resource, search ' +
  'memory, or authorize/alter grants or review gates. Provider egress is disabled; all decisions ' +
  'remain local.'

const gateStatuses: LocalDecisionGateStatus[] = [
  'none',
  'review_required',
  'human_approval_required',
  'unresolved',
]

const inputShape = {
  schemaVersion: tool.schema.literal(1),
  candidateAgents: tool.schema.array(tool.schema.string().min(1)).max(14),
  domain: tool.schema.string().nullable(),
  candidateSkillIds: tool.schema.array(tool.schema.string().min(1)).max(64),
  candidateResourceIds: tool.schema.array(tool.schema.string().min(1)).max(32),
  memorySearchRelevant: tool.schema.boolean(),
  gateStatus: tool.schema.enum(
    gateStatuses as [LocalDecisionGateStatus, ...LocalDecisionGateStatus[]],
  ),
  complexity: tool.schema
    .object({
      boundedness: tool.schema.number().int().min(0).max(2),
      reversibility: tool.schema.number().int().min(0).max(2),
      dependencies: tool.schema.number().int().min(0).max(2),
      uncertainty: tool.schema.number().int().min(0).max(2),
      verification: tool.schema.number().int().min(0).max(2),
    })
    .strict(),
}

type LocalDecisionToolOptions = {
  loadPolicy?: () => Promise<LocalDecisionPolicy | undefined>
}

/**
 * Optional shadow observer for the V2 tool point.
 *
 * P3 declares `tool.invoke`, and the local selector's input is the surface that
 * carries `complexity` and `gateStatus`. The sink is supplied by the plugin when
 * it registers the tool; nothing here applies its record.
 */
type LocalDecisionShadowOptions = {
  sink?: ShadowSink
}

/**
 * Observe P3 in shadow at `tool.invoke`.
 *
 * Contained on purpose: the adapter already contains its own failures, and
 * this wrapper guarantees that even an unexpected throw cannot change the
 * tool result. No input is mutated and no decision is applied.
 */
function observeToolComplexity(input: unknown, sink?: ShadowSink): void {
  try {
    evaluateComplexityPoint(input, sink)
  } catch {
    // Shadow is best-effort; the tool result is unaffected.
  }
}

async function runDecision(
  input: unknown,
  callerAgent: unknown,
  loadPolicy: () => Promise<LocalDecisionPolicy | undefined>,
): Promise<string> {
  if (callerAgent !== 'zeus') {
    return JSON.stringify(recommendLocalOrchestration(input, callerAgent, undefined))
  }
  const policy = await loadPolicy().catch(() => undefined)
  // Caller context is a host-provided identity string, not non-forgeable runtime provenance.
  // Keep this route hard local-only until provider authorization can be established safely.
  return JSON.stringify(recommendLocalOrchestration(input, callerAgent, policy))
}

/** Create the V1 plugin tool; execution is fail-closed unless host context identifies Zeus. */
export function createLocalDecisionTool(options: LocalDecisionToolOptions = {}) {
  const policyLoader = options.loadPolicy ?? loadLocalDecisionPolicy
  return tool({
    description: TOOL_DESCRIPTION,
    args: inputShape,
    execute: async (input, context: ToolContext) => runDecision(input, context.agent, policyLoader),
  })
}

const v2InputSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'candidateAgents',
    'domain',
    'candidateSkillIds',
    'candidateResourceIds',
    'memorySearchRelevant',
    'gateStatus',
    'complexity',
  ],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    candidateAgents: { type: 'array', maxItems: 14, items: { type: 'string', minLength: 1 } },
    domain: { type: ['string', 'null'] },
    candidateSkillIds: { type: 'array', maxItems: 64, items: { type: 'string', minLength: 1 } },
    candidateResourceIds: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1 } },
    memorySearchRelevant: { type: 'boolean' },
    gateStatus: { type: 'string', enum: gateStatuses },
    complexity: {
      type: 'object',
      additionalProperties: false,
      required: [...LOCAL_DECISION_COMPLEXITY_DIMENSIONS],
      properties: Object.fromEntries(
        LOCAL_DECISION_COMPLEXITY_DIMENSIONS.map((dimension) => [
          dimension,
          { type: 'integer', minimum: 0, maximum: 2 },
        ]),
      ),
    },
  },
}

/** Create a V2 transform definition with the same Zeus-only execution guard and local plan. */
export function createV2LocalDecisionDefinition(
  options: LocalDecisionToolOptions & LocalDecisionShadowOptions = {},
) {
  const policyLoader = options.loadPolicy ?? loadLocalDecisionPolicy
  return {
    name: 'pantheon_local_decision',
    description: TOOL_DESCRIPTION,
    input: v2InputSchema,
    output: {},
    execute: async (input: Record<string, unknown>, context: unknown) => {
      // P3 shadow observation at `tool.invoke`. The input schema declares
      // `complexity` and `gateStatus`, so this is the one wired surface that
      // can feed a complexity decision; the record never alters the result.
      observeToolComplexity(input, options.sink)
      const callerAgent =
        context !== null && typeof context === 'object'
          ? (context as { agent?: unknown }).agent
          : undefined
      return { output: await runDecision(input, callerAgent, policyLoader) }
    },
  }
}
