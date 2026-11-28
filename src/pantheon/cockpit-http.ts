/**
 * Opt-in, read-only HTTP cockpit bound to loopback (S5 / D01).
 *
 * This is a *headless* surface for a Linux VPS reached through an SSH tunnel.
 * It reads the same on-disk artifacts the TUI selector reads, but it serves a
 * different, deliberately smaller payload: `pantheon.cockpit.v1`. It is NOT
 * the TUI `CockpitSnapshot` and makes no parity claim. `buildCockpitSnapshot`
 * needs host telemetry, live children and bus events that only a running host
 * can supply; none of those exist here.
 *
 * Security posture (the reason this is a separate gate):
 * - `PANTHEON_COCKPIT=1` is the only enable switch. Disabled means no server
 *   object is created at all.
 * - Loopback only. A non-loopback `PANTHEON_COCKPIT_HOST` is a fatal config
 *   error, never a warning and never `0.0.0.0`.
 * - GET/HEAD only. There is no write surface, so there is no CSRF surface.
 * - No CORS headers, ever. `Host` must be a loopback authority for the bound
 *   port, otherwise `421 Misdirected Request` with an empty body (DNS
 *   rebinding defence).
 * - `Cache-Control: no-store` + `X-Content-Type-Options: nosniff` on every
 *   response.
 * - Redaction is the default: agent-authored free text (objectives, cascade
 *   reasons, board goals/workstreams and message bodies) is omitted rather
 *   than scrubbed, together with session ids, cost/token-shaped fields, file
 *   lists and command lines. Only `?full=1` returns them.
 *
 * @module cockpit-http
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename, resolve } from 'node:path'
import {
  type BoardMessage,
  type BoardMessageTag,
  getBoardStatus,
  listBoardChannels,
  readBoardMessages,
} from './board-messages.ts'
import { buildDependencyGraph, type DependencyGraph } from './step-dependencies.ts'
import { readStepLedgerSnapshot, type StepLedgerEntry } from './step-ledger.ts'

/** Versioned envelope id. A future divergence from the TUI type bumps this. */
export const COCKPIT_SCHEMA = 'pantheon.cockpit.v1'
/** D01 default. */
export const DEFAULT_COCKPIT_PORT = 4747
/** The one accepted token carrier (defence-in-depth, not the boundary). */
export const COCKPIT_TOKEN_HEADER = 'x-pantheon-cockpit-token'
/** Number of board messages included in the envelope. */
const BOARD_MESSAGE_LIMIT = 50

const PACKAGE_VERSION = (() => {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
})()

export type CockpitEnv = Record<string, string | undefined>

/** A fatal cockpit configuration error. Startup must not continue. */
export class CockpitConfigError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CockpitConfigError'
    this.code = code
  }
}

export interface CockpitConfig {
  readonly enabled: boolean
  /** The address actually bound. `localhost` is canonicalized to `127.0.0.1`. */
  readonly host: '127.0.0.1' | '::1'
  readonly port: number
  readonly token?: string
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

/**
 * Resolve the D01 env contract. Throws `CockpitConfigError` for every fatal
 * setting while the cockpit is enabled. When disabled it never validates the
 * port or host: a configured-but-disabled cockpit must not fail startup.
 */
export function resolveCockpitConfig(env: CockpitEnv = process.env): CockpitConfig {
  const enabled = (env.PANTHEON_COCKPIT ?? '').trim() === '1'
  if (!enabled) {
    return { enabled: false, host: '127.0.0.1', port: DEFAULT_COCKPIT_PORT }
  }

  const rawPort = env.PANTHEON_COCKPIT_PORT
  let port = DEFAULT_COCKPIT_PORT
  if (rawPort !== undefined) {
    // No trim: `' 0 '` is a typo, not a port. Only bare decimal digits pass.
    // The error names both the received value and the accepted shape: a stray
    // space or a trailing newline from a `.env` loader must be diagnosable
    // without reading the plugin log.
    if (!/^[0-9]+$/.test(rawPort)) {
      throw new CockpitConfigError(
        'invalid_port',
        `PANTHEON_COCKPIT_PORT must be a bare integer between 1 and 65535 with no surrounding whitespace, quotes or trailing newline (got ${JSON.stringify(rawPort)}; expected e.g. "4747")`,
      )
    }
    port = Number(rawPort)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new CockpitConfigError(
        'invalid_port',
        `PANTHEON_COCKPIT_PORT must be between 1 and 65535 with no surrounding whitespace (got ${JSON.stringify(rawPort)}; expected e.g. "4747"); 0 is never an ephemeral port`,
      )
    }
  }

