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
import type { ToolDef } from "./types.js";

interface Input {
  slug: string;
  title: string;
  goal: string;
  target_path_globs: string[];
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
  if (missionId !== null && phaseId !== null) {
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
    target_path_globs: input.target_path_globs,
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
    module: input.module ?? input.target_path_globs[0]?.split("/")[0] ?? ".",
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

  return {
    ok: true,
    task_id: taskId,
    spec_path: `.cairn/tasks/active/${taskId}/spec.tightened.md`,
    status_path: `.cairn/tasks/active/${taskId}/status.yaml`,
    in_scope_decisions: input.in_scope_decisions ?? [],
    in_scope_invariants: (input.in_scope_invariants ?? []).map(renderInvariantId),
    mission_id: missionId,
    phase_id: phaseId,
  };
}

export const taskCreateTool: ToolDef<Input> = {
  name: "cairn_task_create",
  description:
    "Allocate a task_id and atomically write spec.tightened.md + status.yaml under .cairn/tasks/active/<task_id>/. The server controls task_id format (TSK-YYYY-MM-DD-<slug>-<5-digit-ms>) — callers cannot misformat it. Required by the cairn-direction skill before any source mutation.",
  inputSchema: taskCreateInput,
  handler,
};
