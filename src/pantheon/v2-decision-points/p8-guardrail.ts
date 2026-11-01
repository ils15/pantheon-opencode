/**
 * P8 (guardrail) — an off-by-default `noul` filter that can only narrow.
 *
 * `execute.before` is the only hard barrier in the V2 surface. P8 sits *below*
 * it and never above it, built around one property: for every input x,
 * `p8(x) ⊆ baseline(x)`. Narrowing (allow → deny) is legal; granting is not,
 * under any input and any flag value. That is structural, not policy: the only
 * effect this module can write is the literal `'deny'`, and the only other value
 * it can report is the baseline it read. No branch produces `'allow'` or `'ask'`.
 * {@link p8NarrowsOnly} states the property; the test suite enumerates it.
 *
 * The write path also requires the event's `effect` to be an **own writable data
 * property** before `Reflect.set` runs. A descriptor that is an accessor (own
 * getter/setter) or absent (the write would delegate to the prototype) is
 * refused with `p8.write.delegation` instead of trusting whatever `set` the
 * host installed. Without that check, "narrowing-only for every input" would
 * hold for data properties only.
 *
 * ## Record truthfulness (N9)
 *
 * `wrote` and `narrowed` describe this module's own post-write read. JavaScript
 * offers no way to tell an exotic target (a `Proxy` with a lying descriptor
 * trap) from a plain object, and any number of in-process reads can be made to
 * disagree. The guarantee is therefore not "the target accepted the write" but
 * "the effect recorded is the effect the event holds when the record is
 * produced": the plugin re-reads `event.effect` after the effect is final and
 * records `guardrail.narrow` only if that read still says `deny`. This module
 * never widens either way — a mismatch downgrades a claim, never an effect.
 *
 * ## Blast radius (N5) — measured: the declared rules match nothing
 *
 * PROBE-F (permission.evaluate paths; measured facts summarized in
 * docs/reference/local-decision-router.md) delivered 24 real
 * `permission.evaluate` events on the 2.2.5 host. Every one
 * carries a valid `action` token and a non-empty top-level `sessionID`
 * (PROBE-F §3.2), so neither declared rule can match: `action.unusable` needs a
 * non-token action, `allow.unattributed` needs an `allow` with no session. With
 * the flag on the outcome is `p8.rule.none` → `guardrail.keep`, i.e. **inert**
 * (PROBE-F §6 I-F3: the rules were matched statically against the measured
 * payload; the flag itself was never enabled). The availability risk the
 * phase-5 review named — denying native events with no `action` — does not
 * materialise on this host, because the host always supplies one. The real
 * finding is the opposite: no narrowing.
 *
 * An unrecognised effect is not a barrier either. The host treats a value it
 * does not recognise as `ask`, resolves it, and executes (PROBE-F §3.6), so
 * "refuse and keep" does not block. `execute.before` remains the only hard
 * barrier: a `throw` there denies and skips permission evaluation, while a
 * `throw` here does not deny at all (PROBE-F §3.7).
 *
 * Off by default: `PANTHEON_V2_P8_GUARDRAIL` is absent in a default install and
 * absence means disabled, so this phase ships no behavioural change. Evaluation
 * is synchronous with no I/O (it cannot delay admission), and every failure —
 * unreadable payload, unrecognized baseline, a host event that refuses the
 * write — resolves to "leave the baseline alone". A guardrail that cannot
 * narrow is a no-op, not an allow.
 *
 * ## Path coverage — measured host paths, no observed narrowing
 *
 * `PM-09` recorded that these surfaces never fired; PROBE-F fired them and
 * measured 9 of the 10 rows below. A row's `measured` status means the host path
 * was observed — **not** that P8 narrowed on it: no rule matched on any measured
 * payload, so no narrowing exists to observe. `unmeasured` is reserved for the
 * one path PROBE-F could not reach. Evidence cites the probe section; PROBE-F
 * proposes `F-42…F-48` but those ids are not assigned in this change, and this
 * module must not invent them (PLAN §5.4). {@link P8_PATH_COVERAGE} is the
 * machine-readable form.
 *
 *   | path                                                   | status     | evidence       |
 *   |--------------------------------------------------------|------------|----------------|
 *   | permission.evaluate: hook delivery                     | measured   | PROBE-F §3.1   |
 *   | permission.evaluate: payload shape (action/sessionID…) | measured   | PROBE-F §3.2   |
 *   | permission.evaluate: `event.effect` write is honored   | measured   | PROBE-F §3.4   |
 *   | permission.evaluate: ordering vs. the host rules       | measured   | PROBE-F §3.3   |
 *   | permission.evaluate: existing `deny` early return      | measured   | PROBE-F §3.5   |
 *   | permission.evaluate: `decision.egress` early return    | unmeasured | PROBE-F §3.9   |
 *   | permission.evaluate: unknown/unrecognized baseline     | measured   | PROBE-F §3.6   |
 *   | execute.before: delivery                               | measured   | PROBE-F §3.8   |
 *   | execute.before: payload shape                          | measured   | PROBE-F §3.8   |
 *   | execute.before: throw-to-deny semantics                | measured   | PROBE-F §3.7   |
 *
 * `permission.evaluate.egress` is unreachable in this host: a tool that declares
 * the `decision.egress` permission registers but is never advertised to the
 * provider, so the action never reaches the hook (PROBE-F §3.9). Its early
 * return therefore reads a branch that was never delivered.
 *
 * On `execute.before` P8 adds no barrier: a second barrier is the widening risk
 * this phase must not take, and narrowing is optional (equality is a subset).
 */

