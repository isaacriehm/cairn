import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";
import {
  findActiveMission,
  readMissionState,
  readRoadmap,
} from "@isaacriehm/cairn-state";
import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { mcpError } from "../errors.js";
import { taskCreateInput } from "../schemas.js";
import { linkTaskToPhase } from "../../missions/task-link.js";
import type { ToolDef } from "./types.js";

interface Input {
  slug: string;
  title: string;
  goal: string;
  target_path_globs?: string[];
  in_scope_decisions?: string[];
  in_scope_invariants?: string[];
  constraints?: string[];
  out_of_scope?: string[];
  acceptance?: string[];
  module?: string;
  needs_review?: boolean;
  mission_id?: string;
  phase_id?: string;
}

/**
 * Generate a `task_id` matching the regex `^TSK-[a-z0-9-]+-[0-9a-f]{7}$`.
 *
 * Format: `TSK-<slug>-<7-hex>` where the 7-hex suffix is the first
 * 7 chars of `sha256(slug + crypto.randomUUID())`. Stable, content-
 * addressed, no counter file, no rollover. ~268M unique values per
 * slug bucket; cross-slug collisions impossible because the slug is
 * in the id.
 *
 * Rationale: operators don't manually check task numbers; if order
 * matters, `ls .cairn/tasks/` sorts by mtime. Hash is the safer
 * long-haul format.
 */
function generateTaskId(slug: string): string {
  const hash = createHash("sha256")
    .update(`${slug}${randomUUID()}`, "utf8")
    .digest("hex")
    .slice(0, 7);
  return `TSK-${slug}-${hash}`;
}

function renderInvariantId(id: string): string {
  return id.startsWith("§") ? id : `§${id}`;
}

