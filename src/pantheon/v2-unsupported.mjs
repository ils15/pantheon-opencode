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
 * The scripts are plain Node ESM and must stay that way, and `.mjs` is a
 * REPO-WIDE INVARIANT rather than a judgement about Node: `tsx` is a
 * devDependency only, and no plain-Node script in `scripts/` or `bin/` imports
 * a `.ts` module — every `.ts` path there is a string to copy, stat or read as
 * text (`scripts/install/opencode.mjs`, `scripts/probe-pantheon-cost.mjs`,
 * `scripts/package-evidence.mjs`, `scripts/check-plugin-v2-coverage.mjs`).
 * So a `.mjs` import is the only form all three consumers can share, and it
 * matches the existing `src/pantheon/presets.mjs` + `.d.mts` precedent.
 *
 * NOT the reason: type-stripping. `package.json#engines` admits Node >=26.4.0,
 * which defaults to unflagged type-stripping (it landed in 22.18.0), so that argument would not
 * have held on any admitted version. The live hazard is that `engines` is not
 * ENFORCED: a Node 20 user can run `doctor` and would get no type-stripping,
 * which is an argument for a runtime version check, not for this file's shape.
 *
 * The SEED is the statically-known half of `getUnsupportedFeatures()`: what a
 * migrating user loses by choosing the V2 contract, knowable with no host at
 * all. Runtime-appended entries (`tool-transform`, `event-stream`, …) are
 * observations about one live host and are deliberately NOT seeded here — they
 * are not known until the plugin runs against a real V2 host.
 *
 * ONE SOURCE OF TRUTH: install and doctor both read the seed from here, so the
 * two cannot drift apart, and what they report IS what this file lists. Note the
 * scope of that claim: it holds between the SEED and the two reporters. The
 * LIVE list `getUnsupportedFeatures()` returns is this seed PLUS markers appended
 * at runtime (`tool-transform`, `event-stream`, …), so it is a superset and the
 * two are expected to differ there. Do not copy these strings into a script;
 * import them.
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
  // GoalLoopClient and a BackgroundJobBoard. V2 has no `client` to build the
  // loop's session calls, and the bridge the V2 entry injects deliberately
  // carries the board and the todo enforcer only, so
  // pantheon_goal_create/get/update stay absent from the V2 surface rather
  // than being registered as non-functional placeholders.
  'goal-tools',
  // CONDITIONAL reduction (issue #265/#267): the V2 entry DOES construct the
  // V1 TodoEnforcer and inject it through the bridge, but only when the host's
  // `session` domain exposes the four methods the enforcer uses (`todo`,
  // `messages`, `children`, `promptAsync`). The measured 2.1.4 domain exposes
  // `hook`/`get`/`list`/`create`/`remove`/`prompt`/`generate`/… and NOT the
  // four, so on that host idle continuation does not run and the enforcer is
  // not constructed — the limitation is announced here instead of being hidden
  // behind a null bridge. V1 reaches those calls through `client.session`.
  'idle-todo-enforcer',
  // Todo preservation across compaction (`todo-preserve.ts`): V1 captures the
  // session's todo list in `experimental.session.compacting`, activates the
  // snapshot on `session.compacted` and rewrites the first post-compaction
  // `todowrite`. V2 has no todo API to capture from, so the snapshot is absent
  // and the first `todowrite` is not rewritten.
  'todo-restore',
  // The `<tool_ceiling>` block fed by `handleToolCeilingEvent` on V1
  // (`message.updated`). V2's event route handles session.* events only, so
  // there is no producer for the host-reported remaining context budget and
  // the block is not injected into the compaction context.
  'tool-ceiling',
  // BackgroundJobBoard bookkeeping: the shared board INSTANCE is reachable on
  // V2 through the injected bridge, but the transitions that make it useful
  // (onTerminal audit line, terminal reports on session.idle, dispatch mirror
  // for native background tasks) are driven from V1's event hook and from
  // pantheon-hooks.ts, neither of which a V2-only install loads. The board is
  // present; nothing on V2 writes to it.
  'board-transitions',
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
