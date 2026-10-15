/** Prepare same-source paired agent directories with a frozen control Zeus prompt. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { copyAgentPrompts } from '../../scripts/build-agents-md.mjs'
import { agentFixtureIdentity } from './agent-fixture.mjs'

/**
 * Materialize complete generated agent directories for a paired prompt run.
 * Every non-Zeus prompt is generated from the same source for both arms; only
 * the control's Zeus prompt is replaced by the frozen generated artifact.
 */
export function preparePairedAgentPromptFixtures({
  sourceAgentsDir,
  controlZeusPromptPath,
  outputRoot,
}) {
  const source = resolve(sourceAgentsDir)
  const controlPrompt = resolve(controlZeusPromptPath)
  const output = resolve(outputRoot)
  const controlDir = join(output, 'control-agents')
  const candidateDir = join(output, 'candidate-agents')

  mkdirSync(output, { recursive: true })
  copyAgentPrompts(source, controlDir)
  copyAgentPrompts(source, candidateDir)
  writeFileSync(join(controlDir, 'zeus.md'), readFileSync(controlPrompt, 'utf8'))

  return {
    control: agentFixtureIdentity(controlDir, ['zeus']),
    candidate: agentFixtureIdentity(candidateDir, ['zeus']),
  }
}
