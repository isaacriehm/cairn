/**
 * Phase types for the MCP-native init pipeline.
 *
 * Each phase is a function `(ctx, state) → PhaseResult` registered as
 * an MCP tool. The cairn-adopt skill drives the pipeline by invoking
 * `cairn_init_resume` to read the next phase id, then calling the
 * phase tool. When the phase returns `needs_input`, the skill renders
 * an inline `AskUserQuestion`, threads the answer back, and re-invokes
 * the same phase tool until it returns `complete` with the next id.
 *
 * State persists to `.cairn/init-state.json` between phases so the
 * pipeline is crash-safe — operator can `/exit` Claude Code mid-init
 * and pick up at the same phase on the next session.
 */

/** Phase ids in execution order. */
export const PHASE_IDS = [
  "1-detect",
  "2-walker",
  "3-mapper",
  "3b-seed",
  "4-pilot",
  "5-brand",
  "5b-topic-index",
  "6-docs-ingest",
  "7b-source-comments",
  "7c-rules-merge",
  "8-baseline",
  "10-strip",
  "12-multidev",
] as const;

export type PhaseId = (typeof PHASE_IDS)[number];

/** Inline A/B/C question rendered via AskUserQuestion in the skill. */
export interface PhaseQuestion {
  /** Stable identifier so the skill can correlate answers across re-invocations. */
  id: string;
  /** Operator-facing prompt — full English, not caveman. */
  prompt: string;
  /** Options labeled A/B/C/... */
  options: PhaseOption[];
  /** Default option id (used when operator skips or auto-pilot is set). */
  default: string;
}

export interface PhaseOption {
  /** Internal id stored back into state.answer when chosen. */
  id: string;
  /** Operator-visible label. */
  label: string;
  /** Optional secondary line — displayed under the label. */
  detail?: string;
}

/**
 * State carried between phase invocations. `outputs` accumulates each
 * phase's typed result keyed by phase id; `answer` is set by the skill
 * driver when re-invoking a phase that returned `needs_input`.
 */
export interface PhaseState {
  /** Repo root the pipeline is operating against. */
  repoRoot: string;
  /** The phase currently executing. */
  currentPhase: PhaseId;
  /** Accumulated outputs keyed by phase id. */
  outputs: PhaseOutputs;
  /** Operator's answer to the last `needs_input` question (if any). */
  answer?: string | undefined;
  /** When the pipeline started (ISO-8601). */
  startedAt: string;
  /** Schema version for the on-disk state file (bump on breaking change). */
  schemaVersion: 1;
}

/**
 * Phase outputs are deliberately loose-typed — each phase function
 * stamps its own typed result under its id. Downstream phases read
 * via type-narrowing helpers in their own modules.
 */
export type PhaseOutputs = {
  -readonly [K in PhaseId]?: unknown;
};

/** Discriminated union returned by every phase function. */
export type PhaseResult =
  | {
      readonly status: "complete";
      /** Next phase id to invoke; null = pipeline done. */
      readonly nextPhase: PhaseId | null;
      readonly state: PhaseState;
    }
  | {
      readonly status: "needs_input";
      readonly question: PhaseQuestion;
      readonly state: PhaseState;
    }
  | {
      readonly status: "error";
      readonly error: PhaseError;
      readonly state: PhaseState;
    };

/** Phase failure mode — propagates back to the skill for operator surfacing. */
export interface PhaseError {
  /** Stable error code; the skill can pattern-match for retry semantics. */
  code: string;
  /** Operator-facing message. */
  message: string;
  /** Optional captured stderr / stack for diagnostics. */
  detail?: string;
}

/** Step the orchestrator is reporting on. Used by the resume entry point. */
export interface ResumeReport {
  readonly status: "ready" | "done";
  readonly nextPhase: PhaseId | null;
  readonly state: PhaseState;
}
