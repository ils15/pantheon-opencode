// biome-ignore-all lint/suspicious/noExplicitAny: OpenCode exposes its TUI API at runtime.
// biome-ignore-all lint/a11y/noStaticElementInteractions: TUI elements, not DOM
/** @jsxImportSource @opentui/solid */

/**
 * pantheon-settings.tsx — the /pantheon-settings window.
 *
 * One section per page, keyboard-first: `tab` cycles sections, `up`/`down`
 * select, `enter`/`space` dispatches the selected row (the Gates section
 * writes the GLOBAL overrides file — the same one the installer and doctor
 * consume; Updates runs a registry check). `escape`/`q` closes. The
 * gated-layer pattern mirrors the dispatch panel and whats-new windows.
 * Every failure path is silent (fail-open).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@opencode/plugin/tui/context'
import { createSignal, For, Show } from 'solid-js'
import {
  buildDecisionSection,
  readDecisionRouterConfig,
  setDecisionEnabled,
  writeDecisionRouterConfig,
} from './decision-router-state.ts'
import { buildJ1Section } from './j1-gate-status.ts'
import {
  buildAboutSection,
  buildGatesSection,
  canWriteOverrides,
  type EffectiveOverrides,
  firstSelectableId,
  flatSelectableRows,
  isBehaviorDisabled,
  mergedOverrides,
  type OverridesLoad,
  type SettingsRow,
  type SettingsSection,
  serializeOverrides,
  toggledOverrides,
} from './pantheon-settings-state.ts'
import {
  buildPresetSection,
  clearActivePreset,
  globalActivePresetPath,
  projectActivePresetPath,
  readActivePresetMarker,
  writeActivePreset,
} from './preset-state.ts'
import { nextCheckState, type UpdateCheckState } from './update-notice.ts'
import {
  buildUpdatesSection,
  registryUrlForChannel,
  type UpdatesSectionInput,
  updateChannelFor,
} from './update-status.ts'

function globalOverridesPath(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '', '.config')
  return join(xdgConfig, 'opencode', 'pantheon-overrides.json')
}

function projectOverridesPath(): string {
  return join(process.cwd(), '.pantheon', 'overrides.json')
}

/** Read one overrides file; a missing file is empty, an unreadable one is corrupt. */
function readOneOverrides(path: string): { value: EffectiveOverrides; corrupt: boolean } {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { value: {}, corrupt: true }
    }
    return { value: parsed as EffectiveOverrides, corrupt: false }
  } catch (error) {
    return { value: {}, corrupt: (error as NodeJS.ErrnoException)?.code !== 'ENOENT' }
  }
}

function readOverridesLoad(): OverridesLoad {
  const globalRead = readOneOverrides(globalOverridesPath())
  const projectRead = readOneOverrides(projectOverridesPath())
  return {
    global: globalRead.value,
    project: projectRead.value,
    corruptGlobal: globalRead.corrupt,
  }
}

function writeOverridesToDisk(load: OverridesLoad): void {
  writeFileSync(globalOverridesPath(), serializeOverrides(load.global), 'utf8')
}

function updateCheckStatePath(): string {
  const stateDir = process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? '', '.local', 'state')
  return join(stateDir, 'pantheon', 'update-check.json')
}

function readUpdateCheckState(): UpdateCheckState {
  try {
    return JSON.parse(readFileSync(updateCheckStatePath(), 'utf8')) as UpdateCheckState
  } catch {
    return {}
  }
}

/**
 * Registry check for the RUNNING version's channel (beta installs ask the
 * beta dist-tag). Resolves with the latest version seen, or null offline.
 */
async function fetchLatestForChannel(currentVersion: string): Promise<string | null> {
  try {
    const response = await fetch(registryUrlForChannel(updateChannelFor(currentVersion)), {
      signal: AbortSignal.timeout(5000),
    })
    const latest = String(((await response.json()) as { version?: unknown })?.version ?? '')
    return latest || null
  } catch {
    return null
  }
}

function persistUpdateCheckState(previous: UpdateCheckState, latest: string | null): void {
  try {
    const path = updateCheckStatePath()
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(
      path,
      `${JSON.stringify(nextCheckState(previous, latest ? { version: latest, message: '' } : null, Date.now()), null, 2)}\n`,
    )
  } catch {
    /* state is a cache — never block on it */
  }
}

function resolveRunningVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: string }
    return manifest.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export function SettingsContent(props: {
  sections: () => SettingsSection[]
  page: () => number
  selectedId: () => string | undefined
  fg?: any
  muted?: any
}) {
  const section = () =>
    props.sections()[props.page()] ?? {
      id: 'empty',
      title: '',
      rows: [],
    }
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>
      <text attributes={1} fg={props.fg}>
        {section().title}
      </text>
      <text fg={props.muted}>{'─'.repeat(38)}</text>
      <For each={section().rows}>
        {(row: SettingsRow) => {
          const isSelected = () => row.selectable !== false && row.id === props.selectedId()
          const marker = () => row.marker ?? (row.disabled ? '[x]' : '[ ]')
          return (
            <box flexDirection="column">
              <text
                fg={isSelected() ? props.fg : props.muted}
                {...(isSelected() ? { attributes: 1 } : {})}
              >
                {`${marker()} ${row.title}${isSelected() ? '  <-' : ''}`}
              </text>
              <Show when={row.description !== ''}>
                <text fg={props.muted}>{`    ${row.description}`}</text>
              </Show>
            </box>
          )
        }}
      </For>
      <box height={1} />
      <Show when={section().hint !== undefined}>
        <text fg={props.muted}>{section().hint}</text>
      </Show>
      <text fg={props.muted}>
        {`${props.page() + 1}/${props.sections().length} · `}tab: section · up/down: select · enter:
        apply · esc/q: close
      </text>
    </box>
  )
}

/**
 * Entry glue: read both overrides files, then show the window through the
 * host dialog stack once. The gated keymap layer is inert while the window
 * is closed. Never throws.
 */
