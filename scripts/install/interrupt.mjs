/**
 * interrupt.mjs — Ctrl-C behaves like every other cancel, for the window in
 * which the installer is actually working.
 *
 * Before this existed, NOTHING under `bin/` or `scripts/install/` handled
 * SIGINT: an interrupted install died by default action, printed no reason, and
 * left no trace — the user could not tell an interrupt from a crash, and a
 * re-run could not tell what the previous attempt did. The prompt library
 * consumes Ctrl-C in raw mode while a question is on screen, so this covers the
 * rest of the run (backup, copies, config write, state write).
 *
 * LIFETIME MATTERS AS MUCH AS THE MESSAGE: the handler is registered when the
 * install starts and must be DEACTIVATED once the run has been recorded. Left
 * registered, a Ctrl-C during the post-install `--doctor` step would rewrite a
 * COMPLETED install as `canceled / applied:false` and claim nothing was
 * applied. {@link createInterruptHandler} therefore owns its registration and
 * exposes `deactivate()` for the caller to call at that point.
 *
 * Contract, all of it pinned by tests:
 *   - exactly ONE message is printed, and it names the interrupt as the point;
 *   - with `--json`, the message goes to stderr so stdout stays parsable;
 *   - the outcome is recorded once (a second Ctrl-C must not record twice);
 *   - the exit code is 130, the documented "canceled" code;
 *   - after `deactivate()`, the signal is no longer handled at all.
 *
 * Kept injectable rather than reading globals so the exit code, the streams,
 * the emitter and the record call are all observable in a unit test.
 *
 * @module interrupt
 */

/**
 * Build and REGISTER a SIGINT handler.
 *
 * @param {{
 *   message: string,
 *   json?: boolean,
 *   onInterrupt?: () => void,
 *   endGaugeLine?: () => void,
 *   writeStderr?: (line: string) => void,
 *   logStderr?: (line: string) => void,
 *   exit?: (code: number) => void,
 *   emitter?: { once: (event: string, listener: () => void) => unknown, removeListener: (event: string, listener: () => void) => unknown },
 * }} options
 * @returns {(() => void) & { deactivate: () => void }} the registered handler
 */
export function createInterruptHandler({
  message,
  json = false,
  onInterrupt = () => {},
  endGaugeLine = () => {},
  writeStderr = (line) => process.stderr.write(`${line}\n`),
  logStderr = (line) => console.error(line),
  exit = (code) => process.exit(code),
  emitter = process,
}) {
  let handled = false
  const handle = function handleInterrupt() {
    if (handled) return
    handled = true
    try {
      // The progress gauge owns the current terminal line; close it so the
      // message is not appended to a half-drawn bar and then erased.
      endGaugeLine()
      if (json) writeStderr(message)
      else logStderr(message)
      onInterrupt()
    } finally {
      exit(130)
    }
  }
  /** Stop handling SIGINT: the run this handler described is over. */
  handle.deactivate = () => {
    emitter.removeListener('SIGINT', handle)
  }
  emitter.once('SIGINT', handle)
  return handle
}
