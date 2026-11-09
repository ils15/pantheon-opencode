/**
 * pantheon-settings-state.ts — the pure state core of the settings window.
 *
 * TUI-local copy doctrine (same as cost-data.ts): the bundle must stay
 * self-contained. The behaviors registry mirrors routing.yml's `behaviors:`
 * (drift-pinned by tests/pantheon-settings-state.test.mjs); the Gates section
 * reads and writes the GLOBAL overrides file — the same one
 * `pantheon-opencode`'s installer and doctor consume
 * (`<config-dir>/pantheon-overrides.json`).
 *
 * Sections: the window renders one section per page. This module owns the
 * section/row model and the Gates section; other sections live in sibling
 * TUI-local modules (j1-gate-status.ts, update-status.ts, …) and follow the
 * same shape.
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

/** Which behaviors the settings window can toggle (runtime + install skills). */
export const SETTINGS_TOGGLABLE_IDS = new Set(SETTINGS_BEHAVIORS.map((b) => b.id))

export function isBehaviorDisabled(effective: EffectiveOverrides, id: string): boolean {
  return effective[id]?.action === 'disable'
}

// ── Section / row model ────────────────────────────────────────────────

export interface SettingsRow {
  /** Namespaced action key (`gate.<behavior-id>`, `update.check`, …). */
  id: string
  title: string
  description: string
  /** Gates rows: the override disables the behavior (`[x]` marker). */
  disabled?: boolean
  /** Overrides the `[x]`/`[ ]` marker (`→` action, `✓`/`!` status). */
  marker?: string
  /** false → skipped by up/down and never dispatched by enter (info lines). */
  selectable?: boolean
  /** The effective entry comes from the PROJECT overrides file (read-only). */
  source?: 'global' | 'project'
}

export interface SettingsSection {
  id: string
  title: string
  /** One muted hint line under the rows. */
  hint?: string
  rows: SettingsRow[]
}

/** The rows up/down can reach and enter can dispatch on, in order. */
export function selectableRows(section: SettingsSection): SettingsRow[] {
  return section.rows.filter((row) => row.selectable !== false)
}

/** Flat selection order across every section of the window. */
export function flatSelectableRows(sections: readonly SettingsSection[]): SettingsRow[] {
  return sections.flatMap((section) => selectableRows(section))
}

export function firstSelectableId(sections: readonly SettingsSection[]): string | undefined {
  return flatSelectableRows(sections)[0]?.id
}

// ── Overrides load (global + project files) ────────────────────────────

export interface OverridesLoad {
  global: EffectiveOverrides
  project: EffectiveOverrides
  /** The GLOBAL file exists but does not parse — writes are refused. */
  corruptGlobal: boolean
}

/**
 * Merge for DISPLAY only, mirroring the runtime precedence: the project file
 * wins per id (whole entry). The window still writes only the global file.
 */
export function mergedOverrides(load: OverridesLoad): EffectiveOverrides {
  return { ...load.global, ...load.project }
}

export function canWriteOverrides(load: OverridesLoad): boolean {
  return !load.corruptGlobal
}

// ── Toggle semantics ───────────────────────────────────────────────────

export const TOGGLE_REASON = 'toggled in /pantheon-settings'

/**
 * Toggle: disabled -> enabled; enabled -> disabled.
 *
 * A `replace` entry is never destroyed by a toggle ("never trap user state"):
 * disabling keeps its `content` under the disable entry, and re-enabling
 * restores the replace. A settings-written disable (no content) is removed
 * outright so the overrides file does not accumulate toggle noise.
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
      // A settings-written disable restores a clean replace; a hand-authored
      // disable+content keeps its own provenance reason.
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

export function serializeOverrides(effective: EffectiveOverrides): string {
  const ordered: Record<string, unknown> = {}
  for (const id of Object.keys(effective).sort()) ordered[id] = effective[id]
  return `${JSON.stringify(ordered, null, 2)}\n`
}

// ── Gates section ──────────────────────────────────────────────────────

/**
 * The Gates & Overrides page: behavior state from BOTH overrides files.
 * A project-owned entry wins the runtime merge and the window only writes
 * the global file, so project rows are marked and not togglable here.
 */
export function buildGatesSection(load: OverridesLoad): SettingsSection {
  const merged = mergedOverrides(load)
  const rows: SettingsRow[] = SETTINGS_BEHAVIORS.map((behavior) => {
    const fromProject = load.project[behavior.id] !== undefined
    return {
      id: `gate.${behavior.id}`,
      title: fromProject ? `${behavior.title} (project)` : behavior.title,
      description: behavior.description,
      disabled: isBehaviorDisabled(merged, behavior.id),
      selectable: !fromProject,
      source: fromProject ? 'project' : 'global',
    }
  })
  return {
    id: 'gates',
    title: 'Gates & Overrides',
    hint: canWriteOverrides(load)
      ? 'enter: disable/enable · writes pantheon-overrides.json (global)'
      : 'overrides file unreadable — writes refused; repair with `pantheon-opencode doctor --fix`',
    rows,
  }
}

// ── About section ──────────────────────────────────────────────────────

export function buildAboutSection(version: string): SettingsSection {
  return {
    id: 'about',
    title: 'About',
    rows: [
      {
        id: 'about.version',
        title: `Pantheon v${version}`,
        description: 'OpenCode 2.x only — the V1 contract is removed.',
        selectable: false,
      },
      {
        id: 'about.behaviors',
        title: `${SETTINGS_BEHAVIORS.length} togglable behaviors`,
        description: 'Docs: docs/design/2.0-settings-and-install.md',
        selectable: false,
      },
    ],
  }
}
