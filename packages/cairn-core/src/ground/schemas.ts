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
    supersedes: z.string().nullable().optional(),
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

export const DecisionFrontmatter = z
  .object({
    id: z.string().regex(/^DEC-\d{4,}$/, "decision id must match DEC-NNNN"),
    title: z.string(),
    type: z.literal("adr").optional(),
    status: z.enum(["draft", "accepted", "superseded", "archived"]),
    audience: Audience.optional(),
    generated: z.string().optional(),
    "verified-at": z.string().optional(),
    "source-commits": z.array(z.string()).optional(),
    decided_at: z.string().optional(),
    decided_by: z.string().optional(),
    scope_globs: z.array(z.string()).optional(),
    supersedes: z.string().nullable().optional(),
    superseded_by: z.string().nullable().optional(),
    assertions: z.array(DecisionAssertion).optional(),
    human_review_hint: z.string().optional(),
    related_invariants: z.array(z.string()).optional(),
  })
  .passthrough();
export type DecisionFrontmatter = z.infer<typeof DecisionFrontmatter>;

export const InvariantFrontmatter = z
  .object({
    id: z.string().regex(/^V\d{4,}$/, "invariant id must match V<NNNN>"),
    title: z.string(),
    type: z.literal("invariant").optional(),
    status: z.enum(["active", "superseded"]).optional(),
    audience: Audience.optional(),
    generated: z.string().optional(),
    "verified-at": z.string().optional(),
    source_run: z.string().optional(),
    source_decision: z.string().nullable().optional(),
    introduced_for_bug: z.string().optional(),
    sensor: z.string().optional(),
    e2e: z.string().optional(),
    naming_convention: z.string().optional(),
    superseded_by: z.string().nullable().optional(),
  })
  .passthrough();
export type InvariantFrontmatter = z.infer<typeof InvariantFrontmatter>;

export const DecisionLedgerEntry = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  scope_globs: z.array(z.string()).optional(),
  supersedes: z.string().nullable().optional(),
  superseded_by: z.string().nullable().optional(),
});
export type DecisionLedgerEntry = z.infer<typeof DecisionLedgerEntry>;

export const InvariantLedgerEntry = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  source_decision: z.string().nullable().optional(),
  superseded_by: z.string().nullable().optional(),
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

export const DriftEvent = z.object({
  ts: z.string(),
  kind: z.enum([
    "frontmatter_stale",
    "generator_drift",
    "broken_link",
    "orphan_path",
    "manifest_hash_changed",
  ]),
  path: z.string(),
  detail: z.string().optional(),
  severity: z.enum(["soft", "hard"]).default("soft"),
});
export type DriftEvent = z.infer<typeof DriftEvent>;
