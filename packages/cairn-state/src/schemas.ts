import { z } from "zod";

export const Audience = z.enum(["ai-only", "dual", "human-only"]);
export type Audience = z.infer<typeof Audience>;

export const ProvenanceFrontmatter = z
  .object({
    type: z.string().optional(),
    status: z.string().optional(),
    audience: Audience.optional(),
    generated: z.string().optional(),
    "verified-at": z.string().optional(),
    "source-commits": z.array(z.string()).optional(),
    supersedes: z.string().nullish(),
  })
  .passthrough();
export type ProvenanceFrontmatter = z.infer<typeof ProvenanceFrontmatter>;

export const ManifestEntry = z.object({
  path: z.string(),
  sha256: z.string().length(64),
  classification: z.string(),
  audience: z.string().optional(),
  verified_at: z.string().optional(),
  generator: z.string().optional(),
  source: z.string().optional(),
});
export type ManifestEntry = z.infer<typeof ManifestEntry>;

export const Manifest = z.object({
  version: z.literal(1),
  generated: z.string(),
  generator: z.string().optional(),
  files: z.array(ManifestEntry),
});
export type Manifest = z.infer<typeof Manifest>;

export const DecisionAssertion = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    kind: z.literal("schema_must_contain"),
    table: z.string(),
    column: z.string(),
    column_type: z.string().optional(),
    nullable: z.boolean().optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("text_must_match"),
    pattern: z.string(),
    in_globs: z.array(z.string()),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("text_must_not_match"),
    pattern: z.string(),
    in_globs: z.array(z.string()),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("index_must_exist"),
    table: z.string(),
    columns: z.array(z.string()),
    where: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("ast_pattern"),
    language: z.string(),
    pattern: z.string(),
    in_globs: z.array(z.string()),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("file_must_not_be_modified"),
    path: z.string(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("query_must_filter_by"),
    orm: z.string(),
    in_globs: z.array(z.string()),
    table: z.string(),
    columns: z.array(z.string()),
    operator: z.enum(["eq", "in", "between", "is_not_null"]),
    require_combination: z.enum(["and", "or"]),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("route_must_have_guard"),
    in_globs: z.array(z.string()),
    guard: z.string(),
    require_on: z.array(z.string()),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("event_must_emit"),
    in_globs: z.array(z.string()),
    after_method: z.string(),
    event_key: z.string(),
    payload_must_include: z.array(z.string()).optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("service_method_must_call"),
    in_globs: z.array(z.string()),
    in_method: z.string(),
    must_call: z.string(),
    before_returning: z.boolean().optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("human_review_hint"),
    description: z.string(),
  }),
]);
export type DecisionAssertion = z.infer<typeof DecisionAssertion>;

/**
 * sot_kind = where the canonical prose lives for this DEC.
 *   "ledger" — body in this DEC file is canonical (source-comment essay,
 *              operator-recorded). Lens renders body verbatim.
 *   "path"   — sot_path points at the canonical location (doc paragraph,
 *              CLAUDE.md section). Lens renders live content from there.
 */
export const SotKind = z.enum(["ledger", "path"]);
export type SotKind = z.infer<typeof SotKind>;

export const DecisionFrontmatter = z
  .object({
    id: z.string().regex(/^DEC-[0-9a-f]{7,}$/, "decision id must match DEC-<hash7>"),
    title: z.string(),
    type: z.literal("adr").optional(),
    status: z
      .string()
      .refine(
        (s) =>
          s === "accepted" ||
          s === "superseded" ||
          s === "archived" ||
          /^draft(?:-from-[a-z-]+)?$/.test(s),
        "decision status must be draft | draft-from-<source> | accepted | superseded | archived",
      ),
    audience: Audience.optional(),
    generated: z.string().optional(),
    "verified-at": z.string().optional(),
    "source-commits": z.array(z.string()).optional(),
    decided_at: z.string().optional(),
    decided_by: z.string().optional(),
    scope_globs: z.array(z.string()).optional(),
    supersedes: z.string().nullish(),
    superseded_by: z.string().nullish(),
    assertions: z.array(DecisionAssertion).optional(),
    human_review_hint: z.string().optional(),
    related_invariants: z.array(z.string()).optional(),
    sot_kind: SotKind,
    sot_path: z.string().min(1),
    sot_content_hash: z.string().length(64),
    related: z.string().nullish(),
    derived_from: z.string().nullish(),
  })
  .passthrough();
