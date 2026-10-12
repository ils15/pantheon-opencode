// biome-ignore-all lint/suspicious/noExplicitAny: OpenCode V2 exposes its TUI API at runtime.
/** @jsxImportSource @opentui/solid */

import { Plugin } from '@opencode/plugin/tui'
import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'

const SINGLETON = Symbol.for('pantheon.tui.v2.loaded')

function Sidebar(props: { context: any; sessionID?: string }) {
  const { context } = props
  const [revision, setRevision] = createSignal(0)
  const location = context.location ?? context.data.location.default()

  const session = createMemo(() => {
    revision()
    return props.sessionID ? context.data.session.get(props.sessionID) : undefined
  })
  const branch = createMemo(() => {
    revision()
    const info = context.data.location.vcs.info(location)
    return info?.branch?.current ?? null
  })
  const delegations = createMemo(() => {
    revision()
    const id = props.sessionID
    if (!id) return []
    const family: string[] = context.data.session.family(id) ?? []
    return family
      .filter((childID) => childID !== id)
      .map((childID) => context.data.session.get(childID))
      .filter((child: any) => child?.parentID === id)
      .slice(0, 6)
  })

  onMount(() => {
    const stop: Array<() => void> = []
    for (const type of [
      'session.created',
      'session.updated',
      'session.status',
      'session.deleted',
    ]) {
      try {
        stop.push(context.data.on(type, () => setRevision((value) => value + 1)))
      } catch {
        // Sidebar remains useful with the initial cached state if an event is unavailable.
      }
    }
    if (props.sessionID) {
      void context.data.session.sync(props.sessionID).then(() => setRevision((value) => value + 1))
    }
    void context.data.location.vcs.sync(location).then(() => setRevision((value) => value + 1))
    onCleanup(() => {
      for (const unsubscribe of stop) unsubscribe()
    })
  })

  const text = () => context.theme.text?.base
  const muted = () => context.theme.text?.muted ?? text()

  return (
    <box flexDirection="column" width="100%" padding={1}>
      <text fg={text()} attributes={1}>{`Pantheon v${__PANTHEON_VERSION__}`}</text>
      <text fg={muted()}>OpenCode V2 · plugin TUI ativo</text>
      <Show when={branch()}>{(value) => <text fg={muted()}>{`Branch: ${value()}`}</text>}</Show>
      <Show when={session()} fallback={<text fg={muted()}>Nenhuma sessão selecionada</text>}>
        {(current) => (
          <>
            <text fg={text()}>{`Sessão: ${current().title || current().id}`}</text>
            <Show when={current().agent}>
              <text fg={muted()}>{`Agente: ${current().agent}`}</text>
            </Show>
          </>
        )}
      </Show>
      <Show when={delegations().length > 0}>
        <text fg={text()} attributes={1}>
          Delegações
        </text>
        <For each={delegations()}>
          {(child: any) => <text fg={muted()}>{`· ${child.title || child.id}`}</text>}
        </For>
      </Show>
    </box>
  )
}

const plugin = Plugin.define({
  id: 'pantheon.tui',
  setup(context: any) {
    const globalState = globalThis as unknown as Record<PropertyKey, unknown>
    if (globalState[SINGLETON]) return
    globalState[SINGLETON] = true

    const unregister = context.ui.slot({
      append: 'sidebar.content',
      render: ({ sessionID }: { sessionID?: string }) => (
        <Sidebar context={context} sessionID={sessionID} />
      ),
    })
    return () => {
      if (typeof unregister === 'function') unregister()
      delete globalState[SINGLETON]
    }
  },
})

export default plugin
