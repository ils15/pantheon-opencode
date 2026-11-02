/**
 * Type declarations for unsupported.mjs (the V2 feature-reduction seed).
 * Consumed by src/plugin-v2.ts via `import ... from './pantheon/unsupported.mjs'`,
 * and by the plain-`.mjs` install/health scripts at runtime.
 */

/** Statically-known V2 feature reductions, in report order. */
export declare const UNSUPPORTED_FEATURE_SEED: readonly string[]

/** A fresh, mutable copy of the seed, so a reporter cannot mutate the shared list. */
export declare function listUnsupportedFeatures(): string[]
