/**
 * Phase 12 — garbage collection cadence.
 *
 * GC runs five passes against the canonical zone of an
 * adopted project's mirror checkout:
 *
 *   1. frontmatter-freshness — verified-at >30d warn, >60d block
 *   2. generator-drift       — re-run profile.extractors, diff against ground
 *   3. stub-catalog-hits     — full-tree scan against stub-patterns.yaml
 *   4. doc-gardening         — broken markdown links, orphan paths
 *   5. quality-grades        — rebuild .cairn/ground/quality-grades.yaml
 *
 * Each pass returns `GcFinding[]` and may attach a `GcCommitProposal` when the
 * fix is mechanical (frontmatter refresh, generator regen, quality-grades
 * rebuild). The sweep composer produces a `GcSweepResult` that the CLI / cron
 * decides how to apply.
 *
 * Auto-merge classes:
 *   safe        — formatting, doc regen, frontmatter refresh, generated content,
 *                 archive moves, stub-catalog additions. Push, no UAT.
 *   code        — touches *.ts outside generator-managed files. Sensors +
 *                 reviewer + UAT 🟢 → push.
 *   high-stakes — touches projectGlobs.high_stakes_globs. Above + E2E + Layer E.
 */

export type GcPassId =
  | "frontmatter-freshness"
  | "generator-drift"
  | "stub-catalog-hits"
  | "doc-gardening"
  | "quality-grades"
  | "scope-coverage"
  | "completion-integrity"
  | "citation-integrity"
  | "attested-commits-pruning";

export type GcFindingKind =
  | "frontmatter_stale"
  | "generator_drift"
  | "stub_hit"
  | "broken_link"
  | "orphan_path"
  | "quality_update"
  | "scope_uncovered"
  | "scope_drift_orphan"
  | "scope_index_missing"
  | "task_integrity_error"
  | "orphaned_citation"
  | "stale_citation"
  | "quality_grades_rebuilt"
  | "superseded_citation";

export type GcAutoMergeClass = "safe" | "code" | "high-stakes";

export interface GcFinding {
  pass: GcPassId;
  kind: GcFindingKind;
  /** Repo-relative path the finding applies to. */
  path: string;
  /** Human-readable, one-line summary. */
  detail: string;
  /** warn = surface; block = sensor-equivalent failure. info = neutral. */
  severity: "warn" | "block" | "info" | "soft";
  /** Days since verified-at (frontmatter pass only). */
  age_days?: number;
  /** Stub-pattern id when kind = "stub_hit". */
  pattern_id?: string;
  /** Line number when relevant (1-based). */
  line?: number;
  /** Verbatim text that triggered the finding. */
  matched_text?: string;
}

/**
 * A mechanical patch the pass can produce. The CLI / cron applies it as a
 * single `chore(gc): ...` commit when the proposal's class is enabled.
 * Patches are absolute file rewrites — keys are repo-relative paths, values
 * are the full new content. Empty-string content means "delete this file".
 */
export interface GcCommitProposal {
  pass: GcPassId;
  class: GcAutoMergeClass;
  /** Files this commit touches. */
  paths: string[];
  /** path → full new content. Empty value = delete. */
  patch: Record<string, string>;
  /** Conventional-commits-shaped subject + body. */
  commit_message: string;
  /** Findings this commit resolves (for audit log + Discord summary). */
  findings: GcFinding[];
}

export interface GcSweepResult {
  generated: string;
  /** All findings across passes. Includes those covered by proposals. */
  findings: GcFinding[];
  /** Mechanical patches the passes produced. */
  proposals: GcCommitProposal[];
  /** Per-pass timing (ms). */
  pass_durations: Record<GcPassId, number>;
  duration_ms: number;
}

/**
 * Outcome of `runGcBatch` — one or more proposals applied, optional canary
 * verification, optional rollback on failure. The CLI uses this to print the
 * summary and (when configured) push the resulting commits.
 */
export interface GcBatchResult {
  /** Applied commits with their resulting SHA. */
  applied: {
    pass: GcPassId;
    class: GcAutoMergeClass;
    commit_sha: string;
    commit_message: string;
    paths: string[];
  }[];
  /** Proposals NOT applied (class not enabled, or canary failed). */
  surfaced: GcCommitProposal[];
  /** Pre-batch SHA — used for rollback. */
  pre_batch_sha: string;
  /** Post-batch SHA when canary passed; equal to pre_batch_sha when nothing applied or rolled back. */
  post_batch_sha: string;
  /** True when verifyBatchCanary passed (or wasn't run because <2 applied). */
  canary_ok: boolean;
  /** Canary failure details when canary_ok = false. */
  canary_failures: string[];
  /** True when batch was rolled back due to canary fail. */
  rolled_back: boolean;
}
