/**
 * exit-codes.mjs — the process exit code the `init` CLI returns for an
 * `installOpenCode` result. Pure, so the mapping is unit-testable without
 * spawning the CLI.
 *
 *   `0`   success, or plan-only / declined (nothing applied)
 *   `1`   failure (the CLI handles thrown errors separately)
 *   `2`   apply requested without authorization (non-interactive, no --yes)
 *   `3`   drift detected — a planned target changed between plan and apply
 *   `130` canceled
 */

export function resolveInstallExitCode(result, isDryRun) {
  if (isDryRun) return 0
  if (result?.applied !== false) return 0
  switch (result.reason) {
    case 'not-authorized':
      return 2
    case 'drift':
      return 3
    case 'canceled':
      return 130
    default:
      return 0
  }
}
