// biome-ignore-all lint/suspicious/noExplicitAny: OpenCode exposes its TUI API at runtime.
// biome-ignore-all lint/a11y/noStaticElementInteractions: TUI elements, not DOM
/** @jsxImportSource @opentui/solid */

/**
 * artifacts.tsx — Interactive `/pantheon-artifacts` (and `/artifacts`) TUI dialog.
 *
 * Scans `.pantheon/deepwork/<slug>/*.md`, `.pantheon/reports/*.md`, and
 * `docs/adr/*.md` (resolving linked git worktrees back to the main repository),
 * lets users browse artifacts with keyboard or mouse, and renders paginated
 * terminal-friendly views of plans, reports, and ADRs.
 */

import { readFileSync } from 'node:fs'
import type { Context } from '@opencode/plugin/tui/context'
import { createSignal, For, Show } from 'solid-js'
import {
  ARTIFACT_LINE_WIDTH,
  artifactKindLabel,
  formatArtifactLines,
  type PantheonArtifactEntry,
  paginateArtifactLines,
  scanPantheonArtifacts,
} from './artifacts-state.ts'
import { handleMouseClick, stopMouseEvent } from './mouse-click'
import { resolveLanguage } from './settings-i18n'
import { tuiPrefs } from './tui-prefs'

function readArtifactContent(entry: PantheonArtifactEntry): string {
  try {
    return readFileSync(entry.path, 'utf8')
  } catch {
    return ''
  }
}

