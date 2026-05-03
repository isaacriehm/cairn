import type { ClaudeTier } from "../claude/index.js";
import type { FrontendAdapter } from "../frontend/index.js";
import type { ReviewVerdict } from "../reviewer/types.js";
import type { ProjectGlobs, SensorLanguage, SensorSweepResult } from "../sensors/types.js";
import type { UatDecision, UatRunnerInput } from "../uat/types.js";

/**
 * Phases a code-class run can be in. The lifecycle is linear; no skipping.
 *
 *   queued       — accepted from the inbox; waiting for the FIFO to drain
 *   tightening   — Layer F spec tightener (Phase 7) is running
 *   blocked      — tightener returned ready=false; awaiting operator answers
 *   prepping     — workspace prep: mirror sync + SHA pin + dirty-overlap gate
 *   running      — agent subprocess executing inside the mirror
 *   succeeded    — agent finished; sensors / reviewer / UAT gates are later phases
 *   failed       — terminal: tightener errored, workspace gate refused, agent timed
 *                  out, or stream parse failed
 *
 * Phase 8 minimum exercises queued → prepping → running → succeeded | failed.
 * `tightening` and `blocked` are wired but Phase 8 lets the smoke bypass via
 * `bypass_tightener` to avoid spending Sonnet quota on every run.
 */
export type RunPhase =
  | "queued"
  | "tightening"
  | "blocked"
  | "prepping"
  | "running"
  | "sensing"
  | "reviewing"
  | "uat"
  | "backpropping"
  | "succeeded"
  | "failed";

/**
 * Persisted at `.harness/runs/active/<run_id>/meta.json`. The orchestrator
 * writes this on every phase transition. The grounding daemon's drift
 * detector reads it for module-health quality grades.
 */
export interface RunMeta {
  run_id: string;
  task_id: string;
  agent_role: "implementer";
  phase: RunPhase;
  started_at: string;
  finished_at?: string;
  tier: ClaudeTier;
  model: string;
  mirror_path: string;
  /** SHA captured at workspace prep (origin/main pin). */
  sha_pin?: string;
  events_count: number;
  duration_ms?: number;
  /** Populated when phase = "failed". */
  error?: string;
  /** Populated when tightener ran. */
  tightener_score?: number;
  tightener_ready?: boolean;
  /** Source channel id when ingested via Discord — used for postTaskUpdate. */
  channel_id?: string;
  /** Number of agent attempts dispatched (1 = no retries). */
  attempts?: number;
  /** Per-attempt sensor sweep summary; persisted in events log too. */
  sensor_history?: {
    attempt: number;
    ok: boolean;
    hard_failures: number;
    soft_findings: number;
    sensor_ids_failed: string[];
  }[];
  /** Final sweep result reference for downstream layers. */
  last_sensor_sweep?: Pick<
    SensorSweepResult,
    "ok" | "hard_failures" | "soft_findings"
  >;
  /** Per-attempt reviewer subagent (Layer C) summary. */
  reviewer_history?: {
    attempt: number;
    ok: boolean;
    verdict: ReviewVerdict;
    hard_gaps: number;
    soft_gaps: number;
    confidence_signal: "high" | "medium" | "low";
  }[];
  last_reviewer?: {
    ok: boolean;
    verdict: ReviewVerdict;
    hard_gaps: number;
    soft_gaps: number;
    confidence_signal: "high" | "medium" | "low";
  };
  /** Per-attempt UAT (Layer U) summary. */
  uat_history?: {
    attempt: number;
    ok: boolean;
    all_passed: boolean;
    probe_failures: number;
    operator_decision: UatDecision;
  }[];
  last_uat?: {
    ok: boolean;
    all_passed: boolean;
    probe_failures: number;
    operator_decision: UatDecision;
  };
  /** Backprop subagent (Phase 13) summary. Set when backprop ran. */
  last_backprop?: {
    ok: boolean;
    invariant_id: string;
    invariant_path: string;
    sensor_path: string;
    enforcement_kind: "regex_sensor" | "named_e2e";
    /** Commit SHA on the mirror; undefined if commit step skipped/failed. */
    commit_sha?: string;
    /** Set when ok=false; agent threw / write failed / commit threw. */
    error?: string;
  };
}

/**
 * Shape of a `task` row dropped to `.harness/inbox/<...>.json` by adapters.
 * The orchestrator is tolerant — fields beyond `task_id` and `task` are
 * optional and just plumb through to the run.
 */
export interface InboxTaskRow {
  kind: "task";
  source: string;
  received_at: string;
  task_id?: string;
  task: {
    rawText: string;
    intent: string;
    authorId: string;
    channelId?: string;
    guildId?: string;
    messageId?: string;
    receivedAt?: string;
  };
  classification?: { intent: string; confidence: number; source: string };
  free_text?: unknown;
  slash?: unknown;
  /** Optional override per L24 / WORKFLOW_GUIDE §4.5. */
  ship_anyway?: boolean;
  /** Globs the run is expected to touch — used for dirty-overlap. */
  target_path_globs?: string[];
  /** Optional title override (otherwise derived from rawText[0..80]). */
  title?: string;
  /** Optional acceptance criteria pre-supplied. */
  acceptance_criteria?: string[];
}

