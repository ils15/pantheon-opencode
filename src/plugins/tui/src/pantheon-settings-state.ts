/**
 * pantheon-settings-state.ts — the pure state core of the settings window.
 *
 * TUI-local copy doctrine (same as cost-data.ts): the bundle must stay
 * self-contained. The behaviors registry mirrors routing.yml's `behaviors:`
 * (drift-pinned by tests/pantheon-settings-state.test.mjs).
 *
 * Model (2.0.0-beta.4, the quota-style full window): the window is a set of
 * TABS; each tab holds GROUPS of setting ROWS; a row carries a display VALUE
 * and — when the setting is editable — the CYCLE of allowed values that
 * ←/→ steps through. Edits stage into a DRAFT (id → pending value); `save`
 * applies the draft through injected writers, `reset` drops it. The disk
 * never changes before save.
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
  {
    id: 'gate-idle-todo-enforcer',
    kind: 'runtime',
    title: 'Idle todo enforcer',
    description: 'Continues pending todos when a session goes idle.',
  },
  {
    id: 'gate-context-pruner',
    kind: 'runtime',
    title: 'Context pruner',
    description: 'Prunes repeated tool output before summarization.',
  },
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

/** Which behaviors the settings window can write (runtime + install skills). */
export const SETTINGS_TOGGLABLE_IDS = new Set(SETTINGS_BEHAVIORS.map((b) => b.id))

export function isBehaviorDisabled(effective: EffectiveOverrides, id: string): boolean {
  return effective[id]?.action === 'disable'
}

export const TOGGLE_REASON = 'toggled in /pantheon-settings'

/**
 * Toggle (a targeted write keeps the toggle semantics: a `replace` entry is
 * never destroyed — disabling keeps its `content`, re-enabling restores the
 * replace; a settings-written disable is removed outright, no toggle noise).
 */
export function toggledOverrides(
  effective: EffectiveOverrides,
  id: string,
  reason: string = TOGGLE_REASON,
): EffectiveOverrides {
  const next: EffectiveOverrides = { ...effective }
  const entry = next[id]
  if (entry?.action === 'disable') {
    if (entry.content !== undefined) {
      next[id] =
        entry.reason === reason
          ? { action: 'replace', content: entry.content }
          : {
              action: 'replace',
              content: entry.content,
              ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
            }
    } else {
      delete next[id]
    }
  } else {
    next[id] =
      entry?.content !== undefined
        ? { action: 'disable', reason, content: entry.content }
        : { action: 'disable', reason }
  }
  return next
}

/** Set an explicit on/off target (the cycler's save path) via the toggle semantics. */
export function setOverrideState(
  effective: EffectiveOverrides,
  id: string,
  target: 'enabled' | 'disabled',
  reason: string = TOGGLE_REASON,
): EffectiveOverrides {
  const disabled = isBehaviorDisabled(effective, id)
  if ((target === 'disabled') === disabled) return effective
  return toggledOverrides(effective, id, reason)
}

export function serializeOverrides(effective: EffectiveOverrides): string {
  const ordered: Record<string, unknown> = {}
  for (const id of Object.keys(effective).sort()) ordered[id] = effective[id]
  return `${JSON.stringify(ordered, null, 2)}\n`
}

// ── Overrides load (global + project files) ────────────────────────────

export interface OverridesLoad {
  global: EffectiveOverrides
  project: EffectiveOverrides
  /** The GLOBAL file exists but does not parse — writes are refused. */
  corruptGlobal: boolean
}

/** Merge for DISPLAY only, mirroring the runtime precedence: project wins per id. */
export function mergedOverrides(load: OverridesLoad): EffectiveOverrides {
  return { ...load.global, ...load.project }
}

export function canWriteOverrides(load: OverridesLoad): boolean {
  return !load.corruptGlobal
}

// ── Tab / group / row model (the cycler window) ────────────────────────

export interface SettingsRow {
  id: string
  name: string
  /** Current effective value (display); the staged draft may differ. */
  value: string
  /** Allowed values for ←/→; presence marks the row as editable. */
  cycle?: readonly string[]
  /** The row's DEFAULT value — what the Defaults action stages. */
  def?: string
  /** Right-column note (writes-where, applies-live, from-where). */
  note?: string
  /** Enter triggers this action instead of cycling (e.g. `update-check`). */
  action?: string
}

export interface SettingsGroup {
  /** Bold group header; undefined renders rows without a header. */
  title?: string
  rows: SettingsRow[]
}

export interface SettingsTab {
  id: string
  title: string
  groups: SettingsGroup[]
}

/** Neutral tab for out-of-range indexes (noUncheckedIndexedAccess guard). */
export const EMPTY_TAB: SettingsTab = { id: 'empty', title: '', groups: [] }

/** Flat, in-order rows of a tab (the up/down navigation space). */
export function tabRows(tab: SettingsTab): SettingsRow[] {
  return tab.groups.flatMap((group) => group.rows)
}

export function findRow(tab: SettingsTab, id: string): SettingsRow | undefined {
  return tabRows(tab).find((row) => row.id === id)
}

// ── The cycler ─────────────────────────────────────────────────────────

/** Step through the cycle with wrap-around; non-cyclable rows return the input. */
export function cycleValue(value: string, cycle: readonly string[], direction: 1 | -1): string {
  if (cycle.length === 0) return value
  const index = cycle.indexOf(value)
  if (index === -1) return cycle[0] ?? value
  const next = (index + direction + cycle.length) % cycle.length
  return cycle[next] ?? value
}

// ── The draft (staged edits; the disk never changes before save) ───────

export type SettingsDraft = Record<string, string>

