/**
 * v2-capabilities.mjs — what the OpenCode V2 plugin surface ACTUALLY is.
 *
 * Two reporting defects this module exists to prevent, both of them statements
 * that were narrower than the truth:
 *
 *  1. The installer printed `listV2UnsupportedFeatures()` under the heading
 *     "Unsupported features", which reads like the complete list of what V2
 *     does. That list is a SEED: the live set is this seed PLUS markers the
 *     plugin appends at runtime when a host API turns out to be missing
 *     (`tool-transform`, `event-stream`, …), which cannot be known at install
 *     time. So the printed list must say what it is.
 *  2. "Reduced surface" alone is misleading in the other direction: V2 is not
 *     a stub. It registers session `context`/`prompt`/`compaction` hooks, tool
 *     `execute.before`/`execute.after` hooks, a permission `evaluate` hook,
 *     `tool`/`agent`/`command`/`reference` transforms and five session events.
 *     A user deciding between generations is entitled to both halves.
 *
 * The registered surface below is derived from `src/plugin-v2.ts` (the
 * registration sites, not the module header: the header still claims the
 * caller/target matrix is enforced, while the enforcement guard's own docstring
 * records that omitting the hierarchy wiring skips that branch — the gap is
 * stated here as a gap).
 *
 * The seed itself is IMPORTED, never copied: an installer that restated these
 * strings could drift from `src/pantheon/v2-unsupported.mjs`, and a test pins
 * the two together.
 *
 * @module v2-capabilities
 */

import { listV2UnsupportedFeatures } from '../../src/pantheon/v2-unsupported.mjs'

/** Tools registered unconditionally through `ctx.tool.transform`. */
export const V2_REGISTERED_TOOLS = Object.freeze([
  'hashline_edit',
  'pantheon_cost',
  'pantheon_model',
])

/** Tools registered only when the host exposes the API they need. */
export const V2_HOST_DEPENDENT_TOOLS = Object.freeze(['vision_describe', 'pantheon_bounded_read'])

/** Session hooks V2 registers. */
export const V2_SESSION_HOOKS = Object.freeze(['context', 'prompt', 'compaction'])

/** Tool hooks V2 registers. */
export const V2_TOOL_HOOKS = Object.freeze(['execute.before', 'execute.after'])

/** Permission hooks V2 registers. */
export const V2_PERMISSION_HOOKS = Object.freeze(['evaluate'])

/** Transform domains V2 registers. */
export const V2_TRANSFORMS = Object.freeze(['tool', 'agent', 'command', 'reference'])

/** Host events V2 subscribes to. */
export const V2_EVENTS = Object.freeze([
  'session.created',
  'session.idle',
  'session.deleted',
  'session.error',
  'session.compacted',
])

/** Scope line that keeps the seed from reading as the complete list. */
export const V2_NOT_REGISTERED_SCOPE =
  'statically known seed; the live plugin adds further markers at runtime when a host API is missing'

/**
 * Machine-readable capability description for the V2 generation.
 *
 * JSON-safe by construction: `--json` carries this object, so the same facts
 * are available to a machine as to a reader.
 *
 * @returns {{
 *   generation: 'v2',
 *   registered: {
 *     tools: string[],
 *     host_dependent_tools: string[],
 *     session_hooks: string[],
 *     tool_hooks: string[],
 *     permission_hooks: string[],
 *     transforms: string[],
 *     events: string[],
 *   },
 *   not_registered: string[],
 *   not_registered_scope: string,
 * }}
 */
export function v2Capabilities() {
  return {
    generation: 'v2',
    registered: {
      tools: [...V2_REGISTERED_TOOLS],
      host_dependent_tools: [...V2_HOST_DEPENDENT_TOOLS],
      session_hooks: [...V2_SESSION_HOOKS],
      tool_hooks: [...V2_TOOL_HOOKS],
      permission_hooks: [...V2_PERMISSION_HOOKS],
      transforms: [...V2_TRANSFORMS],
      events: [...V2_EVENTS],
    },
    not_registered: listV2UnsupportedFeatures(),
    not_registered_scope: V2_NOT_REGISTERED_SCOPE,
  }
}

