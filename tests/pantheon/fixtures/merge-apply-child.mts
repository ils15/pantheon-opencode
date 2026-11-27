/**
 * Cross-process merge worker for `ephemeral-merge.test.ts`.
 *
 * A merge token is process-local by design, so a cross-process test cannot hand
 * a token to a child: the child previews and applies itself. The barrier file
 * makes both children reach `apply` together, and `--hold` keeps one of them
 * inside the mutation window long enough to prove the lock is not stolen.
 *
 * Protocol: write `<report>.preview` (with the token), wait for `<barrier>`,
 * apply, then write `<report>` with the outcome and timestamps.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { mergeEphemeralStep, resetMergeTokens } from '../../../src/pantheon/ephemeral-merge.ts'

interface ChildArgs {
  readonly cwd: string
  readonly stepKey: string
  readonly holdMs: number
  readonly commit: boolean
  readonly barrier: string
  readonly report: string
  readonly ready: string
}

function parseArgs(argv: readonly string[]): ChildArgs {
  const get = (flag: string): string => {
    const index = argv.indexOf(flag)
    const value = index >= 0 ? argv[index + 1] : undefined
    if (!value) throw new Error(`missing ${flag}`)
    return value
  }
  return {
    cwd: get('--cwd'),
    stepKey: get('--step'),
    holdMs: Number(get('--hold')),
    commit: argv.includes('--commit'),
    barrier: get('--barrier'),
    report: get('--report'),
    ready: `${get('--report')}.preview`,
  }
}

async function waitForBarrier(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  resetMergeTokens()
  const preview = await mergeEphemeralStep({
    cwd: args.cwd,
    stepKey: args.stepKey,
    mode: 'preview',
  })
  writeFileSync(args.ready, JSON.stringify({ token: preview.token, ok: preview.ok }))
  const released = await waitForBarrier(args.barrier, 30_000)
  if (!released) {
    writeFileSync(args.report, JSON.stringify({ ok: false, error: 'barrier_timeout' }))
    return
  }

  let lockAt: number | undefined
  const startedAt = Date.now()
  const res = await mergeEphemeralStep({
    cwd: args.cwd,
    stepKey: args.stepKey,
    mode: 'apply',
    confirmToken: preview.token,
    ...(args.commit ? { commit: true } : {}),
    ...(args.holdMs > 0
      ? {
          onBeforeMerge: async () => {
            await new Promise((resolve) => setTimeout(resolve, args.holdMs))
          },
        }
      : {}),
    onAfterLock: () => {
      lockAt = Date.now()
    },
  })
  writeFileSync(
    args.report,
    JSON.stringify({
      ok: res.ok,
      error: res.error ?? null,
      metadataRecorded: res.metadataRecorded ?? null,
      changes: res.changes ?? null,
      startedAt,
      lockAt: lockAt ?? null,
      doneAt: Date.now(),
    }),
  )
}

await main().catch((err: unknown) => {
  const report = process.argv[process.argv.indexOf('--report') + 1] ?? '/dev/null'
  writeFileSync(
    report,
    JSON.stringify({
      ok: false,
      error: `child_threw: ${err instanceof Error ? err.message : String(err)}`,
    }),
  )
})