export type DecisionFrontmatter = z.infer<typeof DecisionFrontmatter>;

export const InvariantFrontmatter = z
  .object({
    id: z.string().regex(/^INV-[0-9a-f]{7,}$/, "invariant id must match INV-<hash7>"),
    title: z.string(),
    type: z.literal("invariant").optional(),
    status: z.enum(["active", "superseded", "archived"]).optional(),
    audience: Audience.optional(),
    generated: z.string().optional(),
    "verified-at": z.string().optional(),
    source_run: z.string().optional(),
    source_decision: z.string().nullish(),
    introduced_for_bug: z.string().optional(),
    sensor: z.string().optional(),
    e2e: z.string().optional(),
    naming_convention: z.string().optional(),
    superseded_by: z.string().nullish(),
    sot_kind: SotKind,
    sot_path: z.string().min(1),
    sot_content_hash: z.string().length(64),
    related: z.string().nullish(),
    derived_from: z.string().nullish(),
  })
  .passthrough();
export type InvariantFrontmatter = z.infer<typeof InvariantFrontmatter>;

export const DecisionLedgerEntry = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  scope_globs: z.array(z.string()).optional(),
  supersedes: z.string().nullish(),
  superseded_by: z.string().nullish(),
});
export type DecisionLedgerEntry = z.infer<typeof DecisionLedgerEntry>;

export const InvariantLedgerEntry = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  source_decision: z.string().nullish(),
  superseded_by: z.string().nullish(),
});
export type InvariantLedgerEntry = z.infer<typeof InvariantLedgerEntry>;

export const QualityGrade = z.object({
  module: z.string(),
  score: z.number().min(0).max(100),
  pass_rate: z.number().min(0).max(1),
  drift_count: z.number().int().nonnegative(),
  last_updated: z.string(),
  recent_run_count: z.number().int().nonnegative(),
});
export type QualityGrade = z.infer<typeof QualityGrade>;

export const QualityGrades = z.object({
  version: z.literal(1),
  generated: z.string(),
  modules: z.array(QualityGrade),
});
export type QualityGrades = z.infer<typeof QualityGrades>;

/**
 * Topic-index entry — one row per content-fingerprint slug across all
 * scanned sources. `sot_source` is the canonical source path picked by
 * priority order (docs/* > CLAUDE.md > AGENTS.md > source comments).
 * `candidates` lists every place the same prose appears (one becomes the
 * SoT, the rest become §DEC-<id> cites).
 *
 * `marker_kind` is stamped at walk-time when the SoT block sits under a
 * `cairn:` frontmatter key (file-level) or has a `<!-- cairn:decision -->`
 * / `<!-- cairn:rule -->` HTML comment within 3 lines of its heading
 * (block-level). Phase 6 Stage 3 reads this field directly off the
 * topic-index and bypasses Stages 1+2 (file-purpose + section batch
 * classifiers) for marked entries — the operator has already declared
 * the block authoritative, so Haiku adds no signal.
 *
 * `content_hash` mirrors the SoT block's body hash at walk-time. Used by
 * `cairn_propose_decision` (PR 2) and the alignment hooks to detect
 * source drift before promoting a candidate to a draft.
 */
export const TopicIndexEntry = z.object({
  slug: z.string(),
  dec_id: z.string().optional(),
  sot_source: z.string(),
  candidates: z.array(
    z.object({
      file: z.string(),
      kind: z.enum(["doc", "claudemd", "agentsmd", "rule", "source-comment"]),
      anchor: z.string().optional(),
      line_range: z.tuple([z.number().int(), z.number().int()]).optional(),
    }),
  ),
  created_at: z.string(),
  marker_kind: z.enum(["decision", "rule"]).optional(),
  content_hash: z.string().length(64).optional(),
});
export type TopicIndexEntry = z.infer<typeof TopicIndexEntry>;

export const TopicIndex = z.object({
  version: z.literal(1),
  generated: z.string(),
  topics: z.record(z.string(), TopicIndexEntry),
});
export type TopicIndex = z.infer<typeof TopicIndex>;

/**
 * SoT bindings — bidirectional map between DEC ids and their canonical
 * source paths. Forward index is one-to-one. Reverse index is one-to-many
 * because supersedes chains keep the same sot_path across multiple DEC
 * ids.
 */