/** On/off switch read by the plugin wiring. Any other value means off. */
export const P8_GUARDRAIL_FLAG_ENV = 'PANTHEON_V2_P8_GUARDRAIL'

/** Permissiveness order. A decision may only move down this scale. */
export const P8_EFFECT_RANK = Object.freeze({ deny: 0, ask: 1, allow: 2 } as const)

export type P8PermissionEffect = keyof typeof P8_EFFECT_RANK

/**
 * Declared narrowing rules — syntax only, never a measured payload semantic, so
 * a rule that could widen cannot be introduced by editing a branch.
 */
export const P8_RULES = Object.freeze([
  /** The baseline is not attributable: no printable action token. */
  'p8.rule.action.unusable',
  /** An `allow` that names no session cannot be audited. */
  'p8.rule.allow.unattributed',
] as const)

export type P8RuleId = (typeof P8_RULES)[number]

export type P8Outcome = 'guardrail.keep' | 'guardrail.narrow' | 'guardrail.refusal'

/**
 * `measured`: the host path was observed in PROBE-F and the evidence names the
 * probe section (the `F-` ids for PROBE-F are proposed but not yet assigned).
 * `unmeasured`: the path was never exercised. Neither value claims a P8
 * narrowing — no measured payload matched a declared rule.
 */
export type P8PathStatus = 'measured' | 'unmeasured'

export interface P8PathCoverage {
  readonly path: string
  readonly status: P8PathStatus
  /** Probe section that observed the path; the premise id when unmeasured. */
  readonly evidence: readonly string[]
}

/** Every path P8 touches. Frozen: a path cannot be dropped silently. */
export const P8_PATH_COVERAGE: readonly P8PathCoverage[] = Object.freeze([
  { path: 'permission.evaluate.delivery', status: 'measured', evidence: ['PROBE-F §3.1'] },
  { path: 'permission.evaluate.payload-shape', status: 'measured', evidence: ['PROBE-F §3.2'] },
  { path: 'permission.evaluate.effect-write', status: 'measured', evidence: ['PROBE-F §3.4'] },
  { path: 'permission.evaluate.ordering', status: 'measured', evidence: ['PROBE-F §3.3'] },
  { path: 'permission.evaluate.existing-deny', status: 'measured', evidence: ['PROBE-F §3.5'] },
  { path: 'permission.evaluate.egress', status: 'unmeasured', evidence: ['PROBE-F §3.9'] },
  {
    path: 'permission.evaluate.unknown-baseline',
    status: 'measured',
    evidence: ['PROBE-F §3.6'],
  },
  { path: 'execute.before.delivery', status: 'measured', evidence: ['PROBE-F §3.8'] },
  { path: 'execute.before.payload-shape', status: 'measured', evidence: ['PROBE-F §3.8'] },
  { path: 'execute.before.throw-to-deny', status: 'measured', evidence: ['PROBE-F §3.7'] },
])

