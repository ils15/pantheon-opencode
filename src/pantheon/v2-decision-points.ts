/**
 * The P1…P11 registry table — the single per-point record.
 *
 * Each entry carries its domain surface, host surface and tool-vs-hook side,
 * status, evidence ids, premise ids, blocking condition, event shape where the
 * point is event-driven, and notes. Resource ids are not stored here: they are
 * derived from these fields by `v2-decision-resource-ids.ts`.
 *
 * Data only: the status rules, premise register and audit live in
 * `v2-decision-registry.ts`. Frozen at module load, because an adapter that
 * could rewrite a status could turn a premise into an apparent measurement.
 *
 * `mode` declares the mode a point would run in, never a production call site:
 * `wired` records whether the shipped plugin constructs the adapter, and the
 * source-derived audit in `tests/pantheon/v2-decision-wiring.test.ts` fails when
 * the flag and the production import graph disagree. P1 and P2 are constructed
 * at the prompt hook, P3 at `tool.invoke` (its declared surface and the only one
 * carrying `complexity`/`gateStatus`), P7 on the event channel and P8 on
 * permission.evaluate; P4, P5, P6, P9, P10 and P11 remain library code with no
 * caller outside the harness and the tests, and their `wired` stays `false`.
 */

import type { DecisionPoint } from './v2-decision-registry.ts'

const SHADOW = 'shadow' as const

