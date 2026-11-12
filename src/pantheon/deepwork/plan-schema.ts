/**
 * plan-schema.ts — Canonical schema for Pantheon Deepwork Plans.
 *
 * Principle: JSON is the ground truth, Markdown is the projection.
 * Strictly avoids HTML; uses structured contracts and native OpenCode gates.
 */

import { z } from 'zod'

export const PlanAcceptanceKindSchema = z.enum(['test', 'command', 'file', 'manual'])
export type PlanAcceptanceKind = z.infer<typeof PlanAcceptanceKindSchema>

export const PlanAcceptanceCriterionSchema = z.object({
  kind: PlanAcceptanceKindSchema,
  check: z.string().min(1),
  fails_now: z.boolean().default(true),
  verified: z.boolean().default(false),
  proof: z.string().optional(),
})
export type PlanAcceptanceCriterion = z.infer<typeof PlanAcceptanceCriterionSchema>

export const TaskStateSchema = z.enum([
  'pending',
  'ready',
  'in_progress',
  'done',
  'failed',
  'blocked',
])
export type TaskState = z.infer<typeof TaskStateSchema>

export const PlanTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  agent: z.string().default('zeus'),
  phase: z.number().int().min(0).default(1),
  state: TaskStateSchema.default('pending'),
  depends_on: z.array(z.string()).default([]),
  parallel_safe: z.boolean().default(false),
  acceptance: z.array(PlanAcceptanceCriterionSchema).default([]),
  result: z
    .object({
      summary: z.string().optional(),
      verified_at: z.string().optional(),
      artifacts: z.array(z.string()).optional(),
    })
    .optional(),
})
export type PlanTask = z.infer<typeof PlanTaskSchema>

export const DecisionStatusSchema = z.enum(['pending', 'resolved'])
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>

export const PlanDecisionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  options: z.array(z.string()).min(2),
  chosen: z.string().optional(),
  status: DecisionStatusSchema.default('pending'),
})
export type PlanDecision = z.infer<typeof PlanDecisionSchema>

export const PlanRiskSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  mitigation: z.string().optional(),
})
export type PlanRisk = z.infer<typeof PlanRiskSchema>

export const PlanMetadataSchema = z.object({
  created_at: z.string(),
  updated_at: z.string(),
  version: z.number().int().default(1),
})
export type PlanMetadata = z.infer<typeof PlanMetadataSchema>

export const DeepworkPlanSchema = z.object({
  plan_id: z.string().min(1),
  title: z.string().min(1),
  intent: z.string().min(1),
  done_when: z.array(z.string()).default([]),
  decisions_needed: z.array(PlanDecisionSchema).default([]),
  risks: z.array(PlanRiskSchema).default([]),
  out_of_scope: z.array(z.string()).default([]),
  tasks: z.array(PlanTaskSchema).default([]),
  metadata: PlanMetadataSchema,
})
export type DeepworkPlan = z.infer<typeof DeepworkPlanSchema>

export function validatePlan(data: unknown): DeepworkPlan {
  return DeepworkPlanSchema.parse(data)
}