export const SotBindings = z.object({
  version: z.literal(1),
  generated: z.string(),
  forward: z.record(z.string(), z.string()),
  reverse: z.record(z.string(), z.array(z.string())),
});
export type SotBindings = z.infer<typeof SotBindings>;

/**
 * Sot-cache — tokenized DEC body shingles for Jaccard pre-filter in the
 * Layer A alignment hook. Mtime-keyed so the cache rebuilds incrementally
 * on PostToolUse Write events.
 */
export const SotCacheEntry = z.object({
  dec_id: z.string(),
  sot_path: z.string(),
  body_hash: z.string().length(64),
  tokens: z.array(z.string()),
  shingles: z.array(z.string()),
  mtime_ms: z.number(),
});
export type SotCacheEntry = z.infer<typeof SotCacheEntry>;

export const SotCache = z.object({
  version: z.literal(1),
  generated: z.string(),
  entries: z.record(z.string(), SotCacheEntry),
});
export type SotCache = z.infer<typeof SotCache>;

/**
 * Anchor-map — external map from topic slug to its current location in
 * source. Allows operator's docs to stay pristine (no `<!-- cairn-anchor -->`
 * injected) while drift detection reconciles via content_hash.
 */
export const AnchorMapEntry = z.object({
  file: z.string(),
  current_anchor: z.string().optional(),
  content_hash: z.string().length(64),
  line_range: z.tuple([z.number().int(), z.number().int()]).optional(),
  kind: z.enum(["doc", "claudemd", "agentsmd", "rule", "source-comment"]),
});
export type AnchorMapEntry = z.infer<typeof AnchorMapEntry>;

export const AnchorMap = z.object({
  version: z.literal(1),
  generated: z.string(),
  anchors: z.record(z.string(), AnchorMapEntry),
});
export type AnchorMap = z.infer<typeof AnchorMap>;

export const DriftEvent = z.object({
  ts: z.string(),
  kind: z.enum([
    "frontmatter_stale",
    "generator_drift",
    "broken_link",
    "orphan_path",
    "orphan_entity",
    "manifest_hash_changed",
    "doc-drift",
    "paragraph-deleted",
    "pre-commit-drift",
  ]),
  path: z.string(),
  detail: z.string().optional(),
  severity: z.enum(["soft", "hard"]).default("soft"),
  dec_id: z.string().optional(),
});
export type DriftEvent = z.infer<typeof DriftEvent>;

/**
 * Layer B pre-commit-drift log entry written by the git pre-commit
 * hook (`cairn hook pre-commit-align`). SessionStart Drain SessionStart drain
 * consumes this file, re-checks each entry against the (possibly
 * changed) source location, and runs the Haiku judge for ambiguous
 * candidates.
 *
 * Path: `.cairn/staleness/pre-commit-deferred.jsonl`.
 *
 * `tier: tier1` — deterministic match passed (Jaccard ≥ 0.85, shingle
 * ≥ 0.6, length ratio 0.5–2.0). SessionStart Drain can auto-cite without Haiku
 * if the block survives.
 *
 * `tier: tier2-3` — Jaccard pre-filter survivors only; Tier 1 didn't
 * fire. SessionStart Drain invokes Haiku dedup judge.
 */
export const PreCommitDriftCandidate = z.object({
  id: z.string(),
  similarity: z.number(),
  body_hash: z.string(),
  sot_path: z.string(),
});
export type PreCommitDriftCandidate = z.infer<typeof PreCommitDriftCandidate>;

export const PreCommitDriftLogEntry = z.object({
  ts: z.string(),
  file: z.string(),
  block_start_line: z.number(),
  block_end_line: z.number(),
  block_content_hash: z.string(),
  block_prose: z.string(),
  tier: z.enum(["tier1", "tier2-3"]),
  candidates: z.array(PreCommitDriftCandidate),
});
export type PreCommitDriftLogEntry = z.infer<typeof PreCommitDriftLogEntry>;

/**
 * Rejected-candidate ledger entry (`.cairn/ground/_rejected.yaml`).
 *
 * Records topic-index slugs the operator (or `ai-curator`) decided are
 * *not* canonical — false positives, research notes, planning prose,
 * etc. The drift sensor reads this file and suppresses any candidate
 * whose slug appears here; phase 6 / `cairn ingest` skip rejected slugs
 * on the next pass instead of re-proposing them.
 *
 * Dedup is by slug. First writer wins the `reason` string; subsequent
 * writes only refresh `rejected_at`. Phase 5b GC drops entries whose
 * slug is no longer present in the freshly-built topic-index.
 */
