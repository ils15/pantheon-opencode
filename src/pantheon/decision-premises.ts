/**
 * Premise register — PM-03…PM-18 plus PRE-01/PRE-02, referenced by id from the
 * registry. The canonical text lives in `STATUS.md` § Premissas; this file
 * keeps the ids, their state and their blocking targets close to the audit
 * that checks them.
 *
 * `status: 'closed'` means the premise was retired by a measurement, and the
 * statement records the residual scope that measurement left open. It never
 * means the measurement closed the *effect* question for a point that cites it.
 */

export interface PremiseEntry {
  readonly id: string
  readonly statement: string
  readonly blocks: string
  /** `closed` only when a named measurement retired the premise. */
  readonly status: 'open' | 'closed'
}

/** PM-03…PM-18 plus PRE-01/PRE-02, referenced by id from the registry. */
export const PREMISE_REGISTER: readonly PremiseEntry[] = Object.freeze([
  Object.freeze({
    id: 'PRE-01',
    statement:
      'P7 by event was a premise with a negative signal until the channel form was measured; PROBE-D closed C7, and the residual `session.idle`/`session.compacted` negative signal stays measured',
    blocks: 'nothing — historical record (C7 closed by PROBE-D)',
    status: 'closed',
  }),
  Object.freeze({
    id: 'PRE-02',
    statement:
      'prompt.skills absent makes filterSkills a no-op; P2 does not filter on the default path',
    blocks: 'P2b activation (PM-07)',
    status: 'open',
  }),
  Object.freeze({
    id: 'PM-03',
    statement: 'Origin of the Phase 0a carrier divergence is a hypothesis (2.1.4 session.id)',
    blocks: 'nothing — historical record',
    status: 'open',
  }),
  Object.freeze({
    id: 'PM-04',
    statement:
      'reason:"overflow" was not inducible in 6 error shapes; child-session compaction is measured (3/3) but its checkpoint reinjection is not',
    blocks: 'P9 / Phase 3 (C9)',
    status: 'open',
  }),
  Object.freeze({
    id: 'PM-05',
    statement:
      'Exclusivity of the system channel is unproven; the messages mode was never exercised',
    blocks: 'P9 / Phase 3',
    status: 'open',
  }),
  Object.freeze({
    id: 'PM-06',
    statement:
      'Skill and tool catalogs with Pantheon installed were measured (F-26: ctx.skill, tool.transform draft). ctx.agent.transform was never exercised',
    blocks: 'P11 (Phase 6) for agents only',
    status: 'closed',
  }),
  Object.freeze({
    id: 'PM-07',
    statement: 'Populated prompt.skills / prompt.agents were never observed',
    blocks: 'P1/P2b activation',
    status: 'open',
  }),
  Object.freeze({
    id: 'PM-08',
    statement: 'ctx.model / ctx.provider were never exercised as a catalog source',
    blocks: 'P11 / Phase 6',
    status: 'open',
  }),
  Object.freeze({
    id: 'PM-09',
    statement: 'permission.evaluate and execute.before were registered but never fired',
    blocks: 'P5/P8 (C8)',
    status: 'open',
  }),
  Object.freeze({
    id: 'PM-10',
    statement: 'Package/venv idempotence and clean-room reproducibility were not measured',
    blocks: 'D7 / Phase 7',
    status: 'open',
  }),
  Object.freeze({
    id: 'PM-11',
    statement: 'The 1–8 setup multiplicity per run is unexplained and unanalysed',
    blocks: 'P7/P9 duplication risk',
    status: 'open',
  }),
  Object.freeze({
    id: 'PM-12',
    statement:
      'Child/background coverage by session.execution.succeeded was not measured; closed by PROBE-D (F-18–F-21: 13/13 child sessions). Nested depth >= 2, background image jobs and execution.failed/.interrupted in a child remain unmeasured',
    blocks: 'nothing — C7 closed by PROBE-D',
    status: 'closed',
  }),
  Object.freeze({
    id: 'PM-13',
    statement:
      'The installer "Change plan" is not a preview: it announces creates that do not occur',
    blocks: 'D7 / Phase 7',
    status: 'open',
  }),
  Object.freeze({
    id: 'PM-14',
    statement: 'Current V2 dispatch reads an envelope field absent from the measured shape (I-01)',
    blocks: 'Phase 4 payload reading',
    status: 'open',
  }),
  Object.freeze({
    id: 'PM-15',
    statement: 'Installer backups accumulate credential material without warning',
    blocks: 'D7 / Phase 7',
    status: 'open',
  }),
  Object.freeze({
    id: 'PM-16',
    statement:
      'Honouring of the effect write is unmeasured: if the host assigns event.effect only after permission.evaluate, P8 reads no baseline, denies and never narrows — and with the result discarded, "on and inert" is indistinguishable from "on and working"',
    blocks: 'P8 activation (C8 / PH5-1, PH5-5)',
    status: 'open',
  }),
  Object.freeze({
    id: 'PM-17',
    statement:
      'The 12-execution P7 cap has no measured reset surface: reset() exists but no user-input signal was wired to it, which is why the cap is advisory',
    blocks: 'nothing today — P7 effect is none; blocks any claim about the cap',
    status: 'open',
  }),
  Object.freeze({
    id: 'PM-18',
    statement:
      'BM25 versus embeddings was not run (offline environment, no embedding model); BM25 stays the baseline and no gain or loss may be quoted',
    blocks: 'any retrieval/token gain claim in P4/P11',
    status: 'open',
  }),
])

export const PREMISE_IDS = [
  'PRE-01',
  'PRE-02',
  ...Array.from({ length: 16 }, (_, index) => `PM-${String(index + 3).padStart(2, '0')}`),
] as const
