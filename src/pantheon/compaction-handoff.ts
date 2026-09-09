/**
 * Compaction handoff coordinator.
 *
 * Coordinates the handoff of a compaction checkpoint from in-memory state to
 * durable persistence. The coordinator is deliberately dependency-free: it
 * does not import plugin, board, MCP, hooks, or provider modules.
 */

export interface HandoffRecord {
  digest: string
  payload: string
  version: number
  sessionId: string
  leaseToken: string
}

export interface PersistencePort {
  prepare(input: HandoffRecord): Promise<void>
  read(sessionId: string, key: string): Promise<HandoffRecord | null>
  commit(sessionId: string, key: string, record: HandoffRecord): Promise<void>
}

export interface MemoryPort {
  publishImmutable(sessionId: string, key: string, record: HandoffRecord): Promise<void>
  readByIdempotencyKey(key: string): Promise<HandoffRecord | null>
}

export type HandoffStatus =
  | 'COMMITTED'
  | 'UNAVAILABLE'
  | 'CONFLICT'
  | 'NOT_SUPPORTED'
  | 'INVALID_INPUT'

/** Maximum allowed integer version value. */
export const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER

/** Maximum encoded payload size in bytes (128 KiB). */
export const MAX_PAYLOAD_BYTES = 65_536

/** Maximum length of URL-safe identifiers. */
export const MAX_ID_LENGTH = 128

const URL_SAFE_PATTERN = /^[A-Za-z0-9._~-]+$/
const DIGEST_PATTERN = /^[a-f0-9]{64}$/

/** Validate a URL-safe identifier: 1-128 chars, no control characters. */
function isValidIdentifier(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }
  if (value.length < 1 || value.length > MAX_ID_LENGTH) {
    return false
  }
  if (value.length > 0 && !URL_SAFE_PATTERN.test(value)) {
    return false
  }
  return true
}

/** Validate a lease token: 1-128 chars, no control characters. */
function isValidLeaseToken(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }
  if (value.length < 1 || value.length > MAX_ID_LENGTH) {
    return false
  }
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) {
      return false
    }
  }
  return true
}

/** Validate a positive integer version within the safe integer range. */
function isValidVersion(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_SAFE_INTEGER
  )
}

/** Validate a 64-character lowercase hex digest. */
function isValidDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_PATTERN.test(value)
}

/**
 * Validate that a payload is UTF-8 encodable and contains no NUL or control
 * characters (tab, LF, and CR are permitted).
 */
function isValidPayload(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }
  if (value.length < 1 || value.length > MAX_PAYLOAD_BYTES) {
    return false
  }

  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes < 1 || bytes > MAX_PAYLOAD_BYTES) {
    return false
  }
  if (value.includes('\0')) {
    return false
  }

  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return false
    }
  }
  return true
}

/**
 * Compute the digest over the exact UTF-8 encoded bytes of a payload.
 */
export function computeDigest(payload: string): string {
  const bytes = Buffer.from(payload, 'utf8')
  let hash = ''
  for (const byte of bytes) {
    hash += byte.toString(16).padStart(2, '0')
  }
  return hash
}

/** Create a result describing a failed validation. */
function invalid(message: string): { status: 'INVALID_INPUT'; message: string } {
  return { status: 'INVALID_INPUT', message }
}

/** Create a result describing a missing dependency. */
function notSupported(): { status: 'NOT_SUPPORTED' } {
  return { status: 'NOT_SUPPORTED' }
}

/** Create a result describing a conflict. */
function conflict(message: string): { status: 'CONFLICT'; message: string } {
  return { status: 'CONFLICT', message }
}

/** Create a result describing an unavailable memory port. */
function unavailable(message: string): { status: 'UNAVAILABLE'; message: string } {
  return { status: 'UNAVAILABLE', message }
}

/** Create a successful committed result. */
function committed(digest: string): { status: 'COMMITTED'; digest: string } {
  return { status: 'COMMITTED', digest }
}

/**
 * Compaction handoff coordinator.
 *
 * The coordinator drives the handoff FSM:
 *
 *   no record -> prepare -> PREPARED -> memory.publishImmutable
 *   -> memory.readByIdempotencyKey -> persistence.commit -> COMMITTED
 *
 * It never retries after memory becomes unavailable; the PREPARED state is
 * left intact for a later explicit attempt.
 */
export class CompactionHandoffCoordinator {
  private readonly persistence: PersistencePort | undefined
  private readonly memory: MemoryPort | undefined

