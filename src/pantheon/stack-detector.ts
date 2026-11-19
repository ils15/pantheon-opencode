/**
 * Typed wrapper around `scripts/stack-detector.mjs` for Pantheon plugin tools.
 */

// @ts-expect-error Typed manually below so Node CLI binaries can share the pure ESM module.
import { detectRepositoryStacks as detectRepositoryStacksImpl } from '../../scripts/stack-detector.mjs'

export interface DetectedStack {
  readonly id: 'node-typescript' | 'python' | 'rust' | 'go'
  readonly manifest: string
  readonly frameworks: readonly string[]
  readonly testRunner: string
  readonly linter: string
}

export interface SpecialistRecommendation {
  readonly name: string
  readonly archetype: 'backend' | 'frontend' | 'data' | 'security'
  readonly description: string
  readonly stack: readonly string[]
  readonly testCommand: string
  readonly suggestedDocs: readonly string[]
}

export interface StackDetectionReport {
  readonly stacks: readonly DetectedStack[]
  readonly suggestedSpecialists: readonly SpecialistRecommendation[]
  readonly suggestedDocs: readonly string[]
}

export function detectRepositoryStacks(workspaceDir: string): StackDetectionReport {
  return detectRepositoryStacksImpl(workspaceDir) as StackDetectionReport
}
