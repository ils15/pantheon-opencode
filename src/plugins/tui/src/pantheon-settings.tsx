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
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@opencode/plugin/tui/context'
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import {
  buildAutonomyTab,
  DEFAULT_DECISION_BUDGETS,
  DEFAULT_GOAL_LOOP_PREFS,
  type DecisionBudgets,
  type GoalLoopPrefs,
  parseUsd,
} from './autonomy-state.ts'
import {
  applyDecisionRow,
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
  buildChangelogTab,
  buildGatesTab,
  type ChangelogHighlightItem,
  canWriteOverrides,
  type DraftWriter,
  type DraftWriterResult,
  draftCount,
  draftDirty,
  type EffectiveOverrides,
  EMPTY_TAB,
  findRow,
  type OverridesLoad,
  resetTab,
  type SettingsDraft,
  type SettingsRow,
  type SettingsTab,
  serializeOverrides,
  setOverrideState,
  settledDraft,
  stageDefaults,
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
  type UpdateChannel,
  type UpdatesSectionInput,
  updateChannelFor,
} from './update-status.ts'
import { extractHighlights, readChangelogForBundle } from './whats-new-highlights.ts'

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

function userOpenCodeConfigPath(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '', '.config')
  return join(xdgConfig, 'opencode', 'opencode.json')
}

/** Read options.goal_loop from the user's opencode.json (fail-open). */
function readGoalLoopPrefs(): GoalLoopPrefs {
  const fallback = { ...DEFAULT_GOAL_LOOP_PREFS }
  try {
    const parsed = JSON.parse(readFileSync(userOpenCodeConfigPath(), 'utf8')) as {
      options?: { goal_loop?: Partial<GoalLoopPrefs> }
    }
    const raw = parsed?.options?.goal_loop
    if (raw && typeof raw === 'object') {
      return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
        cooldownMs:
          typeof raw.cooldownMs === 'number' && raw.cooldownMs >= 1000
            ? Math.floor(raw.cooldownMs)
            : fallback.cooldownMs,
        maxContinuations:
          typeof raw.maxContinuations === 'number' && raw.maxContinuations >= 1
            ? Math.min(200, Math.floor(raw.maxContinuations))
            : fallback.maxContinuations,
      }
    }
  } catch {
    /* fail-open */
  }
  return fallback
}

/** Read the decision budgets from decision-router.json's `budget` envelope (fail-open). */
function readDecisionBudgets(): DecisionBudgets {
  const fallback = { ...DEFAULT_DECISION_BUDGETS }
  try {
    const path = join(
      process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '', '.config'),
      'pantheon',
      'decision-router.json',
    )
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { budget?: Partial<DecisionBudgets> }
    const raw = parsed?.budget
    if (raw && typeof raw === 'object') {
      return {
        monthlyUsd:
          typeof raw.monthlyUsd === 'number' && raw.monthlyUsd > 0
            ? raw.monthlyUsd
            : fallback.monthlyUsd,
        perDecisionUsd:
          typeof raw.perDecisionUsd === 'number' && raw.perDecisionUsd > 0
            ? raw.perDecisionUsd
            : fallback.perDecisionUsd,
      }
    }
  } catch {
    /* fail-open */
  }
  return fallback
}

/**
 * Surgically set one key under `options` in the user's opencode.json
 * (preserving every other key). Startup-applied options live here — the
 * runtime resolves them once at plugin setup.
 */