  const rawHost = (env.PANTHEON_COCKPIT_HOST ?? '127.0.0.1').trim().toLowerCase()
  const hostValue = rawHost === '[::1]' ? '::1' : rawHost
  if (!LOOPBACK_HOSTS.has(hostValue)) {
    throw new CockpitConfigError(
      'non_loopback_host',
      `PANTHEON_COCKPIT_HOST must be loopback (127.0.0.1, ::1 or localhost); refusing to bind ${JSON.stringify(env.PANTHEON_COCKPIT_HOST)}`,
    )
  }

  const token = env.PANTHEON_COCKPIT_TOKEN
  // A whitespace-only token is a live one-character secret (the space) that an
  // operator can neither see nor type back reliably. Do not trim it into an
  // empty "disabled" token: that would hide the mistake. Reject it loudly.
  if (typeof token === 'string' && token.length > 0 && token.trim() === '') {
    throw new CockpitConfigError(
      'invalid_token',
      `PANTHEON_COCKPIT_TOKEN must be a non-empty secret when set (got ${JSON.stringify(token)}; expected a token with at least one non-whitespace character, or unset it to disable the token check)`,
    )
  }
  return {
    enabled: true,
    host: hostValue === '::1' ? '::1' : '127.0.0.1',
    port,
    ...(typeof token === 'string' && token.length > 0 ? { token } : {}),
  }
}

/** Headless reduction of the on-disk artifacts. Deliberately not `CockpitSnapshot`. */
export interface HeadlessCockpitSnapshot {
  readonly schema: typeof COCKPIT_SCHEMA
  readonly version: string
  readonly kind: 'headless'
  readonly source: 'on-disk'
  readonly parity: 'not-tui-snapshot'
  readonly generatedAt: string
  /** `true` when the ledger exists but cannot be parsed; `steps` is then empty. */
  readonly stepsCorrupt: boolean
  readonly steps: ReadonlyArray<HeadlessStep>
  readonly graph: DependencyGraph
  readonly board: HeadlessBoard
}

export interface HeadlessStep {
  readonly stepKey: string
  /**
   * Agent-authored free text. `?full=1` only: default mode carries
   * `objectiveLength` instead, because free text can carry absolute paths,
   * command lines and pasted credentials and is not passed through a scrubber.
   */
  readonly objective?: string
  /** Default mode only (also present in full mode): length of the omitted objective. */
  readonly objectiveLength: number
  readonly agent: string
  readonly state: string
  readonly taskType?: string
  readonly dependsOn: readonly string[]
  readonly blockedBy: readonly string[]
  /** Agent-authored free text. `?full=1` only. */
  readonly cascadeReason?: string
  /** Default mode only (also present in full mode): length of the omitted reason. */
  readonly cascadeReasonLength?: number
  readonly verificationAttempts?: number
  readonly verificationFailures?: number
  readonly verificationExitCode?: number
  readonly lastMutationAt: number | null
  readonly lastVerifiedAt: number | null
  readonly updatedAt: string
  readonly mutatedFileCount: number
  /** Full mode only: paths, commands, receipts and ephemeral metadata. */
  readonly mutatedFiles?: readonly string[]
  readonly receiptId?: string
  readonly verificationCommand?: string
  readonly reproductionCommand?: string
  readonly reproductionExitCode?: number
  readonly baselineTree?: string
  readonly baselineRef?: string
  readonly ephemeral?: Record<string, unknown>
}

export interface HeadlessBoardThread {
  readonly channel: string
  readonly threadId: string
  /** Agent-authored free text. `?full=1` only. */
  readonly goal?: string
  /** Default mode only (also present in full mode). */
  readonly goalLength?: number
  /** Agent-authored free text. `?full=1` only. */
  readonly workstream?: string
  /** Default mode only (also present in full mode). */
  readonly workstreamLength?: number
  readonly headSeq: number
  readonly messageCount: number
  readonly lastTag?: BoardMessageTag
  readonly updatedAt: number
}

