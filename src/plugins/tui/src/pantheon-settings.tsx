// biome-ignore-all lint/suspicious/noExplicitAny: OpenCode exposes its TUI API at runtime.
// biome-ignore-all lint/a11y/noStaticElementInteractions: TUI elements, not DOM
/** @jsxImportSource @opentui/solid */

/**
 * pantheon-settings.tsx — the /pantheon-settings window (2.0.0-beta.4).
 *
 * A FULL-SCREEN settings window in the OpenCode Quota shape: a tab header,
 * grouped setting rows with ←/→ value cyclers, a note column, and a
 * save/reset footer. The surface is a ROUTER PAGE (`ui.router.register` +
 * `navigate({type:'plugin'})`) — true full-screen, reachable from the home
 * route AND sessions, no focus dance (binary-verified precedent: the host's
 * own opencode.diffs plugin). Hosts without a router fall back to the old
 * dialog with the same commands (fail-open).
 *
 * Edits stage into a DRAFT: ←/→ cycles a row's value, `ctrl+s` saves every
 * staged row through the per-surface guards, `ctrl+r` resets the current
 * tab, `esc`/`q` confirms before discarding. The disk never changes before
 * save, and every refusal surfaces in the notice line — never silent.
 *
 * The keymap layer is registered ONCE at setup with `priority: 1` (the host
 * resolves bind conflicts by priority then registration order — a stale
 * dispatch-panel layer must never win while this window is open; field
 * report beta.2: navigation "stopped working" was exactly that theft).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@opencode/plugin/tui/context'
import { createSignal, For, onCleanup, Show } from 'solid-js'
import {
  buildDecisionTab,
  type DecisionConfigRead,
  readDecisionRouterConfig,
  setDecisionEnabled,
  writeDecisionRouterConfig,
} from './decision-router-state.ts'
import { buildDoctorTab } from './doctor-state.ts'
import { buildJ1Tab } from './j1-gate-status.ts'
import {
  applyDraft,
  buildAboutTab,
  buildGatesTab,
  canWriteOverrides,
  type DraftWriter,
  type DraftWriterResult,
  draftCount,
  draftDirty,
  type EffectiveOverrides,
  EMPTY_TAB,
  type OverridesLoad,
  resetTab,
  type SettingsDraft,
  type SettingsRow,
  type SettingsTab,
  serializeOverrides,
  setOverrideState,
  settledDraft,
  stageValue,
  tabDirty,
  tabRows,
} from './pantheon-settings-state.ts'
import {
  buildPresetTab,
  clearActivePreset,
  globalActivePresetPath,
  PRESET_NONE,
  projectActivePresetPath,
  readActivePresetMarker,
  writeActivePreset,
} from './preset-state.ts'
import { applyTuiRow, buildTuiTab, mutateTuiPrefs, tuiPrefs } from './tui-prefs.ts'
import { nextCheckState, type UpdateCheckState } from './update-notice.ts'
import {
  buildUpdatesTab,
  registryUrlForChannel,
  type UpdatesSectionInput,
  updateChannelFor,
} from './update-status.ts'

export const ROUTE_NAME = 'pantheon-settings'


/** The input mode the page pushes while mounted (composer layers sleep). */
export const ROUTE_MODE = 'pantheon-settings'

/** Loose local shape of a host route (the real Route lives in the host typings). */
type WindowRoute =
  | { type: 'home' }
  | { type: 'session'; sessionID: string }
  | { type: 'plugin'; name: string; data?: Record<string, unknown> }

/**
 * Strip a LIVE route object down to the plain shape the route store expects.
 * `router.current()` returns the host's live data (reactive proxies, location
 * objects with cycles) and the host's navigate deep-clones via JSON.stringify
 * — passing the live object through throws "cyclic structures" and the
 * window could never close (field report beta.5, root cause).
 */
function plainRoute(route: WindowRoute | undefined): WindowRoute {
  if (route === undefined) return { type: 'home' }
  if (route.type === 'session' && 'sessionID' in route && typeof route.sessionID === 'string') {
    return { type: 'session', sessionID: route.sessionID }
  }
  if (route.type === 'plugin' && typeof route.name === 'string') {
    return { type: 'plugin', name: route.name }
  }
  return { type: 'home' }
}

