/**
 * pantheon-settings-state.ts — the pure state core of the settings window.
 *
 * TUI-local copy doctrine (same as cost-data.ts): the bundle must stay
 * self-contained. The behaviors registry mirrors routing.yml's `behaviors:`
 * (drift-pinned by tests/settings-registry.test.mjs); the Overrides tab reads
 * and writes the GLOBAL overrides file — the same one
 * `pantheon-opencode`'s installer and doctor consume
 * (`<config-dir>/pantheon-overrides.json`).
 */

export interface SettingsBehavior {
  id: string
  kind: 'install' | 'runtime'
  title: string
  description: string
}

/** Mirrors routing.yml `behaviors:` — drift-pinned by the registry test. */
export const SETTINGS_BEHAVIORS: readonly SettingsBehavior[] = Object.freeze([
  {
    id: 'skill-auto-continue',
    kind: 'install',
    title: 'Auto-continue skill',
    description: 'Continue multi-step todos while keeping safety gates.',
  },
  {
    id: 'skill-tdd-with-agents',
    kind: 'install',
    title: 'TDD with agents skill',
    description: 'RED, GREEN, REFACTOR test-driven implementation.',
  },
  {
    id: 'skill-code-review-checklist',
    kind: 'install',
    title: 'Code review checklist skill',
    description: 'Systematic code review and quality gates.',
  },
  {
    id: 'skill-prompt-refinery',
    kind: 'install',
    title: 'Prompt refinery skill',
    description: 'Vague requests refined — silent adjust, >> full contract.',
  },
  { id: 'gate-idle-todo-enforcer', kind: 'runtime', title: 'Idle todo enforcer', description: 'Continues pending todos when a session goes idle.' },
  { id: 'gate-context-pruner', kind: 'runtime', title: 'Context pruner', description: 'Prunes repeated tool output before summarization.' },
  {
    id: 'gate-j1-risk-gate',
    kind: 'runtime',
    title: 'J1 risk gate',
    description: 'High-risk tool calls demand explicit human approval.',
  },
])

export interface OverrideEntry {
  action: 'disable' | 'replace'
  content?: string
  reason?: string
}

export type EffectiveOverrides = Record<string, OverrideEntry>

/** Which behaviors the settings window can toggle (runtime + install skills). */
export const SETTINGS_TOGGLABLE_IDS = new Set(SETTINGS_BEHAVIORS.map((b) => b.id))

export function isBehaviorDisabled(effective: EffectiveOverrides, id: string): boolean {
  return effective[id]?.action === 'disable'
}

/** Toggle: disabled -> enabled (entry removed); enabled -> disabled (entry written). */
export function toggledOverrides(
  effective: EffectiveOverrides,
  id: string,
  reason = 'toggled in /pantheon-settings',
): EffectiveOverrides {
  const next: EffectiveOverrides = { ...effective }
  if (next[id]?.action === 'disable') delete next[id]
  else next[id] = { action: 'disable', reason }
  return next
}

export function serializeOverrides(effective: EffectiveOverrides): string {
  const ordered: Record<string, unknown> = {}
  for (const id of Object.keys(effective).sort()) ordered[id] = effective[id]
  return `${JSON.stringify(ordered, null, 2)}\n`
}

export interface AboutData {
  version: string
  skillCount: number
  agentCount: number
}

export function aboutRows(data: AboutData): string[] {
  return [
    `Pantheon v${data.version}`,
    `${data.skillCount} skills · 14 agents · 5 MCP servers`,
    'OpenCode 2.x only — the V1 contract is removed.',
    'Docs: docs/design/2.0-settings-and-install.md',
  ]
}