export function stageValue(
  draft: SettingsDraft,
  row: SettingsRow,
  direction: 1 | -1,
): SettingsDraft {
  if (row.cycle === undefined) return draft
  const current = draft[row.id] ?? row.value
  const staged = cycleValue(current, row.cycle, direction)
  if (staged === row.value) {
    // staged back onto the disk value — drop the entry (no toggle noise)
    if (draft[row.id] === undefined) return draft
    const next = { ...draft }
    delete next[row.id]
    return next
  }
  return { ...draft, [row.id]: staged }
}

/** Stage an explicit target value for one row (the Defaults action path). */
export function stageRowToValue(
  draft: SettingsDraft,
  row: SettingsRow,
  target: string,
): SettingsDraft {
  if (!row.cycle?.includes(target)) return draft
  if (target === row.value) {
    if (draft[row.id] === undefined) return draft
    const next = { ...draft }
    delete next[row.id]
    return next
  }
  return { ...draft, [row.id]: target }
}

/**
 * Stage every cyclable row's DEFAULT value of a tab. Rows already at their
 * default have their staged entry dropped; rows staged elsewhere keep it
 * until the Defaults action targets them.
 */
export function stageDefaults(draft: SettingsDraft, tab: SettingsTab): SettingsDraft {
  let next = draft
  for (const row of tabRows(tab)) {
    if (row.cycle === undefined || row.def === undefined) continue
    const candidate = next[row.id] ?? row.value
    if (candidate === row.def) {
      if (next[row.id] !== undefined) {
        const copy = { ...next }
        delete copy[row.id]
        next = copy
      }
      continue
    }
    next = stageRowToValue(next, { ...row, value: candidate }, row.def)
  }
  return next
}

/** Drop every staged entry of one tab (ctrl+r). */
export function resetTab(draft: SettingsDraft, tab: SettingsTab): SettingsDraft {
  const ids = new Set(tabRows(tab).map((row) => row.id))
  const next: SettingsDraft = {}
  for (const [id, value] of Object.entries(draft)) {
    if (!ids.has(id)) next[id] = value
  }
  return next
}

export function draftCount(draft: SettingsDraft): number {
  return Object.keys(draft).length
}

export function draftDirty(draft: SettingsDraft): boolean {
  return draftCount(draft) > 0
}

export function tabDirty(draft: SettingsDraft, tab: SettingsTab): boolean {
  return tabRows(tab).some((row) => draft[row.id] !== undefined)
}

// ── Applying the draft ─────────────────────────────────────────────────

export interface DraftWriterResult {
  ok: boolean
  reason?: string
}

/**
 * One callback that dispatches a staged row to its real writer (gates →
 * overrides file, decision → decision-router.json, preset → active-preset).
 *Injected by the glue so the disk never runs in tests.
 */
export type DraftWriter = (id: string, value: string) => DraftWriterResult

export interface AppliedDraft {
  applied: string[]
  failed: { id: string; reason: string }[]
}

/** Apply every staged entry; failures are collected, never thrown. */
export function applyDraft(draft: SettingsDraft, writer: DraftWriter): AppliedDraft {
  const applied: string[] = []
  const failed: AppliedDraft['failed'] = []
  for (const [id, value] of Object.entries(draft)) {
    const result = writer(id, value)
    if (result.ok) applied.push(id)
    else failed.push({ id, reason: result.reason ?? 'write failed' })
  }
  return { applied, failed }
}

/** The rows that succeeded and are still in the draft (failed ones stay staged). */
export function settledDraft(draft: SettingsDraft, applied: readonly string[]): SettingsDraft {
  const next: SettingsDraft = {}
  for (const [id, value] of Object.entries(draft)) {
    if (!applied.includes(id)) next[id] = value
  }
  return next
}

// ── Gates / About tabs (behavior-native; the other tabs live in their modules) ──

export const GATES_ENABLED_CYCLE: readonly string[] = Object.freeze(['enabled', 'disabled'])

export function buildGatesTab(load: OverridesLoad): SettingsTab {
  const merged = mergedOverrides(load)
  const rowFor = (behavior: SettingsBehavior): SettingsRow => {
    const fromProject = load.project[behavior.id] !== undefined
    const writable = !fromProject && canWriteOverrides(load)
    return {
      id: `gate.${behavior.id}`,
      name: fromProject ? `${behavior.title} (project)` : behavior.title,
      value: isBehaviorDisabled(merged, behavior.id) ? 'disabled' : 'enabled',
      ...(writable ? { cycle: GATES_ENABLED_CYCLE } : {}),
      note: fromProject
        ? 'project file wins at runtime — edit .pantheon/overrides.json'
        : behavior.description,
    }
  }
  const install = SETTINGS_BEHAVIORS.filter((behavior) => behavior.kind === 'install')
  const runtime = SETTINGS_BEHAVIORS.filter((behavior) => behavior.kind === 'runtime')
  return {
    id: 'gates',
    title: 'Gates',
    groups: [
      { title: 'Install skills', rows: install.map(rowFor) },
      { title: 'Runtime gates', rows: runtime.map(rowFor) },
    ],
  }
}

export function buildAboutTab(version: string): SettingsTab {
  return {
    id: 'about',
    title: 'About',
    groups: [
      {
        rows: [
          {
            id: 'about.version',
            name: 'Version',
            value: `v${version}`,
            note: 'OpenCode 2.x only — the V1 contract is removed',
          },
          {
            id: 'about.behaviors',
            name: 'Behaviors',
            value: String(SETTINGS_BEHAVIORS.length),
            note: 'docs/design/2.0-settings-and-install.md',
          },
        ],
      },
    ],
  }
}
