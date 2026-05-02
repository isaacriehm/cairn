/**
 * Reviewer subagent (Layer C) — Phase 10.
 *
 * Per PRIMER §10 + INTEGRATION_PLAN §5 Phase 10:
 *   - Same model as implementer (no model split). Context isolation does
 *     the work, not weight diversity (L15).
 *   - Fresh `claude` subprocess; reads ONLY the tightened spec, diff
 *     content, decisions ledger, in-scope assertions, and Phase 9 soft
 *     findings. Does NOT see implementer's reasoning or tool-use trace.
 *   - Anti-completionist prompt; default verdict = fail.
 *   - Structured output via `--json-schema`.
 */

import type { ClaudeTier } from "../claude/index.js";
import type { DecisionFrontmatter } from "../ground/schemas.js";
import type { DiffEntry, SensorFinding } from "../sensors/index.js";

export type ReviewVerdict = "pass" | "fail";

export type ReviewGapCategory =
  | "deferred_but_claimed_done"
  | "missing_acceptance_criterion"
  | "scope_leak"
  | "query_scope_omission"
  | "decision_contradiction"
  | "unhandled_error"
  | "fake_thoroughness"
  | "documentation_drift"
  | "security_concern"
  | "other";

export interface ReviewGap {
  category: ReviewGapCategory;
  description: string;
  /** Repo-relative path of the file the gap is anchored on, when applicable. */
  path?: string;
  /** Symbol or function name the gap references. */
  symbol?: string;
  /** "hard" gates the run; "soft" reports for operator/UAT visibility. */
  severity: "hard" | "soft";
}

export interface ReviewerOutput {
  verdict: ReviewVerdict;
  gaps: ReviewGap[];
  /** Reviewer's confidence in its own verdict. */
  confidence_signal: "high" | "medium" | "low";
  /** One-paragraph natural-language summary of the review. */
  summary: string;
}

export interface ReviewerInput {
  /**
   * The tightened spec body the implementer received. This is the only
   * statement of intent the reviewer sees. Do NOT include the original
   * untightened task body or any operator chatter.
   */
  tightened_spec: string;
  /** Acceptance criteria the implementer was given. */
  acceptance_criteria: string[];
  /** Files changed in this run with their post-change content. */
  diff: DiffEntry[];
  /** Accepted decisions whose scope_globs overlap the diff. */
  decisions_in_scope: DecisionFrontmatter[];
  /** Soft findings from Phase 9 sensors (advisory; not gating). */
  soft_findings: SensorFinding[];
  /**
   * True iff diff touches any high_stakes_globs. Triggers the explicit
   * query-scope completeness check in the prompt (Codex audit Q1).
   */
  is_high_stakes: boolean;
  /** Tier to use — match implementer per L15. */
  tier: ClaudeTier;
  /** Per-call timeout. Default 300_000 ms. */
  timeout_ms?: number;
}

export interface ReviewerResult {
  output: ReviewerOutput;
  tier: ClaudeTier;
  /**
   * Aggregate decision: false when verdict=fail OR any hard gap exists.
   * Soft gaps + verdict=pass = ok. Orchestrator gates on this.
   */
  ok: boolean;
  duration_ms: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}