export const RejectedEntry = z.object({
  slug: z.string(),
  rejected_at: z.string(),
  rejected_by: z.enum(["operator", "ai-curator", "cairn-init"]),
  reason: z.string(),
  sot_source: z.string(),
  line_range: z.tuple([z.number().int(), z.number().int()]).optional(),
});
export type RejectedEntry = z.infer<typeof RejectedEntry>;

export const RejectedYaml = z.object({
  version: z.literal(1),
  generated: z.string(),
  rejected: z.array(RejectedEntry),
});
export type RejectedYaml = z.infer<typeof RejectedYaml>;

/**
 * `.cairn/ground/file-candidates-map.yaml` — per-file count of
 * topic-index entries with `dec_id IS NULL`. Built at the end of phase
 * 5b (and refreshed whenever `dec_id` is stamped — phase 6, the PR 2
 * `cairn_propose_decision` tool, etc.). The read-enrich hook consults
 * this map to inject a candidate-count warning when an AI agent reads a
 * file with unpromoted candidates, without scanning the whole topic
 * index per Read.
 */
export const FileCandidatesMap = z.object({
  version: z.literal(1),
  generated: z.string(),
  file_candidates: z.record(z.string(), z.number().int().nonnegative()),
});
export type FileCandidatesMap = z.infer<typeof FileCandidatesMap>;

/* -------------------------------------------------------------------------- */
/* Source Comment Types (structural)                                          */
/* -------------------------------------------------------------------------- */

export type CommentLang =
  | "js"
  | "py"
  | "rs"
  | "go"
  | "java"
  | "c"
  | "cs"
  | "rb"
  | "sh"
  | "php"
  | "lua"
  | "dart"
  | "kt"
  | "swift"
  | "scala"
  | "unknown";

export type CommentKind = "block" | "jsdoc" | "line-cluster" | "license";

export interface CommentBlock {
  /** Stable per-walk id: `<rel-path>:<startLine>-<endLine>` */
  id: string;
  /** Repo-relative POSIX path. */
  file: string;
  lang: CommentLang;
  kind: CommentKind;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  /** Raw text including comment markers. */
  raw: string;
  /** Stripped prose — markers + leading `*` removed, used for word count. */
  prose: string;
  lineCount: number;
  charCount: number;
  wordCount: number;
  /** Index where `raw` starts in the file (UTF-8 bytes ≈ chars for source). */
  startOffset: number;
  /** Index immediately after `raw`. */
  endOffset: number;
}

/* -------------------------------------------------------------------------- */
/* Mission system — supra-task layer                                          */
/* -------------------------------------------------------------------------- */

/**
 * Per-mission default exit gate, with optional per-phase override in
 * roadmap.md frontmatter.
 *   - `prompt` — Stop hook surfaces inline AskUserQuestion on phase complete.
 *   - `auto`   — cursor advances silently when last phase task graduates.
 *   - `manual` — operator advances explicitly via cairn_mission_advance.
 */
export const MissionExitGate = z.enum(["prompt", "auto", "manual"]);
export type MissionExitGate = z.infer<typeof MissionExitGate>;

export const MissionPhase = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "phase id must be kebab-case ([a-z0-9-]+)"),
  title: z.string().min(1),
  depends_on: z.array(z.string()).default([]),
  exit_criteria: z.string().min(1),
  exit_gate: MissionExitGate.optional(),
});
export type MissionPhase = z.infer<typeof MissionPhase>;

/**
 * Roadmap frontmatter — `.cairn/ground/missions/<id>/roadmap.md`. Lives
 * in committed ground state; multi-dev visible. Phase YAML is canonical;
 * any prose body is operator notes ignored by Cairn parsing.
 */
export const MissionRoadmapFrontmatter = z
  .object({
    mission_id: z.string().regex(/^MIS-[a-z0-9-]+-[0-9a-f]{7}$/, "mission id must match MIS-<slug>-<hash7>"),
    title: z.string().min(1),
    spec_path: z.string().min(1),
    created_at: z.string(),
    exit_gate: MissionExitGate,
    phases: z.array(MissionPhase).min(1),
  })
  .passthrough();
export type MissionRoadmapFrontmatter = z.infer<typeof MissionRoadmapFrontmatter>;

export const MissionPhaseState = z.enum(["pending", "in_progress", "done"]);
export type MissionPhaseState = z.infer<typeof MissionPhaseState>;

