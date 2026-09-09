/**
 * Tests for B3-04 — compaction handoff coordinator.
 *
 * Required cases:
 * 1. Valid new key -> COMMITTED
 * 2. Same key/digest (idempotent replay) -> COMMITTED
 * 3. Same key/different digest -> CONFLICT
 * 4. Stale lease/version -> CONFLICT
 * 5. Invalid sessionId -> INVALID_INPUT
 * 6. Invalid idempotencyKey -> INVALID_INPUT
 * 7. Invalid lease token -> INVALID_INPUT
 * 8. Invalid version -> INVALID_INPUT
 * 9. Invalid digest -> INVALID_INPUT
 * 10. Payload too large -> INVALID_INPUT
 * 11. Payload with control chars -> INVALID_INPUT
 * 12. Memory unavailable -> UNAVAILABLE (no retry/fallback)
 */
import { strict as assert } from 'node:assert'

import {
  CompactionHandoffCoordinator,
  type HandoffRecord,
  type MemoryPort,
  type PersistencePort,
} from '../../src/pantheon/compaction-handoff.ts'

const SESSION_ID = 'ses_root'
const IDEMPOTENCY_KEY = 'idem_001'
const LEASE_TOKEN = 'test_dummy_fixture'
const VERSION = '1.2.3'
const DIGEST = 'a'.repeat(64)
const PAYLOAD = 'compact payload'

// ─── Harness ────────────────────────────────────────────────────────────

class MemoryAdapter implements MemoryPort {
  readonly records = new Map<string, HandoffRecord>()
  publishAttempts = 0
  failPublish = false

  async publish(key: string, record: HandoffRecord): Promise<boolean> {
    this.publishAttempts += 1
    if (this.failPublish) {
      throw new Error('memory unavailable')
    }
    if (this.records.has(key)) {
      return false
    }
    this.records.set(key, record)
    return true
  }

  async read(key: string): Promise<HandoffRecord | null> {
    return this.records.get(key) ?? null
  }
}

class PersistenceAdapter implements PersistencePort {
  readonly records = new Map<string, HandoffRecord>()
  loadFailures = 0

  async load(key: string): Promise<HandoffRecord | null> {
    if (this.loadFailures > 0) {
      this.loadFailures -= 1
      throw new Error('persistence unavailable')
    }
    return this.records.get(key) ?? null
  }

  async save(key: string, record: HandoffRecord): Promise<void> {
    this.records.set(key, record)
  }

  async delete(key: string): Promise<void> {
    this.records.delete(key)
  }
}

function makeCoordinator(
  memory: MemoryAdapter,
  persistence: PersistenceAdapter = new PersistenceAdapter(),
): CompactionHandoffCoordinator {
  return new CompactionHandoffCoordinator(persistence, memory)
}

async function run(
  coordinator: CompactionHandoffCoordinator,
  args: Parameters<CompactionHandoffCoordinator['prepare']>,
) {
  return await coordinator.prepare(...args)
}

