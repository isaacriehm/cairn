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
import type { BaselineAuditResult } from "../baseline-audit.js";
import type { MultiDevInstallResult } from "../multi-dev/index.js";
import type { MapperResultPersisted } from "./mapper-output-io.js";
import type { TopicIndexPhaseOutput } from "./7-topic-index.js";
import type { PreflightOutput } from "./5-preflight.js";

/** Phase ids in execution order. */
export const PHASE_IDS = [
  "1-detect",
  "2-walker",
  "3-mapper",
  "4-seed",
  "5-preflight",
  "6-brand",
  "7-topic-index",
  "8-docs-ingest",
  "9a-walker",
  "9b-curate",
  "9c-emit",
  "9d-comp-walk",
  "9e-comp-annotate",
  "9f-comp-emit",
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
  schemaVersion: 3;
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

export interface BrandOutput {
  choice: string;
  applied: { updated: string[]; warnings: string[] } | null;
}

export interface StripState {
  pending: string[];
  decisions: Record<string, "strip" | "keep" | "skip">;
}

/**
 * Output of phases collapsed to no-ops by the curator pipeline merge
 * (Phase 8 docs-ingest + Phase 10 rules-merge in v0.9.0). The runners
 * stay registered so resumes from old state files don't blow up; they
 * stamp this marker into outputs and advance.
 */
export interface NoopPhaseOutput {
  skipped: "merged-into-9-curator" | "self-adopt";
}

/**
 * Output of the unified curator walker (9a-walker). Counts what the
 * regex pre-filter let through and points to the on-disk corpus +
 * shard plan the skill driver picks up.
 */
export interface WalkerOutput {
  skipped?: "self-adopt";
  /** Repo-relative path to the spilled corpus.jsonl. */
  corpus_path?: string;
  /** Repo-relative path to the spilled shards.json. */
  shards_path?: string;
  /** Total surviving records across all sub-walkers. */
  records_total?: number;
  /** Per-source-kind count. */
  records_by_kind?: { comment: number; doc: number; rule: number };
  /** Records dropped by the regex pre-filter, by reason. */
  dropped?: Record<string, number>;
  /** Number of shards produced by the packer. */
  shards?: number;
  /** Total estimated input tokens across shards. */
  total_input_tokens_estimate?: number;
}

/**
 * Output stamped by the 9b-curate runner. The map+reduce dispatch is
 * skill-driven (parallel subagents write JSONL); the runner merely
 * confirms `final.jsonl` exists, counts its entries, and advances.
 */
export interface CurateOutput {
  skipped?: "self-adopt";
  /** Repo-relative path to final.jsonl. */
  final_path?: string;
  /** Number of candidate entries the reducer emitted. */
  final_entries?: number;
}

/**
 * Output of the deterministic emit phase (9c-emit). Records what
 * passed the strict validators and what dropped silently.
 */
export interface EmitOutput {
  skipped?: "self-adopt";
  decsWritten?: { id: string; path: string; title: string }[];
  invsWritten?: { id: string; path: string; title: string }[];
  dropped?: number;
  dropReasons?: Record<string, number>;
}

/**
 * Output of the deterministic component-walk phase (9d-comp-walk): the
 * corpus of files missing a `@cairn` header that the annotate step
 * (9e) works from. No-ops on self-adopt or when the project carries no
 * `components:` config (those skip the whole component trio).
 */
export interface CompWalkOutput {
  skipped?: "self-adopt" | "no-components";
  /** Scanned component files missing a `@cairn` header. */
  missing_count?: number;
  /** Repo-relative path to the missing-header corpus JSONL. */
  corpus_path?: string;
}

/**
 * Output of the skill-driven annotate phase (9e-comp-annotate). The
 * cairn-adopt skill dispatches `component-annotator` subagents that
 * write headers into source; this runner confirms how many of the
 * walk's missing files now carry a header and advances.
 */
export interface CompAnnotateOutput {
  skipped?: "self-adopt" | "no-components" | "nothing-missing";
  /** Files from the walk corpus that now carry a `@cairn` header. */
  annotated?: number;
  /** Files still missing a header (surface as debt in 9f). */
  still_missing?: number;
}

/**
 * Output of the deterministic component-emit phase (9f-comp-emit).
 * No-ops on self-adopt / no `components:` config. Otherwise records
 * what the index build, singleton→§INV draft, and advisory audit
 * produced.
 */
export interface ComponentsPhaseOutput {
  skipped?: "self-adopt" | "no-components";
  /** Components written to the derived index. */
  indexed?: number;
  /** Scanned component files missing a `@cairn` header. */
  missing?: number;
  /** `@singleton` headers promoted to §INV ledger entries. */
  singletons_drafted?: number;
  /** Advisory audit findings (inline rebuilds + name collisions). */
  audit_findings?: number;
  /** Repo-relative baseline file written for attention triage, when non-empty. */
  baseline_path?: string;
}

export interface PhaseOutputs {
  "1-detect"?: DetectionResult;
  "2-walker"?: RepoSummary;
  "3-mapper"?: MapperResultPersisted;
  "4-seed"?: SeedPhaseOutput;
  "5-preflight"?: PreflightOutput;
  "6-brand"?: BrandOutput;
  "7-topic-index"?: TopicIndexPhaseOutput;
  "8-docs-ingest"?: NoopPhaseOutput;
  "9a-walker"?: WalkerOutput;
  "9b-curate"?: CurateOutput;
  "9c-emit"?: EmitOutput;
  "9d-comp-walk"?: CompWalkOutput;
  "9e-comp-annotate"?: CompAnnotateOutput;
  "9f-comp-emit"?: ComponentsPhaseOutput;
  "10-rules-merge"?: NoopPhaseOutput;
  "11-baseline"?: BaselineAuditResult;
  "12-strip"?: StripState;
  "13-multidev"?: MultiDevInstallResult & {
    /** Number of files in the manifest after the phase 13 finalize rebuild. */
    manifest_files?: number;
  };
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
