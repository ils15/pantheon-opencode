import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Allocate an isolated delegation output directory for a test.
 *
 * Delegation factories default `outputDir` to the real `.pantheon/delegations`
 * tree. Tests must never read/write there: the leak polluted real user reports
 * and made the suite touch `.pantheon/delegations/ses_root/*.md`.
 */
export function tmpDelegationDir(prefix = 'pantheon-del-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * Allocate an isolated PROJECT directory and `process.chdir()` into it.
 *
 * The BackgroundJobBoard singleton persists to the RELATIVE path
 * `.pantheon/board/state.json` (src/pantheon/shared-board.ts) and the
 * delegation writers use relative `.pantheon/delegations` / signal dirs.
 * A test that imports the real `src/plugin.ts` and calls
 * `pantheon_delegate.execute` MUST call this BEFORE the first
 * `getSharedBoard()` (i.e. before importing the plugin) — otherwise the
 * registered job leaks into the repo's real board as a phantom
 * `running`/`error` row that never expires.
 *
 * Mirrors the isolation already used by native-task-board.test.ts.
 */
export function useTmpProjectDir(prefix = 'pantheon-project-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  process.chdir(dir)
  return dir
}