/** The registry. Frozen: adapters read it, nothing mutates it. */
export const DECISION_POINT_REGISTRY: readonly DecisionPoint[] = Object.freeze([
  Object.freeze<DecisionPoint>({
    id: 'P1',
    surface: 'agent',
    hostSurface: 'session.hook.prompt',
    toolOrHook: 'hook',
    hostPoint: "session.hook('prompt')",
    primitives: ['choice'],
    mode: SHADOW,
    status: 'premise',
    wired: true,
    evidence: ['F-08'],
    premises: ['PM-06', 'PM-07'],
    blockingCondition:
      'PM-07 open: a host-populated prompt.agents was never observed, so no effect of a prompt mutation on the next turn was measured for P1. C6 itself is closed by PROBE-E and is not the blocker',
    notes:
      'Measured only as prompt-payload shape (F-08). Populated prompt.agents was never observed.',
  }),
  Object.freeze<DecisionPoint>({
    id: 'P2',
    surface: 'skill',
    hostSurface: 'session.hook.prompt',
    toolOrHook: 'hook',
    hostPoint: "session.hook('prompt') + filterSkills; catalog source ctx.skill",
    primitives: ['choice', 'rank'],
    mode: SHADOW,
    status: 'advisory',
    wired: true,
    evidence: ['F-06', 'F-08', 'F-09', 'F-10'],
    premises: ['PRE-02', 'PM-06', 'PM-07', 'PM-13'],
    blockingCondition:
      'P2b cancelled by measurement: no measured mutation surface reaches project skills (PROBE-E §5.1/§9), so effective filtering is unreachable and P2 records only',
    unknowns: [
      'other project-skill removal paths were not exercised (PROBE-E §7)',
      'mutation inside a child/subagent session is UNKNOWN (PROBE-E §7)',
    ],
    notes:
      'P2 é no-op empírico no caminho default (F-09, PRE-02). P2a resolves the skill source, but the shipped prompt hook passes no `skillsDraft` — `applyTurnDecisionToPrompt(prompt, decision)` — so `skillsSource` is only `none` or `prompt` at runtime and the `draft` source (resolveSkillSource) has no production caller. P2b was cancelled, not emulated: skill.transform add/remove changes the next turn only for builtin draft entries; project skills are unreachable (get returns null, remove is ok without effect, an add override is not rendered). P2 never filters and claims no token reduction. PM-13 applies by analogy: an effect announced without an observable artifact is not an effect.',
  }),
  Object.freeze<DecisionPoint>({
    id: 'P3',
    surface: 'complexity',
    hostSurface: 'tool.invoke',
    toolOrHook: 'tool',
    hostPoint: 'ask.score + noul (tool pantheon_local_decision)',
    primitives: ['score', 'noul'],
    mode: SHADOW,
    status: 'premise',
    wired: true,
    evidence: [],
    premises: ['PM-06', 'PM-09'],
    blockingCondition:
      'PM-09 open: no tool call was measured, so the tool.invoke surface that would carry complexity scoring was never exercised. C6 is closed by PROBE-E and is not the blocker',
    notes:
      'Complexity classification is contract-only in this phase. Wired at its declared `tool.invoke`: `pantheon_local_decision` execute hands the adapter its own input, whose schema requires `complexity` and `gateStatus`, so the adapter classifies from the payload that reaches it instead of refusing from the prompt hook. PM-09 stays open — no tool call was ever measured — so this records a decision only when the tool is invoked and never applies one.',
  }),
  Object.freeze<DecisionPoint>({
    id: 'P4',
    surface: 'memory',
    hostSurface: 'session.hook.context',
    toolOrHook: 'hook',
    hostPoint: 'rank (context → system)',
    primitives: ['rank'],
    mode: SHADOW,
    status: 'measured',
    wired: false,
    evidence: ['F-02', 'F-03'],
    premises: ['PM-05'],
    blockingCondition: null,
    notes:
      'System-array carrier and checkpoint reinjection measured (F-02, F-03); channel exclusivity unproven (PM-05).',
  }),
  Object.freeze<DecisionPoint>({
    id: 'P5',
    surface: 'verification',
    hostSurface: 'session.hook.execute.after',
    toolOrHook: 'hook',
    hostPoint: 'verify (execute.after / context)',
    primitives: ['verify'],
    mode: SHADOW,
    status: 'premise',
    wired: false,
    evidence: [],
    premises: ['PM-09'],
    blockingCondition:
      'C8 open: permission.evaluate and execute.before were registered but never fired; no tool call was measured',
    notes: 'Verdicts PASS/FAIL/BLOCK; failed_to_respond in mandatory verification is BLOCK.',
  }),
  Object.freeze<DecisionPoint>({
    id: 'P6',
    surface: 'council',
    hostSurface: 'session.hook.prompt',
    toolOrHook: 'hook',
    hostPoint: 'rank + score (prompt)',
    primitives: ['rank', 'score'],
    mode: SHADOW,
    status: 'measured',
    wired: false,
    evidence: ['F-08'],
    premises: ['PM-07'],
    blockingCondition: null,
    notes:
      'Prompt payload shape measured (F-08); populated prompt.agents was never observed (PM-07). Unwired: the prompt surface carries `prompt.agents`/`prompt.skills`, never the `{ id, score, justification }` candidate list this adapter ranks, so constructing it there would only record a permanent `council.source.absent` refusal. No measured surface carries council candidates; it stays library code until one does.',
  }),
  Object.freeze<DecisionPoint>({
    id: 'P7',
    surface: 'loop',
    hostSurface: 'event.channel',
    toolOrHook: 'hook',
    hostPoint: 'session.execution.succeeded — data.sessionID',
    primitives: ['noul', 'score'],
    mode: 'migration',
    status: 'measured',
    wired: true,
    evidence: ['F-11', 'F-12', 'F-13', 'I-01'],
    premises: [],
    blockingCondition: null,
    trigger: 'session.execution.succeeded',
    eventShape: {
      type: 'session.execution.succeeded',
      carrier: 'data.sessionID',
      forbiddenCarriers: ['properties'],
    },
    unknowns: [
      'session.execution.failed / .interrupted in a child session were never induced (PROBE-D §5.1)',
      'nested subagent depth >= 2 was never exercised (PROBE-D §5.2)',
      'a background image job was never exercised (PROBE-D §5.4)',
    ],
    notes:
      'Branch 1 of PLAN §5.1 was selected by PROBE-D §7 (`.pantheon/deepwork/decision-layer-v2/PROBE-D-turn-end-channel.md`): `session.execution.succeeded` is delivered for child sessions with the child copy of `data.sessionID` — 13/13 children (6 foreground, 5 background, 2 with compaction) — and for background work (PROBE-D §4.1–§4.2). The event does NOT carry `parentID` (`dataKeys=["sessionID"]`, 44/44): attribution comes from `session.created.parentID` or `ctx.session.get`, never from the succeeded event (PROBE-D §4.1). Multiplicity is per EXECUTION, not per turn: 44 `started` = 44 `succeeded` for 46 inbox items; manual compaction adds +1 (C2 = 3), automatic compaction +0 (C1 = 1), a late background notification +1 on the parent (B3/B4/B5 = 2 vs B1/B2 = 1) (PROBE-D §4.3). The adapter implements that execution counter (`v2-decision-points/p7-loop.ts`) behind `PANTHEON_V2_P7_LOOP`, OFF by default; cutover is Phase 4b. Effect stays unmeasured (C6 is closed by PROBE-E; no effect of P7 itself was observed): the adapter records `effect: none` and must never be described as working enforcement while the flag is off. The 12-execution cap (`P7_LOOP_MAX_EXECUTIONS`) is ADVISORY: `reset()` is caller-supplied, no measured user-input surface in the probed host provides a signal to call it, and the streak is not claimed to reset on any event. PROBE-D retires the PRE-01/PM-12 blocking premises; the premise register records PM-12 as closed by that measurement.',
  }),
  Object.freeze<DecisionPoint>({
    id: 'P8',
    surface: 'guardrail',
    hostSurface: 'permission.evaluate',
    toolOrHook: 'hook',
    hostPoint: 'noul (permission.evaluate only; execute.before untouched)',
    primitives: ['noul'],
    mode: 'off',
    status: 'premise',
    wired: true,
    evidence: [],
    premises: ['PM-09', 'PM-16'],
    blockingCondition:
      'C8 open: permission.evaluate was registered and never fired; activation also waits on PH5-1…PH5-5 (PLAN A-6 renames the Phase 5 review conditions) and enters off after P1–P3 are stable, with Themis review',
    securityInvariant:
      'execute.before remains the only hard barrier. No adapter may allow what that barrier denies.',
    unknowns: [
      'permission.evaluate delivery, payload shape, effect-write honouring and ordering are unmeasured (PM-09, review N1/N5)',
      'accessor/proxy write targets, inherited effect and non-writable own properties are unproven (review N2); the write now refuses a non-own or accessor descriptor, but host payloads carrying them were never observed',
      'the rule blast radius on native events without an action token is unmeasured (review N5): action.unusable would deny such events, and payload shape is PM-09',
    ],
    notes:
      'Starts off, not shadow. Only permission.evaluate is wired: execute.before is untouched and P8 adds no second barrier there. The Phase 5 review (N1–N8, conditions PH5-1…PH5-5) keeps activation blocked and forbids reading this entry as coverage. Its wiring findings N1 (discarded result / proof before P8), N3 (silent rejection) and N4 (no flag-on test) were repaired without activating the flag: apply() now runs before writeProof, so the proof records the post-apply effect (PH5-1); the guardrail outcome is emitted through the 0b telemetry sink carrying the `mode` this entry declares — `off`, never `active` — so a record cannot advertise an activation the registry denies (N10a); the record is emitted only after the delegation policy has decided and only when a fresh re-read of the event still holds the effect it describes, so a policy deny is never recorded as a P8 narrowing and a lying Proxy trap is never recorded as a write (N10b, N9); the write refuses accessor and non-own descriptors with p8.write.delegation (PH5-2). The flag-on integration test through the registered handler and the PANTHEON_V2_P8_GUARDRAIL isolation of the contract suite are PH5-3; the flag and the rule blast radius are documented in README and docs/reference/env-vars.md under PH5-4 (A-6 mapping). The rule blast radius on native events lacking action remains UNMEASURED (N5), every permission.evaluate path stays unmeasured (PM-09, P8_PATH_COVERAGE), the host honouring the write is a premise (PM-16), and activation stays blocked pending C8 and re-review.',
  }),
  Object.freeze<DecisionPoint>({
    id: 'P9',
    surface: 'compaction',
    hostSurface: 'session.hook.compaction',
    toolOrHook: 'hook',
    hostPoint: 'noul + score (compaction)',
    primitives: ['noul', 'score'],
    mode: SHADOW,
    status: 'measured',
    wired: false,
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
    hostSurface: 'session.hook.prompt',
    toolOrHook: 'hook',
    hostPoint: 'verify (per council member; prompt surface)',
    primitives: ['verify'],
    mode: SHADOW,
    status: 'premise',
    wired: false,
    evidence: [],
    premises: [],
    blockingCondition:
      'Not implemented: per-counselor claims were never designed or measured (DISCOVERY §4); no measured surface carries `counsellors[].claims[]`',
    notes:
      'Explicit verdict per claim; failed_to_respond is BLOCK in mandatory verification. The prompt hook is the only measured council surface (F-08), but that payload carries neither counsellors nor claims, so the point is unwired: constructing it there would record `claims.absent` forever. The declaration records intent and the boundary, not exercised coverage.',
  }),
  Object.freeze<DecisionPoint>({
    id: 'P11',
    surface: 'catalog',
    hostSurface: 'tool.transform',
    toolOrHook: 'tool',
    hostPoint: 'own adapter in tool.transform',
    primitives: ['choice'],
    mode: SHADOW,
    status: 'measured',
    wired: false,
    evidence: ['F-05', 'F-07'],
    premises: ['PM-06', 'PM-08'],
    blockingCondition: null,
    notes:
      'Host catalog context is ABSENT at every measured point (F-05) and was removed from the design; the adapter uses the tool.transform draft (F-07).',
  }),
])
