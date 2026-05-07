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
  related_invariants: z.array(z.string()).optional(),
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
 * hook (`cairn hook pre-commit-align`). Layer C SessionStart drain
 * consumes this file, re-checks each entry against the (possibly
 * changed) source location, and runs the Haiku judge for ambiguous
 * candidates.
 *
 * Path: `.cairn/staleness/pre-commit-deferred.jsonl`.
 *
 * `tier: tier1` — deterministic match passed (Jaccard ≥ 0.85, shingle
 * ≥ 0.6, length ratio 0.5–2.0). Layer C can auto-cite without Haiku
 * if the block survives.
 *
 * `tier: tier2-3` — Jaccard pre-filter survivors only; Tier 1 didn't
 * fire. Layer C invokes Haiku dedup judge.
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
