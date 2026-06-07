import { z } from "zod";

// Each constant below is the input zod RAW SHAPE the MCP SDK accepts directly
// in `registerTool({ inputSchema: ... })`. Keeping them as raw shapes (not
// pre-built objects) lets the SDK convert to JSON Schema for tool listings.

// ── Read tools — graph traversal ───────────────────────────────────────────

export const decisionGetInput = {
  // Relaxed: accept any ID-shape so the handler can return a friendly
  // redirect when callers pass an INV- id by mistake. Strict DEC-
  // validation moved into the handler.
  id: z.string().regex(/^[A-Z]+-[0-9a-f]{7,}$/, "id must match <PREFIX>-<hash7>"),
};

export const canonicalForTopicInput = {
  topic: z.string().min(1),
};

export const invariantGetInput = {
  // Relaxed: accept any ID-shape so the handler can return a friendly
  // redirect when callers pass a DEC- id by mistake.
  id: z.string().regex(/^[A-Z]+-[0-9a-f]{7,}$/, "id must match <PREFIX>-<hash7>"),
};

export const inScopeInput = {
  path_globs: z.array(z.string()).min(1),
  types: z.array(z.enum(["decision", "invariant"])).optional(),
  status: z.array(z.string()).optional(),
};

// ── Read tools — 3-layer progressive retrieval ─────────────────────────────

export const searchInput = {
  query: z.string().min(1),
  scope: z.array(z.string()).optional(),
  kinds: z.array(z.enum(["decision", "invariant", "task", "run", "doc", "manifest"])).optional(),
  limit: z.number().int().positive().max(50).optional(),
};

// ── Write tools ────────────────────────────────────────────────────────────

export const taskCreateInput = {
  // Slug is folded into the task directory name (`.cairn/tasks/active/<id>/`).
  // Bumped from 42→80 chars after mine showed real-world slugs like
  // `f01-route-claim-revalidation-via-status-svc` (43) failing the
  // old cap and forcing operators to invent abbreviations.
  slug: z
    .string()
    .regex(
      /^[a-z][a-z0-9-]{1,78}[a-z0-9]$/,
      "slug must be lowercase kebab — letters, digits, hyphens; 3-80 chars",
    ),
  // Title renders in the statusline + lens. Statusline already truncates
  // gracefully; advisory 80 chars matches the operator's natural
  // PR-style titles ("F-01: route claim revalidation via status svc").
  // Cap = 4000 chars; the handler soft-truncates anything beyond the
  // 80-char advisory with a trailing marker and returns `truncated:
  // ["title"]`. Hard reject only when title is empty or absurd. Avoids
  // the "AI burns a turn re-shrinking a 120-char title" loop the
  // datamine caught.
  title: z
    .string()
    .min(3)
    .max(4000, "title must be ≤4000 chars (advisory: ~80 chars; longer values auto-truncate)"),
  goal: z.string().min(1),
  // Optional in v0.12.x — historical AI sessions repeatedly omitted it
  // and burned a turn re-trying. When absent, the handler infers from
  // the active task's module/goal. Operators can still pin scope
  // explicitly by passing the array.
  target_path_globs: z.array(z.string().min(1)).optional(),
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
  /**
   * Mission anchor — when set, the task is linked to the given phase
   * of the mission. Defaults to the active mission's cursor when both
   * fields are omitted. Pass `mission_id: ""` to opt out (side-task).
   */
  mission_id: z
    .string()
    .regex(/^MIS-[a-z0-9-]+-[0-9a-f]{7}$|^$/, "mission id must match MIS-<slug>-<hash7> or empty string")
    .optional(),
  phase_id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "phase id must be kebab-case")
    .optional(),
};

/**
 * `cairn_task_journal_append` — append a per-turn journal entry. The
 * journal is the resume-layer record that survives `/clear`. `task_id`
 * defaults to the most-recently-touched active task.
 */
