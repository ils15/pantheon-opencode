// biome-ignore-all lint/suspicious/noExplicitAny: OpenCode exposes its TUI API at runtime.
// biome-ignore-all lint/a11y/noStaticElementInteractions: TUI elements, not DOM
/** @jsxImportSource @opentui/solid */

/**
 * whats-new.tsx — the one-time "What's new" window (per Pantheon version).
 *
 * When the running Pantheon version changed since the last TUI start, the V2
 * entrypoint fires {@link maybeShowWhatsNewV2} (fire-and-forget, never
 * awaited — startup must never block). The decision lives in
 * whats-new-open.ts; this file is only the host glue + view:
 * `context.ui.dialog.show` plus a keymap layer gated on the open signal so
 * `escape`/`q` dismiss while (and only while) the window is up — the same
 * gated-layer pattern as the dispatch panel.
 *
 * Deliberately V2-only: the two dist entries are self-contained (the V1
 * sidebar mirrors the preset resolver rather than importing it) because any
 * module shared by both entries becomes a content-hashed chunk in dist/,
 * changing the artifact shape the byte-reproducible-dist gate pins. The V1
 * generation (OpenCode 1.x, legacy) does not show the window; the pure
 * modules here are generation-agnostic, so a V1 mirror can follow the
 * documented inline-replica precedent if it is ever wanted.
 *
 * Dismissal always funnels into `markSeenWhatsNew` (idempotent), so the window
 * is shown exactly once per version. Every failure path is silent: missing
 * CHANGELOG.md, unreadable state, a host API that throws — the window simply
 * does not show (fail-open, like the rest of the plugin).
 */
import type { Context } from '@opencode/plugin/tui/context'
import { createSignal, For } from 'solid-js'
import { readChangelogForBundle, resolveRunningVersion } from './whats-new-highlights.ts'
import { openWhatsNew, type WhatsNewViewData } from './whats-new-open.ts'
import { defaultWhatsNewStatePath } from './whats-new-state.ts'

/** Window body: title, rule, bounded highlight lines, dismiss hint. */
export function WhatsNewContent(props: { data: WhatsNewViewData; fg?: any; muted?: any }) {
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>
      <text attributes={1} fg={props.fg}>
        {props.data.title}
      </text>
      <text fg={props.muted}>{'─'.repeat(38)}</text>
      <For each={props.data.lines}>
        {(line: string) => <text fg={line.startsWith('• ') ? props.fg : props.muted}>{line}</text>}
      </For>
      <box height={1} />
      <text fg={props.muted}>{props.data.hint}</text>
    </box>
  )
}

/**
 * Entry glue: resolve version + shipped CHANGELOG.md, then show the window
 * through the host dialog stack once. Never throws.
 */
export async function maybeShowWhatsNewV2(context: Context): Promise<void> {
  try {
    const version = await resolveRunningVersion(import.meta.url)
    if (!version) return
    const statePath = await defaultWhatsNewStatePath()
    const changelogText = await readChangelogForBundle(import.meta.url)

    const [open, setOpen] = createSignal(false)
    let dismiss: () => void = () => {}
    try {
      // Gated layer: inert (all keys fall through) while the window is closed.
      context.keymap.layer(() => ({
        mode: 'global',
        enabled: () => open(),
        commands: [
          {
            id: 'pantheon.whats-new.close',
            title: 'Fechar o que há de novo',
            bind: 'escape,q',
            run: () => {
              if (!open()) return false
              dismiss()
              return undefined
            },
          },
        ],
      }))
    } catch {
      /* keymap API unavailable — the host dialog chrome still dismisses (ESC) */
    }

    await openWhatsNew({
      version,
      statePath,
      changelogText,
      show: (render, onClose) => {
        const close = () => {
          setOpen(false)
          onClose()
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
        try {
          const theme = context.theme?.text ?? {}
          context.ui.dialog.show(
            () => <WhatsNewContent data={render()} fg={theme.base} muted={theme.muted} />,
            close,
          )
        } catch {
          /* dialog stack unavailable — fail-open, retried on the next start */
        }
      },
    })
  } catch {
    /* fail-open — the window must never block or break TUI startup */
  }
}