// ── Shared blocking state (the dispatch panel gates on this) ───────────

const [blocking, setBlocking] = createSignal(false)

/** True while a Pantheon settings surface (page or fallback dialog) is open. */
export function pantheonSettingsBlocking(): boolean {
  return blocking()
}

let routerAvailable = false

// ── Disk readers/writers (unchanged contracts from beta.2/3) ───────────

function globalOverridesPath(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '', '.config')
  return join(xdgConfig, 'opencode', 'pantheon-overrides.json')
}

function projectOverridesPath(): string {
  return join(process.cwd(), '.pantheon', 'overrides.json')
}

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
  // The tsdown embed (same source the sidebar footer uses) is authoritative —
  // the naive ../../package.json read breaks in every real layout (the dev
  // tree and the installed TUI copy both put package.json one level above
  // dist, not two — field report beta.5: the header showed vunknown).
  if (typeof __PANTHEON_VERSION__ !== 'undefined' && __PANTHEON_VERSION__ !== '') {
    return __PANTHEON_VERSION__
  }
  try {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string }
    return manifest.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

// ── The window view (presentational; both surfaces render it) ──────────

const NAME_WIDTH = 28
const VALUE_WIDTH = 22

export function SettingsWindow(props: {
  version: string
  tabs: () => SettingsTab[]
  page: () => number
  selected: () => number
  draft: () => SettingsDraft
  notice: () => string | undefined
  fg?: any
  muted?: any
  warn?: any
}) {
  const tab = () => props.tabs()[props.page()] ?? props.tabs()[0] ?? EMPTY_TAB
  const rows = () => tabRows(tab())
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>
      <box flexDirection="row">
        <text flexShrink={0} attributes={1} fg={props.fg}>
          {`Pantheon v${props.version}`}
        </text>
        <For each={props.tabs()}>
          {(t, index) => (
            <text
              flexShrink={0}
              fg={index() === props.page() ? props.fg : props.muted}
              {...(index() === props.page() ? { attributes: 1 } : {})}
            >
              {`   ${t.title}${tabDirty(props.draft(), t) ? ' ●' : ''}`}
            </text>
          )}
        </For>
        <box flexGrow={1} />
        <text flexShrink={0} fg={props.muted}>
          {'esc'}
        </text>
      </box>
      <text fg={props.muted}>{'─'.repeat(72)}</text>
      <For each={tab().groups}>
        {(group) => (
          <box flexDirection="column">
            <Show when={group.title !== undefined}>
              <text attributes={1} fg={props.fg}>
                {group.title}
              </text>
            </Show>
            <For each={group.rows}>
              {(row: SettingsRow) => {
                const isSelected = () => rows()[props.selected()]?.id === row.id
                const display = () => props.draft()[row.id] ?? row.value
                const staged = () => props.draft()[row.id] !== undefined
                const gutter = () => (isSelected() ? '▸ ' : '  ')
                const valueCell = () => (row.cycle !== undefined ? `< ${display()} >` : display())
                return (
                  <box flexDirection="row">
                    <box width={NAME_WIDTH + 2}>
                      <text fg={props.fg} {...(isSelected() ? { attributes: 1 } : {})}>
                        {`${gutter()}${row.name}`.padEnd(NAME_WIDTH + 2)}
                      </text>
                    </box>
                    <box width={VALUE_WIDTH}>
                      <text
                        fg={isSelected() || staged() ? props.fg : props.muted}
                        {...(isSelected() ? { attributes: 1 } : {})}
                      >
                        {`${valueCell()}${staged() ? ' ●' : ''}`.padEnd(VALUE_WIDTH)}
                      </text>
                    </box>
                    <Show when={row.note !== undefined}>
                      <box flexGrow={1} flexShrink={1}>
                        <text fg={props.muted}>{row.note}</text>
                      </box>
                    </Show>
                  </box>
                )
              }}
            </For>
            <box height={1} />
          </box>
        )}
      </For>
      <Show when={props.notice() !== undefined}>
        <text fg={props.notice()?.startsWith('saved') ? props.muted : (props.warn ?? props.muted)}>
          {props.notice()?.startsWith('saved') ? props.notice() : `⚠ ${props.notice()}`}
        </text>
      </Show>
      <text fg={draftDirty(props.draft()) ? (props.warn ?? props.fg) : props.muted}>
        {draftDirty(props.draft())
          ? `● unsaved (${draftCount(props.draft())}) — ctrl+s save · ctrl+r reset page`
          : 'no staged changes'}
      </text>
      <text fg={props.muted}>
        {
          '1-9 tab · ←/→ change value · enter apply · tab next tab · ctrl+s save · ctrl+r reset page · esc/q close'
        }
      </text>
    </box>
  )
}