export const taskJournalAppendInput = {
  task_id: z
    .string()
    .regex(/^TSK-[a-z0-9-]+-[0-9a-f]{7}$/, "task id must match TSK-<slug>-<7-hex>")
    .optional(),
  // Cap = 4000 chars; the handler soft-truncates anything beyond the
  // 320-char advisory size with a trailing marker. Hard reject only
  // when summary is empty or absurd. Avoids the "AI burns a turn
  // re-shrinking a 350-char string" loop that bit operators on older
  // (160-char) limits.
  summary: z
    .string()
    .min(1)
    .max(4000, "summary must be ≤4000 chars (advisory: ~320 chars; longer values auto-truncate)"),
  next_step: z
    .string()
    .max(4000, "next_step must be ≤4000 chars (advisory: ~320 chars; longer values auto-truncate)")
    .optional(),
  // Cap = 200 paths; the handler keeps the first 20 (advisory) and
  // returns `truncated: ["files_touched"]` plus the dropped tail in
  // `dropped.files_touched`. Hard reject only on absurd input. Avoids
  // the "AI re-tries the call with a shorter slice" loop the
  // datamine caught.
  files_touched: z
    .array(z.string().min(1))
    .max(200, "files_touched must be ≤200 paths (advisory: ≤20; longer arrays auto-truncate)")
    .optional(),
  decisions_loaded: z
    .array(z.string().regex(/^DEC-[0-9a-f]{7,}$/))
    .max(20)
    .optional(),
  /** Claude Code session id of the writer, if known. Stamped into the entry. */
  session_id: z.string().optional(),
};

/**
 * `cairn_resume` — read the resume payload for an active task.
 */
export const resumeInput = {
  task_id: z
    .string()
    .regex(/^TSK-[a-z0-9-]+-[0-9a-f]{7}$/, "task id must match TSK-<slug>-<7-hex>")
    .optional(),
  max_entries: z.number().int().min(1).max(50).optional(),
};

/**
 * `cairn_task_complete` — graduate an active task to a terminal phase
 * (succeeded / failed / aborted). Format: `TSK-<slug>-<7-hex>`.
 * `task_id` is optional — defaults to the most-recently-touched
 * active task (same auto-pick as `cairn_task_journal_append` /
 * `cairn_resume`).
 */
export const taskCompleteInput = {
  task_id: z
    .string()
    .regex(
      /^TSK-[a-z0-9-]+-[0-9a-f]{7}$/,
      "task id must match TSK-<slug>-<7-hex>",
    )
    .optional(),
  outcome: z.enum(["succeeded", "failed", "aborted"]),
  // Cap = 8000 chars; handler soft-truncates beyond the 2000-char
  // advisory size. Same UX principle as task_journal_append.summary.
  summary: z
    .string()
    .max(8000, "summary must be ≤8000 chars (advisory: ~2000 chars; longer values auto-truncate)")
    .optional(),
};

/**
 * `cairn_task_reopen` — pull a graduated task back to `tasks/active/`.
 * Inverse of `cairn_task_complete`. Reasoning field is optional but
 * recommended so the next operator/session sees why the task came back.
 */
export const taskReopenInput = {
  task_id: z
    .string()
    .regex(
      /^TSK-[a-z0-9-]+-[0-9a-f]{7}$/,
      "task id must match TSK-<slug>-<7-hex>",
    ),
  reason: z.string().max(2000, "reason must be ≤2000 chars").optional(),
};

export const recordDecisionInput = {
  id: z.string().regex(/^DEC-[0-9a-f]{7,}$/).optional(),
  slug: z.string().optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  scope_globs: z.array(z.string()).optional(),
  supersedes: z.string().optional(),
  assertions: z.array(z.unknown()).optional(),
  human_review_hint: z.string().optional(),
  body_markdown: z.string().optional(),
  target: z.enum(["inbox", "accepted"]).optional(),
};

export const retireDecisionInput = {
  id: z.string().regex(/^DEC-[0-9a-f]{7,}$/, "id must match DEC-<hash7>"),
  reason: z.string().min(1).optional(),
};

