/**
 * Compaction Handoff Coordinator Tests
 * Uses node:assert and node:test. Fakes for PersistencePort and MemoryPort
 * are provided inline.
 */

import assert from 'node:assert'
import { beforeEach, describe, it } from 'node:test'
import {
  CompactionHandoffCoordinator,
  type HandoffRecord,
  MAX_PAYLOAD_BYTES,
  MAX_SAFE_INTEGER,
  type MemoryPort,
  type PersistencePort,
} from '../../src/pantheon/compaction-handoff'

/** Fake PersistencePort that stores records in a Map. */
class FakePersistence implements PersistencePort {
  private records = new Map<string, HandoffRecord>()

  async prepare(input: HandoffRecord): Promise<void> {
    this.records.set(input.sessionId, input)
  }

  async read(sessionId: string, _key: string): Promise<HandoffRecord | null> {
    const record = this.records.get(sessionId)
    return record ?? null
  }

  async commit(sessionId: string, _key: string, record: HandoffRecord): Promise<void> {
    this.records.set(sessionId, record)
  }
}

/** Fake MemoryPort that stores records in a Map. */
class FakeMemory implements MemoryPort {
  private records = new Map<string, HandoffRecord>()

  async publishImmutable(_sessionId: string, key: string, record: HandoffRecord): Promise<void> {
    this.records.set(key, record)
  }

  async readByIdempotencyKey(key: string): Promise<HandoffRecord | null> {
    const record = this.records.get(key)
    return record ?? null
  }
}

/** MemoryPort that always throws on operations. */
class UnavailableMemory implements MemoryPort {
  async publishImmutable(_sessionId: string, _key: string, _record: HandoffRecord): Promise<void> {
    throw new Error('Memory unavailable')
  }

  async readByIdempotencyKey(_key: string): Promise<HandoffRecord | null> {
    throw new Error('Memory unavailable')
  }
}

/**
 * MemoryPort that always throws on every operation (never recovers). */
class PermanentlyUnavailableMemory implements MemoryPort {
  async publishImmutable(_sessionId: string, _key: string, _record: HandoffRecord): Promise<void> {
    throw new Error('Memory permanently unavailable')
  }
  async readByIdempotencyKey(_key: string): Promise<HandoffRecord | null> {
    throw new Error('Memory permanently unavailable')
  }
}

/**
 * MemoryPort that throws on first publish, then succeeds. */
class CrashMemory implements MemoryPort {
  private publishCount = 0

  async publishImmutable(_sessionId: string, _key: string, _record: HandoffRecord): Promise<void> {
    this.publishCount++
    if (this.publishCount === 1) {
      throw new Error('Simulated crash')
    }
  }

  async readByIdempotencyKey(_key: string): Promise<HandoffRecord | null> {
    // Return a record only after the second publish attempt
    if (this.publishCount >= 2) {
      return {
        digest: 'a'.repeat(64),
        payload: 'data',
        sessionId: 'session-11',
        leaseToken: 'lease-11',
        version: 42,
      }
    }
    return null
  }
}

