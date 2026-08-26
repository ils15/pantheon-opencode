import type { BackgroundJobRecord } from './background-job-board.ts'

type ToastCategory = 'errors' | 'delegations' | 'council'

const toastMode = (process.env.PANTHEON_TOASTS ?? '').trim().toLowerCase()
const enabledToastCategories: ReadonlySet<ToastCategory> = (() => {
  switch (toastMode) {
    case 'off':
      return new Set()
    case 'errors':
      return new Set(['errors'])
    case 'council':
      return new Set(['errors', 'council'])
    case 'all':
      return new Set(['errors', 'delegations', 'council'])
    default:
      return new Set(['errors', 'delegations', 'council'])
  }
})()
const terminalToastsShown = new Set<string>()
const terminalStates = new Set(['completed', 'error', 'cancelled'])

/** Match the lifecycle toast gate used by pantheon-hooks. */
export function delegationToastEnabled(): boolean {
  return enabledToastCategories.has('delegations')
}

export type ToastClient = {
  tui?: {
    showToast?: (input: {
      body: {
        title?: string
        message: string
        variant: 'info' | 'success' | 'warning' | 'error'
        duration: number
      }
    }) => Promise<unknown>
  }
}

/** Best-effort visual completion signal; never affects board finalization. */
export async function showDelegationTerminalToast(
  client: ToastClient,
  job: Pick<BackgroundJobRecord, 'taskID' | 'alias' | 'agent' | 'state' | 'timedOut'>,
): Promise<void> {
  try {
    if (!delegationToastEnabled()) return
    const isTerminal = job.timedOut || terminalStates.has(job.state)
    if (isTerminal) {
      if (terminalToastsShown.has(job.taskID)) return
      terminalToastsShown.add(job.taskID)
    }
    const showToast = client.tui?.showToast
    if (typeof showToast !== 'function') return
    const state = job.timedOut ? 'timeout' : job.state
    const variant =
      state === 'completed'
        ? 'success'
        : state === 'error' || state === 'timeout'
          ? 'error'
          : 'warning'
    await showToast({
      body: {
        title: 'Delegação concluída',
        message: `${job.alias} (${job.agent}) — ${state}`,
        variant,
        duration: 4000,
      },
    })
  } catch {
    // TUI is optional (and may disappear during shutdown); completion is durable.
  }
}
