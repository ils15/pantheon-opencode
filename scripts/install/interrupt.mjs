/**
 * interrupt.mjs — Ctrl-C behaves like every other cancel.
 *
 * Before this existed, NOTHING under `bin/` or `scripts/install/` handled
 * SIGINT: an interrupted install died by default action, printed no reason, and
 * left no trace — the user could not tell an interrupt from a crash, and a
 * re-run could not tell what the previous attempt did. The prompt library
 * consumes Ctrl-C in raw mode while a question is on screen, so this covers the
 * rest of the run (backup, copies, config write, state write).
 *
 * Contract, all of it pinned by tests:
 *   - exactly ONE message is printed, and it names the interrupt as the point;
 *   - with `--json`, the message goes to stderr so stdout stays parsable;
 *   - the outcome is recorded once (a second Ctrl-C must not record twice);
 *   - the exit code is 130, the documented "canceled" code.
 *
 * Kept injectable rather than reading globals so the exit code, the streams and
 * the record call are all observable in a unit test.
 *
 * @module interrupt
 */

/**
 * Build a SIGINT handler.
 *
 * @param {{
 *   message: string,
 *   json?: boolean,
 *   onInterrupt?: () => void,
 *   endGaugeLine?: () => void,
 *   writeStderr?: (line: string) => void,
 *   logStderr?: (line: string) => void,
 *   exit?: (code: number) => void,
 * }} options
 * @returns {() => void} the handler
 */
export function createInterruptHandler({
  message,
  json = false,
  onInterrupt = () => {},
  endGaugeLine = () => {},
  writeStderr = (line) => process.stderr.write(`${line}\n`),
  logStderr = (line) => console.error(line),
  exit = (code) => process.exit(code),
}) {
  let handled = false
  return function handleInterrupt() {
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
}