// ── Shared window controller (signals + writers), mounted per surface ──

interface PageApi {
  move: (delta: number) => void
  step: (direction: 1 | -1) => void
  actuate: () => void
  nextTab: () => void
  jumpTab: (index: number) => void
  save: () => void
  resetPage: () => void
  close: () => void
}

let pageApi: PageApi | undefined

function createWindowController(
  context: Context,
  exit: () => void,
): {
  tabs: () => SettingsTab[]
  page: () => number
  selected: () => number
  draft: () => SettingsDraft
  notice: () => string | undefined
  api: PageApi
  cleanup: () => void
} {
  const [page, setPage] = createSignal(0)
  const [selected, setSelected] = createSignal(0)
  const [load, setLoad] = createSignal(readOverridesLoad())
  const [decision, setDecision] = createSignal<DecisionConfigRead>(readDecisionRouterConfig())
  const [presetTick, setPresetTick] = createSignal(0)
  const [lastChecked, setLastChecked] = createSignal<string | undefined>(undefined)
  const [checking, setChecking] = createSignal(false)
  const [draft, setDraft] = createSignal<SettingsDraft>({})
  const [notice, setNotice] = createSignal<string | undefined>(undefined)

  const currentVersion = resolveRunningVersion()

  const presetInput = () => {
    void presetTick()
    return {
      globalName: readActivePresetMarker(globalActivePresetPath())?.name ?? null,
      projectName: readActivePresetMarker(projectActivePresetPath())?.name ?? null,
    }
  }

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

  const tabs = (): SettingsTab[] => [
    buildGatesTab(load()),
    buildDecisionTab(decision()),
    buildPresetTab(presetInput()),
    buildTuiTab(tuiPrefs()),
    buildJ1Tab(process.env, false),
    buildUpdatesTab(updatesInput()),
    buildDoctorTab({
      runningVersion: currentVersion,
      nodeVersion: process.versions.node,
      load: load(),
    }),
    buildAboutTab(currentVersion),
  ]

  const rows = () => tabRows(tabs()[page()] ?? tabs()[0] ?? EMPTY_TAB)

  const move = (delta: number) => {
    const list = rows()
    if (list.length === 0) return
    setSelected((current) => Math.min(Math.max(current + delta, 0), list.length - 1))
  }

  const step = (direction: 1 | -1) => {
    const row = rows()[selected()]
    if (row === undefined) return
    setNotice(undefined)
    setDraft(stageValue(draft(), row, direction))
  }

  const checkUpdatesNow = () => {
    if (checking()) return
    setChecking(true)
    setNotice(undefined)
    void fetchLatestForChannel(currentVersion)
      .then((latest) => {
        if (latest) setLastChecked(latest)
        persistUpdateCheckState(readUpdateCheckState(), latest)
      })
      .catch(() => {
        /* offline — the row keeps the last known state */
      })
      .finally(() => setChecking(false))
  }

  const dispatchWrite = (id: string, value: string): DraftWriterResult => {
    if (id.startsWith('gate.')) {
      if (!canWriteOverrides(load())) {
        return { ok: false, reason: 'overrides file unreadable — repair with `doctor --fix`' }
      }
      const behaviorId = id.slice('gate.'.length)
      const nextGlobal = setOverrideState(
        load().global,
        behaviorId,
        value === 'disabled' ? 'disabled' : 'enabled',
      )
      if (nextGlobal === load().global) return { ok: true }
      try {
        writeOverridesToDisk({ ...load(), global: nextGlobal })
        setLoad({ ...load(), global: nextGlobal })
        return { ok: true }
      } catch {
        return { ok: false, reason: 'overrides disk write failed' }
      }
    }
    if (id === 'decision.enabled') {
      const current = decision()
      if (current.corrupt) {
        return {
          ok: false,
          reason: 'decision-router.json unreadable — repair via `decision-router setup-model`',
        }
      }
      const guarded = setDecisionEnabled(current.config, value === 'enabled')
      if (!guarded.ok) return { ok: false, reason: guarded.reason }
      try {
        writeDecisionRouterConfig(guarded.config)
        setDecision({ config: guarded.config, corrupt: false })
        return { ok: true }
      } catch {
        return { ok: false, reason: 'decision-router disk write failed' }
      }
    }
    if (id === 'preset') {
      try {
        if (value === PRESET_NONE) clearActivePreset(globalActivePresetPath())
        else writeActivePreset(globalActivePresetPath(), value)
        setPresetTick((tick) => tick + 1)
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : 'preset marker write failed',
        }
      }
    }
    if (id.startsWith('tui.')) {
      // The prefs live in the host's durable reactive store: the mutation is
      // async (persist), but the in-memory store flips immediately — the
      // sidebar/footer/panel re-render on save, no restart. A persist
      // failure surfaces in the notice line when it settles.
      try {
        mutateTuiPrefs((prefsDraft) => applyTuiRow(prefsDraft, id, value))
          .then(() => setNotice(undefined))
          .catch(() =>
            setNotice('tui prefs: persist failed — the change is active for this session only'),
          )
        return { ok: true }
      } catch {
        return { ok: false, reason: 'tui prefs storage unavailable' }
      }
    }
    return { ok: false, reason: 'unknown staged row' }
  }

  const save = () => {
    if (!draftDirty(draft())) {
      setNotice('nothing staged — ←/→ stages a change first')
      return
    }
    const writer: DraftWriter = dispatchWrite
    const { applied, failed } = applyDraft(draft(), writer)
    if (applied.length > 0) {
      setDraft(settledDraft(draft(), applied))
      setLoad(readOverridesLoad())
      setDecision(readDecisionRouterConfig())
      setPresetTick((tick) => tick + 1)
    }
    if (failed.length > 0) {
      setNotice(`${failed.map((f) => `${f.id}: ${f.reason}`).join(' · ')} — staged changes kept`)
    } else {
      setNotice(`saved ${applied.length} change${applied.length === 1 ? '' : 's'}`)
    }
  }

  const resetPage = () => {
    const tab = tabs()[page()]
    if (tab === undefined) return
    setDraft(resetTab(draft(), tab))
    setNotice(undefined)
  }

  const nextTab = () => {
    setPage((current) => (current + 1) % tabs().length)
    setSelected(0)
  }

  const close = () => {
    // A dialog.confirm here would render in the home/session view chrome,
    // which a full-screen ROUTE page replaces — an invisible prompt that
    // pends forever (field report beta.5: esc "did nothing" with staged
    // changes). Close always exits; discarding is announced, never asked.
    const staged = draftCount(draft())
    if (staged > 0) {
      setDraft({})
      try {
        context.ui.toast?.show?.({
          variant: 'info',
          message: `settings: ${staged} staged change${staged === 1 ? '' : 's'} discarded`,
        })
      } catch {
        /* toast unavailable */
      }
    }
    exit()
  }

  const api: PageApi = {
    move,
    step,
    actuate: () => {
      const row = rows()[selected()]
      if (row?.action === 'update-check') checkUpdatesNow()
      else step(1)
    },
    nextTab,
    jumpTab: (index) => {
      if (index >= 0 && index < tabs().length) {
        setPage(index)
        setSelected(0)
      }
    },
    save,
    resetPage,
    close,
  }

  return {
    tabs,
    page,
    selected,
    draft,
    notice,
    api,
    cleanup: () => {
      pageApi = undefined
      setBlocking(false)
    },
  }
}

