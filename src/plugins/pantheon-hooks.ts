/**
 * pantheon-hooks.ts — Pantheon runtime security-hook plugin for OpenCode.
 *
 * Re-created per Council Synthesis 2026-08-05 (P0): the previous hook plugin
 * was removed on 24-25/07 because it used the Bun Shell `$` from the plugin
 * API, whose interface has NO `.timeout()` method — every hook crashed with
 * `TypeError: $.quiet().nothrow().timeout is not a function`. The 10 functional
 * scripts in scripts/hooks/ (gitleaks covers only staged files, NOT tool
 * calls) were left orphaned. This plugin wires them back into the opencode
 * runtime via `node:child_process` (version-proof — see hook-runner.ts).
 *
 * Hook mapping (Claude Code protocol payload {tool_name, tool_input,
 * agent_id, session_id} delivered on the script stdin):
 *   - tool.execute.before → validate-talos-scope.sh, scan-secrets.sh,
 *     validate-tool-safety.sh + on-subagent-delegation-start.sh (only when the
 *     tool is a delegation tool such as `task`, to keep the audit log honest)
 *   - tool.execute.after  → format-multi-language.sh, log-session-start.sh +
 *     on-subagent-delegation-stop.sh (delegation tool only)
 *   - event session.created → log-session-start.sh, validate-post-conditions.sh
 *
 * Notes:
 *   - `agent_id` is NOT present in the opencode tool.execute hook payloads
 *     ({tool, sessionID, callID}), so it is passed as '' — validate-talos-scope
 *     then takes its safe skip path; the agent-agnostic scan-secrets and
 *     validate-tool-safety protections remain fully active.
 *   - tool.execute hooks cannot hard-deny the tool call through this API
 *     (the output only mutates args; real deny is the permission system), so
 *     violations surface as stderr + non-zero exit codes logged below.
 *   - Logging policy: non-zero exit → console.error (the security signal);
 *     zero exit → silent for the validate/scan/format hooks (they print
 *     "[TALOS SCOPE] skipping" etc. on every call — noise) and console.log for
 *     the audit hooks (session/delegation logs users want to see).
 *   - Hooks NEVER throw: every body is try/catch'd and only logs.
 *
 * IMPORTANT (OpenCode 1.18.11 legacy loader): this module must export EXACTLY
 * ONE function-valued export — the default plugin (see src/plugin.ts L47-52).
 * Helpers live in ./hook-runner.ts and are imported from there.
 */
import type { Plugin } from '@opencode-ai/plugin'
import { runHook, type HookPayload } from './hook-runner.ts'

/** Tools that represent a subagent delegation (opencode `task` tool etc.). */
const DELEGATION_TOOL_RE = /^(task|.*delegate.*|.*subagent.*)$/i

/** Scripts whose zero-exit stderr is worth relaying (audit trail). */
const AUDIT_HOOKS = new Set([
  'log-session-start.sh',
  'on-subagent-delegation-start.sh',
  'on-subagent-delegation-stop.sh',
  'validate-post-conditions.sh',
])

function trim(s: string, max = 2000): string {
  const t = s.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** Translate the opencode hook event into the Claude Code protocol payload. */
function payloadFor(
  input: { tool: string; sessionID: string },
  toolInput: unknown,
): HookPayload {
  return {
    tool_name: input.tool,
    tool_input: toolInput ?? {},
    // tool.execute hooks carry no agent — '' lets talos-scope skip safely.
    agent_id: (input as { agent?: { id?: string } }).agent?.id ?? '',
    session_id: input.sessionID,
  }
}

/** Run one hook with the logging policy; NEVER throw out of the hook. */
async function safeRun(script: string, payload: HookPayload): Promise<void> {
  try {
    const result = await runHook(script, payload)
    const tag = `[pantheon-hooks:${script}]`
    if (result.code !== 0) {
      console.error(
        `${tag} exit ${result.code}${result.timedOut ? ' (timed out)' : ''}: ${trim(result.stderr || result.stdout || 'no output')}`,
      )
    } else if (AUDIT_HOOKS.has(script) && result.stderr.trim()) {
      console.log(`${tag} ${trim(result.stderr)}`)
    }
  } catch (err) {
    // runHook never throws, but the hook body must survive anything.
    console.error(
      `[pantheon-hooks:${script}] unexpected failure: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

const plugin: Plugin = async () => {
  return {
    'tool.execute.before': async (input, output) => {
      try {
        const payload = payloadFor(input, output.args ?? {})
        const hooks = [
          'validate-talos-scope.sh',
          'scan-secrets.sh',
          'validate-tool-safety.sh',
        ]
        if (DELEGATION_TOOL_RE.test(input.tool)) {
          hooks.push('on-subagent-delegation-start.sh')
        }
        await Promise.all(hooks.map((script) => safeRun(script, payload)))
      } catch {
        // Never let a hook take down the opencode session.
      }
    },
    'tool.execute.after': async (input) => {
      try {
        const payload = payloadFor(input, input.args ?? {})
        const hooks = ['format-multi-language.sh']
        if (DELEGATION_TOOL_RE.test(input.tool)) {
          hooks.push('on-subagent-delegation-stop.sh')
        }
        await Promise.all(hooks.map((script) => safeRun(script, payload)))
      } catch {
        // Never let a hook take down the opencode session.
      }
    },
    event: async ({ event: ev }) => {
      try {
        if (ev.type === 'session.created') {
          const payload: HookPayload = { session_id: ev.properties.info.id }
          await Promise.all(
            ['log-session-start.sh', 'validate-post-conditions.sh'].map((script) =>
              safeRun(script, payload),
            ),
          )
        }
      } catch {
        // Never let a hook take down the opencode session.
      }
    },
  }
}

export default plugin
