import { z } from "zod";

// Each constant below is the input zod RAW SHAPE the MCP SDK accepts directly
// in `registerTool({ inputSchema: ... })`. Keeping them as raw shapes (not
// pre-built objects) lets the SDK convert to JSON Schema for tool listings.

// ── Read tools — graph traversal ───────────────────────────────────────────

export const decisionGetInput = {
  id: z.string().regex(/^DEC-[0-9a-f]{7,}$/, "decision id must match DEC-<hash7>"),
};

export const decisionsInScopeInput = {
  path_globs: z.array(z.string()).min(1),
  status: z.array(z.enum(["draft", "accepted", "superseded", "archived"])).optional(),
};

export const decisionsForSymbolInput = {
  file: z.string().min(1),
  symbol: z.string().min(1),
};

export const canonicalForTopicInput = {
  topic: z.string().min(1),
};

export const groundGetInput = {
  category: z.enum([
    "schema",
    "routes",
    "events",
    "quality_grades",
    "glossary",
    "manifest",
  ]),
  key: z.string().optional(),
};

export const supersedesChainInput = {
  decision_id: z.string().min(1),
};

export const invariantGetInput = {
  id: z.string().regex(/^INV-[0-9a-f]{7,}$/, "invariant id must match INV-<hash7>"),
};

export const invariantsInScopeInput = {
  path_globs: z.array(z.string()).min(1),
  status: z.array(z.enum(["active", "superseded"])).optional(),
};

// ── Read tools — 3-layer progressive retrieval ─────────────────────────────

export const searchInput = {
  query: z.string().min(1),
  scope: z.array(z.string()).optional(),
  kinds: z.array(z.enum(["decision", "invariant", "task", "run", "doc", "manifest"])).optional(),
  limit: z.number().int().positive().max(50).optional(),
};

export const timelineInput = {
  scope: z.array(z.string()).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  kinds: z.array(z.string()).optional(),
};

export const getFullInput = {
  id: z.string().min(1),
  kind: z.enum(["decision", "invariant", "task", "run"]),
};

// ── Read tools — historical zone (gated) ───────────────────────────────────

export const queryHistoryInput = {
  scope: z.string().min(1),
  path_hint: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
};

// ── Write tools ────────────────────────────────────────────────────────────

export const taskCreateInput = {
  slug: z
    .string()
    .regex(
      /^[a-z][a-z0-9-]{1,40}[a-z0-9]$/,
      "slug must be lowercase kebab — letters, digits, hyphens; 3-42 chars",
    ),
  title: z
    .string()
    .min(3)
    .max(50, "title must be ≤50 chars (renders in the statusline + lens)"),
  goal: z.string().min(1),
  target_path_globs: z.array(z.string().min(1)).min(1),
  in_scope_decisions: z
    .array(z.string().regex(/^DEC-[0-9a-f]{7,}$/, "decision id must match DEC-<hash7>"))
    .optional(),
  in_scope_invariants: z
    .array(z.string().regex(/^INV-[0-9a-f]{7,}$/, "invariant id must match INV-<hash7>"))
    .optional(),
  constraints: z.array(z.string().min(1)).optional(),
  out_of_scope: z.array(z.string().min(1)).optional(),
  acceptance: z.array(z.string().min(1)).optional(),
  module: z.string().optional(),
};

export const recordDecisionInput = {
  id: z.string().regex(/^DEC-[0-9a-f]{7,}$/).optional(),
  title: z.string().min(1),
  summary: z.string().min(1),
  scope_globs: z.array(z.string()).min(1),
  supersedes: z.string().optional(),
  assertions: z.array(z.unknown()).optional(),
  human_review_hint: z.string().optional(),
  body_markdown: z.string().optional(),
  target: z.enum(["inbox", "accepted"]).optional(),
};

export const archiveInput = {
  path: z.string().min(1),
  reason: z.string().min(1),
  archive_dir: z.string().optional(),
};

export const resolveAttentionInput = {
  /**
   * Item id from the attention skill — DEC-NNNN for a draft, the
   * baseline finding key (e.g. `BASELINE-stub_catalog_hits-services/auth.ts`)
   * for sensor findings, the event filename for invalidation events.
   *
   * For kind=bypass, item_id is the full SHA of the FIRST flagged commit
   * (the rest go in flagged_items). For kind=review, item_id is the
   * task_id of the FIRST pending review. For kind=conflict, item_id is
   * the conflict filename slug `<a-id>__<b-id>` (without `.md`).
   */
  item_id: z.string().min(1),
  /**
   * Operator's pick from the inline A/B/C/D. The fourth slot is only
   * meaningful for `conflict` kind (archive-both per plan §5.4.1); other
   * kinds reject `d`.
   */
  choice: z.enum(["a", "b", "c", "d"]),
  /**
   * Item kind — narrows the resolution path. The skill knows the kind
   * from the item it surfaced.
   *
   * `bypass`   — Stop hook surfaced N commits not in `.attested-commits`.
   *              choice=a record-bypass (DEC), b accept-as-noted, c defer.
   * `review`   — Stop hook surfaced N pending reviewer attestations.
   *              choice=a spawn-now, b skip, c defer.
   * `conflict` — Phase 7c contradiction judge wrote a conflict file.
   *              choice=a keep A (supersede B), b keep B (supersede A),
   *              c merge into a fresh DEC (both old superseded),
   *              d archive both (move conflict file to _archived/).
   *              Plan §5.4.1 — never rewrites source files.
   * `alignment_pending` — Layer A's Pass-2 dedup or creation judge stayed
   *              ambiguous and wrote `.cairn/ground/alignment-pending/<slug>.md`
   *              for operator triage (plan §4.1.A / §4.1.B).
   *              For tier2-ambiguous (paired with an existing entity):
   *                a=same (cite existing + strip), b=augments (sibling DEC
   *                linked via `related` + double-cite), c=new (fresh DEC),
   *                d=replace (new supersedes existing).
   *              For tier3-ambiguous (no candidate):
   *                a=decision (fresh DEC + cite), b=constraint (fresh INV
   *                + cite), c=descriptive (drop pending, leave source),
   *                d=none-of-these (drop pending, leave source untouched).
   */
  kind: z.enum([
    "decision_draft",
    "baseline_finding",
    "invalidation_event",
    "drift",
    "bypass",
    "review",
    "conflict",
    "alignment_pending",
  ]),
  /**
   * Full SHA / task_id list for the bypass / review snapshot. Used
   * with choice=c so the defer file knows which items to suppress.
   * Optional for the other kinds (item_id alone identifies them).
   */
  flagged_items: z.array(z.string().min(1)).optional(),
  /** Override the defer window (hours). Default 24. Only meaningful when choice=c. */
  defer_hours: z.number().int().min(1).max(24 * 30).optional(),
  /** Optional free-text — when choice=c the operator may type a rationale. */
  rationale: z.string().optional(),
};

export const alignDrainInput = {
  /**
   * Hard cap on Haiku judge calls. Excess entries stay in the deferred
   * logs for a future drain. Default 30 (plan §4.3 budget).
   */
  max_haiku_calls: z.number().int().min(0).max(200).optional(),
  /**
   * Dry-run: classify every entry and report what would happen but do
   * not strip-replace source files, write alignment-pending records,
   * or truncate the deferred logs.
   */
  dry_run: z.boolean().optional(),
};

