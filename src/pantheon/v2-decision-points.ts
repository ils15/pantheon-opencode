/**
 * The P1…P11 registry table.
 *
 * Data only: the status rules, premise register and audit live in
 * `v2-decision-registry.ts`. Frozen at module load, because an adapter that
 * could rewrite a status could turn a premise into an apparent measurement.
 */

import type { DecisionPoint } from './v2-decision-registry.ts'

const SHADOW = 'shadow' as const

/** The registry. Frozen: adapters read it, nothing mutates it. */
export const DECISION_POINT_REGISTRY: readonly DecisionPoint[] = Object.freeze([
  Object.freeze<DecisionPoint>({
    id: 'P1',
    surface: 'agent',
    hostPoint: "session.hook('prompt')",
    primitives: ['choice'],
    mode: SHADOW,
    status: 'premise',
    evidence: ['F-08'],
    premises: ['PM-06', 'PM-07'],
    blockingCondition:
      'C6 open: a prompt mutation was never observed taking effect in the next turn',
    notes:
      'Measured only as prompt-payload shape (F-08). Populated prompt.agents was never observed.',
  }),
  Object.freeze<DecisionPoint>({
    id: 'P2',
    surface: 'skill',
    hostPoint: "session.hook('prompt') + filterSkills; catalog source ctx.skill",
    primitives: ['choice', 'rank'],
    mode: SHADOW,
    status: 'advisory',
    evidence: ['F-06', 'F-08', 'F-09', 'F-10'],
    premises: ['PRE-02', 'PM-06', 'PM-07', 'PM-13'],
    blockingCondition:
      'P2b cancelled by measurement: no measured mutation surface reaches project skills (PROBE-E §5.1/§9), so effective filtering is unreachable and P2 records only',
    unknowns: [
      'other project-skill removal paths were not exercised (PROBE-E §7)',
      'mutation inside a child/subagent session is UNKNOWN (PROBE-E §7)',
    ],
    notes:
      'P2 é no-op empírico no caminho default (F-09, PRE-02). P2a reports the skill source. P2b was cancelled, not emulated: skill.transform add/remove changes the next turn only for builtin draft entries; project skills are unreachable (get returns null, remove is ok without effect, an add override is not rendered). P2 never filters and claims no token reduction. PM-13 applies by analogy: an effect announced without an observable artifact is not an effect.',
  }),
  Object.freeze<DecisionPoint>({
    id: 'P3',
    surface: 'complexity',
    hostPoint: 'ask.score + noul (tool pantheon_local_decision)',
    primitives: ['score', 'noul'],
    mode: SHADOW,
    status: 'premise',
    evidence: [],
    premises: ['PM-06'],
    blockingCondition: 'C6 open: no measured effect in the following turn',
    notes: 'Complexity classification is contract-only in this phase.',
  }),
  Object.freeze<DecisionPoint>({
    id: 'P4',
    surface: 'memory',
    hostPoint: 'rank (context → system)',
    primitives: ['rank'],
    mode: SHADOW,
    status: 'measured',
    evidence: ['F-02', 'F-03'],
    premises: ['PM-05'],
    blockingCondition: null,
    notes:
      'System-array carrier and checkpoint reinjection measured (F-02, F-03); channel exclusivity unproven (PM-05).',
  }),
  Object.freeze<DecisionPoint>({
    id: 'P5',
    surface: 'verification',
    hostPoint: 'verify (execute.after / context)',
    primitives: ['verify'],
    mode: SHADOW,
    status: 'premise',
    evidence: [],
    premises: ['PM-09'],
    blockingCondition:
      'C8 open: permission.evaluate and execute.before were registered but never fired; no tool call was measured',
    notes: 'Verdicts PASS/FAIL/BLOCK; failed_to_respond in mandatory verification is BLOCK.',
  }),
  Object.freeze<DecisionPoint>({
    id: 'P6',
    surface: 'council',
    hostPoint: 'rank + score (prompt)',
    primitives: ['rank', 'score'],
    mode: SHADOW,
    status: 'measured',
    evidence: ['F-08'],
    premises: ['PM-07'],
    blockingCondition: null,
    notes: 'Prompt payload shape measured; populated prompt.agents was never observed.',
  }),
  Object.freeze<DecisionPoint>({
    id: 'P7',
    surface: 'loop',
    hostPoint: 'session.execution.succeeded — data.sessionID',
    primitives: ['noul', 'score'],
    mode: 'migration',
    status: 'deferred',
    evidence: ['F-11', 'F-12', 'F-13', 'I-01'],
    premises: ['PRE-01', 'PM-12'],
    blockingCondition:
      'C7 open: child/background coverage of session.execution.succeeded was never measured (Probe D / Phase 0c)',
    trigger: 'session.execution.succeeded',
    eventShape: {
      type: 'session.execution.succeeded',
      carrier: 'data.sessionID',
      forbiddenCarriers: ['properties'],
    },
    notes:
      'Deferred, not shadow: replaces behaviour that is already active. Fallback branch (2/3 of PLAN §5.1): V2 delivers no loop enforcement, owner stays V1, and the gap is documented. It must never be described as working enforcement.',
  }),
  Object.freeze<DecisionPoint>({
    id: 'P8',
    surface: 'guardrail',
    hostPoint: 'noul (permission.evaluate / execute.before)',
    primitives: ['noul'],
    mode: 'off',
    status: 'premise',
    evidence: [],
    premises: ['PM-09'],
    blockingCondition:
      'C8 open: permission.evaluate and execute.before were registered but never fired; enters off after P1–P3 are stable, with Themis review',
    securityInvariant:
      'execute.before remains the only hard barrier. No adapter may allow what that barrier denies.',
    notes: 'Starts off, not shadow. Can only narrow, never widen, a host decision.',
  }),
  Object.freeze<DecisionPoint>({
    id: 'P9',
    surface: 'compaction',
    hostPoint: 'noul + score (compaction)',
    primitives: ['noul', 'score'],
    mode: SHADOW,
    status: 'measured',
    scope: 'top-level-session-only',
    evidence: ['F-01', 'F-02', 'F-03', 'F-04'],
    premises: ['PM-04', 'PM-05'],
    blockingCondition: null,
    unknowns: [
      'child-session compaction is UNKNOWN',
      'reason:"overflow" was never exercised',
      'the messages channel was never exercised',
    ],
    notes:
      'Measured on top-level sessions only: top-level sessionID carrier (F-01) and system-array text (F-02).',
  }),
  Object.freeze<DecisionPoint>({
    id: 'P10',
    surface: 'claims',
    hostPoint: 'verify (per council member)',
    primitives: ['verify'],
    mode: SHADOW,
    status: 'premise',
    evidence: [],
    premises: [],
    blockingCondition:
      'Not implemented: per-counselor claims were never designed or measured (DISCOVERY §4)',
    notes: 'Explicit verdict per claim; failed_to_respond is BLOCK in mandatory verification.',
  }),
  Object.freeze<DecisionPoint>({
    id: 'P11',
    surface: 'catalog',
    hostPoint: 'own adapter in tool.transform',
    primitives: ['choice'],
    mode: SHADOW,
    status: 'measured',
    evidence: ['F-05', 'F-07'],
    premises: ['PM-06', 'PM-08'],
    blockingCondition: null,
    notes:
      'Host catalog context is ABSENT at every measured point (F-05) and was removed from the design; the adapter uses the tool.transform draft (F-07).',
  }),
])
