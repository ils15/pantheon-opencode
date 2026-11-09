// biome-ignore-all lint/suspicious/noExplicitAny: OpenCode exposes its TUI API at runtime.
// biome-ignore-all lint/a11y/noStaticElementInteractions: TUI elements, not DOM
/** @jsxImportSource @opentui/solid */

/**
 * pantheon-settings.tsx — the /pantheon-settings window.
 *
 * Three pages (Gates / Overrides+About), keyboard-first: `up`/`down` select,
 * `enter`/`space` toggles the selected behavior (writes the GLOBAL overrides
 * file — the same one the installer and doctor consume), `tab` flips pages,
 * `escape`/`q` closes. The gated-layer pattern mirrors the dispatch panel and
 * whats-new windows. Every failure path is silent (fail-open).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@opencode/plugin/tui/context'
import { createSignal, For, Show } from 'solid-js'
import {
  type EffectiveOverrides,
  isBehaviorDisabled,
  SETTINGS_BEHAVIORS,
  type SettingsRow,
  serializeOverrides,
  toggledOverrides,
} from './pantheon-settings-state.ts'

function globalOverridesPath(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '', '.config')
  return join(xdgConfig, 'opencode', 'pantheon-overrides.json')
}

function readOverridesFromDisk(): EffectiveOverrides {
  try {
    return JSON.parse(readFileSync(globalOverridesPath(), 'utf8')) as EffectiveOverrides
  } catch {
    return {}
  }
}

function writeOverridesToDisk(effective: EffectiveOverrides): void {
  writeFileSync(globalOverridesPath(), serializeOverrides(effective), 'utf8')
}

/** Rows shown on the Gates page: behavior state from the overrides file. */
export function buildSettingsRows(effective: EffectiveOverrides): SettingsRow[] {
  return SETTINGS_BEHAVIORS.map((behavior) => ({
    id: behavior.id,
    title: behavior.title,
    description: behavior.description,
    disabled: isBehaviorDisabled(effective, behavior.id),
  }))
}

export function SettingsContent(props: {
  rows: () => SettingsRow[]
  selected: () => number
  page: () => number
  version: () => string
  about: () => string[]
  fg?: any
  muted?: any
}) {
  const marker = (row: SettingsRow) => (row.disabled ? '[x]' : '[ ]')
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>
      <Show
        when={props.page() === 0}
        fallback={
          <box flexDirection="column">
            <text attributes={1} fg={props.fg}>
              About
            </text>
            <text fg={props.muted}>{'─'.repeat(38)}</text>
            <For each={props.about()}>{(line: string) => <text fg={props.muted}>{line}</text>}</For>
          </box>
        }
      >
        <text attributes={1} fg={props.fg}>
          Gates &amp; Overrides
        </text>
        <text fg={props.muted}>{'─'.repeat(38)}</text>
        <For each={props.rows()}>
          {(row: SettingsRow, index: () => number) => (
            <box flexDirection="column">
              <text
                fg={props.selected() === index() ? props.fg : props.muted}
                attributes={props.selected() === index() ? 1 : undefined}
              >
                {`${marker(row)} ${row.title}${props.selected() === index() ? '  <-' : ''}`}
              </text>
              <text fg={props.muted}>{`    ${row.description}`}</text>
            </box>
          )}
        </For>
        <box height={1} />
        <text fg={props.muted}>
          {'enter: disable/enable · writes pantheon-overrides.json (global)'}
        </text>
      </Show>
      <box height={1} />
      <text fg={props.muted}>
        {`${props.page() + 1}/2 · `}tab: page · up/down: select · enter: toggle · esc/q: close
      </text>
    </box>
  )
}

/**
 * Entry glue: read the overrides state, then show the window through the host
 * dialog stack once. The gated keymap layer is inert while the window is
 * closed. Never throws.
 */
export async function maybeShowPantheonSettings(context: Context): Promise<void> {
  try {
    const [open, setOpen] = createSignal(false)
    const [page, setPage] = createSignal(0)
    const [selected, setSelected] = createSignal(0)
    const [effective, setEffective] = createSignal<EffectiveOverrides>(readOverridesFromDisk())

    const rows = () => buildSettingsRows(effective())
    const about = () => [
      `Pantheon v${resolveRunningVersion()}`,
      `${SETTINGS_BEHAVIORS.length} togglable behaviors · OpenCode 2.x only`,
      'Docs: docs/design/2.0-settings-and-install.md',
    ]

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
              setSelected((current) => Math.min(current + 1, rows().length - 1))
              return undefined
            },
          },
          {
            id: 'pantheon.settings.up',
            title: 'Select previous',
            bind: 'up,k',
            run: () => {
              if (!open()) return false
              setSelected((current) => Math.max(current - 1, 0))
              return undefined
            },
          },
          {
            id: 'pantheon.settings.toggle',
            title: 'Disable/enable the selected behavior',
            bind: 'enter,space',
            run: () => {
              if (!open()) return false
              const row = rows()[selected()]
              if (row === undefined) return false
              setEffective(toggledOverrides(effective(), row.id))
              writeOverridesToDisk(effective())
              return undefined
            },
          },
          {
            id: 'pantheon.settings.page',
            title: 'Flip page',
            bind: 'tab',
            run: () => {
              if (!open()) return false
              setPage((current) => (current === 0 ? 1 : 0))
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
            rows={rows}
            selected={selected}
            page={page}
            version={resolveRunningVersion}
            about={about}
            fg={theme.base}
            muted={theme.muted}
          />
        ),
        close,
      )
    } catch {
      /* dialog stack unavailable — fail-open */
    }
  } catch {
    /* fail-open — the window must never block or break TUI startup */
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