export interface OrchestratorOptions {
  /** Project name as registered with mirror (slug, not display). */
  projectName: string;
  /** Repo root for inbox + runs + tasks dirs (typically the mirror path). */
  repoRoot: string;
  /** Adapters used for surfacing run progress + dialogs. */
  adapters: FrontendAdapter[];
  /** Skip the spec tightener (Phase 7). Smoke convenience. Default false. */
  bypassTightener?: boolean;
  /** Skip the sensor sweep (Phase 9). Smoke convenience. Default false. */
  bypassSensors?: boolean;
  /** Skip the reviewer subagent (Phase 10). Smoke convenience. Default false. */
  bypassReviewer?: boolean;
  /** Skip the UAT pipeline (Phase 11). Smoke convenience. Default false. */
  bypassUat?: boolean;
  /**
   * Skip the backprop subagent (Phase 13). Smoke convenience. Default
   * false — production runs invoke backprop on every successful code-class
   * UAT-approved run.
   */
  bypassBackprop?: boolean;
  /**
   * Override the backprop tier. Default = `tier_assignment.backprop_author`
   * from workflow.md (Tier 2 / Sonnet). Smokes drop to Tier 1 (Haiku) for
   * speed + quota.
   */
  backpropTier?: ClaudeTier;
  /**
   * Tier for the decision-capture extractor (Phase 14). Default = haiku
   * per workflow.md `decision_extractor: 1`. Sonnet may be useful when
   * directions are long-form and a Haiku miss-classifies them.
   */
  decisionExtractorTier?: ClaudeTier;
  /**
   * Confirm-dialog timeout for the decision-capture flow. Default 60_000
   * ms. Smokes drop this to a few seconds so stub adapters resolve fast.
   */
  decisionConfirmTimeoutMs?: number;
  /**
   * Skip the post-commit refinement step (Phase 14.x). Default false.
   * Smokes that don't care about refinement (e.g. `smoke:decision-capture`)
   * flip this on to keep the flow pure-mechanical.
   */
  bypassRefinement?: boolean;
  /**
   * Tier for the refinement-proposer call. Default = decisionExtractorTier
   * (haiku). The refiner is small JSON in / small JSON out; haiku is
   * sufficient for almost every case.
   */
  refinementTier?: ClaudeTier;
  /** Refinement-dialog timeout. Default 60_000 ms. */
  refinementDialogTimeoutMs?: number;
  /**
   * UAT-runner hints surfaced to the agent — base URL for http probes,
   * cli prefix/cwd, and which heavier probe surfaces are available
   * (ui/sql/integration). Adopted from `<project>:` extension block at
   * init. Defaults exclude the heavy surfaces; ui/sql/integration must be
   * explicitly enabled via setup:uat-* helpers per Phase 11.5/11.6.
   */
  uatHints?: UatRunnerInput["hints"];
  /**
   * Cold-start smoke command (e.g. `pnpm db:reset && pnpm db:migrate &&
   * pnpm start:dev`). Recorded as a single command + args; orchestrator
   * spawns it before probes when the UAT-runner sets `cold_start_smoke=true`.
   */
  uatColdStartCommand?: { command: string; args: string[]; cwd?: string };
  /**
   * Override the post-reject A/B/C/D dialog timeout. Default 24h per
   * UAT_PIPELINE.md §9 (`uat_decision_seconds`). Smokes pass a short
   * value so stub adapters resolve quickly.
   */
  uatRejectDialogTimeoutMs?: number;
  /** Override the question agent's tier. Default: same tier as implementer. */
  uatQuestionTier?: ClaudeTier;
  /** Cap on ❓ Ask iterations per run. Default 5 in runUat. */
  uatMaxQuestionRounds?: number;
  /**
   * Force this tier for the implementer. Default: haiku (cheap; raise to
   * sonnet for code-class tasks once Phase 9+ adds trust-class detection).
   */
  defaultTier?: ClaudeTier;
  /** Inbox poll interval — chokidar fires events but we also poll for safety. */
  pollIntervalMs?: number;
  /** Per-run hard timeout. Default 600_000 ms (10 min). */
  runTimeoutMs?: number;
  /** Allowed tools list passed to `claude --allowed-tools`. */
  allowedTools?: string[];
  /** Stack-profile language list — filters Layer A patterns. Default ["typescript"]. */
  sensorLanguages?: SensorLanguage[];
  /** Resolved <project>: extension globs from workflow.md. Default {}. */
  projectGlobs?: ProjectGlobs;
  /**
   * Max agent attempts before the run is failed-honesty-checked. Default 3
   * per L42 (max_attempts_per_task=3, attempt 2 = first sensor-feedback retry).
   */
  maxAttempts?: number;
}

export interface QueueEntry {
  run_id: string;
  task_id: string;
  enqueued_at: string;
  row: InboxTaskRow;
  /** Where the inbox row file lives — moved to processed/ on completion. */
  inbox_file: string;
}