const ACTION_TOKEN = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/
const REASON_TOKEN = /^[a-z0-9][a-z0-9.:-]{0,63}$/

export interface P8GuardrailOptions {
  /** Defaults to `false`: absence of the flag means disabled. */
  readonly enabled?: boolean
}

export interface P8GuardrailInput {
  /** Effect the host/delegation produced. Read, never inferred. */
  readonly baseline: unknown
  /** Permission event as delivered (measured shape: PROBE-F §3.2). */
  readonly event?: unknown
}

export interface P8GuardrailDecision {
  readonly enabled: boolean
  readonly decision: P8Outcome
  /** The baseline, or `deny`. Never a value the baseline did not have. */
  readonly effect: P8PermissionEffect | 'unavailable'
  /** True only when `deny` replaced a wider baseline. */
  readonly narrowed: boolean
  readonly rules: readonly string[]
  /** Token explaining the outcome; always present. */
  readonly reason: string
}

export interface P8ApplyResult extends P8GuardrailDecision {
  /** True only when this call wrote `deny` onto the event. */
  readonly wrote: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Rank of a known effect; `null` for anything else (unprovable baseline). */
export function p8EffectRank(effect: unknown): number | null {
  if (typeof effect !== 'string' || !Object.hasOwn(P8_EFFECT_RANK, effect)) return null
  return P8_EFFECT_RANK[effect as P8PermissionEffect]
}

/** `true` only when both values are recognized and `p8` is at most the baseline. */
export function p8NarrowsOnly(baseline: unknown, effect: unknown): boolean {
  const base = p8EffectRank(baseline)
  const next = p8EffectRank(effect)
  if (base === null || next === null) return false
  return next <= base
}

function readEffect(value: unknown): P8PermissionEffect | null {
  const rank = p8EffectRank(value)
  if (rank === null) return null
  return value as P8PermissionEffect
}

/** Rules that match, in declaration order. Cannot return a wider decision. */
function matchedRules(event: unknown, baseline: P8PermissionEffect): readonly P8RuleId[] {
  const record = isRecord(event) ? event : null
  const matched: P8RuleId[] = []
  if (typeof record?.action !== 'string' || !ACTION_TOKEN.test(record.action)) {
    matched.push('p8.rule.action.unusable')
  }
  if (baseline === 'allow' && !isNonEmptyString(record?.sessionID)) {
    matched.push('p8.rule.allow.unattributed')
  }
  return matched
}

function decision(
  enabled: boolean,
  outcome: P8Outcome,
  effect: P8PermissionEffect | 'unavailable',
  baseline: P8PermissionEffect | null,
  rules: readonly string[],
  reason: string,
): P8GuardrailDecision {
  const token = REASON_TOKEN.test(reason) ? reason : 'p8.reason.invalid'
  const narrowed = effect === 'deny' && baseline !== null && baseline !== 'deny'
  const safeOutcome: P8Outcome = narrowed ? 'guardrail.narrow' : outcome
  return Object.freeze({
    enabled,
    decision: safeOutcome,
    effect,
    narrowed,
    rules: Object.freeze([...rules]),
    reason: token,
  })
}

/** Evaluate P8. Disabled echoes the baseline; an unrecognized baseline refuses. */
export function evaluateP8Guardrail(
  input: P8GuardrailInput,
  options: P8GuardrailOptions = {},
): P8GuardrailDecision {
  const enabled = options.enabled === true
  let baseline: P8PermissionEffect | null
  try {
    baseline = readEffect(input.baseline)
  } catch {
    baseline = null
  }
  if (baseline === null) {
    return decision(
      enabled,
      'guardrail.refusal',
      'unavailable',
      null,
      [],
      'p8.baseline.unrecognized',
    )
  }
  if (!enabled) return decision(false, 'guardrail.keep', baseline, baseline, [], 'p8.disabled')
  if (baseline === 'deny') {
    return decision(true, 'guardrail.keep', 'deny', baseline, [], 'p8.baseline.deny')
  }
  let rules: readonly P8RuleId[]
  try {
    rules = matchedRules(input.event, baseline)
  } catch {
    // The baseline was readable, so the honest answer is "keep it": an
    // unreadable event is a missing narrowing opportunity, never a grant.
    return decision(true, 'guardrail.keep', baseline, baseline, [], 'p8.event.unreadable')
  }
  if (rules.length === 0)
    return decision(true, 'guardrail.keep', baseline, baseline, [], 'p8.rule.none')
  return decision(true, 'guardrail.narrow', 'deny', baseline, rules, 'p8.rule.matched')
}

/**
 * Classify `event.effect` before writing it.
 *
 * `delegation`: the own descriptor is absent or an accessor, so an assignment
 * would create a property or run a host setter — the write is refused.
 * `non-writable`: an own data property that cannot be replaced — also refused,
 * with the existing `p8.write.rejected` token.
 * `writable`: an own writable data property, the only safe target.
 */
function effectWriteKind(target: object): 'writable' | 'delegation' | 'non-writable' {
  const descriptor = Object.getOwnPropertyDescriptor(target, 'effect')
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return 'delegation'
  return descriptor.writable === true ? 'writable' : 'non-writable'
}

function refusedWrite(
  enabled: boolean,
  baseline: P8PermissionEffect | null,
  reason: string,
): P8ApplyResult {
  return Object.freeze({
    ...decision(enabled, 'guardrail.keep', baseline ?? 'unavailable', baseline, [], reason),
    wrote: false,
  })
}

/**
 * Apply P8 to a permission event: read `event.effect`, write `'deny'` only when
 * a rule matched. A refused write leaves the baseline and reports
 * `p8.write.rejected` (frozen/non-writable or a throwing target) or
 * `p8.write.delegation` (accessor or non-own descriptor); this never throws
 * into admission.
 */
export function applyP8ToPermissionEvent(
  event: unknown,
  options: P8GuardrailOptions = {},
): P8ApplyResult {
  const enabled = options.enabled === true
  let baseline: P8PermissionEffect | null = null
  try {
    baseline = readEffect(isRecord(event) ? event.effect : undefined)
  } catch {
    baseline = null
  }
  const evaluated = evaluateP8Guardrail({ baseline, event }, options)
  if (!evaluated.narrowed) return Object.freeze({ ...evaluated, wrote: false })
  try {
    if (!isRecord(event)) return refusedWrite(enabled, baseline, 'p8.write.delegation')
    const kind = effectWriteKind(event)
    if (kind === 'delegation') return refusedWrite(enabled, baseline, 'p8.write.delegation')
    if (kind === 'non-writable') return refusedWrite(enabled, baseline, 'p8.write.rejected')
    // `Reflect.set` reports a refused write instead of throwing in strict mode,
    // so a frozen host object cannot turn P8 into an exception in admission.
    const assigned = Reflect.set(event, 'effect', 'deny')
    if (!assigned || event.effect !== 'deny') {
      return refusedWrite(enabled, baseline, 'p8.write.rejected')
    }
    return Object.freeze({ ...evaluated, wrote: true })
  } catch {
    return refusedWrite(enabled, baseline, 'p8.write.rejected')
  }
}

export interface P8Guardrail {
  readonly enabled: boolean
  /** Pure evaluation; never throws, never writes. */
  evaluate(input: P8GuardrailInput): P8GuardrailDecision
  /** Narrowing-only application; never throws, may write `deny` only. */
  apply(event: unknown): P8ApplyResult
}

/** Whether the operator explicitly enabled the flag. Absence means off. */
export function p8GuardrailEnabledFromEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env[P8_GUARDRAIL_FLAG_ENV] ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

/** Create a P8 instance. Disabled unless the caller says otherwise. */
export function createP8Guardrail(options: P8GuardrailOptions = {}): P8Guardrail {
  const enabled = options.enabled === true
  return Object.freeze({
    enabled,
    evaluate: (input: P8GuardrailInput) => evaluateP8Guardrail(input, { enabled }),
    apply: (event: unknown) => applyP8ToPermissionEvent(event, { enabled }),
  })
}