export async function maybeShowPantheonSettings(context: Context): Promise<void> {
  try {
    const [open, setOpen] = createSignal(false)
    const [page, setPage] = createSignal(0)
    const [load, setLoad] = createSignal<OverridesLoad>(readOverridesLoad())
    const [lastChecked, setLastChecked] = createSignal<string | undefined>(undefined)
    const [checking, setChecking] = createSignal(false)
    const [decision, setDecision] = createSignal(readDecisionRouterConfig())
    const [presetTick, setPresetTick] = createSignal(0)

    const currentVersion = resolveRunningVersion()

    const updatesInput = (): UpdatesSectionInput => {
      const input: UpdatesSectionInput = {
        currentVersion,
        state: readUpdateCheckState(),
        checking: checking(),
        nowMs: Date.now(),
      }
      const seen = lastChecked()
      if (seen !== undefined) input.lastCheckedVersion = seen
      return input
    }

    const presetInput = () => {
      void presetTick()
      return {
        globalName: readActivePresetMarker(globalActivePresetPath())?.name ?? null,
        projectName: readActivePresetMarker(projectActivePresetPath())?.name ?? null,
      }
    }

    const sections = (): SettingsSection[] => [
      buildGatesSection(load()),
      buildDecisionSection(decision()),
      buildPresetSection(presetInput()),
      buildJ1Section(process.env, isBehaviorDisabled(mergedOverrides(load()), 'gate-j1-risk-gate')),
      buildUpdatesSection(updatesInput()),
      buildAboutSection(currentVersion),
    ]
    const [selectedId, setSelectedId] = createSignal<string | undefined>(
      firstSelectableId(sections()),
    )

    const move = (delta: number) => {
      const list = flatSelectableRows(sections())
      if (list.length === 0) return
      const current = list.findIndex((row) => row.id === selectedId())
      const nextIndex = current === -1 ? 0 : Math.min(Math.max(current + delta, 0), list.length - 1)
      setSelectedId(list[nextIndex]?.id)
    }

    const flipSection = () => {
      const count = sections().length
      const next = (page() + 1) % count
      setPage(next)
      const target = sections()[next]
      if (target === undefined) return
      const within = flatSelectableRows([target])[0]
      if (within) setSelectedId(within.id)
    }

    const toggleSelectedGate = () => {
      const id = selectedId()
      if (id === undefined || !id.startsWith('gate.')) return false
      if (!canWriteOverrides(load())) return undefined // corrupt file — writes refused
      const behaviorId = id.slice('gate.'.length)
      const next: OverridesLoad = {
        ...load(),
        global: toggledOverrides(load().global, behaviorId),
      }
      try {
        writeOverridesToDisk(next)
        setLoad(next)
      } catch {
        /* disk write failed — keep the in-memory state, stay open */
      }
      return undefined
    }

    const checkUpdatesNow = () => {
      if (checking()) return undefined
      setChecking(true)
      void fetchLatestForChannel(currentVersion)
        .then((latest) => {
          if (latest) setLastChecked(latest)
          persistUpdateCheckState(readUpdateCheckState(), latest)
        })
        .catch(() => {
          /* offline — the row keeps the last known state */
        })
        .finally(() => setChecking(false))
      return undefined
    }

    const toggleDecisionEnabled = () => {
      const current = decision()
      if (current.corrupt) return undefined // invalid file — writes refused
      const next = setDecisionEnabled(current.config, !current.config.enabled)
      if (!next.ok) return undefined // guard refused (egress consent missing)
      try {
        writeDecisionRouterConfig(next.config)
        setDecision({ config: next.config, corrupt: false })
      } catch {
        /* disk write failed — keep the in-memory state */
      }
      return undefined
    }

    const applySelectedPreset = () => {
      const id = selectedId()
      if (id === undefined) return undefined
      const name = id.startsWith('preset.') ? id.slice('preset.'.length) : null
      if (name === null || name === 'project') return undefined
      const path = globalActivePresetPath()
      try {
        if (name === 'none') clearActivePreset(path)
        else writeActivePreset(path, name)
        setPresetTick((tick) => tick + 1)
      } catch {
        /* disk write failed — the section keeps showing the last read state */
      }
      return undefined
    }

    let dismiss: () => void = () => {}
    try {
      context.keymap.layer(() => ({
        mode: 'global',
        enabled: () => open(),
        commands: [
          {
            id: 'pantheon.settings.close',
            title: 'Close settings',
            bind: 'escape,q',
            run: () => {
              if (!open()) return false
              dismiss()
              return undefined
            },
          },
          {
            id: 'pantheon.settings.down',
            title: 'Select next',
            bind: 'down,j',
            run: () => {
              if (!open()) return false
              move(1)
              return undefined
            },
          },
          {
            id: 'pantheon.settings.up',
            title: 'Select previous',
            bind: 'up,k',
            run: () => {
              if (!open()) return false
              move(-1)
              return undefined
            },
          },
          {
            id: 'pantheon.settings.toggle',
            title: 'Apply the selected row',
            bind: 'enter,space',
            run: () => {
              if (!open()) return false
              const id = selectedId()
              if (id?.startsWith('gate.')) return toggleSelectedGate()
              if (id === 'decision.enabled') return toggleDecisionEnabled()
              if (id?.startsWith('preset.')) return applySelectedPreset()
              if (id === 'update.check') return checkUpdatesNow()
              return undefined
            },
          },
          {
            id: 'pantheon.settings.section',
            title: 'Next section',
            bind: 'tab',
            run: () => {
              if (!open()) return false
              flipSection()
              return undefined
            },
          },
        ],
      }))
    } catch {
      /* keymap API unavailable — the host dialog chrome still dismisses (ESC) */
    }

    // The host may dismiss the dialog on its own and call this callback from
    // inside its dismissal; mutating the dialog stack there re-enters the host
    // mid-close and the swallowed failure leaves the window unclosable (the
    // whats-new split: clear() lives only in dismiss, never in close).
    const close = () => {
      setOpen(false)
    }
    dismiss = () => {
      try {
        context.ui.dialog.clear()
      } catch {
        /* already closed */
      }
      close()
    }
    setOpen(true)
    setPage(0)
    try {
      const theme = context.theme?.text ?? {}
      context.ui.dialog.show(
        () => (
          <SettingsContent
            sections={sections}
            page={page}
            selectedId={selectedId}
            fg={theme.base}
            muted={theme.muted}
          />
        ),
        close,
      )
      // Roomier chrome for the sectioned window; older hosts without `set`
      // keep the default size (fail-open).
      try {
        context.ui.dialog.set?.({ size: 'xlarge' })
      } catch {
        /* size control unavailable */
      }
    } catch {
      /* dialog stack unavailable — fail-open */
    }
  } catch {
    /* fail-open — the window must never block or break TUI startup */
  }
}