function renderBulletList(items: string[] | undefined, fallback: string): string {
  if (items === undefined || items.length === 0) return `- ${fallback}\n`;
  return items.map((item) => `- ${item}`).join("\n") + "\n";
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;

  const taskId = generateTaskId(input.slug);
  const taskDir = join(ctx.repoRoot, ".cairn", "tasks", "active", taskId);
  if (existsSync(taskDir)) {
    return mcpError(
      "TASK_DIR_EXISTS",
      `${taskDir} already exists — collision on millisecond suffix; retry`,
    );
  }

  mkdirSync(taskDir, { recursive: true });

  const generatedAt = new Date().toISOString();
  const needsReview = input.needs_review ?? true;

  // Mission anchor — explicit input wins; otherwise inherit from the
  // active mission's cursor. Empty string means opt-out (side-task).
  let missionId: string | null = null;
  let phaseId: string | null = null;
  if (input.mission_id === "") {
    missionId = null;
    phaseId = null;
  } else if (input.mission_id !== undefined && input.mission_id !== null) {
    missionId = input.mission_id;
    phaseId = input.phase_id ?? null;
  } else {
    const activeMission = findActiveMission(ctx.repoRoot);
    if (activeMission !== null) {
      const state = readMissionState(ctx.repoRoot, activeMission);
      const roadmap = readRoadmap(ctx.repoRoot, activeMission);
      const cursorPhase = state?.cursor.active_phase ?? null;
      if (cursorPhase !== null && roadmap?.frontmatter.phases.some((p) => p.id === cursorPhase)) {
        missionId = activeMission;
        phaseId = input.phase_id ?? cursorPhase;
      }
    }
  }
  // Scope-mismatch warning. When a task auto-attaches to the cursor
  // phase (operator didn't pass an explicit `mission_id`), check whether
  // the task title + module + slug share any signal-bearing token with
  // the phase exit_criteria. If nothing matches, surface a non-blocking
  // warning so the caller can offer the operator a `mission_id: ""`
  // opt-out. Real-world bleed: regression-fix tasks silently piling onto
  // an unrelated wave phase's `task_ids`.
  let scopeWarning: string | null = null;
  if (
    missionId !== null &&
    phaseId !== null &&
    (input.mission_id === undefined || input.mission_id === null)
  ) {
    const roadmap = readRoadmap(ctx.repoRoot, missionId);
    if (roadmap !== null && !roadmap.frontmatter.phases.some((p) => p.id === phaseId)) {
      return mcpError(
        "VALIDATION_FAILED",
        `phase_id ${phaseId} not present in roadmap of ${missionId}`,
      );
    }
    const phaseDef = roadmap?.frontmatter.phases.find((p) => p.id === phaseId);
    if (phaseDef !== undefined) {
      const tokens = new Set<string>();
      for (const s of [input.title, input.slug, input.module ?? ""]) {
        for (const tok of s.toLowerCase().split(/[^a-z0-9]+/)) {
          if (tok.length >= 3) tokens.add(tok);
        }
      }
      const criteria = `${phaseDef.title} ${phaseDef.exit_criteria}`.toLowerCase();
      const hit = [...tokens].some((tok) => criteria.includes(tok));
      if (!hit && tokens.size > 0) {
        scopeWarning =
          `Task auto-attached to cursor phase \`${phaseId}\` but title/module/slug share no token with the phase exit_criteria. ` +
          `If this is a side-task (regression fix, unrelated refactor), re-create with \`mission_id: ""\` so it doesn't pollute \`phase_progress.task_ids\`. ` +
          `Phase title: "${phaseDef.title}".`;
      }
    }
  } else if (missionId !== null && phaseId !== null) {
    const roadmap = readRoadmap(ctx.repoRoot, missionId);
    if (roadmap !== null && !roadmap.frontmatter.phases.some((p) => p.id === phaseId)) {
      return mcpError(
        "VALIDATION_FAILED",
        `phase_id ${phaseId} not present in roadmap of ${missionId}`,
      );
    }
  }

  const specFrontmatter = {
    id: taskId,
    title: input.title,
    type: "spec",
    status: "ready",
    audience: "dual",
    generated: generatedAt,
    target_path_globs: input.target_path_globs ?? [],
    in_scope_decisions: input.in_scope_decisions ?? [],
    in_scope_invariants: input.in_scope_invariants ?? [],
    needs_review: needsReview,
  };

  const specBody = [
    `# ${input.title}`,
    "",
    "## Goal",
    "",
    input.goal,
    "",
    "## Constraints",
    "",
    renderBulletList(input.constraints, "(no in-scope decisions or invariants applied)"),
    "## Out of scope",
    "",
    renderBulletList(input.out_of_scope, "(none)"),
    "## Acceptance",
    "",
    renderBulletList(input.acceptance, "(implementation passes the operator's spot check)"),
  ].join("\n");

  const specContent = `---\n${stringifyYaml(specFrontmatter)}---\n\n${specBody}`;
  const specPath = join(taskDir, "spec.tightened.md");
  writeFileSync(specPath, specContent, "utf8");

  const statusFrame: Record<string, unknown> = {
    id: taskId,
    phase: "running",
    module: input.module ?? input.target_path_globs?.[0]?.split("/")[0] ?? ".",
    title: input.title,
    started_at: generatedAt,
  };
  if (missionId !== null && phaseId !== null) {
    statusFrame["mission_id"] = missionId;
    statusFrame["phase_id"] = phaseId;
  }
  const statusContent = stringifyYaml(statusFrame);
  const statusPath = join(taskDir, "status.yaml");
  writeFileSync(statusPath, statusContent, "utf8");

  // Eagerly link the task to its phase's `task_ids`. Before this, linkage
  // only fired in `onTaskCompleted` — meaning a phase that had pending
  // (not-yet-completed) tasks looked empty to `mission_advance choice=exit`,
  // forcing operators to pass `choice=force` even though real work was
  // anchored to the phase. Linking on create makes the phase ledger
  // reflect intent, not just graduation.
  if (missionId !== null && phaseId !== null) {
    linkTaskToPhase(ctx.repoRoot, missionId, phaseId, taskId);
  }

  return {
    ok: true,
    task_id: taskId,
    spec_path: `.cairn/tasks/active/${taskId}/spec.tightened.md`,
    status_path: `.cairn/tasks/active/${taskId}/status.yaml`,
    in_scope_decisions: input.in_scope_decisions ?? [],
    in_scope_invariants: (input.in_scope_invariants ?? []).map(renderInvariantId),
    mission_id: missionId,
    phase_id: phaseId,
    ...(scopeWarning !== null ? { warning: scopeWarning } : {}),
  };
}

export const taskCreateTool: ToolDef<Input> = {
  name: "cairn_task_create",
  description:
    "Allocate a task_id and atomically write spec.tightened.md + status.yaml under .cairn/tasks/active/<task_id>/. " +
    "**Required fields**: `slug` (lowercase kebab, 3-80 chars), `title` (≤80 chars), `goal` (free-form). " +
    "**Optional**: `target_path_globs` (defaults to []; pass paths to pin scope), `in_scope_decisions`, `in_scope_invariants`, `constraints`, `out_of_scope`, `acceptance`, `module`, `needs_review`, `mission_id` (anchor to mission; defaults to active mission's cursor — pass `''` to opt out as side-task), `phase_id`. " +
    "Server controls task_id format (`TSK-<slug>-<7-hex>`); callers cannot misformat it. " +
    "Auto-links the new task to its phase's `task_ids` immediately so `cairn_mission_advance choice='exit'` sees the task without waiting for `cairn_task_complete`. " +
    "Required by the cairn-direction skill before any source mutation.",
  inputSchema: taskCreateInput,
  handler,
};