export interface HeadlessBoardMessage {
  readonly seq: number
  readonly timestamp: number
  readonly channel: string
  readonly threadId: string
  readonly from: string
  readonly mentions: readonly string[]
  readonly replyToSeq?: number
  readonly tag?: BoardMessageTag
  readonly stepKey?: string
  /** Agent-authored free text. Full mode only. */
  readonly goal?: string
  readonly goalLength?: number
  /** Agent-authored free text. Full mode only. */
  readonly workstream?: string
  readonly workstreamLength?: number
  /** Full mode only. */
  readonly body?: string
  /** Default mode: length of the omitted body. */
  readonly bodyLength: number
  /** Full mode only. */
  readonly ephemeral?: Record<string, unknown>
}

export interface HeadlessBoard {
  readonly head: number
  readonly channels: readonly string[]
  readonly channelHeaders: ReadonlyArray<{
    readonly channel: string
    readonly threadId: string
    /** Agent-authored free text. Full mode only. */
    readonly goal?: string
    readonly goalLength?: number
    /** Agent-authored free text. Full mode only. */
    readonly workstream?: string
    readonly workstreamLength?: number
    readonly updatedAt: number
  }>
  readonly threads: readonly HeadlessBoardThread[]
  readonly messages: readonly HeadlessBoardMessage[]
  readonly messageLimit: number
  /** `false` when `?full=1`; makes the redaction state explicit, not implicit. */
  readonly bodiesRedacted: boolean
}

export interface BuildHeadlessSnapshotOptions {
  /** `?full=1`: include board bodies, paths, commands and ephemeral ids. */
  readonly full?: boolean
  /** Injectable clock for deterministic tests. */
  readonly now?: Date
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value }
}

function reduceStep(entry: StepLedgerEntry, full: boolean): HeadlessStep {
  const base: HeadlessStep = {
    stepKey: entry.stepKey,
    // Free text is opt-in. Default mode exposes only its length, never the
    // text: an objective routinely contains a path, a command line or a pasted
    // token and no scrubber can be proven complete over agent-authored prose.
    objectiveLength: entry.objective.length,
    agent: entry.agent,
    state: entry.state,
    dependsOn: [...(entry.dependsOn ?? [])],
    blockedBy: [...(entry.blockedBy ?? [])],
    lastMutationAt: entry.lastMutationAt ?? null,
    lastVerifiedAt: entry.lastVerifiedAt ?? null,
    updatedAt: entry.updatedAt,
    mutatedFileCount: Array.isArray(entry.mutatedFiles) ? entry.mutatedFiles.length : 0,
    ...optional('taskType', entry.taskType),
    ...(entry.cascadeReason === undefined
      ? {}
      : { cascadeReasonLength: entry.cascadeReason.length }),
    ...optional('verificationAttempts', entry.verificationAttempts),
    ...optional('verificationFailures', entry.verificationFailures),
    ...optional('verificationExitCode', entry.verificationExitCode),
  }
  if (!full) return base
  return {
    ...base,
    objective: entry.objective,
    ...optional('cascadeReason', entry.cascadeReason),
    mutatedFiles: [...(entry.mutatedFiles ?? [])],
    ...optional('receiptId', entry.receiptId),
    ...optional('verificationCommand', entry.verificationCommand),
    ...optional('reproductionCommand', entry.reproductionCommand),
    ...optional('reproductionExitCode', entry.reproductionExitCode),
    ...optional('baselineTree', entry.baselineTree),
    ...optional('baselineRef', entry.baselineRef),
    ...(entry.ephemeral === undefined
      ? {}
      : { ephemeral: entry.ephemeral as Record<string, unknown> }),
  }
}

function reduceMessage(message: BoardMessage, full: boolean): HeadlessBoardMessage {
  const base: HeadlessBoardMessage = {
    seq: message.seq,
    timestamp: message.timestamp,
    channel: message.channel,
    threadId: message.threadId,
    from: message.from,
    mentions: [...message.mentions],
    bodyLength: message.body.length,
    ...(message.goal === undefined ? {} : { goalLength: message.goal.length }),
    ...(message.workstream === undefined ? {} : { workstreamLength: message.workstream.length }),
    ...optional('replyToSeq', message.replyToSeq),
    ...optional('tag', message.tag),
    ...optional('stepKey', message.stepKey),
  }
  if (!full) return base
  return {
    ...base,
    ...optional('goal', message.goal),
    ...optional('workstream', message.workstream),
    body: message.body,
    ...(message.ephemeral === undefined
      ? {}
      : { ephemeral: message.ephemeral as unknown as Record<string, unknown> }),
  }
}

