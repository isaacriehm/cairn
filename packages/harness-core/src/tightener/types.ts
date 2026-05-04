/**
 * Spec tightener (Layer F) per `docs/PRIMER.md` §10. Single Tier-1 (Haiku)
 * call before any code is written.
 */

export interface Ambiguity {
  /** Stable id within this tightener call (e.g. "Q1"). */
  id: string;
  question: string;
  /** Concrete A/B/C/D candidate resolutions; empty when caller must free-text. */
  candidate_resolutions: string[];
}

export interface TightenerOutput {
  ambiguities: Ambiguity[];
  conflicts: string[];
  missing_acceptance: string[];
  scope_concerns: string[];
  existing_stub_overlap: string[];
  /** 0-10 integer; >= 7 AND ready_to_execute → safe to dispatch. */
  spec_quality_score: number;
  ready_to_execute: boolean;
  /**
   * The model's proposed tightened version of the spec body. Must always
   * be set so callers have a fallback when ambiguities exist (the proposal
   * uses the most defensible default per L44).
   */
  tightened_spec_proposal: string;
}

export interface TightenerInput {
  title: string;
  body: string;
  /** Recent decisions in scope (id + summary). Loaded from MCP by caller. */
  decisions_in_scope?: { id: string; title: string; summary: string }[];
  /** Invariants in scope (id + title). Loaded from MCP by caller. */
  invariants_in_scope?: { id: string; title: string }[];
  /** Ground extracts in scope (key + content snippet). */
  ground_extracts?: { key: string; snippet: string }[];
  /** Existing stubs/TODOs the agent may step on. */
  existing_stubs?: string[];
  /** Operator override per L24: ship even when score below threshold. */
  ship_anyway?: boolean;
  /**
   * Force a specific tier instead of the body-length heuristic. Useful for
   * smoke tests and for operators who know they want Sonnet on a touchy
   * spec without rewriting it to trip the auto-escalate threshold.
   */
  force_tier?: "haiku" | "sonnet";
}

export interface TightenerResult {
  /** Raw tightener output as returned by the model. */
  output: TightenerOutput;
  /** Tier actually used (auto-escalated if body length tripped the threshold). */
  tier: "haiku" | "sonnet";
  /** True when the gate passes: score >= floor AND ready_to_execute, OR ship_anyway. */
  ready: boolean;
  /** Quality floor used to compute `ready`. Default 7 per workflow.md `spec_quality_floor`. */
  quality_floor: number;
  /** Wall-clock duration of the model call. */
  duration_ms: number;
  /** Token usage if reported by the CLI. */
  usage?: { input_tokens?: number; output_tokens?: number };
}