describe('CompactionHandoffCoordinator', () => {
  let persistence: PersistencePort
  let memory: MemoryPort
  let coordinator: CompactionHandoffCoordinator

  beforeEach(() => {
    persistence = new FakePersistence()
    memory = new FakeMemory()
    coordinator = new CompactionHandoffCoordinator(persistence, memory)
  })

  describe('validation', () => {
    it('rejects INVALID_INPUT when sessionId is empty', async () => {
      const result = await coordinator.prepare('', 'key', 'token', 1, 'd'.repeat(64), 'payload')
      assert.strictEqual(result.status, 'INVALID_INPUT')
    })

    it('rejects INVALID_INPUT when sessionId has control char', async () => {
      const result = await coordinator.prepare(
        's\x01ession',
        'key',
        'token',
        1,
        'd'.repeat(64),
        'payload',
      )
      assert.strictEqual(result.status, 'INVALID_INPUT')
    })

    it('rejects INVALID_INPUT when sessionId exceeds max length', async () => {
      const result = await coordinator.prepare(
        'a'.repeat(129),
        'key',
        'token',
        1,
        'd'.repeat(64),
        'payload',
      )
      assert.strictEqual(result.status, 'INVALID_INPUT')
    })

    it('rejects INVALID_INPUT when idempotencyKey is empty', async () => {
      const result = await coordinator.prepare('session', '', 'token', 1, 'd'.repeat(64), 'payload')
      assert.strictEqual(result.status, 'INVALID_INPUT')
    })

    it('rejects INVALID_INPUT when idempotencyKey has control char', async () => {
      const result = await coordinator.prepare(
        'session',
        'k\x01ey',
        'token',
        1,
        'd'.repeat(64),
        'payload',
      )
      assert.strictEqual(result.status, 'INVALID_INPUT')
    })

    it('rejects INVALID_INPUT when idempotencyKey exceeds max length', async () => {
      const result = await coordinator.prepare(
        'session',
        'a'.repeat(129),
        'token',
        1,
        'd'.repeat(64),
        'payload',
      )
      assert.strictEqual(result.status, 'INVALID_INPUT')
    })

    it('rejects INVALID_INPUT when leaseToken is empty', async () => {
      const result = await coordinator.prepare('session', 'key', '', 1, 'd'.repeat(64), 'payload')
      assert.strictEqual(result.status, 'INVALID_INPUT')
    })

    it('rejects INVALID_INPUT when leaseToken has control char', async () => {
      const result = await coordinator.prepare(
        'session',
        'key',
        't\x01oken',
        1,
        'd'.repeat(64),
        'payload',
      )
      assert.strictEqual(result.status, 'INVALID_INPUT')
    })

    it('rejects INVALID_INPUT when leaseToken exceeds max length', async () => {
      const result = await coordinator.prepare(
        'session',
        'key',
        'a'.repeat(129),
        1,
        'd'.repeat(64),
        'payload',
      )
      assert.strictEqual(result.status, 'INVALID_INPUT')
    })

    it('rejects INVALID_INPUT when version <= 0', async () => {
      const result = await coordinator.prepare(
        'session',
        'key',
        'token',
        0,
        'd'.repeat(64),
        'payload',
      )
      assert.strictEqual(result.status, 'INVALID_INPUT')
    })

    it('rejects INVALID_INPUT when version > MAX_SAFE_INTEGER', async () => {
      const result = await coordinator.prepare(
        'session',
        'key',
        'token',
        MAX_SAFE_INTEGER + 1,
        'd'.repeat(64),
        'payload',
      )
      assert.strictEqual(result.status, 'INVALID_INPUT')
    })

    it('rejects INVALID_INPUT when version is not integer', async () => {
      const result = await coordinator.prepare(
        'session',
        'key',
        'token',
        1.5,
        'd'.repeat(64),
        'payload',
      )
      assert.strictEqual(result.status, 'INVALID_INPUT')
    })

    it('rejects INVALID_INPUT when digest is not 64 chars', async () => {
      const result = await coordinator.prepare(
        'session',
        'key',
        'token',
        1,
        'd'.repeat(63),
        'payload',
      )
      assert.strictEqual(result.status, 'INVALID_INPUT')
    })

    it('rejects INVALID_INPUT when digest is 65 chars', async () => {
      const result = await coordinator.prepare(
        'session',
        'key',
        'token',
        1,
        'd'.repeat(65),
        'payload',
      )
      assert.strictEqual(result.status, 'INVALID_INPUT')
    })

    it('rejects INVALID_INPUT when digest has uppercase', async () => {
      const result = await coordinator.prepare(
        'session',
        'key',
        'token',
        1,
        'D'.repeat(64),
        'payload',
      )
      assert.strictEqual(result.status, 'INVALID_INPUT')
    })

    it('rejects INVALID_INPUT when digest has non-hex char', async () => {
      const result = await coordinator.prepare(
        'session',
        'key',
        'token',
        1,
        'g'.repeat(64),
        'payload',
      )
      assert.strictEqual(result.status, 'INVALID_INPUT')
    })

    it('rejects INVALID_INPUT when payload has NUL', async () => {
      const result = await coordinator.prepare(
        'session',
        'key',
        'token',
        1,
        'd'.repeat(64),
        'p\x00ayload',
      )
      assert.strictEqual(result.status, 'INVALID_INPUT')
    })

    it('rejects INVALID_INPUT when payload exceeds limit', async () => {
      const result = await coordinator.prepare(
        'session',
        'key',
        'token',
        1,
        'd'.repeat(64),
        'a'.repeat(MAX_PAYLOAD_BYTES + 1),
      )
      assert.strictEqual(result.status, 'INVALID_INPUT')
    })

    it('accepts payload at exact limit', async () => {
      const result = await coordinator.prepare(
        'session',
        'key',
        'token',
        1,
        'd'.repeat(64),
        'a'.repeat(MAX_PAYLOAD_BYTES),
      )
      assert.strictEqual(result.status, 'COMMITTED')
    })

    it('accepts multibyte UTF-8 payload', async () => {
      const result = await coordinator.prepare(
        'session',
        'key',
        'token',
        1,
        'd'.repeat(64),
        '🚀🌟✨',
      )
      assert.strictEqual(result.status, 'COMMITTED')
    })
  })

  describe('happy path', () => {
    it('returns COMMITTED for valid new key', async () => {
      const result = await coordinator.prepare(
        'session-1',
        'key-1',
        'token-1',
        1,
        'd'.repeat(64),
        'payload-1',
      )
      assert.strictEqual(result.status, 'COMMITTED')
      assert.strictEqual(result.digest, 'd'.repeat(64))
    })

    it('returns COMMITTED for same key/digest replay (idempotent)', async () => {
      // First call
      await coordinator.prepare('session-1', 'key-1', 'token-1', 1, 'd'.repeat(64), 'payload-1')

      // Second call with same inputs
      const result = await coordinator.prepare(
        'session-1',
        'key-1',
        'token-1',
        1,
        'd'.repeat(64),
        'payload-1',
      )
      assert.strictEqual(result.status, 'COMMITTED')
      assert.strictEqual(result.digest, 'd'.repeat(64))
    })
  })

  describe('conflicts', () => {
    it('returns CONFLICT for same key/different digest', async () => {
      // First call
      await coordinator.prepare('session-1', 'key-1', 'token-1', 1, 'd'.repeat(64), 'payload-1')

      // Second call with same key but different digest
      const result = await coordinator.prepare(
        'session-1',
        'key-1',
        'token-1',
        1,
        'e'.repeat(64),
        'payload-1',
      )
      assert.strictEqual(result.status, 'CONFLICT')
    })

    it('returns CONFLICT for stale lease', async () => {
      // First call
      await coordinator.prepare('session-1', 'key-1', 'token-1', 1, 'd'.repeat(64), 'payload-1')

      // Second call with same key/digest but different lease
      const result = await coordinator.prepare(
        'session-1',
        'key-1',
        'token-2',
        1,
        'd'.repeat(64),
        'payload-1',
      )
      assert.strictEqual(result.status, 'CONFLICT')
    })

    it('returns CONFLICT for stale version', async () => {
      // First call
      await coordinator.prepare('session-1', 'key-1', 'token-1', 1, 'd'.repeat(64), 'payload-1')

      // Second call with same key/digest/lease but different version
      const result = await coordinator.prepare(
        'session-1',
        'key-1',
        'token-1',
        2,
        'd'.repeat(64),
        'payload-1',
      )
      assert.strictEqual(result.status, 'CONFLICT')
    })

    it('returns CONFLICT for memory publish twice different digest', async () => {
      const crashMemory = new CrashMemory()
      const coordinatorCrash = new CompactionHandoffCoordinator(persistence, crashMemory)

      // First publish succeeds (after crash)
      await coordinatorCrash.prepare(
        'session-11',
        'idem-key-11',
        'lease-11',
        42,
        'a'.repeat(64),
        'data',
      )

      // Second publish with different digest should conflict
      const result = await coordinatorCrash.prepare(
        'session-11',
        'idem-key-11',
        'lease-11',
        42,
        'b'.repeat(64),
        'data',
      )
      assert.strictEqual(result.status, 'CONFLICT')
    })
  })

  describe('unavailable', () => {
    it('returns UNAVAILABLE when memory port throws', async () => {
      const unavailableMemory = new UnavailableMemory()
      const coordinatorUnavailable = new CompactionHandoffCoordinator(
        persistence,
        unavailableMemory,
      )

      const result = await coordinatorUnavailable.prepare(
        'session',
        'key',
        'token',
        1,
        'd'.repeat(64),
        'payload',
      )
      assert.strictEqual(result.status, 'UNAVAILABLE')
    })

    it('does not retry after memory becomes unavailable', async () => {
      const permanentlyUnavailable = new PermanentlyUnavailableMemory()
      const coordinatorCrash = new CompactionHandoffCoordinator(persistence, permanentlyUnavailable)

      // First call fails
      let result = await coordinatorCrash.prepare(
        'session-11',
        'idem-key-11',
        'lease-11',
        42,
        'd'.repeat(64),
        'data',
      )
      assert.strictEqual(result.status, 'UNAVAILABLE')

      // Second call should still return UNAVAILABLE (no retry)
      result = await coordinatorCrash.prepare(
        'session-11',
        'idem-key-11',
        'lease-11',
        42,
        'd'.repeat(64),
        'data',
      )
      assert.strictEqual(result.status, 'UNAVAILABLE')
    })

    it('returns COMMITTED on explicit replay after crash', async () => {
      const crashMemory = new CrashMemory()
      const coordinatorCrash = new CompactionHandoffCoordinator(persistence, crashMemory)

      // First call fails (simulated crash)
      let result = await coordinatorCrash.prepare(
        'session-11',
        'idem-key-11',
        'lease-11',
        42,
        'd'.repeat(64),
        'data',
      )
      assert.strictEqual(result.status, 'UNAVAILABLE')

      // Second call succeeds (memory now available)
      result = await coordinatorCrash.prepare(
        'session-11',
        'idem-key-11',
        'lease-11',
        42,
        'd'.repeat(64),
        'data',
      )
      assert.strictEqual(result.status, 'COMMITTED')
    })
  })

  describe('missing ports', () => {
    it('returns NOT_SUPPORTED when persistence port missing', async () => {
      const coordinatorNoPersistence = new CompactionHandoffCoordinator(undefined, memory)
      const result = await coordinatorNoPersistence.prepare(
        'session',
        'key',
        'token',
        1,
        'd'.repeat(64),
        'payload',
      )
      assert.strictEqual(result.status, 'NOT_SUPPORTED')
    })

    it('returns NOT_SUPPORTED when memory port missing', async () => {
      const coordinatorNoMemory = new CompactionHandoffCoordinator(persistence, undefined)
      const result = await coordinatorNoMemory.prepare(
        'session',
        'key',
        'token',
        1,
        'd'.repeat(64),
        'payload',
      )
      assert.strictEqual(result.status, 'NOT_SUPPORTED')
    })

    it('returns NOT_SUPPORTED when both ports missing', async () => {
      const coordinatorNoPorts = new CompactionHandoffCoordinator(undefined, undefined)
      const result = await coordinatorNoPorts.prepare(
        'session',
        'key',
        'token',
        1,
        'd'.repeat(64),
        'payload',
      )
      assert.strictEqual(result.status, 'NOT_SUPPORTED')
    })
  })
})