// ── The router page (the primary surface) ──────────────────────────────

function SettingsPage(props: { context: Context; data: Record<string, any> | undefined }) {
  const returnRoute = (props.data as { returnRoute?: WindowRoute } | undefined)?.returnRoute
  const context = props.context
  const controller = createWindowController(context, () =>
    navigateBack(context, returnRoute !== undefined ? { returnRoute } : {}),
  )
  const theme = context.theme?.text ?? {}
  const warn = (theme?.feedback as any)?.warning?.base ?? theme.muted
  // The page owns the keyboard while mounted: push an input MODE so the
  // composer's base-mode layers sleep (they eat escape and plain letters —
  // the host's own menus push a mode for exactly this). The page layer is
  // scoped to this mode; cleanup pops it.
  try {
    const popMode = context.keymap?.mode?.push?.(ROUTE_MODE)
    if (popMode !== undefined) onCleanup(() => popMode())
  } catch {
    /* mode API unavailable — composer layers stay active; keys still fall
       through to the mode-less fallback layer below */
  }
  onCleanup(controller.cleanup)
  setBlocking(true)
  pageApi = controller.api
  return (
    <SettingsWindow
      version={resolveRunningVersion()}
      tabs={controller.tabs}
      page={controller.page}
      selected={controller.selected}
      draft={controller.draft}
      notice={controller.notice}
      fg={theme.base}
      muted={theme.muted}
      warn={warn}
    />
  )
}

