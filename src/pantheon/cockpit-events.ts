/**
 * Persistent Cross-Process Cockpit Telemetry Recorder (`cockpit-events.ts`).
 *
 * Bridges the server plugin's in-memory `PantheonBus` (`getSharedBus()`) to
 * `.pantheon/telemetry/cockpit-events.ndjson` so the TUI plugin (`/pantheon-cockpit`
 * Flightdeck Semantic Event Stream) displays live bus events across isolated runtimes.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { getSharedBus } from './bus.ts'
import { resolveSharedPantheonRoot } from './tool-context.ts'

export interface PersistedCockpitEvent {
  readonly kind: string
  readonly timestamp: number
  readonly agent: string
  readonly detail: string
  readonly severity: 'info' | 'ok' | 'warn' | 'error'
}

const MAX_RETAINED_EVENTS = 160

function resolveCockpitTelemetryPath(workspaceDir: string): string {
  const root = resolveSharedPantheonRoot(workspaceDir)
  const dir = join(root, '.pantheon', 'telemetry')
  mkdirSync(dir, { recursive: true })
  const canonicalDir = realpathSync(dir)
  const target = resolve(canonicalDir, 'cockpit-events.ndjson')
  const prefix = canonicalDir.endsWith(sep) ? canonicalDir : `${canonicalDir}${sep}`
  if (!target.startsWith(prefix)) {
    throw new Error('Cockpit telemetry path escapes .pantheon/telemetry boundary')
  }
  return target
}

/** Append one normalized event line to `.pantheon/telemetry/cockpit-events.ndjson`, capping history. */
export function appendCockpitBusEvent(workspaceDir: string, entry: PersistedCockpitEvent): void {
  try {
    const filePath = resolveCockpitTelemetryPath(workspaceDir)
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8')
    const raw = readFileSync(filePath, 'utf8')
    const lines = raw.split(/\r?\n/).filter(Boolean)
    if (lines.length > MAX_RETAINED_EVENTS) {
      writeFileSync(filePath, `${lines.slice(-MAX_RETAINED_EVENTS).join('\n')}\n`, 'utf8')
    }
  } catch {
    /* telemetry recording is strictly best-effort */
  }
}

/** Read recent persisted telemetry events (fail-open). */
export function readCockpitBusEvents(workspaceDir: string, limit = 40): PersistedCockpitEvent[] {
  try {
    const root = resolveSharedPantheonRoot(workspaceDir)
    const filePath = join(root, '.pantheon', 'telemetry', 'cockpit-events.ndjson')
    if (!existsSync(filePath)) return []
    const lines = readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean)
    const out: PersistedCockpitEvent[] = []
    for (const line of lines.slice(-limit)) {
      try {
        const parsed = JSON.parse(line) as Partial<PersistedCockpitEvent>
        if (typeof parsed.kind === 'string' && typeof parsed.detail === 'string') {
          out.push({
            kind: parsed.kind,
            timestamp: typeof parsed.timestamp === 'number' ? parsed.timestamp : Date.now(),
            agent: typeof parsed.agent === 'string' ? parsed.agent : 'pantheon',
            detail: parsed.detail,
            severity:
              parsed.severity === 'ok' || parsed.severity === 'warn' || parsed.severity === 'error'
                ? parsed.severity
                : 'info',
          })
        }
      } catch {
        /* ignore malformed NDJSON line */
      }
    }
    return out
  } catch {
    return []
  }
}

/** Subscribe to all PantheonBus cockpit channels and persist them for the TUI. */
export function wireCockpitBusRecorder(workspaceDir: string): () => void {
  const bus = getSharedBus()
  const unsubs = [
    bus.on('lsp:diagnostics', (ev) => {
      appendCockpitBusEvent(workspaceDir, {
        kind: 'lsp:diagnostics',
        timestamp: ev.timestamp,
        agent: ev.source,
        detail: `${ev.file} · ${ev.errors} err / ${ev.count} total`,
        severity: ev.errors > 0 ? 'warn' : 'ok',
      })
    }),
    bus.on('review:verdict', (ev) => {
      appendCockpitBusEvent(workspaceDir, {
        kind: 'review:verdict',
        timestamp: ev.timestamp,
        agent: ev.targetAgent,
        detail: `${ev.verdict}: ${ev.summary}`,
        severity:
          ev.verdict === 'BLOCK' ? 'error' : ev.verdict === 'APPROVE_WITH_NOTES' ? 'warn' : 'ok',
      })
    }),
    bus.on('step:rollback', (ev) => {
      appendCockpitBusEvent(workspaceDir, {
        kind: 'step:rollback',
        timestamp: ev.timestamp,
        agent: 'ledger',
        detail: `${ev.stepKey} (${ev.reason}) -> ${ev.success ? 'restored' : 'failed'}`,
        severity: ev.success ? 'warn' : 'error',
      })
    }),
    bus.on('reproduction:gate', (ev) => {
      appendCockpitBusEvent(workspaceDir, {
        kind: 'reproduction:gate',
        timestamp: ev.timestamp,
        agent: ev.agent,
        detail: `${ev.stepKey} [${ev.tool}] -> ${ev.allowed ? 'allowed' : 'blocked (RED required)'}`,
        severity: ev.allowed ? 'ok' : 'warn',
      })
    }),
    bus.on('themis:reflex:escalated', (ev) => {
      appendCockpitBusEvent(workspaceDir, {
        kind: 'themis:reflex:escalated',
        timestamp: ev.timestamp,
        agent: ev.agent,
        detail: `${ev.taskID} (${ev.error})`,
        severity: 'error',
      })
    }),
    bus.on('agent:execution:receipt', (ev) => {
      appendCockpitBusEvent(workspaceDir, {
        kind: 'agent:execution:receipt',
        timestamp: ev.timestamp,
        agent: ev.agent,
        detail: `${ev.taskID} receipt=${ev.receiptId}`,
        severity: 'ok',
      })
    }),
  ]
  return () => {
    for (const unsub of unsubs) {
      try {
        unsub()
      } catch {
        /* ignore */
      }
    }
  }
}
