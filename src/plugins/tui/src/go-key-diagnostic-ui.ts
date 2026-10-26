import type { Context, KeymapCommand } from '@opencode/plugin/tui/context'
import type { GoKeyDiagnosticResult } from './go-key-diagnostic'
import { quotaRpc } from './quota-rpc'

const EXPLANATIONS: Record<GoKeyDiagnosticResult['category'], string> = {
  not_run: 'No request was sent. No eligible Go API key was available or the attempt was canceled.',
  already_used:
    'No request was sent. The one-shot diagnostic was already used in this plugin runtime.',
  success: 'HTTP success only; not proof of a stable quota contract or parsed quota correctness.',
  unauthorized: 'Request rejected; cause unknown.',
  redirect: 'Redirect was not followed.',
  http_error: 'HTTP error; cause unknown.',
  timeout: 'Request timed out; no retry was made.',
  network_error: 'Network error; no retry was made.',
}

/** Treat RPC data as untrusted: only render allowlisted categories and coarse metadata. */
function resultMessage(value: unknown): string {
  if (!value || typeof value !== 'object' || !('category' in value)) {
    return 'Diagnostic result unavailable. Request outcome unknown; no automatic retry.'
  }
  const category = value.category
  if (typeof category !== 'string' || !Object.hasOwn(EXPLANATIONS, category)) {
    return 'Diagnostic result unavailable. Request outcome unknown; no automatic retry.'
  }
  const status =
    'status' in value &&
    typeof value.status === 'number' &&
    Number.isInteger(value.status) &&
    value.status >= 100 &&
    value.status <= 599
      ? ` · HTTP ${value.status}`
      : ''
  const contentType =
    'content_type' in value &&
    typeof value.content_type === 'string' &&
    ['application/json', 'text/plain', 'text/html', 'other', 'missing'].includes(value.content_type)
      ? ` · content type: ${value.content_type}`
      : ''
  return `${category}${status}${contentType}\n${EXPLANATIONS[category as GoKeyDiagnosticResult['category']]}`
}

/** Native keyboard-accessible dialogs; never invoked by quota refresh or panel mounting. */
export function quotaGoCheckCommand(
  context: Pick<Context, 'ui' | 'client' | 'location' | 'data'>,
): KeymapCommand {
  let active = false
  return {
    id: 'pantheon.quota.go-check',
    title: 'Pantheon: Go API-key check (one-shot)',
    description: 'Manual diagnostic with confirmation; not a quota refresh',
    group: 'Pantheon',
    palette: true,
    slash: { name: 'quota-go-check' },
    run: async (): Promise<void> => {
      if (active) return
      active = true
      try {
        const confirmed = await context.ui.dialog.confirm({
          title: 'Go API-key diagnostic — send once?',
          message:
            'Send one GET to https://opencode.ai/zen/go/v1/usage using the configured Go API key once? OAuth is not used. No request body, redirects, retries, or response-body reading. 5-second timeout. One attempt per plugin runtime, including failed or unavailable-key attempts. This does not refresh quota.',
          label: { confirm: 'Send once', cancel: 'Cancel (no request)' },
        })
        if (confirmed !== true) return
        let message: string
        try {
          const result = await context.client.rpc(quotaRpc).go_key_diagnostic(
            {},
            {
              location: context.location ?? context.data.location.default(),
            },
          )
          message = resultMessage(result)
        } catch {
          // Transport errors may contain credentials or provider text. Never render/log them.
          message = 'Diagnostic result unavailable. Request outcome unknown; no automatic retry.'
        }
        await context.ui.dialog.alert({ title: 'Go API-key diagnostic', message })
      } finally {
        active = false
      }
    },
  }
}
