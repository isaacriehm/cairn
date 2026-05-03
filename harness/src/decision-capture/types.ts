/**
 * Phase 14 — decision capture flow.
 *
 * Per WORKFLOW_GUIDE / L26 / L27 / INTEGRATION_PLAN §5 Phase 14:
 *
 *   /direction <text>  OR  free-text Tier-0 classified as `direction`
 *   → Tier-1 decision-extractor produces structured candidate
 *   → harness writes draft to .harness/ground/decisions/_inbox/DEC-NNNN.draft.md
 *   → Discord prompt: 🟢 commit | 🟡 edit | 🔴 not-a-decision
 *   → on 🟢: status:accepted, move to .harness/ground/decisions/DEC-NNNN.md,
 *            regenerate decisions.ledger.yaml; assertions become live
 *   → on 🟡: leave draft + post correction prompt (re-run extractor on follow-up)
 *   → on 🔴: discard draft (no record)
 *
 * The extractor is read-only (no file-write tools). The draft writer + the
 * confirm flow are pure-mechanical. The only LLM call is the extractor;
 * everything else is the harness assembling state from the typed payload.
 */

import type { ClaudeTier } from "../claude/index.js";

/** Assertion shape the extractor proposes — superset of DecisionAssertion kinds. */
export interface CandidateAssertion {
  /** Optional id; harness fills in `<DEC-id>-A<N>` if absent. */
  id?: string;
  kind:
    | "schema_must_contain"
    | "text_must_match"
    | "text_must_not_match"
    | "index_must_exist"
    | "ast_pattern"
    | "file_must_not_be_modified"
    | "query_must_filter_by"
    | "route_must_have_guard"
    | "event_must_emit"
    | "service_method_must_call"
    | "human_review_hint";
  /** Free-form description of what the assertion enforces. */
  description: string;
  /**
   * Inline assertion-specific knobs — typed loosely on this side because the
   * extractor's output is best-effort. Sensors/Layer-D evaluate these against
   * the diff at run time; malformed entries fail loud at evaluation, not here.
   */
  parameters?: Record<string, unknown>;
}

export interface DecisionExtractorOutput {
  /** One-line subject — imperative voice. */
  subject: string;
  /** 2-4 sentence summary expanding the subject. */
  summary: string;
  /** Repo-relative globs the decision binds. May be empty. */
  scope_globs: string[];
  /**
   * Existing decision id this one supersedes, when the operator's direction
   * is explicitly a course-change. Format DEC-NNNN. Null/undefined when not
   * applicable.
   */
  supersedes?: string | null;
  /** 0-3 candidate assertions; harness materializes them into the draft. */
  candidate_assertions: CandidateAssertion[];
  /** Extractor's confidence the input was a real direction. */
  confidence_signal: "high" | "medium" | "low";
  /**
   * Set when the extractor decided the input was not a direction at all
   * (rambling, off-topic, question-shaped). When true, the draft is NOT
   * written; the caller treats it as a no-op.
   */
  not_a_decision: boolean;
}

export interface DecisionExtractorInput {
  /** Raw operator text (slash-arg or free-text body). */
  raw_text: string;
  /** Operator id (for audit / decided_by frontmatter). */
  author_id: string;
  /** When the message was received. ISO timestamp. */
  received_at: string;
  /** Source channel/source for traceability. */
  source: string;
  /**
   * Optional: existing accepted-decision summaries the extractor can cite for
   * supersedes. Each item: `{id, title, scope_summary}`. Order: most recent
   * first. Cap to ~10 per call to keep the prompt bounded.
   */
  accepted_decisions?: { id: string; title: string; scope_summary: string }[];
  /** Tier — default 1 (Haiku) per workflow.md `decision_extractor: 1`. */
  tier: ClaudeTier;
  /** Per-call timeout. Default 120_000 ms. */
  timeout_ms?: number;
}

/** A draft written to `_inbox/`. Returned by writeDecisionDraft. */
export interface DecisionDraft {
  /** Allocated DEC-id. */
  id: string;
  /** Repo-relative path of the draft file. */
  draft_path: string;
  /** Path the draft will move to on accept. */
  canonical_path: string;
  /** Original extractor output (for confirmation rendering). */
  output: DecisionExtractorOutput;
  /** Raw direction text the operator submitted. */
  raw_text: string;
}

/** Operator's verdict on a draft. */
export type DraftConfirmDecision = "commit" | "edit" | "reject";

