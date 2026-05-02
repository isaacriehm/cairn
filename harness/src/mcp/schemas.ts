import { z } from "zod";

// Each constant below is the input zod RAW SHAPE the MCP SDK accepts directly
// in `registerTool({ inputSchema: ... })`. Keeping them as raw shapes (not
// pre-built objects) lets the SDK convert to JSON Schema for tool listings.

// ── Read tools — graph traversal ───────────────────────────────────────────

export const decisionGetInput = {
  id: z.string().regex(/^DEC-\d{4,}$/, "decision id must match DEC-NNNN"),
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
  id: z.string().regex(/^V\d{4,}$/, "invariant id must match V<NNNN>"),
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

export const appendInput = {
  path: z.string().min(1),
  content: z.string(),
  newline_separator: z.boolean().optional(),
};

export const recordDecisionInput = {
  id: z.string().regex(/^DEC-\d{4,}$/).optional(),
  title: z.string().min(1),
  summary: z.string().min(1),
  scope_globs: z.array(z.string()).min(1),
  supersedes: z.string().optional(),
  assertions: z.array(z.unknown()).optional(),
  human_review_hint: z.string().optional(),
  body_markdown: z.string().optional(),
  target: z.enum(["inbox", "accepted"]).optional(),
};

export const recordRunEventInput = {
  run_id: z.string().min(1),
  event: z.object({
    kind: z.string().min(1),
    payload: z.unknown().optional(),
  }),
};

export const dropTaskInput = {
  title: z.string().min(1),
  body: z.string().min(1),
  intent: z.enum([
    "run_pilot",
    "review_module",
    "fix_issue",
    "eval",
    "staleness_scan",
    "unknown",
  ]),
  target_path_globs: z.array(z.string()).optional(),
  priority: z.number().int().min(1).max(10).optional(),
  parent_task_id: z.string().optional(),
  source: z.string().optional(),
};

export const archiveInput = {
  path: z.string().min(1),
  reason: z.string().min(1),
  archive_dir: z.string().optional(),
};