/**
 * The human-readable capability notice.
 *
 * Deliberately multi-line: one wrapped paragraph of eleven facts is unreadable
 * on a 60-column terminal. `notice()` prefixes only the first line, so the
 * continuation lines are indented to align under the marker.
 *
 * @param {ReturnType<typeof v2Capabilities>} [capabilities]
 * @returns {string}
 */
export function formatV2CapabilityNotice(capabilities = v2Capabilities()) {
  const { registered, not_registered, not_registered_scope } = capabilities
  const indent = ' '.repeat(7) // aligns under the `[INFO] ` prefix notice() adds
  return [
    'V2 plugin generation — what this install registers:',
    `${indent}tools: ${registered.tools.join(', ')} (plus ${registered.host_dependent_tools.join(', ')} when the host exposes them)`,
    `${indent}hooks: session ${registered.session_hooks.join('/')}; tool ${registered.tool_hooks.join('/')}; permission ${registered.permission_hooks.join('/')}`,
    `${indent}transforms: ${registered.transforms.join(', ')}; events: ${registered.events.join(', ')}`,
    `${indent}not registered (${not_registered_scope}): ${not_registered.join(', ')}`,
  ].join('\n')
}

/**
 * Whether a `plugins` list registers the Pantheon V2 entry.
 *
 * Matched on the `plugin-v2` marker so every real spelling counts: the
 * canonical directory, an absolute path to it, and the package export.
 *
 * @param {unknown} ref
 * @returns {boolean}
 */
export function isPantheonV2Reference(ref) {
  const candidate =
    typeof ref === 'string'
      ? ref
      : ref && typeof ref === 'object'
        ? (ref.package ?? ref.path ?? ref.source ?? ref.id ?? ref.name)
        : undefined
  return typeof candidate === 'string' && candidate.includes('plugin-v2')
}

/**
 * Whether the installed Pantheon V2 entry can receive plugin `options`.
 *
 * The host hands a plugin its `options` only from the OBJECT form
 * (`{ package, options }`); a bare string entry leaves `ctx.options` empty, and
 * `context_pruner` / `memory_injection` read exactly that object. A fresh
 * install that emitted a bare string therefore had no reachable opt-in switch
 * at all — this is the check that reports it after install.
 *
 * @param {unknown} plugins the `plugins` array from the config
 * @returns {{registered: boolean, reachable: boolean, form: 'object'|'string'|'absent', detail: string}}
 */
export function describePluginOptionsReachability(plugins) {
  const list = Array.isArray(plugins) ? plugins : []
  const entries = list.filter((ref) => isPantheonV2Reference(ref))
  if (entries.length === 0) {
    return {
      registered: false,
      reachable: false,
      form: 'absent',
      detail: 'no Pantheon V2 entry is registered, so plugin options are not read at all',
    }
  }
  const forms = entries.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return 'string'
    const options = entry.options
    return typeof options === 'object' && options !== null && !Array.isArray(options)
      ? 'object-with-options'
      : 'object-without-options'
  })
  const reachable = forms.includes('object-with-options')
  if (reachable) {
    const extra = forms.filter((form) => form !== 'object-with-options')
    return {
      registered: true,
      reachable: true,
      form: 'object',
      detail:
        'at least one Pantheon V2 entry carries an "options" object, so context_pruner and ' +
        'memory_injection can be configured there' +
        (extra.length === 0
          ? ''
          : `; ${extra.length} other Pantheon entr${extra.length === 1 ? 'y' : 'ies'} in the same list cannot carry options`),
    }
  }
  const stringOnly = forms.every((form) => form === 'string')
  return {
    registered: true,
    reachable: false,
    form: stringOnly ? 'string' : 'object',
    detail: stringOnly
      ? 'the Pantheon V2 entry is a bare string, so the host passes no options and ' +
        'context_pruner/memory_injection cannot be enabled; the object form ' +
        '{"package": …, "options": {…}} makes them reachable'
      : 'the Pantheon V2 entry has no "options" object, so the host passes an empty ' +
        'options bag and context_pruner/memory_injection stay at their defaults',
  }
}
