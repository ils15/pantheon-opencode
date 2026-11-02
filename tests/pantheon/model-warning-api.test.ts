import { strict as assert } from 'node:assert'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import type { PluginContext as V2PluginContext } from '@opencode-ai/plugin/v2/promise'

type HasKey<Value, Key extends PropertyKey> = Key extends keyof Value ? true : false

// Compile-time contract checks against the installed 1.18.33 plugin types:
// the server plugin context has no client, TUI, toast, or structured logger;
// the separate TUI plugin API owns ui.toast.
const SERVER_CONTEXT_HAS_TUI: HasKey<V2PluginContext, 'tui'> = false
const SERVER_CONTEXT_HAS_CLIENT: HasKey<V2PluginContext, 'client'> = false
const SERVER_CONTEXT_HAS_UI: HasKey<V2PluginContext, 'ui'> = false
const SERVER_CONTEXT_HAS_TOAST: HasKey<V2PluginContext, 'toast'> = false
const SERVER_CONTEXT_HAS_LOGGER: HasKey<V2PluginContext, 'logger'> = false
const SERVER_CONTEXT_HAS_LOG: HasKey<V2PluginContext, 'log'> = false
const SERVER_CONTEXT_HAS_NOTIFY: HasKey<V2PluginContext, 'notify'> = false

const toastWarnings: Array<Parameters<TuiPluginApi['ui']['toast']>[0]> = []
const mockTuiToast: TuiPluginApi['ui']['toast'] = (input) => toastWarnings.push(input)

mockTuiToast({
  title: 'Pantheon model configuration',
  message: 'Manual model overrides could not be read; check active-preset.json.',
  variant: 'warning',
})

assert.equal(SERVER_CONTEXT_HAS_TUI, false)
assert.equal(SERVER_CONTEXT_HAS_CLIENT, false)
assert.equal(SERVER_CONTEXT_HAS_UI, false)
assert.equal(SERVER_CONTEXT_HAS_TOAST, false)
assert.equal(SERVER_CONTEXT_HAS_LOGGER, false)
assert.equal(SERVER_CONTEXT_HAS_LOG, false)
assert.equal(SERVER_CONTEXT_HAS_NOTIFY, false)
assert.equal(toastWarnings.length, 1)
assert.equal(toastWarnings[0]?.variant, 'warning')
assert.match(toastWarnings[0]?.message ?? '', /active-preset\.json/)
assert.doesNotMatch(toastWarnings[0]?.message ?? '', /model id|secret/i)
console.log(
  '✅ V2 warning API boundary: no user-visible server context channel; TUI toast is separate',
)
