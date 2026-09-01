import { fileURLToPath } from 'node:url'
import type {
  AgentDraft,
  CatalogDraft,
  CommandDraft,
  PluginContext,
  ReferenceDraft,
  SkillDraft,
} from '@opencode-ai/plugin/v2/promise'
import { define } from '@opencode-ai/plugin/v2/promise'

export const V2_UNSUPPORTED_FEATURES = [
  'legacy-hooks',
  'tool-execute-hooks',
  'session-hooks',
  'event-stream',
  'compaction-hook',
] as const

const POLICY_MARKER = '<!-- pantheon-v2-policy -->'
const POLICY = `${POLICY_MARKER}\nFollow Pantheon routing policy: delegate implementation work to the named specialist and do not claim work was performed without verification.`

function transformAgents(draft: AgentDraft): void {
  for (const agent of draft.list()) {
    draft.update(agent.id, (current) => {
      if (!current.system?.includes(POLICY_MARKER)) {
        current.system = current.system ? `${current.system}\n\n${POLICY}` : POLICY
      }
      if (agent.id === 'zeus') current.mode = 'primary'
    })
  }
}

function transformCatalog(draft: CatalogDraft, options: PluginContext['options']): void {
  const configured = options.default_model
  if (typeof configured !== 'string') return
  const separator = configured.indexOf('/')
  if (separator <= 0 || separator === configured.length - 1) return
  const providerID = configured.slice(0, separator)
  const modelID = configured.slice(separator + 1)
  if (draft.model.get(providerID, modelID)) draft.model.default.set(providerID, modelID)
}

function transformCommands(draft: CommandDraft): void {
  for (const command of draft.list()) {
    if (command.name.startsWith('pantheon-')) {
      draft.update(command.name, (current) => {
        current.description ??= 'Pantheon orchestration command'
      })
    }
  }
}

function transformSkills(draft: SkillDraft): void {
  const path = fileURLToPath(new URL('./skills', import.meta.url))
  if (!draft.list().some((source) => source.type === 'directory' && source.path === path)) {
    draft.source({ type: 'directory', path })
  }
}

function transformReferences(draft: ReferenceDraft): void {
  draft.add('pantheon-agents', {
    type: 'local',
    path: fileURLToPath(new URL('../AGENTS.md', import.meta.url)),
    description: 'Pantheon agent and execution policy',
  })
}

export const plugin = define({
  id: 'pantheon-opencode-v2',
  async setup(context: PluginContext): Promise<void> {
    await Promise.all([
      context.agent.transform(transformAgents),
      context.catalog.transform((draft) => transformCatalog(draft, context.options)),
      context.command.transform(transformCommands),
      context.reference.transform(transformReferences),
      context.skill.transform(transformSkills),
    ])
  },
})

export default plugin
