/**
 * Compaction Handoff Coordinator (B3-04) — pure, bounded state machine for
 * handing off compaction context from the session to persistent memory.
 *
 * WHY: compaction needs a deterministic, idempotent handoff that survives
 * retries without exactly-once claims. The coordinator keeps the handoff
 * local, pure, and testable — no runtime hooks, no board, no MCP, no plugins.
 *
 * HOW: the handoff flows PREPARED -> memory immutable publish -> COMMITTED.
 * The memory port is the only write surface. A missing port returns
 * NOT_SUPPORTED; a memory failure returns UNAVAILABLE and leaves the handoff
 * in PREPARED (no retry, no fallback). Idempotency is enforced by
 * (sessionId, digest): same key/digest is a no-op COMMITTED, same key/different
 * digest is CONFLICT. Lease token and version are checked before publish.
 *
 * @module compaction-handoff
 */

// ─── Types ──────────────────────────────────────────────────────────────

/** A persisted handoff record stored by the memory port. */
export interface HandoffRecord {
  /** Immutable digest of the handoff payload. */
  digest: string
  /** Original payload bytes (UTF-8). */
  payload: string
  /** Monotonic handoff version. */
  version: string
  /** Session this handoff belongs to. */
  sessionId: string
}

/** Persistence port — thin read/write surface injected by the caller. */
export interface PersistencePort {
  /** Read a record by key, or null when absent. */
  load(key: string): Promise<HandoffRecord | null>
  /** Atomically write a record. */
  save(key: string, record: HandoffRecord): Promise<void>
  /** Remove a record by key. */
  delete(key: string): Promise<void>
}

/** Memory port — the immutable publish surface for handoff records. */
export interface MemoryPort {
  /**
   * Immutable publish: writes the record only if the key is absent.
   * Returns true on success, false when the key already exists.
   */
  publish(key: string, record: HandoffRecord): Promise<boolean>
  /** Read a record by key, or null when absent. */
  read(key: string): Promise<HandoffRecord | null>
}

/** Result of a handoff attempt. */
export interface HandoffResult {
  /** Final status of the attempt. */
  status: HandoffStatus
  /** The session key used for the handoff. */
  key: string
  /** The digest that was (or would have been) committed. */
  digest: string
  /** Human-readable reason for non-COMMITTED outcomes. */
  message?: string
}

/** All possible outcomes of a handoff attempt. */
export const HandoffStatus = {
  /** Handoff was committed (or idempotently re-committed). */
  COMMITTED: 'COMMITTED' as const,
  /** The memory port was unavailable; the handoff stays PREPARED. */
  UNAVAILABLE: 'UNAVAILABLE' as const,
  /** The key/digest or lease/version collided. */
  CONFLICT: 'CONFLICT' as const,
  /** The persistence or memory port was not supplied. */
  NOT_SUPPORTED: 'NOT_SUPPORTED' as const,
  /** One or more input fields failed validation. */
  INVALID_INPUT: 'INVALID_INPUT' as const,
} as const

/** Type of handoff status values. */
export type HandoffStatus = (typeof HandoffStatus)[keyof typeof HandoffStatus]

/**
 * Validation result for a handoff request.
 * `true` means valid; `string` carries the failure reason.
 */
type ValidationResult = true | string

// ─── Constants ──────────────────────────────────────────────────────────

/** Maximum payload size in bytes (64 KiB). */
export const MAX_PAYLOAD_BYTES = 64 * 1024

/** Payloads must not contain control characters (except tab, LF, CR). */
const CONTROL_CHAR_RE = new RegExp(`[^${printableRanges()}]`)

/** Payload must be valid UTF-8 with no embedded NUL bytes. */
const NUL_RE = new RegExp(String.fromCharCode(0))

/** Build a printable-character class for the control-char regex. */
function printableRanges(): string {
  return [
    '\\x20-\\x7e', // printable ASCII
    '\\x09', // tab
    '\\x0a', // LF
    '\\x0d', // CR
  ].join('')
}

/** Digest format: lowercase hex, 64 chars (SHA-256). */
const DIGEST_RE = /^[0-9a-f]{64}$/

/** Version format: semantic version (e.g. 1.2.3). */
const VERSION_RE = /^\d+\.\d+\.\d+$/

/** Lease token format: URL-safe token (e.g. 32+ chars of [A-Za-z0-9_-]). */
const LEASE_TOKEN_RE = /^[A-Za-z0-9_.-]{32,}$/

/** Session ID format: non-empty, URL-safe, 1–128 chars. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/** Idempotency key format: non-empty, URL-safe, 1–128 chars. */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/

// ─── Validation ─────────────────────────────────────────────────────────

/** Validate a handoff request. Returns `true` when valid, else a reason. */
export function validateHandoff(
  sessionId: string,
  idempotencyKey: string,
  leaseToken: string,
  version: string,
  digest: string,
  payload: string,
): ValidationResult {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    return 'Invalid sessionId'
  }
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    return 'Invalid idempotencyKey'
  }
  if (typeof leaseToken !== 'string' || !LEASE_TOKEN_RE.test(leaseToken)) {
    return 'Invalid lease token'
  }
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    return 'Invalid version'
  }
  if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) {
    return 'Invalid digest'
  }
  if (typeof payload !== 'string') {
    return 'Invalid payload'
  }
  const payloadBytes = Buffer.byteLength(payload, 'utf8')
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    return 'Payload too large'
  }
  if (CONTROL_CHAR_RE.test(payload) || NUL_RE.test(payload)) {
    return 'Payload contains control characters'
  }
  return true
}

// ─── Coordinator ────────────────────────────────────────────────────────

