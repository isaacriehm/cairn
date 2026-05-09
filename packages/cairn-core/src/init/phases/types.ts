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

import type { DetectionResult } from "../types.js";
import type { RepoSummary } from "../walker.js";
import type { IngestionResult } from "../ingest-docs.js";
import type { RunRulesMergeResult } from "../rules-merge/index.js";
import type { BaselineAuditResult } from "../baseline-audit.js";
import type { MultiDevInstallResult } from "../multi-dev/index.js";
import type { MapperResultPersisted } from "./mapper-output-io.js";
import type { IngestSourceCommentsResultPersisted } from "./source-comments-output-io.js";
import type { TopicIndexPhaseOutput } from "./7-topic-index.js";

/** Phase ids in execution order. */
export const PHASE_IDS = [
  "1-detect",
  "2-walker",
  "3-mapper",
  "4-seed",
  "5-pilot",
  "6-brand",
  "7-topic-index",
  "8-docs-ingest",
  "9-source-comments",
  "10-rules-merge",
  "11-baseline",
  "12-strip",
  "13-multidev",
] as const;

export type PhaseId = (typeof PHASE_IDS)[number];

/** Inline A/B/C question rendered via AskUserQuestion in the skill. */
export interface PhaseQuestion {
  /** Stable identifier so the skill can correlate answers across re-invocations. */
  id: string;
  /** Operator-facing prompt — full plain English; no operator-personal voice. */
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

export interface SeedPhaseOutput {
  written_files: string[];
  collisions: string[];
  config_path: string;
  scope_index_path: string;
  workflow_slug_patched: boolean;
  workflow_patch_error: string | null;
  attested_seeded: number;
  attested_seed_status: "ok" | "skipped" | "error";
}

export interface PilotOutput {
  picked: string;
}

export interface BrandOutput {
  choice: string;
  applied: { updated: string[]; warnings: string[] } | null;
}

export interface StripState {
  pending: string[];
  decisions: Record<string, "strip" | "keep" | "skip">;
}

export interface PhaseOutputs {
  "1-detect"?: DetectionResult;
  "2-walker"?: RepoSummary;
  "3-mapper"?: MapperResultPersisted;
  "4-seed"?: SeedPhaseOutput;
  "5-pilot"?: PilotOutput;
  "6-brand"?: BrandOutput;
  "7-topic-index"?: TopicIndexPhaseOutput;
  "8-docs-ingest"?: IngestionResult;
  "9-source-comments"?: IngestSourceCommentsResultPersisted;
  "10-rules-merge"?: RunRulesMergeResult;
  "11-baseline"?: BaselineAuditResult;
  "12-strip"?: StripState;
  "13-multidev"?: MultiDevInstallResult;
}

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