  constructor(persistence?: PersistencePort, memory?: MemoryPort) {
    this.persistence = persistence
    this.memory = memory
  }

  /**
   * Attempt to hand off a compaction checkpoint.
   *
   * Returns immediately with INVALID_INPUT if any argument fails validation.
   * Returns NOT_SUPPORTED if either required port is missing.
   * Returns CONFLICT for digest or lease/version mismatches.
   * Returns UNAVAILABLE if the memory port cannot publish/read the record.
   * Returns COMMITTED when the record is durably committed.
   */
  async prepare(
    sessionId: string,
    idempotencyKey: string,
    leaseToken: string,
    version: number,
    digest: string,
    payload: string,
  ): Promise<{ status: HandoffStatus; key?: string; digest?: string; message?: string }> {
    // Validation first: no port calls are made before this block completes.
    if (
      !isValidIdentifier(sessionId) ||
      !isValidIdentifier(idempotencyKey) ||
      !isValidLeaseToken(leaseToken) ||
      !isValidVersion(version) ||
      !isValidDigest(digest) ||
      !isValidPayload(payload)
    ) {
      return invalid('Invalid handoff input')
    }

    if (this.persistence === undefined || this.memory === undefined) {
      return notSupported()
    }

    const _key = `${sessionId}:${idempotencyKey}`

    // Check for an existing committed record before preparing a new one.
    const existingRecord = await this.persistence.read(sessionId, idempotencyKey)
    if (existingRecord !== null) {
      if (existingRecord.digest === digest && existingRecord.sessionId === sessionId) {
        // Idempotent replay: same digest and session. Verify lease/version match.
        if (existingRecord.leaseToken !== leaseToken || existingRecord.version !== version) {
          return conflict('Stale lease or version')
        }

        // Verify the record is also in memory. If missing, try to recover by publishing once.
        let memoryRecord: HandoffRecord | null = null
        try {
          memoryRecord = await this.memory.readByIdempotencyKey(idempotencyKey)
        } catch {
          return unavailable('Memory port unavailable')
        }

        if (memoryRecord === null) {
          // Recovery: memory lost the record but persistence has it. Publish once.
          try {
            await this.memory.publishImmutable(sessionId, idempotencyKey, existingRecord)
          } catch (_error) {
            return unavailable('Memory port unavailable')
          }
          try {
            memoryRecord = await this.memory.readByIdempotencyKey(idempotencyKey)
          } catch (_error) {
            return unavailable('Memory port unavailable')
          }
        }

        if (memoryRecord === null) {
          return unavailable('Record not found in memory')
        }

        await this.persistence.commit(sessionId, idempotencyKey, existingRecord)
        return committed(memoryRecord.digest)
      }
      // Different digest or session: conflict.
      return conflict('Digest or session mismatch')
    }

    // Phase 1: prepare in persistence (PREPARED).
    await this.persistence.prepare({ digest, payload, version, sessionId, leaseToken })

    // Phase 2: publish the record to memory. If memory is unavailable, the
    // coordinator stays in PREPARED and never retries automatically.
    try {
      await this.memory.publishImmutable(sessionId, idempotencyKey, {
        digest,
        payload,
        version,
        sessionId,
        leaseToken,
      })
    } catch (_error) {
      return unavailable('Memory port unavailable')
    }

    // Phase 3: read back from memory by idempotency key.
    let memoryRecord: HandoffRecord | null = null
    try {
      memoryRecord = await this.memory.readByIdempotencyKey(idempotencyKey)
    } catch (_error) {
      return unavailable('Memory port unavailable')
    }

    if (memoryRecord === null) {
      return unavailable('Record not found in memory')
    }

    // Stale lease or version check.
    if (memoryRecord.leaseToken !== leaseToken || memoryRecord.version !== version) {
      return conflict('Stale lease or version')
    }

    // Idempotent replay: same key and session is a success.
    // The memory record is authoritative for recovery after crash.
    if (memoryRecord.sessionId === sessionId) {
      // Phase 4: commit to persistence.
      try {
        await this.persistence.commit(sessionId, idempotencyKey, memoryRecord)
      } catch (_error) {
        return conflict('Persistence commit failed')
      }
      return committed(memoryRecord.digest)
    }

    // Same key, different digest or session: conflict.
    return conflict('Digest or session mismatch')
  }
}

export default CompactionHandoffCoordinator