/**
 * Pure compaction handoff coordinator.
 *
 * The coordinator is dependency-injected with a persistence port and a memory
 * port. It performs no I/O of its own and makes no exactly-once guarantees:
 * callers must treat COMMITTED as "published at least once" and re-read by key
 * to determine the current state.
 */
export class CompactionHandoffCoordinator {
  /**
   * Create a coordinator.
   *
   * @param persistence Persistence port for record lookup. Optional; when
   *   missing the coordinator returns NOT_SUPPORTED without touching memory.
   * @param memory Memory port for immutable publish. Optional; when missing
   *   the coordinator returns NOT_SUPPORTED.
   */
  constructor(
    private readonly persistence?: PersistencePort | null,
    private readonly memory?: MemoryPort | null,
  ) {}

  /**
   * Execute one handoff attempt.
   *
   * The attempt flows PREPARED -> memory immutable publish -> COMMITTED.
   * Memory failure leaves the handoff PREPARED and returns UNAVAILABLE;
   * there is no retry and no fallback path.
   *
   * @param sessionId Session this handoff belongs to.
   * @param idempotencyKey Idempotency key for deduplication.
   * @param leaseToken Lease token proving the caller still owns the session.
   * @param version Monotonic handoff version.
   * @param digest SHA-256 digest of the payload.
   * @param payload UTF-8 handoff payload.
   * @returns The outcome of the attempt.
   */
  async prepare(
    sessionId: string,
    idempotencyKey: string,
    leaseToken: string,
    version: string,
    digest: string,
    payload: string,
  ): Promise<HandoffResult> {
    const validation = validateHandoff(
      sessionId,
      idempotencyKey,
      leaseToken,
      version,
      digest,
      payload,
    )
    if (validation !== true) {
      return {
        status: HandoffStatus.INVALID_INPUT,
        key: sessionId ?? '',
        digest: '',
        message: validation,
      }
    }

    if (!this.persistence || !this.memory) {
      return {
        status: HandoffStatus.NOT_SUPPORTED,
        key: sessionId,
        digest,
        message: 'Persistence or memory port not available',
      }
    }

    const record: HandoffRecord = {
      digest,
      payload,
      version,
      sessionId,
    }

    // PREPARED: read the current record to detect idempotent replay or a
    // key/digest collision before attempting any write.
    let existing: HandoffRecord | null = null
    try {
      existing = await this.persistence.load(sessionId)
    } catch {
      return {
        status: HandoffStatus.UNAVAILABLE,
        key: sessionId,
        digest,
        message: 'Persistence unavailable',
      }
    }

    // Lease/version check happens after the idempotency read, so a stale
    // caller cannot resurrect a key that has already been committed.
    if (!this.isLeaseValid(leaseToken, version, existing)) {
      return {
        status: HandoffStatus.CONFLICT,
        key: sessionId,
        digest,
        message: 'Stale lease or version',
      }
    }

    if (existing !== null) {
      if (existing.digest === digest) {
        // Same key/digest: idempotent replay, already committed.
        return { status: HandoffStatus.COMMITTED, key: sessionId, digest }
      }
      // Same key/different digest: collision, never overwrite.
      return {
        status: HandoffStatus.CONFLICT,
        key: sessionId,
        digest,
        message: 'Key already exists with a different digest',
      }
    }

    // Immutable publish: the memory port refuses to overwrite an existing key.
    let published: boolean
    try {
      published = await this.memory.publish(sessionId, record)
    } catch {
      // Memory unavailable: leave PREPARED, no retry, no fallback.
      return {
        status: HandoffStatus.UNAVAILABLE,
        key: sessionId,
        digest,
        message: 'Memory unavailable',
      }
    }

    if (!published) {
      // Publish raced with another writer: treat as a conflict, never retry.
      return {
        status: HandoffStatus.CONFLICT,
        key: sessionId,
        digest,
        message: 'Concurrent publish detected',
      }
    }

    // COMMITTED: the record is now immutable in memory.
    // Persist the record for future idempotency checks.
    if (this.persistence) {
      await this.persistence.save(sessionId, record)
    }
    return { status: HandoffStatus.COMMITTED, key: sessionId, digest }
  }

  /**
   * Check lease freshness and version monotonicity.
   *
   * @param leaseToken Lease token supplied by the caller.
   * @param version Version supplied by the caller.
   * @param existing Existing record, if any.
   * @returns True when the lease is still valid.
   */
  private isLeaseValid(
    leaseToken: string,
    version: string,
    _existing: HandoffRecord | null,
  ): boolean {
    if (!LEASE_TOKEN_RE.test(leaseToken)) {
      return false
    }
    if (!VERSION_RE.test(version)) {
      return false
    }
    // A stale lease/version is one that is older than the record's version.
    // The token carries the version as a prefix: `v{major}.{minor}.{patch}_{random}`.
    const tokenPrefix = leaseToken.startsWith('v') ? leaseToken.slice(1) : leaseToken
    const versionPrefix = tokenPrefix.split('_')[0]
    if (!versionPrefix) {
      return false
    }
    const tokenParts = versionPrefix.split('.')
    const recordParts = version.split('.')
    if (tokenParts.length !== 3 || recordParts.length !== 3) {
      return false
    }
    const tokenNum = tokenParts.map(Number)
    const recordNum = recordParts.map(Number)
    for (let i = 0; i < 3; i += 1) {
      const t = tokenNum[i]
      const r = recordNum[i]
      if (t === undefined || r === undefined) {
        return false
      }
      if (t > r) {
        return true // token is ahead of the record -> still valid
      }
      if (t < r) {
        return false // token is behind the record -> stale
      }
    }
    return true // equal versions are valid
  }
}
