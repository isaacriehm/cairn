/**
 * Coded `.cairn/` migration registry — types.
 *
 * Cairn upgrades constantly but on-disk `.cairn/` state does not move with
 * it. A migration is a versioned, idempotent repair: detect whether a repo
 * still needs the new state shape, then apply it. The runner selects pending
 * migrations by semver against the `cairn_version` pin, applies the `safe`
 * class automatically, and surfaces the `review` class for operator triage.
 *
 * See docs/MIGRATION_FEATURE_EVAL.md.
 */

export interface MigrationResult {
  /** True when apply() actually mutated `.cairn/`. */
  changed: boolean;
  /** One-line human summary of what changed (or why nothing did). */
  detail: string;
}

/**
 * `safe`   — additive or derived-only: add a missing default key, drop an
 *            unconsumed key, rebuild a gitignored derived index, stamp a
 *            marker. Auto-applied silently (incl. at SessionStart).
 * `review` — rewrites source, drops data, or makes a judgement call (brand
 *            re-derive, source strip). Never auto-applied; surfaced for the
 *            operator to run via `cairn migrate`.
 */
export type MigrationClass = "safe" | "review";

export interface Migration {
  /** Stable id, e.g. "0001-drop-dead-config-fields". */
  id: string;
  /** Semver of the Cairn release that REQUIRES this state shape. */
  introducedIn: string;
  /** One-line description, surfaced to the operator + linkable from CHANGELOG. */
  describe: string;
  class: MigrationClass;
  /** Idempotent: true when this repo still needs the migration. */
  detect(repoRoot: string): boolean;
  /** Apply. Must be idempotent and atomic per migration. */
  apply(repoRoot: string): MigrationResult;
}