export const MissionPhaseProgressEntry = z.object({
  state: MissionPhaseState,
  task_ids: z.array(z.string()).default([]),
  graduated_at: z.string().optional(),
  /**
   * True once a `phase-ready-to-exit` invalidation event has been
   * emitted for this phase. Suppresses re-emission on subsequent task
   * completions within the same phase (prevents the prompt storm where
   * every late task completion re-fires the operator-facing
   * "phase ready to exit" surface). Cleared when the cursor advances
   * past the phase or the phase is reopened.
   */
  ready_emitted: z.boolean().optional(),
  /**
   * Per-phase tightening state. Unset while the phase still needs a
   * just-in-time brief; `drafted` once `cairn_mission_plan_phase` has
   * written a brief the operator hasn't confirmed; `accepted` once the
   * brief is locked and tasks may inherit it. The cursor landing on a
   * phase with `brief_status` unset is the "brief-pending" signal the
   * direction skill reads before creating phase-anchored tasks.
   */
  brief_status: z.enum(["drafted", "accepted"]).optional(),
});
export type MissionPhaseProgressEntry = z.infer<typeof MissionPhaseProgressEntry>;

/**
 * One resolved fork captured during per-phase tightening — the question
 * the brief closed plus the operator's (or, in autonomous mode, the
 * model's) choice. Mirrors a lightweight DEC without graduating to the
 * decision graph; phase-scoped and archived with the mission.
 */
export const MissionPhaseBriefDecision = z.object({
  question: z.string().min(1),
  choice: z.string().min(1),
  rationale: z.string().optional(),
});
export type MissionPhaseBriefDecision = z.infer<
  typeof MissionPhaseBriefDecision
>;

/**
 * Per-phase brief — `.cairn/ground/missions/<id>/briefs/<phase-id>.md`.
 * The just-in-time tightening artifact for a single phase: the forks the
 * operator resolved, the constraints tasks in this phase must honour,
 * the phase acceptance bar, and the in-scope ground-state cites that
 * pre-answered the rest. Committed alongside the roadmap (multi-dev
 * visible). Frontmatter is canonical; prose body is operator notes.
 */
export const MissionPhaseBrief = z
  .object({
    phase_id: z.string().min(1),
    drafted_at: z.string(),
    status: z.enum(["drafted", "accepted"]).default("drafted"),
    autonomous: z.boolean().optional(),
    decisions: z.array(MissionPhaseBriefDecision).default([]),
    constraints: z.array(z.string()).default([]),
    acceptance: z.array(z.string()).default([]),
    cite_decisions: z.array(z.string()).default([]),
    cite_invariants: z.array(z.string()).default([]),
  })
  .passthrough();
export type MissionPhaseBrief = z.infer<typeof MissionPhaseBrief>;

export const MissionCursor = z.object({
  active_phase: z.string().nullable(),
  active_phase_started_at: z.string().nullable(),
});
export type MissionCursor = z.infer<typeof MissionCursor>;

export const MissionOutcome = z.enum(["active", "done", "aborted"]);
export type MissionOutcome = z.infer<typeof MissionOutcome>;

/**
 * Per-clone mission state — `.cairn/missions/<id>/state.json`.
 * Tracks the cursor + phase progress. Never committed (gitignored under
 * `.cairn/missions/`).
 */
export const MissionState = z.object({
  mission_id: z.string(),
  started_at: z.string(),
  cursor: MissionCursor,
  phase_progress: z.record(z.string(), MissionPhaseProgressEntry),
  outcome: MissionOutcome.default("active"),
  closed_at: z.string().optional(),
  abort_reason: z.string().optional(),
});
export type MissionState = z.infer<typeof MissionState>;

/**
 * Mission journal entry — `.cairn/missions/<id>/journal.jsonl`. One
 * record per mission-level event (start, advance, resync, close).
 */
export const MissionJournalEntry = z.object({
  ts: z.string(),
  kind: z.enum([
    "started",
    "phase-advanced",
    "phase-deferred",
    "phase-brief-set",
    "task-attached",
    "resync-pending",
    "resync-applied",
    "drift-detected",
    "closed",
    "reopened",
    "exit-gate-changed",
  ]),
  phase_id: z.string().optional(),
  task_id: z.string().optional(),
  detail: z.string().optional(),
});
export type MissionJournalEntry = z.infer<typeof MissionJournalEntry>;