/**
 * Build the `pantheon.cockpit.v1` envelope from on-disk artifacts only.
 *
 * Never mutates the workspace: the ledger read is the non-quarantining variant,
 * so a corrupt ledger is reported (`stepsCorrupt: true`) on every request
 * instead of being moved aside by a GET.
 */
export function buildHeadlessSnapshot(
  workspaceDir: string,
  options: BuildHeadlessSnapshotOptions = {},
): HeadlessCockpitSnapshot {
  const full = options.full === true
  const ledger = readStepLedgerSnapshot(workspaceDir)
  const entries = Object.values(ledger.store.steps).sort((a, b) =>
    a.stepKey.localeCompare(b.stepKey),
  )
  const graph = buildDependencyGraph(
    entries.map((entry) => ({
      stepKey: entry.stepKey,
      state: entry.state,
      dependsOn: entry.dependsOn ?? [],
    })),
  )

  // Persisted summary only. `getBoardStatus` mixes in the in-process
  // BackgroundJobBoard; a headless reader has no live jobs, so that field is
  // deliberately not copied into the envelope.
  const status = getBoardStatus(workspaceDir)
  const read = readBoardMessages(workspaceDir, { limit: BOARD_MESSAGE_LIMIT })
  const channelHeaders = listBoardChannels(workspaceDir).map((header) => ({
    channel: header.channel,
    threadId: header.threadId,
    updatedAt: header.updatedAt,
    ...(header.goal === undefined ? {} : { goalLength: header.goal.length }),
    ...(header.workstream === undefined ? {} : { workstreamLength: header.workstream.length }),
    ...(full
      ? { ...optional('goal', header.goal), ...optional('workstream', header.workstream) }
      : {}),
  }))

  return {
    schema: COCKPIT_SCHEMA,
    version: PACKAGE_VERSION,
    kind: 'headless',
    source: 'on-disk',
    parity: 'not-tui-snapshot',
    generatedAt: (options.now ?? new Date()).toISOString(),
    stepsCorrupt: ledger.corrupt,
    steps: entries.map((entry) => reduceStep(entry, full)),
    graph,
    board: {
      head: status.head,
      channels: [...status.channels],
      channelHeaders,
      threads: status.threads.map((thread) => ({
        channel: thread.channel,
        threadId: thread.threadId,
        headSeq: thread.headSeq,
        messageCount: thread.messageCount,
        updatedAt: thread.updatedAt,
        ...(thread.goal === undefined ? {} : { goalLength: thread.goal.length }),
        ...(thread.workstream === undefined ? {} : { workstreamLength: thread.workstream.length }),
        ...(full
          ? { ...optional('goal', thread.goal), ...optional('workstream', thread.workstream) }
          : {}),
        ...optional('lastTag', thread.lastTag),
      })),
      messages: read.messages.map((message) => reduceMessage(message, full)),
      messageLimit: BOARD_MESSAGE_LIMIT,
      bodiesRedacted: !full,
    },
  }
}

// ─── HTTP surface ──────────────────────────────────────────────────────

const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['Cache-Control', 'no-store'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'"],
  ['Referrer-Policy', 'no-referrer'],
]

function applySecurityHeaders(res: ServerResponse): void {
  for (const [name, value] of SECURITY_HEADERS) res.setHeader(name, value)
}

/** An empty response: status line and headers only, no payload. */
function sendEmpty(res: ServerResponse, status: number, extra?: Record<string, string>): void {
  applySecurityHeaders(res)
  for (const [name, value] of Object.entries(extra ?? {})) res.setHeader(name, value)
  res.statusCode = status
  res.setHeader('Content-Length', '0')
  res.end()
}

