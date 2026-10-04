#!/usr/bin/env node
/**
 * v2-unsupported.mjs — the SEED of V2 feature reductions, in plain ESM.
 *
 * WHY A SEPARATE PLAIN-`.mjs` MODULE: these strings must be readable by three
 * very different consumers, and only one of them can import TypeScript.
 *
 *   - `src/plugin-v2.ts` (TypeScript) — owns the LIVE list, appending to it at
 *     runtime via `markUnsupported()` when a host API turns out to be missing,
 *     and exposes it through `getUnsupportedFeatures()`.
 *   - `scripts/install/opencode.mjs` — reports the reduction at install time
 *     for a V2-generation install.
 *   - `scripts/doctor.mjs` — reports it in the health gate.
 *
 * The scripts are plain Node ESM and must stay that way: `package.json#engines`
 * admits Node `^22.22.2`, which does NOT enable TypeScript type-stripping by
 * default. A `.mjs` import is the only form all three can share, and it matches
 * the existing `src/pantheon/presets.mjs` + `.d.mts` precedent.
 *
 * The SEED is the statically-known half of `getUnsupportedFeatures()`: what a
 * migrating user loses by choosing the V2 contract, knowable with no host at
 * all. Runtime-appended entries (`tool-transform`, `event-stream`, …) are
 * observations about one live host and are deliberately NOT seeded here — they
 * are not known until the plugin runs against a real V2 host.
 *
 * ONE SOURCE OF TRUTH: install and doctor both read the seed from here, so the
 * two cannot drift apart, and both match what `getUnsupportedFeatures()`
 * reports. Do not copy these strings into a script; import them.
 *
 * @module v2-unsupported
 */

/**
 * Statically-known V2 feature reductions, in the order a reader should meet
 * them. Frozen: `plugin-v2.ts` copies it into its own mutable live array, and
 * every other consumer goes through {@link listV2UnsupportedFeatures}.
 *
 * @type {readonly string[]}
 */
export const V2_UNSUPPORTED_FEATURE_SEED = Object.freeze([
  'legacy-hooks',
  // `ctx.catalog` is the one domain a live 2.0.22 host does NOT have: it is
  // absent from `Object.keys(ctx)`, measured in
  // tests/canary/plugin-v2-tool-canary.test.mjs. (`catalog` IS in the 1.18.33
  // SDK's PluginContext, so the SDK types it and the host does not provide it.)
  'catalog-transform',
  // Adapter support, NOT host availability: 2.0.22 exposes ctx.integration and
  // ctx.skill with callable transforms, and Pantheon deliberately registers
  // neither. These entries record what this plugin does not implement.
  'integration-transform',
  // The inspected SkillEditor shape has no `source()` helper — i.e. no
  // `SkillEditor.source()` — for adding a directory source. This is narrower
  // than (and distinct from) ctx.skill's host availability or callable
  // transform, which a live 2.0.22 host does provide.
  'skill-transform',
  // Adapter limitation, not a host gap: the goal loop needs a GoalStore, a
  // GoalLoopClient and a BackgroundJobBoard, none of which the V2
  // PluginContext exposes, and the V1 bridge resolves to null outside V1.
  // pantheon_goal_create/get/update are therefore absent from the V2 surface
  // rather than registered as non-functional placeholders.
  'goal-tools',
  // Adapter limitation, not a host gap — TWO separate reasons, which are easy
  // to conflate and were once stated wrongly (see the v2EnforcementGuard
  // comment in src/plugin-v2.ts for the long form):
  //   - MISSING WIRING: V2 keeps no session→agent map (the host puts the agent
  //     on the execute.before event), so there is no `getSessionAgent` to pass.
  //     The guard would then call isDelegationAllowed(undefined, target) → false
  //     and throw "caller agent is unavailable" on EVERY task() call.
  //   - UNSEEDED HIERARCHY: V2 exposes no seed path, and an unseeded
  //     SessionHierarchyRegistry gates exactly two things — the depth-2 child
  //     deny and the root-session gate. Unseeded, isChild is always false, so
  //     neither can be trusted.
  // Note the hierarchy is NOT what would deny: isRoot reports `true` for an
  // unknown session while unseeded, which PASSES the root gate.
  // Read-only depth-2 still holds via the blocked-tool list in the guard, so
  // this marker records an unenforced matrix, not an unenforced depth limit.
  'delegation-matrix',
])

/**
 * A fresh, mutable copy of the seed.
 *
 * Callers get a copy so a reporter that sorts, filters or appends cannot reach
 * back into the shared list — this is what makes "both surfaces report the same
 * strings" a structural property rather than a convention.
 *
 * @returns {string[]}
 */
export function listV2UnsupportedFeatures() {
  return [...V2_UNSUPPORTED_FEATURE_SEED]
}