function navigateBack(context: Context, data?: { returnRoute?: WindowRoute }): void {
  try {
    const fallback: WindowRoute = { type: 'home' }
    const destination = data?.returnRoute ?? fallback
    context.ui.toast?.show?.({ variant: 'info', message: `settings: navigating ${JSON.stringify(destination)}` })
    context.ui.router.navigate(destination)
    context.ui.toast?.show?.({ variant: 'info', message: 'settings: navigate returned' })
  } catch (error) {
  }
}

// ── The fallback dialog (hosts without a router) ───────────────────────

const [dialogOpen, setDialogOpen] = createSignal(false)
let dialogDismiss: () => void = () => {}

function openSettingsDialog(context: Context): void {
  const controller = createWindowController(context, () => dialogDismiss())
  const theme = context.theme?.text ?? {}
  const warn = (theme?.feedback as any)?.warning?.base ?? theme.muted
  controller.cleanup = () => {
    pageApi = undefined
    setBlocking(false)
    setDialogOpen(false)
  }
  // The host may dismiss the dialog on its own and call this callback from
  // inside its dismissal; clear() must never run there (the whats-new split).
  const close = () => {
    controller.cleanup()
  }
  dialogDismiss = () => {
    try {
      context.ui.dialog.clear()
    } catch {
      /* already closed */
    }
    close()
  }
  setBlocking(true)
  setDialogOpen(true)
  pageApi = controller.api
  try {
    context.ui.dialog.show(
      () => (
        <SettingsWindow
          version={resolveRunningVersion()}
          tabs={controller.tabs}
          page={controller.page}
          selected={controller.selected}
          draft={controller.draft}
          notice={controller.notice}
          fg={theme.base}
          muted={theme.muted}
          warn={warn}
        />
      ),
      close,
    )
  } catch {
    /* dialog stack unavailable — fail-open */
  }
}

// ── Setup: register once, gate once, priority 1 (anti-theft) ───────────