export const retireInvariantInput = {
  id: z.string().regex(/^INV-[0-9a-f]{7,}$/, "id must match INV-<hash7>"),
  reason: z.string().min(1).optional(),
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

// ── Mission system — supra-task layer ──────────────────────────────────────

const missionIdField = z
  .string()
  .regex(/^MIS-[a-z0-9-]+-[0-9a-f]{7}$/, "mission id must match MIS-<slug>-<hash7>");
const missionExitGateField = z.enum(["prompt", "auto", "manual"]);
const missionPhaseIdField = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "phase id must be kebab-case");

const missionPhaseDraftField = z.array(
  z.object({
    id: missionPhaseIdField,
    title: z.string().min(1),
    depends_on: z.array(z.string()).optional(),
    exit_criteria: z.string().min(1),
    exit_gate: missionExitGateField.optional(),
  }),
);

/**
 * `cairn_mission_start` — read the source spec, draft a roadmap via
 * Haiku, return the draft for operator approval. Does NOT write
 * anything to disk; the skill calls `cairn_mission_accept_draft` once
 * the operator confirms.
 *
 * `no_llm: true` skips the Haiku call and returns a single-phase stub
 * roadmap so the operator can hand-edit it before approving (used when
 * Haiku is offline or quota-exhausted).
 */
export const missionStartInput = {
  spec_path: z.string().min(1),
  exit_gate: missionExitGateField,
  no_llm: z.boolean().optional(),
};

export const missionAcceptDraftInput = {
  title: z.string().min(1).max(80),
  spec_path: z.string().min(1),
  exit_gate: missionExitGateField,
  phases: missionPhaseDraftField.min(1),
};

export const missionGetInput = {
  /** Mission id; omit to read the active mission. */
  mission_id: missionIdField.optional(),
};

/**
 * `cairn_mission_plan_phase` — write the just-in-time tightening brief
 * for one phase. `phase_id` defaults to the cursor's active phase.
 * `decisions` captures the forks resolved during tightening;
 * `constraints`/`acceptance` are inherited by every task created in the
 * phase; `cite_decisions`/`cite_invariants` record the ground-state
 * entries that pre-answered the rest. `status=accepted` (default) locks
 * the brief so tasks may inherit it; `drafted` parks it for review.
 * `autonomous: true` marks a brief the model self-resolved without an
 * operator prompt (exit_gate=auto path).
 */
export const missionPlanPhaseInput = {
  phase_id: missionPhaseIdField.optional(),
  decisions: z
    .array(
      z.object({
        question: z.string().min(1),
        choice: z.string().min(1),
        rationale: z.string().optional(),
      }),
    )
    .optional(),
  constraints: z.array(z.string()).optional(),
  acceptance: z.array(z.string()).optional(),
  cite_decisions: z.array(z.string()).optional(),
  cite_invariants: z.array(z.string()).optional(),
  status: z.enum(["drafted", "accepted"]).optional(),
  autonomous: z.boolean().optional(),
  notes: z.string().optional(),
};

/**
 * `cairn_mission_advance` — operator picked a phase-exit choice.
 * `phase_id` is the phase being exited. choice=exit advances cursor;
 * choice=not_yet keeps cursor; choice=defer suppresses the prompt for
 * 24h; choice=force advances even when the phase has zero tasks;
 * choice=drop removes a drifted phase id from `phase_progress` (the
 * id is no longer in roadmap.md — operator deleted it mid-mission).
 */
export const missionAdvanceInput = {
  phase_id: missionPhaseIdField,
  choice: z.enum(["exit", "not_yet", "defer", "force", "drop"]),
  defer_hours: z.number().int().min(1).max(24 * 30).optional(),
};

export const missionResumeInput = {
  mission_id: missionIdField.optional(),
};

export const missionResyncInput = {
  /** Optional override; defaults to the mission's stored spec_path. */
  spec_path: z.string().min(1).optional(),
  no_llm: z.boolean().optional(),
};

/**
 * `cairn_mission_resync_accept` — apply (or reject) a pending resync
 * marker. `outcome=accept` rewrites roadmap.md with the proposed
 * phases, refreshes spec.md, reconciles phase_progress (added phases
 * → pending; removed phases → dropped from progress with journal note).
 * `outcome=reject` deletes the marker without touching roadmap.md.
 */
export const missionResyncAcceptInput = {
  outcome: z.enum(["accept", "reject"]),
};