/** JSON response. `head` suppresses the body while keeping the length accurate. */
function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  head: boolean,
  extraHeaders?: Record<string, string>,
): void {
  const body = JSON.stringify(payload)
  applySecurityHeaders(res)
  for (const [name, value] of Object.entries(extraHeaders ?? {})) res.setHeader(name, value)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(Buffer.byteLength(body)))
  if (head) res.end()
  else res.end(body)
}

/**
 * DNS-rebinding defence: the request authority must name loopback for the port
 * we actually bound. `localhost` is accepted because the tunnel is normally
 * opened against it.
 */
function isAllowedHost(rawHost: string | undefined, port: number): boolean {
  if (typeof rawHost !== 'string') return false
  const host = rawHost.trim().toLowerCase()
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`
}

function tokensEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name]
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) return raw[0]
  return undefined
}

/**
 * A short, stable identity for the served workspace: its directory basename
 * plus a hash of the absolute path. It lets an operator confirm that an SSH
 * tunnel points at the workspace they think, without exposing the absolute
 * path (which leaks the user name and directory layout).
 */
function workspaceIdentity(workspaceDir: string): { name: string; id: string } {
  const absolute = resolve(workspaceDir)
  const name = basename(absolute) || 'workspace'
  const hash = createHash('sha256').update(absolute).digest('hex').slice(0, 8)
  return { name, id: `${name}-${hash}` }
}

function createRequestHandler(
  workspaceDir: string,
  config: CockpitConfig,
  log: (line: string) => void,
): (req: IncomingMessage, res: ServerResponse) => void {
  const workspace = workspaceIdentity(workspaceDir)
  return (req, res) => {
    try {
      // 1. The rebinding gate, before anything else and for every method.
      if (!isAllowedHost(req.headers.host, config.port)) {
        sendEmpty(res, 421)
        return
      }

      // 2. Optional shared-secret check. Defence-in-depth only: loopback is
      //    the boundary, so a missing token must not widen what is served.
      if (config.token !== undefined) {
        const provided = headerValue(req, COCKPIT_TOKEN_HEADER)
        if (provided === undefined || !tokensEqual(provided, config.token)) {
          sendEmpty(res, 401)
          return
        }
      }

      // 3. No write surface, therefore no CSRF surface.
      const method = req.method ?? ''
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { error: 'method_not_allowed' }, false, { Allow: 'GET, HEAD' })
        return
      }
      const head = method === 'HEAD'

      let url: URL
      try {
        url = new URL(req.url ?? '/', 'http://127.0.0.1')
      } catch {
        sendJson(res, 400, { error: 'bad_request' }, head)
        return
      }

      if (url.pathname === '/healthz') {
        sendJson(
          res,
          200,
          {
            ok: true,
            schema: COCKPIT_SCHEMA,
            version: PACKAGE_VERSION,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
          },
          head,
        )
        return
      }

      if (url.pathname === '/' || url.pathname === '/snapshot') {
        const full = url.searchParams.get('full') === '1'
        let snapshot: HeadlessCockpitSnapshot
        try {
          snapshot = buildHeadlessSnapshot(workspaceDir, { full })
        } catch (error) {
          log(`cockpit snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
          sendJson(res, 500, { error: 'snapshot_failed' }, head)
          return
        }
        sendJson(res, 200, snapshot, head)
        return
      }

      sendJson(res, 404, { error: 'not_found' }, head)
    } catch (error) {
      log(`cockpit request failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' }, false)
      else res.end()
    }
  }
}

/** The cockpit could not bind its loopback port (almost always EADDRINUSE). */
export class CockpitBindError extends Error {
  readonly code = 'port_in_use'
  readonly port: number

  constructor(port: number, cause?: unknown) {
    super(
      `cannot bind loopback port ${port}: another process already holds it (EADDRINUSE). ` +
        `Another Pantheon process on this machine most likely owns the port, so an SSH tunnel would serve that process's workspace, not this one. ` +
        `Set PANTHEON_COCKPIT_PORT to a free port for this process and restart.`,
      cause === undefined ? undefined : { cause },
    )
    this.name = 'CockpitBindError'
    this.port = port
  }
}

export interface CockpitListenInfo {
  readonly host: string
  readonly port: number
  readonly url: string
}