export interface ConfirmResult {
  decision: DraftConfirmDecision;
  /** Set when decision="commit" — final canonical path of the accepted decision. */
  accepted_path?: string;
  /** Number of ledger entries after regenerate. */
  ledger_size?: number;
  /** Extractor's structured output preserved for downstream observers. */
  draft?: DecisionDraft;
  /** When decision="edit", operator-supplied correction text. */
  correction?: string;
  /** Extractor confidence. */
  confidence?: "high" | "medium" | "low";
}

/** Aggregate result handed back from runDecisionCapture. */
export interface DecisionCaptureResult {
  /** True iff the extractor flagged not_a_decision and the flow short-circuited. */
  short_circuited: boolean;
  /** Set when the extractor produced a draft. */
  draft?: DecisionDraft;
  /** Set when the operator confirmed via the dialog. */
  confirm?: ConfirmResult;
  /**
   * Set when refinement ran after a 🟢 commit. Absent on edit/reject paths,
   * on bypassRefinement, or when the proposer call failed (the accept still
   * succeeds in that case — refinement is best-effort).
   */
  refinement?: RefinementResult;
  /** Total wall-clock time. */
  duration_ms: number;
}

/* -------------------------------------------------------------------------- */
/* Phase 14.x — refinement (lift candidate_assertions → strict assertions).    */
/* -------------------------------------------------------------------------- */

/**
 * The Tier-1 proposer's per-candidate verdict on whether a strict
 * `DecisionAssertion` shape can be formed and what it should contain.
 *
 * The proposer never decides what gets persisted — it just provides a
 * recommendation. The operator's dialog choice determines what actually
 * lands in the file. The runner re-validates each `strict_assertion`
 * against the production `DecisionAssertion` zod before lifting; a
 * proposal that fails zod is downgraded to `demote` automatically.
 */
export interface RefinementProposal {
  /** Stable id of the candidate this proposal corresponds to (`<DEC-id>-A<NN>`). */
  candidate_id: string;
  /** Original loose kind from the candidate. */
  candidate_kind: CandidateAssertion["kind"];
  /**
   * Proposer's verdict:
   *   - `lift`    — confident strict shape; ready to promote into `assertions:`
   *   - `demote`  — too vague to form mechanical params; convert to
   *                 `human_review_hint` (always soft, always zod-valid)
   *   - `skip`    — leave under `candidate_assertions:` for future refinement
   */
  status: "lift" | "demote" | "skip";
  /** Proposer's confidence in its own recommendation. */
  confidence_signal: "high" | "medium" | "low";
  /**
   * Strict params object the proposer recommends. SHAPE depends on
   * `candidate_kind`. Validated against `DecisionAssertion` zod at apply
   * time; an invalid shape forces auto-demote.
   * Only set when status === "lift".
   */
  strict_assertion?: Record<string, unknown>;
  /**
   * Human-readable explanation rendered into the operator dialog.
   * Always present so the operator can audit each proposal at confirm
   * time without reading the raw JSON.
   */
  rationale: string;
}

/** Aggregate output of `proposeStrictAssertions`. */
export interface RefinerOutput {
  /** One proposal per candidate, in original order. */
  proposals: RefinementProposal[];
}

export interface RefinerInput {
  decision_id: string;
  /** Decision's one-line subject (for prompt context). */
  subject: string;
  /** Decision's summary (for prompt context). */
  summary: string;
  /** Repo-relative globs the decision binds. */
  scope_globs: string[];
  /** Candidate assertions to refine. Order preserved on output. */
  candidates: CandidateAssertion[];
  /** Tier — default haiku. */
  tier: ClaudeTier;
  /** Per-call timeout. Default 120_000 ms. */
  timeout_ms?: number;
}

/** Final outcome after operator dialog + lift. */
export interface RefinementResult {
  decision_id: string;
  /** Proposals as returned by the proposer (pre-decision). */
  proposals: RefinementProposal[];
  /** Operator's choice id from the refinement dialog. */
  operator_choice: "approve_all" | "approve_high_only" | "demote_all" | "skip";
  /** Number of candidates lifted into `assertions:`. */
  lifted_count: number;
  /** Number of candidates demoted into `human_review_hint`. */
  demoted_count: number;
  /** Number of candidates kept under `candidate_assertions:`. */
  skipped_count: number;
  /** Set when the proposer threw or returned malformed output. */
  proposer_failed?: boolean;
}