async function main(): Promise<void> {
  // 1. Valid new key -> COMMITTED
  {
    const memory = new MemoryAdapter()
    const coordinator = makeCoordinator(memory)
    const result = await run(coordinator, [
      SESSION_ID,
      IDEMPOTENCY_KEY,
      LEASE_TOKEN,
      VERSION,
      DIGEST,
      PAYLOAD,
    ])
    assert.equal(result.status, 'COMMITTED')
    assert.equal(result.key, SESSION_ID)
    assert.equal(result.digest, DIGEST)
    assert.equal(memory.publishAttempts, 1)
    assert.ok(memory.records.has(SESSION_ID))
  }

  // 2. Same key/digest (idempotent replay) -> COMMITTED
  {
    const memory = new MemoryAdapter()
    const coordinator = makeCoordinator(memory)
    const args = [SESSION_ID, IDEMPOTENCY_KEY, LEASE_TOKEN, VERSION, DIGEST, PAYLOAD]
    assert.equal((await run(coordinator, args)).status, 'COMMITTED')
    const replay = await run(coordinator, args)
    assert.equal(replay.status, 'COMMITTED')
    assert.equal(memory.publishAttempts, 1, 'idempotent replay must not re-publish')
  }

  // 3. Same key/different digest -> CONFLICT
  {
    const memory = new MemoryAdapter()
    const coordinator = makeCoordinator(memory)
    const args = [SESSION_ID, IDEMPOTENCY_KEY, LEASE_TOKEN, VERSION, DIGEST, PAYLOAD]
    assert.equal((await run(coordinator, args)).status, 'COMMITTED')
    const conflict = await run(coordinator, [
      SESSION_ID,
      IDEMPOTENCY_KEY,
      LEASE_TOKEN,
      VERSION,
      'b'.repeat(64),
      PAYLOAD,
    ])
    assert.equal(conflict.status, 'CONFLICT')
    assert.equal(conflict.digest, 'b'.repeat(64))
  }

  // 4. Stale lease/version -> CONFLICT
  {
    const memory = new MemoryAdapter()
    const coordinator = makeCoordinator(memory)
    assert.equal(
      (await run(coordinator, [SESSION_ID, IDEMPOTENCY_KEY, LEASE_TOKEN, VERSION, DIGEST, PAYLOAD]))
        .status,
      'COMMITTED',
    )
    const stale = await run(coordinator, [
      SESSION_ID,
      IDEMPOTENCY_KEY,
      'v0.9.9_abcdefghijklmnopqrstuvwxyz0123456789',
      VERSION,
      DIGEST,
      PAYLOAD,
    ])
    assert.equal(stale.status, 'CONFLICT')
  }

  // 5. Invalid sessionId -> INVALID_INPUT
  {
    const memory = new MemoryAdapter()
    const coordinator = makeCoordinator(memory)
    const result = await run(coordinator, [
      '',
      IDEMPOTENCY_KEY,
      LEASE_TOKEN,
      VERSION,
      DIGEST,
      PAYLOAD,
    ])
    assert.equal(result.status, 'INVALID_INPUT')
    assert.equal(result.message, 'Invalid sessionId')
  }

  // 6. Invalid idempotencyKey -> INVALID_INPUT
  {
    const memory = new MemoryAdapter()
    const coordinator = makeCoordinator(memory)
    const result = await run(coordinator, [SESSION_ID, '', LEASE_TOKEN, VERSION, DIGEST, PAYLOAD])
    assert.equal(result.status, 'INVALID_INPUT')
    assert.equal(result.message, 'Invalid idempotencyKey')
  }

  // 7. Invalid lease token -> INVALID_INPUT
  {
    const memory = new MemoryAdapter()
    const coordinator = makeCoordinator(memory)
    const result = await run(coordinator, [
      SESSION_ID,
      IDEMPOTENCY_KEY,
      'short',
      VERSION,
      DIGEST,
      PAYLOAD,
    ])
    assert.equal(result.status, 'INVALID_INPUT')
    assert.equal(result.message, 'Invalid lease token')
  }

  // 8. Invalid version -> INVALID_INPUT
  {
    const memory = new MemoryAdapter()
    const coordinator = makeCoordinator(memory)
    const result = await run(coordinator, [
      SESSION_ID,
      IDEMPOTENCY_KEY,
      LEASE_TOKEN,
      'not-a-version',
      DIGEST,
      PAYLOAD,
    ])
    assert.equal(result.status, 'INVALID_INPUT')
    assert.equal(result.message, 'Invalid version')
  }

  // 9. Invalid digest -> INVALID_INPUT
  {
    const memory = new MemoryAdapter()
    const coordinator = makeCoordinator(memory)
    const result = await run(coordinator, [
      SESSION_ID,
      IDEMPOTENCY_KEY,
      LEASE_TOKEN,
      VERSION,
      'short',
      PAYLOAD,
    ])
    assert.equal(result.status, 'INVALID_INPUT')
    assert.equal(result.message, 'Invalid digest')
  }

  // 10. Payload too large -> INVALID_INPUT
  {
    const memory = new MemoryAdapter()
    const coordinator = makeCoordinator(memory)
    const result = await run(coordinator, [
      SESSION_ID,
      IDEMPOTENCY_KEY,
      LEASE_TOKEN,
      VERSION,
      DIGEST,
      'x'.repeat(64 * 1024 + 1),
    ])
    assert.equal(result.status, 'INVALID_INPUT')
    assert.equal(result.message, 'Payload too large')
  }

  // 11. Payload with control chars -> INVALID_INPUT
  {
    const memory = new MemoryAdapter()
    const coordinator = makeCoordinator(memory)
    const result = await run(coordinator, [
      SESSION_ID,
      IDEMPOTENCY_KEY,
      LEASE_TOKEN,
      VERSION,
      DIGEST,
      'bad\x00payload',
    ])
    assert.equal(result.status, 'INVALID_INPUT')
    assert.equal(result.message, 'Payload contains control characters')
  }

  // 12. Memory unavailable -> UNAVAILABLE (no retry/fallback)
  {
    const memory = new MemoryAdapter()
    memory.failPublish = true
    const coordinator = makeCoordinator(memory)
    const result = await run(coordinator, [
      SESSION_ID,
      IDEMPOTENCY_KEY,
      LEASE_TOKEN,
      VERSION,
      DIGEST,
      PAYLOAD,
    ])
    assert.equal(result.status, 'UNAVAILABLE')
    assert.equal(memory.publishAttempts, 1, 'must not retry publish')
    assert.equal(memory.records.size, 0, 'must leave the handoff PREPARED, not committed')
  }

  console.log('All 12 compaction handoff cases passed')
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