export interface StartCockpitOptions {
  readonly workspaceDir: string
  readonly env?: CockpitEnv
  /** `cockpit disabled`, startup warnings and request failures. */
  readonly log?: (line: string) => void
  /**
   * Fatal configuration errors are also written here so the operator sees them
   * on the terminal, not only in `.pantheon/logs/hooks.log`. Defaults to stderr.
   */
  readonly stderr?: (line: string) => void
  /** Production hook used to log the bound port; also the test's listener probe. */
  readonly onListening?: (info: CockpitListenInfo) => void
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

export interface CockpitHandle {
  readonly server: Server
  readonly config: CockpitConfig
  /** Resolves once the socket listens; rejects on bind failure (e.g. EADDRINUSE). */
  readonly ready: Promise<CockpitListenInfo>
  /** Closes the listener and force-closes keep-alive sockets. Idempotent. */
  close(): Promise<void>
}

/**
 * Start the cockpit, or return `null` when it is disabled.
 *
 * Configuration errors throw synchronously, *before* a server object exists:
 * an enabled cockpit with an invalid port or a non-loopback host must bind
 * nothing. Bind failures are asynchronous and surface through `ready`.
 */
export function startCockpitServer(options: StartCockpitOptions): CockpitHandle | null {
  const env = options.env ?? process.env
  const log = options.log ?? (() => {})
  const stderr = options.stderr ?? ((line: string) => void process.stderr.write(`${line}\n`))

  let config: CockpitConfig
  try {
    config = resolveCockpitConfig(env)
  } catch (error) {
    // D01 keeps this fatal. Make it visible on the operator's terminal as well:
    // `.pantheon/logs/hooks.log` is not where someone looks after `opencode`
    // exits immediately.
    if (error instanceof CockpitConfigError) {
      stderr(`pantheon: fatal cockpit configuration error [${error.code}]: ${error.message}`)
    }
    throw error
  }

  if (!config.enabled) {
    const reasons: string[] = []
    if (env.PANTHEON_COCKPIT_PORT !== undefined) {
      reasons.push('PANTHEON_COCKPIT_PORT is set but ignored while the cockpit is disabled')
    }
    const rawEnabled = env.PANTHEON_COCKPIT
    if (rawEnabled !== undefined && rawEnabled.trim() !== '1') {
      reasons.push(`PANTHEON_COCKPIT=${JSON.stringify(rawEnabled)} is not exactly "1"`)
    }
    log(reasons.length === 0 ? 'cockpit disabled' : `cockpit disabled: ${reasons.join('; ')}`)
    return null
  }

  const server = createServer(createRequestHandler(options.workspaceDir, config, log))
  server.on('clientError', (_error, socket) => {
    socket.end(
      'HTTP/1.1 400 Bad Request\r\nCache-Control: no-store\r\n' +
        'X-Content-Type-Options: nosniff\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
    )
  })

  const displayHost = config.host === '::1' ? '[::1]' : config.host
  const ready = new Promise<CockpitListenInfo>((resolve, reject) => {
    // Persistent listener with a state guard: `once('error')` would be consumed
    // by the first post-listen error, turning the second one into an uncaught
    // exception. Pre-listen errors reject `ready`; post-listen errors are logged.
    let settled = false
    server.on('error', (error: unknown) => {
      const described = hasCode(error, 'EADDRINUSE')
        ? new CockpitBindError(config.port, error)
        : error
      if (!settled) {
        settled = true
        reject(described)
        return
      }
      log(
        `cockpit error after listening: ${
          described instanceof Error ? described.message : String(described)
        }`,
      )
    })
    server.once('listening', () => {
      const address = server.address()
      const port = address !== null && typeof address === 'object' ? address.port : config.port
      const info: CockpitListenInfo = {
        host: config.host,
        port,
        url: `http://${displayHost}:${port}`,
      }
      settled = true
      log(`cockpit listening on ${info.url} (loopback only, GET/HEAD, read-only)`)
      try {
        options.onListening?.(info)
      } catch {
        /* a listener callback must never break the socket */
      }
      resolve(info)
    })
    server.listen(config.port, config.host)
  })

  // Never hold the process open on the cockpit's account.
  server.unref()

  let closing: Promise<void> | null = null
  const close = (): Promise<void> => {
    if (closing !== null) return closing
    closing = new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve()
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
      server.closeAllConnections()
    })
    return closing
  }

  return { server, config, ready, close }
}
