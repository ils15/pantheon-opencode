/**
 * Premise register — PM-03…PM-15 plus PRE-01/PRE-02, referenced by id from the
 * registry. The canonical text lives in `STATUS.md` § Premissas; this file
 * keeps the ids and their blocking targets close to the audit that checks them.
 */

export interface PremiseEntry {
  readonly id: string
  readonly statement: string
  readonly blocks: string
}

/** PM-03…PM-15 plus PRE-01/PRE-02, referenced by id from the registry. */
export const PREMISE_REGISTER: readonly PremiseEntry[] = Object.freeze([
  Object.freeze({
    id: 'PRE-01',
    statement:
      'P7 by event was a premise with a negative signal until the channel form was measured',
    blocks: 'P7 / Phase 4 (C7)',
  }),
  Object.freeze({
    id: 'PRE-02',
    statement:
      'prompt.skills absent makes filterSkills a no-op; P2 does not filter on the default path',
    blocks: 'P1/P2 activation (C6)',
  }),
  Object.freeze({
    id: 'PM-03',
    statement: 'Origin of the Phase 0a carrier divergence is a hypothesis (2.1.4 session.id)',
    blocks: 'nothing — historical record',
  }),
  Object.freeze({
    id: 'PM-04',
    statement: 'reason:"overflow" and child-session compaction were never exercised',
    blocks: 'P9 / Phase 3 (C9)',
  }),
  Object.freeze({
    id: 'PM-05',
    statement:
      'Exclusivity of the system channel is unproven; the messages mode was never exercised',
    blocks: 'P9 / Phase 3',
  }),
  Object.freeze({
    id: 'PM-06',
    statement: 'Skill/tool/agent catalogs were not measured with Pantheon installed',
    blocks: 'P2a / P11',
  }),
  Object.freeze({
    id: 'PM-07',
    statement: 'Populated prompt.skills / prompt.agents were never observed',
    blocks: 'P1/P2b activation (C6)',
  }),
  Object.freeze({
    id: 'PM-08',
    statement: 'ctx.model / ctx.provider were never exercised as a catalog source',
    blocks: 'P11 / Phase 6',
  }),
  Object.freeze({
    id: 'PM-09',
    statement: 'permission.evaluate and execute.before were registered but never fired',
    blocks: 'P5/P8 (C8)',
  }),
  Object.freeze({
    id: 'PM-10',
    statement: 'Package/venv idempotence and clean-room reproducibility were not measured',
    blocks: 'D7 / Phase 7',
  }),
  Object.freeze({
    id: 'PM-11',
    statement: 'The 1–8 setup multiplicity per run is unexplained and unanalysed',
    blocks: 'P7/P9 duplication risk',
  }),
  Object.freeze({
    id: 'PM-12',
    statement:
      'Child/background coverage by session.execution.succeeded was not measured; C7 stays open',
    blocks: 'Phase 4 / Probe D',
  }),
  Object.freeze({
    id: 'PM-13',
    statement:
      'The installer "Change plan" is not a preview: it announces creates that do not occur',
    blocks: 'D7 / Phase 7',
  }),
  Object.freeze({
    id: 'PM-14',
    statement: 'Current V2 dispatch reads an envelope field absent from the measured shape (I-01)',
    blocks: 'Phase 4 payload reading',
  }),
  Object.freeze({
    id: 'PM-15',
    statement: 'Installer backups accumulate credential material without warning',
    blocks: 'D7 / Phase 7',
  }),
])

export const PREMISE_IDS = [
  'PRE-01',
  'PRE-02',
  ...Array.from({ length: 13 }, (_, index) => `PM-${String(index + 3).padStart(2, '0')}`),
] as const