function lineColor(line: string, fg: any, muted: any, warn: any): any {
  if (/^\[(?:IMPORTANT|WARNING|CAUTION)\]/.test(line)) return warn ?? '#fba970'
  if (/^\[(?:NOTE|TIP|Mermaid Diagram|Code)/.test(line)) return '#60a5fa'
  if (line.startsWith('• ')) return fg
  if (
    line.startsWith('· ') ||
    (line === line.toUpperCase() && /[A-Z]/.test(line) && line.length > 3)
  ) {
    return fg
  }
  if (line.startsWith('─')) return muted
  return muted ?? fg
}

export function ArtifactsDialogContent(props: {
  entries: PantheonArtifactEntry[]
  selected: () => number
  mode: () => 'list' | 'read'
  page: () => number
  pages: () => string[][]
  isPt: boolean
  fg?: any
  muted?: any
  warn?: any
  onSelect: (index: number) => void
  onOpen: (index?: number) => void
  onBack: () => void
  onPrevPage: () => void
  onNextPage: () => void
  onClose: () => void
}) {
  const activeEntry = () => props.entries[props.selected()]
  const pageCount = () => Math.max(1, props.pages().length)
  const currentRows = () => props.pages()[Math.min(props.page(), pageCount() - 1)] ?? []
  const rule = '─'.repeat(ARTIFACT_LINE_WIDTH)

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={props.warn ?? '#fba970'}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
    >
      {/* Header */}
      <box flexDirection="row" alignItems="center" justifyContent="space-between">
        <box flexDirection="row" alignItems="center">
          <box
            backgroundColor={props.warn ?? '#fba970'}
            paddingLeft={1}
            paddingRight={1}
            marginRight={1}
          >
            <text fg="#000000" attributes={1}>
              {props.isPt ? 'ARTEFATOS' : 'ARTIFACTS'}
            </text>
          </box>
          <text attributes={1} fg={props.fg}>
            {props.mode() === 'read' && activeEntry()
              ? activeEntry()?.title.slice(0, 52)
              : props.isPt
                ? `Planos, Relatórios & ADRs (${props.entries.length})`
                : `Plans, Reports & ADRs (${props.entries.length})`}
          </text>
        </box>
        <box
          onMouseDown={stopMouseEvent}
          onMouseUp={(event: any) => handleMouseClick(event, () => props.onClose())}
        >
          <text fg={props.muted}>{'[ Esc / Q ]'}</text>
        </box>
      </box>

      <box flexDirection="row" height={1} marginTop={1} marginBottom={1}>
        <text fg={props.muted}>{rule}</text>
      </box>

      {/* Body: List or Paginated Reader */}
      <Show
        when={props.mode() === 'read' && activeEntry() !== undefined}
        fallback={
          <box flexDirection="column" minHeight={10}>
            <Show
              when={props.entries.length > 0}
              fallback={
                <box flexDirection="column">
                  <text fg={props.fg} attributes={1}>
                    {props.isPt
                      ? 'Nenhum artefato encontrado neste workspace.'
                      : 'No artifacts found in this workspace.'}
                  </text>
                  <text fg={props.muted} marginTop={1}>
                    {props.isPt
                      ? 'Onde o Pantheon salva artefatos:'
                      : 'Where Pantheon stores artifacts:'}
                  </text>
                  <text fg={props.muted}>
                    {'• .pantheon/deepwork/<slug>/PLAN.md  (/pantheon-deepwork / @athena)'}
                  </text>
                  <text fg={props.muted}>
                    {'• .pantheon/reports/*.md             (@apollo / @themis)'}
                  </text>
                  <text fg={props.muted}>
                    {'• docs/adr/*.md                      (@mnemosyne)'}
                  </text>
                </box>
              }
            >
              <For each={props.entries.slice(0, 12)}>
                {(entry, idx) => {
                  const isSelected = () => idx() === props.selected()
                  const kindTag =
                    `[${artifactKindLabel(entry.kind, props.isPt).toUpperCase()}]`.padEnd(13)
                  const title = (
                    entry.title.length > 30 ? `${entry.title.slice(0, 29)}…` : entry.title
                  ).padEnd(32)
                  const pathTail =
                    entry.relPath.length > 26 ? `…${entry.relPath.slice(-25)}` : entry.relPath
                  return (
                    <box
                      flexDirection="row"
                      {...(isSelected() ? { backgroundColor: '#262626' } : {})}
                      onMouseDown={stopMouseEvent}
                      onMouseUp={(event: any) =>
                        handleMouseClick(event, () => {
                          if (isSelected()) props.onOpen(idx())
                          else props.onSelect(idx())
                        })
                      }
                    >
                      <text
                        fg={isSelected() ? (props.warn ?? '#fba970') : props.muted}
                        attributes={1}
                        wrapMode="none"
                      >
                        {isSelected() ? '▸ ' : '  '}
                      </text>
                      <text
                        fg={isSelected() ? (props.warn ?? '#fba970') : '#60a5fa'}
                        wrapMode="none"
                      >
                        {kindTag}
                      </text>
                      <text
                        fg={isSelected() ? props.fg : props.muted}
                        wrapMode="none"
                        {...(isSelected() ? { attributes: 1 } : {})}
                      >
                        {title}
                      </text>
                      <text
                        fg={props.muted}
                        wrapMode="none"
                      >{`${pathTail} (${entry.lineCount}L)`}</text>
                    </box>
                  )
                }}
              </For>
            </Show>
          </box>
        }
      >
        <box flexDirection="column" minHeight={12}>
          <text fg={props.muted} marginBottom={1}>
            {`${activeEntry()?.relPath ?? ''} · ${activeEntry()?.lineCount ?? 0} ${props.isPt ? 'linhas' : 'lines'}`}
          </text>
          <For each={currentRows()}>
            {(line: string) => (
              <text fg={lineColor(line, props.fg, props.muted, props.warn)}>
                {line === '' ? ' ' : line}
              </text>
            )}
          </For>
        </box>
      </Show>

      <box flexDirection="row" height={1} marginTop={1}>
        <text fg={props.muted}>{rule}</text>
      </box>

      {/* Footer Actions */}
      <box flexDirection="row" alignItems="center" justifyContent="space-between" marginTop={1}>
        <box flexDirection="row" alignItems="center" flexShrink={1}>
          <Show when={props.mode() === 'read'}>
            <box
              backgroundColor="#262626"
              paddingLeft={1}
              paddingRight={1}
              marginRight={1}
              flexShrink={0}
              onMouseDown={stopMouseEvent}
              onMouseUp={(event: any) => handleMouseClick(event, () => props.onBack())}
            >
              <text fg="#ffffff" wrapMode="none">
                {props.isPt ? '‹ Lista' : '‹ List'}
              </text>
            </box>
            <Show when={pageCount() > 1}>
              <box
                backgroundColor="#262626"
                paddingLeft={1}
                paddingRight={1}
                marginRight={1}
                flexShrink={0}
                onMouseDown={stopMouseEvent}
                onMouseUp={(event: any) => handleMouseClick(event, () => props.onPrevPage())}
              >
                <text fg="#ffffff" wrapMode="none">
                  {props.isPt ? '‹ Anterior' : '‹ Prev'}
                </text>
              </box>
              <text fg={props.muted} marginRight={1} wrapMode="none">
                {`${props.page() + 1}/${pageCount()}`}
              </text>
              <box
                backgroundColor="#262626"
                paddingLeft={1}
                paddingRight={1}
                marginRight={1}
                flexShrink={0}
                onMouseDown={stopMouseEvent}
                onMouseUp={(event: any) => handleMouseClick(event, () => props.onNextPage())}
              >
                <text fg="#ffffff" wrapMode="none">
                  {props.isPt ? 'Próxima ›' : 'Next ›'}
                </text>
              </box>
            </Show>
          </Show>
          <text fg={props.muted} wrapMode="none">
            {props.mode() === 'read'
              ? props.isPt
                ? 'b lista · n/p pág · esc'
                : 'b list · n/p page · esc'
              : props.isPt
                ? '↑/↓ mover · enter abrir · esc fechar'
                : '↑/↓ move · enter open · esc close'}
          </text>
        </box>

        <box
          backgroundColor={props.warn ?? '#fba970'}
          paddingLeft={2}
          paddingRight={2}
          flexShrink={0}
          onMouseDown={stopMouseEvent}
          onMouseUp={(event: any) =>
            handleMouseClick(event, () => {
              if (props.mode() === 'list' && props.entries.length > 0) props.onOpen()
              else props.onClose()
            })
          }
        >
          <text fg="#000000" attributes={1} wrapMode="none">
            {props.mode() === 'list' && props.entries.length > 0
              ? props.isPt
                ? 'Abrir'
                : 'Open'
              : props.isPt
                ? 'Fechar'
                : 'Close'}
          </text>
        </box>
      </box>
    </box>
  )
}