export function setupPantheonSettings(context: Context): void {
  try {
    context.ui.router?.register?.({
      name: ROUTE_NAME,
      render: ({ data }) => <SettingsPage context={context} data={data} />,
    })
    routerAvailable = true
  } catch {
    routerAvailable = false
  }

  const routeGated = () => {
    try {
      const route = context.ui?.router?.current?.()
      return route?.type === 'plugin' && route.name === ROUTE_NAME
    } catch {
      return false
    }
  }
  const commands = [
    {
      id: 'pantheon.settings.close',
      title: 'Close settings',
      bind: 'escape,q',
      run: () => {
        try {
          context.ui.toast?.show?.({ variant: 'info', message: 'settings: close command fired' })
        } catch {}
        if (pageApi === undefined) {
          try {
            context.ui.toast?.show?.({
              variant: 'warning',
              message: 'settings: no window controller bound',
            })
          } catch {
            /* toast unavailable */
          }
          return undefined
        }
        pageApi.close()
        return undefined
      },
    },
    {
      id: 'pantheon.settings.down',
      title: 'Select next row',
      bind: 'down,j',
      run: () => {
        pageApi?.move(1)
        return undefined
      },
    },
    {
      id: 'pantheon.settings.up',
      title: 'Select previous row',
      bind: 'up,k',
      run: () => {
        pageApi?.move(-1)
        return undefined
      },
    },
    {
      id: 'pantheon.settings.cycle.next',
      title: 'Stage the next value',
      bind: 'right,l',
      run: () => {
        pageApi?.step(1)
        return undefined
      },
    },
    {
      id: 'pantheon.settings.cycle.prev',
      title: 'Stage the previous value',
      bind: 'left,h',
      run: () => {
        pageApi?.step(-1)
        return undefined
      },
    },
    {
      id: 'pantheon.settings.actuate',
      title: 'Apply / act on the row',
      bind: 'enter,space',
      run: () => {
        pageApi?.actuate()
        return undefined
      },
    },
    {
      id: 'pantheon.settings.next.tab',
      title: 'Next settings tab',
      bind: 'tab',
      run: () => {
        pageApi?.nextTab()
        return undefined
      },
    },
    {
      id: 'pantheon.settings.save',
      title: 'Save staged changes',
      bind: 'ctrl+s',
      run: () => {
        pageApi?.save()
        return undefined
      },
    },
    {
      id: 'pantheon.settings.reset.page',
      title: 'Reset this tab',
      bind: 'ctrl+r',
      run: () => {
        pageApi?.resetPage()
        return undefined
      },
    },
    ...Array.from({ length: 9 }, (_, index) => ({
      id: `pantheon.settings.tab.${index + 1}`,
      title: `Jump to tab ${index + 1}`,
      bind: String(index + 1),
      run: () => {
        pageApi?.jumpTab(index)
        return undefined
      },
    })),
  ]
  // The PAGE layer: scoped to the mode the page pushes while mounted, so the
  // composer's base-mode layers sleep and escape/q reach the close command
  // (field report beta.5: a global layer on a route lost escape/q to the
  // composer — the host's own menus push a mode for exactly this). The
  // route gate stays as a belt-and-suspenders against stale modes.
  try {
    context.keymap.layer(() => ({
      mode: ROUTE_MODE,
      priority: 1,
      enabled: () => routeGated(),
      commands,
    }))
  } catch {
    /* keymap API unavailable — the fallback dialog below still works */
  }
  // The FALLBACK DIALOG layer: same commands, gated on the dialog signal.
  try {
    context.keymap.layer(() => ({
      mode: 'global' as const,
      priority: 1,
      enabled: () => dialogOpen(),
      commands,
    }))
  } catch {
    /* keymap API unavailable — host chrome still dismisses (ESC) */
  }
}

// ── The entry point (command run) ──────────────────────────────────────

export async function openPantheonSettings(context: Context): Promise<void> {
  try {
    if (routerAvailable && context.ui?.router?.navigate) {
      let returnRoute: WindowRoute | undefined
      try {
        const current = context.ui.router.current()
        // Never return INTO the settings page itself; always pass a PLAIN
        // route (see plainRoute — live objects are cyclic).
        if (!(current.type === 'plugin' && current.name === ROUTE_NAME)) {
          returnRoute = plainRoute(current as WindowRoute)
        }
      } catch {
        returnRoute = undefined
      }
      context.ui.router.navigate({
        type: 'plugin',
        name: ROUTE_NAME,
        ...(returnRoute !== undefined ? { data: { returnRoute } } : {}),
      })
      return
    }
  } catch {
    /* router unusable — fall through to the dialog */
  }
  openSettingsDialog(context)
}