function writeUserOption(key: string, value: unknown): void {
  const path = userOpenCodeConfigPath()
  let doc: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) doc = parsed
  } catch {
    /* start a fresh object — nothing parseable to preserve */
  }
  const options =
    typeof doc.options === 'object' && doc.options !== null && !Array.isArray(doc.options)
      ? { ...(doc.options as Record<string, unknown>) }
      : {}
  options[key] = value
  doc.options = options
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`)
}

/** Merge the `budget` envelope into decision-router.json (0600 preserved). */
function writeDecisionBudget(budgets: { monthlyUsd: number; perDecisionUsd: number }): void {
  const path = join(
    process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '', '.config'),
    'pantheon',
    'decision-router.json',
  )
  let doc: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) doc = parsed
  } catch {
    throw new Error('decision-router.json unreadable — repair via `decision-router setup-model`')
  }
  doc.budget = { ...budgets }
  const temp = `${path}.tui.tmp`
  writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, path)
}

function decisionAuthStorePath(): string {
  const xdgData = process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? '', '.local', 'share')
  return join(xdgData, 'opencode', 'auth.json')
}

/** Provider ids registered in the host auth store (existence only — never values). */
function readAuthProviders(): Set<string> {
  const names = new Set<string>()
  try {
    const parsed = JSON.parse(readFileSync(decisionAuthStorePath(), 'utf8')) as Record<
      string,
      unknown
    >
    for (const key of Object.keys(parsed)) names.add(key)
  } catch {
    /* no auth store — nothing recognized */
  }
  return names
}

/** Provider ids present in opencode.json `providers` (the config copy the host reads). */
function readConfigProviders(): Set<string> {
  const names = new Set<string>()
  try {
    const parsed = JSON.parse(readFileSync(userOpenCodeConfigPath(), 'utf8')) as {
      providers?: Record<string, unknown>
    }
    for (const key of Object.keys(parsed?.providers ?? {})) names.add(key)
  } catch {
    /* no config providers */
  }
  return names
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

async function fetchLatestForChannel(channel: UpdateChannel): Promise<string | null> {
  try {
    const response = await fetch(registryUrlForChannel(channel), {
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

const NAME_WIDTH = 26
const VALUE_WIDTH = 24

export function SettingsWindow(props: {
  version: string
  tabs: () => SettingsTab[]
  page: () => number
  selectedId: () => string | undefined
  draft: () => SettingsDraft
  notice: () => string | undefined
  confirmExit?: () => boolean
  fg?: any
  muted?: any
  warn?: any
  hasKeyboard?: () => boolean
  onJumpTab?: (index: number) => void
  onSelectRow?: (id: string) => void
  onCycleValue?: (id: string, direction: 1 | -1) => void
  onSave?: () => void
  onResetPage?: () => void
  onStageDefaults?: () => void
  onClose?: () => void
  onDiscard?: () => void
  onCancelExit?: () => void
  isDialog?: boolean
  maxHeight?: number
  height?: number
  boxRef?: (el: any) => void
  onMouseDown?: () => void
}) {
  const tab = () => props.tabs()[props.page()] ?? props.tabs()[0] ?? EMPTY_TAB
  return (
    <box
      ref={props.boxRef}
      focusable
      flexDirection="column"
      height={props.height}
      flexGrow={props.height !== undefined ? undefined : 1}
      flexBasis={props.height !== undefined ? undefined : 0}
      minHeight={0}
      border={!props.isDialog}
      borderStyle={props.isDialog ? undefined : 'rounded'}
      borderColor={
        props.isDialog
          ? undefined
          : props.hasKeyboard?.()
            ? (props.warn ?? '#fba970')
            : (props.muted ?? '#52525b')
      }
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
      onMouseDown={props.onMouseDown}
    >
      {/* ── Top Header bar: Title + Horizontal Clickable Tabs + ESC (matching opencode-quota) ── */}
      <box flexDirection="row" alignItems="center" flexShrink={0} height={1} marginBottom={1}>
        <text fg={props.fg} attributes={1} wrapMode="none">
          <b>{'Pantheon'}</b>
          <span style={{ fg: props.muted }}>{` v${props.version}`}</span>
        </text>
        <box width={2} />
        <box flexDirection="row" flexGrow={1} flexShrink={1} columnGap={1}>
          <For each={props.tabs()}>
            {(t, index) => {
              const isActive = () => index() === props.page()
              return (
                <box
                  onMouseDown={() => props.onJumpTab?.(index())}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={isActive() ? '#262626' : undefined}
                >
                  <text
                    wrapMode="none"
                    fg={isActive() ? (props.warn ?? '#fba970') : props.muted}
                    {...(isActive() ? { attributes: 1 } : {})}
                  >
                    {`${t.title}${tabDirty(props.draft(), t) ? ' ●' : ''}`}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
        <box onMouseDown={() => props.onClose?.()} paddingLeft={1}>
          <text fg={props.muted} wrapMode="none">
            {'esc'}
          </text>
        </box>
      </box>

      {/* ── Main Body: Scrollable content panel ── */}
      <box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} overflow="hidden">
        <scrollbox flexGrow={1} flexBasis={0} minHeight={0} maxHeight={props.maxHeight}>
          <For each={tab().groups}>
            {(group) => (
              <box flexDirection="column" marginBottom={1}>
                <Show when={group.title !== undefined}>
                  <text attributes={1} fg={props.warn ?? props.fg}>
                    {group.title}
                  </text>
                </Show>
                <For each={group.rows}>
                  {(row: SettingsRow) => {
                    const isSelected = () => row.id === props.selectedId()
                    const display = () => props.draft()[row.id] ?? row.value
                    const staged = () => props.draft()[row.id] !== undefined
                    const gutter = () => (isSelected() ? '▸ ' : '  ')
                    const valueCell = () => {
                      if (row.cycle !== undefined) return `< ${display()} >`
                      if (row.action !== undefined) return `[ ${display()} ]`
                      if (row.id.startsWith('autonomy.gradient.')) return `[ref] ${display()}`
                      return display()
                    }
                    return (
                      <box
                        flexDirection="row"
                        backgroundColor={isSelected() ? '#262626' : undefined}
                        onMouseDown={() => {
                          props.onSelectRow?.(row.id)
                        }}
                      >
                        <box width={NAME_WIDTH + 2}>
                          <text
                            fg={isSelected() ? (props.warn ?? '#fba970') : props.fg}
                            {...(isSelected() ? { attributes: 1 } : {})}
                          >
                            {`${gutter()}${row.name}`.padEnd(NAME_WIDTH + 2)}
                          </text>
                        </box>
                        <box
                          width={VALUE_WIDTH}
                          onMouseDown={() => {
                            props.onSelectRow?.(row.id)
                            props.onCycleValue?.(row.id, 1)
                          }}
                        >
                          <text
                            fg={
                              isSelected()
                                ? '#ffffff'
                                : staged()
                                  ? (props.warn ?? props.fg)
                                  : props.muted
                            }
                            {...(isSelected() || staged() ? { attributes: 1 } : {})}
                          >
                            {`${valueCell()}${staged() ? ' ●' : ''}`.padEnd(VALUE_WIDTH)}
                          </text>
                        </box>
                        <Show when={row.note !== undefined}>
                          <box flexGrow={1} flexShrink={1}>
                            <text fg={isSelected() ? '#e5e7eb' : props.muted}>{row.note}</text>
                          </box>
                        </Show>
                      </box>
                    )
                  }}
                </For>
              </box>
            )}
          </For>
        </scrollbox>
      </box>

      {/* ── Footer: notice + botões (chips) + keys (matching image.png & image_2.png) ── */}
      <Show when={props.notice() !== undefined}>
        <text
          fg={
            props.notice()?.startsWith('[OK]') || props.notice()?.startsWith('saved')
              ? props.fg
              : (props.warn ?? props.muted)
          }
        >
          {props.notice()?.startsWith('[OK]') || props.notice()?.startsWith('saved')
            ? props.notice()
            : `[WARN] ${props.notice()}`}
        </text>
      </Show>

      <Show
        when={props.confirmExit?.()}
        fallback={
          <box flexDirection="column">
            <Show
              when={draftDirty(props.draft())}
              fallback={
                <box flexDirection="row">
                  <box backgroundColor="#262626" onMouseDown={() => props.onClose?.()}>
                    <text fg="#ffffff">{' Close '}</text>
                  </box>
                  <text fg={props.muted}>{'  '}</text>
                  <box backgroundColor="#262626" onMouseDown={() => props.onResetPage?.()}>
                    <text fg="#ffffff">{' Reset page '}</text>
                  </box>
                  <text fg={props.muted}>{'  '}</text>
                  <box backgroundColor="#262626" onMouseDown={() => props.onStageDefaults?.()}>
                    <text fg="#ffffff">{' Defaults '}</text>
                  </box>
                  <box flexGrow={1} />
                  <text fg={props.muted}>{'no staged changes'}</text>
                </box>
              }
            >
              <box flexDirection="row">
                <box backgroundColor="#fba970" onMouseDown={() => props.onSave?.()}>
                  <text fg="#000000">{' Save '}</text>
                </box>
                <text fg={props.muted}>{'  '}</text>
                <box backgroundColor="#262626" onMouseDown={() => props.onDiscard?.()}>
                  <text fg="#ffffff">{' Discard '}</text>
                </box>
                <text fg={props.muted}>{'  '}</text>
                <box backgroundColor="#262626" onMouseDown={() => props.onResetPage?.()}>
                  <text fg="#ffffff">{' Reset page '}</text>
                </box>
                <box flexGrow={1} />
                <text fg={props.warn ?? '#f59e0b'}>{'unsaved changes'}</text>
              </box>
            </Show>
            <text fg={props.muted}>
              {(() => {
                const currentRow = findRow(tab(), props.selectedId())
                if (currentRow?.cycle !== undefined) {
                  return 'click or ›/←/→ change · ↑↓ select · tab next tab · ctrl+s save · ctrl+r reset page · esc close'
                }
                if (currentRow?.action !== undefined) {
                  return 'enter or space run action · ↑↓ select · tab next tab · ctrl+s save · ctrl+r reset page · esc close'
                }
                return '[ref] documented reference (read-only) · ↑↓ select · tab next tab · esc close'
              })()}
            </text>
          </box>
        }
      >
        <box flexDirection="column">
          <box flexDirection="row">
            <text fg={props.warn ?? '#f59e0b'} attributes={1}>
              {'Keep your changes?  '}
            </text>
            <box backgroundColor="#fba970" onMouseDown={() => props.onSave?.()}>
              <text fg="#000000">{' Save '}</text>
            </box>
            <text fg={props.muted}>{'  '}</text>
            <box backgroundColor="#262626" onMouseDown={() => props.onDiscard?.()}>
              <text fg="#ffffff">{' Discard '}</text>
            </box>
            <text fg={props.muted}>{'  '}</text>
            <box backgroundColor="#262626" onMouseDown={() => props.onCancelExit?.()}>
              <text fg="#ffffff">{' Keep editing '}</text>
            </box>
          </box>
          <text fg={props.muted}>{'ctrl+s save · d discard the changes · esc keep editing'}</text>
        </box>
      </Show>
    </box>
  )
}

// ── Shared window controller (signals + writers), mounted per surface ──

interface PageApi {
  move: (delta: number) => void
  step: (direction: 1 | -1) => void
  selectById?: (id: string) => void
  cycleRowById?: (id: string, direction: 1 | -1) => void
  actuate: () => void
  nextTab: () => void
  prevTab?: () => void
  jumpTab: (index: number) => void
  save: () => void
  resetPage: () => void
  stageDefaults: () => void
  close: () => void
  discard?: () => void
  cancelExit?: () => void
  confirmExit?: () => boolean
}

let pageApi: PageApi | undefined

function createWindowController(
  context: Context,
  exit: () => void,
): {
  tabs: () => SettingsTab[]
  page: () => number
  selectedId: () => string | undefined
  draft: () => SettingsDraft
  notice: () => string | undefined
  confirmExit: () => boolean
  api: PageApi
  cleanup: () => void
} {
  const currentVersion = resolveRunningVersion()
  const [page, setPage] = createSignal(0)
  const [selected, setSelected] = createSignal(0)
  const [load, setLoad] = createSignal(readOverridesLoad())
  const [decision, setDecision] = createSignal<DecisionConfigRead>(readDecisionRouterConfig())
  const [goalLoop, setGoalLoop] = createSignal<GoalLoopPrefs>(readGoalLoopPrefs())
  const [budgets, setBudgets] = createSignal<DecisionBudgets>(readDecisionBudgets())
  const [autonomyRestartPending, setAutonomyRestartPending] = createSignal(false)
  const [presetTick, setPresetTick] = createSignal(0)
  const [selectedChannel, setSelectedChannel] = createSignal<UpdateChannel>(
    updateChannelFor(currentVersion),
  )
  const [lastChecked, setLastChecked] = createSignal<string | undefined>(undefined)
  const [checking, setChecking] = createSignal(false)
  const [updating, setUpdating] = createSignal(false)
  const [changelogItems, setChangelogItems] = createSignal<ChangelogHighlightItem[]>([])
  const [draft, setDraft] = createSignal<SettingsDraft>({})
  const [notice, setNotice] = createSignal<string | undefined>(undefined)
  const [confirmExit, setConfirmExit] = createSignal(false)

  // Load changelog highlights asynchronously
  void readChangelogForBundle(import.meta.url).then((text) => {
    if (!text) return
    const hl = extractHighlights(text, currentVersion)
    if (hl.found) {
      const items: ChangelogHighlightItem[] = []
      for (const group of hl.groups) {
        for (const item of group.items) {
          const dash = item.indexOf('—')
          const title = dash !== -1 ? item.slice(0, dash).trim() : item.slice(0, 26)
          items.push({ title, detail: item, group: group.heading ?? undefined })
        }
      }
      setChangelogItems(items)
    }
  })

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
      selectedChannel: selectedChannel(),
      checking: checking(),
      updating: updating(),
      nowMs: Date.now(),
    }
    const seen = lastChecked()
    if (seen !== undefined) input.lastCheckedVersion = seen
    return input
  }

  const tabs = (): SettingsTab[] => [
    buildGatesTab(load()),
    buildDecisionTab(decision(), process.env, readAuthProviders(), readConfigProviders()),
    buildPresetTab(presetInput()),
    buildTuiTab(tuiPrefs()),
    buildAutonomyTab({
      goalLoop: goalLoop(),
      budgets: budgets(),
      goalLoopRestartPending: autonomyRestartPending(),
    }),
    buildJ1Tab(process.env, false),
    buildUpdatesTab(updatesInput()),
    buildChangelogTab(currentVersion, changelogItems()),
    buildDoctorTab({
      runningVersion: currentVersion,
      nodeVersion: process.versions.node,
      load: load(),
    }),
    buildAboutTab(currentVersion),
  ]

  const rows = () => tabRows(tabs()[page()] ?? tabs()[0] ?? EMPTY_TAB)

  const move = (delta: number) => {
    if (confirmExit()) setConfirmExit(false)
    const list = rows()
    if (list.length === 0) return
    setSelected((current) => Math.min(Math.max(current + delta, 0), list.length - 1))
  }

  const step = (direction: 1 | -1) => {
    if (confirmExit()) setConfirmExit(false)
    const row = rows()[selected()]
    if (row === undefined) return
    setNotice(undefined)
    setDraft(stageValue(draft(), row, direction))
  }

  const checkUpdatesNow = (targetChannel: UpdateChannel = selectedChannel()) => {
    if (checking()) return
    setChecking(true)
    setNotice(undefined)
    void fetchLatestForChannel(targetChannel)
      .then((latest) => {
        if (latest) {
          setLastChecked(latest)
          persistUpdateCheckState(readUpdateCheckState(), latest)
        }
      })
      .catch(() => {
        /* offline */
      })
      .finally(() => setChecking(false))
  }

  const runUpdateNow = () => {
    if (updating()) return
    setUpdating(true)
    setNotice(`updating to ${selectedChannel()} channel…`)
    execFile(
      'npm',
      ['install', '-g', `pantheon-opencode@${selectedChannel()}`],
      { timeout: 60_000 },
      (err) => {
        setUpdating(false)
        if (err) {
          setNotice('run in terminal: pantheon-opencode update')
          try {
            context.ui.toast?.show?.({
              variant: 'warning',
              message: 'Update requires terminal permissions: run `pantheon-opencode update`',
            })
          } catch {}
        } else {
          setNotice('[OK] update complete — restart OpenCode or run `npx pantheon-opencode init`')
          try {
            context.ui.toast?.show?.({
              variant: 'info',
              message: 'Pantheon updated successfully!',
            })
          } catch {}
        }
      },
    )
  }

  const dispatchWrite = (id: string, value: string): DraftWriterResult => {
    if (id === 'update.channel') {
      if (value === 'stable' || value === 'beta') {
        setSelectedChannel(value as UpdateChannel)
        checkUpdatesNow(value as UpdateChannel)
        return { ok: true }
      }
      return { ok: false, reason: 'unknown channel' }
    }
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
    if (
      id === 'decision.selection.mode' ||
      id === 'decision.selection.target' ||
      id === 'decision.consent'
    ) {
      const current = decision()
      if (current.corrupt) {
        return {
          ok: false,
          reason: 'decision-router.json unreadable — repair via `decision-router setup-model`',
        }
      }
      const staged = applyDecisionRow(current.config, id, value)
      if (staged === current.config) return { ok: false, reason: 'unknown or invalid value' }
      try {
        writeDecisionRouterConfig(staged)
        setDecision({ config: staged, corrupt: false })
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
    if (id.startsWith('autonomy.goal_loop.')) {
      const next = { ...goalLoop() }
      if (id === 'autonomy.goal_loop.enabled') {
        next.enabled = value === 'enabled'
      } else if (id === 'autonomy.goal_loop.maxContinuations') {
        const parsed = Number(value)
        if (!Number.isFinite(parsed) || parsed < 1 || parsed > 200) {
          return { ok: false, reason: 'max continuations must be 1..200' }
        }
        next.maxContinuations = Math.floor(parsed)
      } else if (id === 'autonomy.goal_loop.cooldownMs') {
        const parsed = Number(value)
        if (!Number.isFinite(parsed) || parsed < 1000) {
          return { ok: false, reason: 'cooldown must be >= 1000ms' }
        }
        next.cooldownMs = Math.floor(parsed)
      }
      try {
        writeUserOption('goal_loop', next)
        setGoalLoop(next)
        setAutonomyRestartPending(true)
        return { ok: true }
      } catch {
        return { ok: false, reason: 'opencode.json write failed' }
      }
    }
    if (id === 'autonomy.budget.monthly' || id === 'autonomy.budget.perDecision') {
      const parsed = parseUsd(value)
      if (parsed === null) return { ok: false, reason: 'invalid USD value' }
      const next = { ...budgets() }
      if (id === 'autonomy.budget.monthly') next.monthlyUsd = parsed
      else next.perDecisionUsd = parsed
      try {
        writeDecisionBudget(next)
        setBudgets(next)
        return { ok: true }
      } catch {
        return { ok: false, reason: 'budget write failed' }
      }
    }
    if (id.startsWith('tui.')) {
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
      if (confirmExit()) {
        exit()
      }
    }
  }

  const resetPage = () => {
    if (confirmExit()) setConfirmExit(false)
    const tab = tabs()[page()]
    if (tab === undefined) return
    setDraft(resetTab(draft(), tab))
    setNotice(undefined)
  }

  const stageDefaultsPage = () => {
    if (confirmExit()) setConfirmExit(false)
    const tab = tabs()[page()]
    if (tab === undefined) return
    setNotice(undefined)
    setDraft(stageDefaults(draft(), tab))
  }

  const nextTab = () => {
    if (confirmExit()) setConfirmExit(false)
    setPage((current) => (current + 1) % tabs().length)
    setSelected(0)
  }

  const close = () => {
    const staged = draftCount(draft())
    if (staged > 0 && !confirmExit()) {
      setConfirmExit(true)
      return
    }
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

  const discard = () => {
    const staged = draftCount(draft())
    setDraft({})
    setConfirmExit(false)
    if (staged > 0) {
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

  const cancelExit = () => {
    setConfirmExit(false)
  }

  const selectedId = () => rows()[selected()]?.id

  const selectById = (id: string) => {
    if (confirmExit()) setConfirmExit(false)
    const list = rows()
    const index = list.findIndex((r) => r.id === id)
    if (index !== -1) setSelected(index)
  }

  const cycleRowById = (id: string, direction: 1 | -1) => {
    if (confirmExit()) setConfirmExit(false)
    const list = rows()
    const index = list.findIndex((r) => r.id === id)
    if (index !== -1) {
      setSelected(index)
      const row = list[index]
      if (row?.action === 'update-check') checkUpdatesNow()
      else if (row?.action === 'update-run') runUpdateNow()
      else if (row) {
        setNotice(undefined)
        setDraft(stageValue(draft(), row, direction))
      }
    }
  }

  const api: PageApi = {
    move,
    step,
    selectById,
    cycleRowById,
    actuate: () => {
      if (confirmExit()) setConfirmExit(false)
      const row = rows()[selected()]
      if (row?.action === 'update-check') checkUpdatesNow()
      else if (row?.action === 'update-run') runUpdateNow()
      else step(1)
    },
    nextTab,
    prevTab: () => {
      if (confirmExit()) setConfirmExit(false)
      const count = tabs().length
      if (count > 0) {
        setPage((current) => (current - 1 + count) % count)
        setSelected(0)
      }
    },
    jumpTab: (index) => {
      if (confirmExit()) setConfirmExit(false)
      if (index >= 0 && index < tabs().length) {
        setPage(index)
        setSelected(0)
      }
    },
    save,
    resetPage,
    stageDefaults: stageDefaultsPage,
    close,
    discard,
    cancelExit,
    confirmExit: () => confirmExit(),
  }

  return {
    tabs,
    page,
    selectedId,
    draft,
    notice,
    confirmExit: () => confirmExit(),
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
      selectedId={controller.selectedId}
      draft={controller.draft}
      notice={controller.notice}
      confirmExit={controller.confirmExit}
      fg={theme.base}
      muted={theme.muted}
      warn={warn}
      onJumpTab={(idx) => controller.api.jumpTab(idx)}
      onSelectRow={(id) => controller.api.selectById?.(id)}
      onCycleValue={(id, dir) => controller.api.cycleRowById?.(id, dir)}
      onSave={() => controller.api.save()}
      onResetPage={() => controller.api.resetPage()}
      onStageDefaults={() => controller.api.stageDefaults()}
      onClose={() => controller.api.close()}
      onDiscard={() => controller.api.discard?.()}
      onCancelExit={() => controller.api.cancelExit?.()}
    />
  )
}

function navigateBack(context: Context, data?: { returnRoute?: WindowRoute }): void {
  try {
    const fallback: WindowRoute = { type: 'home' }
    context.ui.router.navigate(data?.returnRoute ?? fallback)
  } catch {
    /* router unavailable — the failure is observable only as a stuck page */
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
  const rendererHeight = () => (context as any).renderer?.height ?? 30
  const maxHeight = () => Math.max(14, Math.floor(rendererHeight() * 0.75) - 6)
  try {
    context.ui.dialog.show(
      () => (
        <SettingsWindow
          version={resolveRunningVersion()}
          tabs={controller.tabs}
          page={controller.page}
          selectedId={controller.selectedId}
          draft={controller.draft}
          notice={controller.notice}
          confirmExit={controller.confirmExit}
          fg={theme.base}
          muted={theme.muted}
          warn={warn}
          isDialog={true}
          maxHeight={maxHeight()}
          onJumpTab={(idx) => controller.api.jumpTab(idx)}
          onSelectRow={(id) => controller.api.selectById?.(id)}
          onCycleValue={(id, dir) => controller.api.cycleRowById?.(id, dir)}
          onSave={() => controller.api.save()}
          onResetPage={() => controller.api.resetPage()}
          onStageDefaults={() => controller.api.stageDefaults()}
          onClose={() => controller.api.close()}
          onDiscard={() => controller.api.discard?.()}
          onCancelExit={() => controller.api.cancelExit?.()}
        />
      ),
      close,
    )
    context.ui.dialog.set({ size: 'xlarge' })
  } catch {
    /* dialog stack unavailable — fail-open */
  }
}

// ── In-session docked window (session.composer.top) ─────────────────────

const [settingsOpen, setSettingsOpen] = createSignal(false)
const [activeSessionId, setActiveSessionId] = createSignal<string | undefined>()

export function isPantheonSettingsOpen(): boolean {
  return settingsOpen()
}

export function routeSessionID(context: any): string | undefined {
  try {
    const route = context?.ui?.router?.current?.()
    return route?.type === 'session' ? route?.sessionID : undefined
  } catch {
    return undefined
  }
}

export function closePantheonSettings(): void {
  if (pageApi) {
    pageApi.close()
    if (pageApi.confirmExit?.()) {
      return
    }
  }
  setSettingsOpen(false)
  setBlocking(false)
}

export function PantheonSettingsSlot(props: { context: Context; sessionID: string }) {
  onMount(() => {
    setActiveSessionId(props.sessionID)
  })
  onCleanup(() => {
    if (activeSessionId() === props.sessionID) {
      setActiveSessionId(undefined)
    }
  })
  return (
    <Show when={settingsOpen() && (activeSessionId() === props.sessionID || !activeSessionId())}>
      <InSessionSettingsWindow context={props.context} sessionID={props.sessionID} />
    </Show>
  )
}

function InSessionSettingsWindow(props: { context: Context; sessionID: string }) {
  let windowBox: any
  const context = props.context
  const initialRoom = () => Math.max(14, ((context as any).renderer?.height ?? 30) - 10)
  const [roomHeight, setRoomHeight] = createSignal<number>(initialRoom())
  const [hasKeyboard, setHasKeyboard] = createSignal(false)

  function measureRoom(): void {
    const box = windowBox
    if (!box || box.isDestroyed) return
    let child = box
    for (let parent = box.parent; parent; child = parent, parent = parent.parent) {
      const siblings = parent.getChildren?.() ?? []
      const messages = siblings[0]
      if (
        messages === child ||
        !messages?.getChildren?.().some((item: any) => 'scrollChildIntoView' in item)
      ) {
        continue
      }
      const otherRows = siblings
        .filter((item: any) => item !== child && item !== messages)
        .reduce((total: number, item: any) => total + (item.height ?? 0), 0)
      const room = Math.max(
        12,
        (parent.height ?? 24) - 1 - otherRows - ((child.height ?? 0) - (box.height ?? 0)),
      )
      if (room !== roomHeight()) queueMicrotask(() => setRoomHeight(room))
      return
    }
  }

  onMount(() => {
    try {
      ;(context as any).renderer?.root?.on?.('layout-changed', measureRoom)
      ;(context as any).renderer?.on?.('resize', measureRoom)
      onCleanup(() => {
        try {
          ;(context as any).renderer?.root?.off?.('layout-changed', measureRoom)
          ;(context as any).renderer?.off?.('resize', measureRoom)
        } catch {}
      })
    } catch {}
    measureRoom()
    setTimeout(() => {
      try {
        windowBox?.focus?.()
      } catch {}
    }, 50)
  })

  try {
    const popMode = (context as any).keymap?.mode?.push?.(ROUTE_MODE)
    if (popMode !== undefined) onCleanup(() => popMode())
  } catch {}

  const controller = createWindowController(context, () => {
    setSettingsOpen(false)
    setBlocking(false)
  })

  onCleanup(controller.cleanup)
  pageApi = controller.api

  const theme = (context as any).theme?.text ?? {}
  const warn = (theme?.feedback as any)?.warning?.base ?? '#fba970'

  return (
    <SettingsWindow
      boxRef={(el: any) => {
        windowBox = el
        if (el) {
          el.on?.('focused', () => setHasKeyboard(true))
          el.on?.('blurred', () => setHasKeyboard(false))
        }
      }}
      height={roomHeight()}
      version={resolveRunningVersion()}
      tabs={controller.tabs}
      page={controller.page}
      selectedId={controller.selectedId}
      draft={controller.draft}
      notice={controller.notice}
      confirmExit={controller.confirmExit}
      fg={theme.base}
      muted={theme.muted}
      warn={warn}
      hasKeyboard={hasKeyboard}
      onJumpTab={(idx) => controller.api.jumpTab(idx)}
      onSelectRow={(id) => controller.api.selectById?.(id)}
      onCycleValue={(id, dir) => controller.api.cycleRowById?.(id, dir)}
      onSave={() => controller.api.save()}
      onResetPage={() => controller.api.resetPage()}
      onStageDefaults={() => controller.api.stageDefaults()}
      onClose={() => closePantheonSettings()}
      onDiscard={() => controller.api.discard?.()}
      onCancelExit={() => controller.api.cancelExit?.()}
      onMouseDown={() => {
        try {
          windowBox?.focus?.()
        } catch {}
      }}
    />
  )
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
        if (pageApi === undefined) {
          closePantheonSettings()
          return undefined
        }
        if (pageApi.confirmExit?.()) {
          pageApi.cancelExit?.()
          return undefined
        }
        closePantheonSettings()
        return undefined
      },
    },
    {
      id: 'pantheon.settings.discard',
      title: 'Discard staged changes and exit',
      bind: 'd',
      run: () => {
        if (pageApi?.confirmExit?.()) {
          pageApi.discard?.()
          return undefined
        }
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
      id: 'pantheon.settings.prev.tab',
      title: 'Previous settings tab',
      bind: 'shift+tab',
      run: () => {
        pageApi?.prevTab?.()
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
    {
      id: 'pantheon.settings.defaults',
      title: 'Stage defaults for this tab',
      bind: 'ctrl+d',
      run: () => {
        pageApi?.stageDefaults()
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
      enabled: () => routeGated() || settingsOpen(),
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
      enabled: () => dialogOpen() || settingsOpen(),
      commands,
    }))
  } catch {
    /* keymap API unavailable — host chrome still dismisses (ESC) */
  }
}

// ── The entry point (command run) ──────────────────────────────────────

export async function openPantheonSettings(context: Context): Promise<void> {
  try {
    const prefs = tuiPrefs()
    const viewMode = prefs.layout?.settingsView ?? 'docked'
    if (viewMode === 'fullscreen' && routerAvailable && context.ui?.router?.navigate) {
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
    if (viewMode === 'dialog') {
      openSettingsDialog(context)
      return
    }
  } catch {
    /* preferences check failed — fall through to docked */
  }

  // Primary mode: docked in session.composer.top
  const sessionID = (context as any)?.sessionID ?? routeSessionID(context) ?? activeSessionId()
  if (!sessionID) {
    try {
      context.ui?.toast?.show?.({
        variant: 'info',
        title: 'Pantheon',
        message: 'Open a session first: Pantheon settings opens above the prompt box.',
      })
    } catch {}
    return
  }

  if (settingsOpen()) {
    closePantheonSettings()
    return
  }

  setSettingsOpen(true)
  setBlocking(true)
}