export function openArtifactsDialog(
  context: Context,
  workspaceDir: string,
  options?: { initialArtifactId?: string },
): void {
  const entries = scanPantheonArtifacts(workspaceDir)
  const initialIndex = options?.initialArtifactId
    ? entries.findIndex((entry) => entry.id === options.initialArtifactId)
    : -1
  const resolvedIndex = initialIndex >= 0 ? initialIndex : 0
  const isPt = resolveLanguage(tuiPrefs().layout?.language) === 'pt-BR'
  const [open, setOpen] = createSignal(false)
  const [selected, setSelected] = createSignal(resolvedIndex)
  const [mode, setMode] = createSignal<'list' | 'read'>(
    initialIndex >= 0 || entries.length === 1 ? 'read' : 'list',
  )
  const [page, setPage] = createSignal(0)

  const pages = () => {
    const entry = entries[selected()]
    if (!entry) return [[]]
    return paginateArtifactLines(
      formatArtifactLines(readArtifactContent(entry), ARTIFACT_LINE_WIDTH),
    )
  }

  let dismiss = () => {}

  const openSelected = (idx?: number) => {
    if (entries.length === 0) return
    if (typeof idx === 'number') setSelected(Math.min(Math.max(idx, 0), entries.length - 1))
    setPage(0)
    setMode('read')
  }

  try {
    context.keymap.layer(() => ({
      mode: 'global',
      priority: 1,
      enabled: () => open(),
      commands: [
        {
          id: 'pantheon.artifacts.close',
          title: 'Close artifacts viewer',
          bind: 'escape,q',
          run: () => {
            if (!open()) return false
            dismiss()
            return undefined
          },
        },
        {
          id: 'pantheon.artifacts.up',
          title: 'Previous artifact',
          bind: 'up,k',
          run: () => {
            if (!open() || mode() !== 'list' || entries.length === 0) return false
            setSelected((cur) => Math.max(0, cur - 1))
            return undefined
          },
        },
        {
          id: 'pantheon.artifacts.down',
          title: 'Next artifact',
          bind: 'down,j',
          run: () => {
            if (!open() || mode() !== 'list' || entries.length === 0) return false
            setSelected((cur) => Math.min(entries.length - 1, cur + 1))
            return undefined
          },
        },
        {
          id: 'pantheon.artifacts.open-item',
          title: 'Open selected artifact',
          bind: 'enter,space',
          run: () => {
            if (!open()) return false
            if (mode() === 'list' && entries.length > 0) openSelected()
            else dismiss()
            return undefined
          },
        },
        {
          id: 'pantheon.artifacts.back',
          title: 'Back to artifacts list',
          bind: 'b,backspace',
          run: () => {
            if (!open()) return false
            if (mode() === 'read') setMode('list')
            return undefined
          },
        },
        {
          id: 'pantheon.artifacts.next-page',
          title: 'Next artifact page',
          bind: 'n,right',
          run: () => {
            if (!open() || mode() !== 'read') return false
            setPage((cur) => Math.min(cur + 1, Math.max(0, pages().length - 1)))
            return undefined
          },
        },
        {
          id: 'pantheon.artifacts.prev-page',
          title: 'Previous artifact page',
          bind: 'p,left',
          run: () => {
            if (!open() || mode() !== 'read') return false
            setPage((cur) => Math.max(0, cur - 1))
            return undefined
          },
        },
      ],
    }))
  } catch {
    /* keymap unavailable — host chrome handles ESC */
  }

  const close = () => setOpen(false)
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
    const warn = (theme?.feedback as any)?.warning?.base ?? '#fba970'
    context.ui.dialog.show(
      () => (
        <ArtifactsDialogContent
          entries={entries}
          selected={selected}
          mode={mode}
          page={page}
          pages={pages}
          isPt={isPt}
          fg={theme.base}
          muted={theme.muted}
          warn={warn}
          onSelect={(idx) => setSelected(idx)}
          onOpen={(idx) => openSelected(idx)}
          onBack={() => setMode('list')}
          onPrevPage={() => setPage((cur) => Math.max(0, cur - 1))}
          onNextPage={() => setPage((cur) => Math.min(cur + 1, Math.max(0, pages().length - 1)))}
          onClose={dismiss}
        />
      ),
      close,
    )
    context.ui.dialog.set({ size: 'large', centered: true })
  } catch {
    setOpen(false)
  }
}
