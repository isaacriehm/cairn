import {
  countDonePhases,
  detectRoadmapDrift,
  findActiveMission,
  locateMission,
  readMissionState,
  readPhaseBrief,
  readRoadmap,
} from "@isaacriehm/cairn-state";
import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { mcpError } from "../errors.js";
import { missionGetInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  mission_id?: string;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;

  const missionId = input.mission_id ?? findActiveMission(ctx.repoRoot);
  if (missionId === null) {
    return { ok: true, active: false };
  }

  const scope = locateMission(ctx.repoRoot, missionId);
  if (scope === null) {
    return mcpError("MISSION_NOT_FOUND", `Mission ${missionId} not found in active or done sets`);
  }
  // Reading roadmap from `_done/` happens via `locateMission` returning
  // "done"; the schema-validated reader looks at the live roadmap path
  // for active missions only. For now `mission_get` is scoped to active
  // missions; closed-mission inspection is a separate `cairn timeline`
  // surface.
  if (scope === "done") {
    return mcpError("MISSION_NOT_FOUND", `Mission ${missionId} is archived (use cairn_mission_reopen to inspect)`);
  }

  const roadmap = readRoadmap(ctx.repoRoot, missionId);
  const state = readMissionState(ctx.repoRoot, missionId);
  if (roadmap === null || state === null) {
    return mcpError("MISSION_NOT_FOUND", `Mission ${missionId} state or roadmap unreadable`);
  }

  const drift = detectRoadmapDrift(roadmap.frontmatter, state);
  const cursorPhaseId = state.cursor.active_phase;
  const cursorPhase =
    cursorPhaseId === null
      ? null
      : roadmap.frontmatter.phases.find((p) => p.id === cursorPhaseId) ?? null;

  // Per-phase brief surface — the skill reads `brief_status` to decide
  // whether the cursor phase still needs just-in-time tightening before
  // tasks are created against it. `null` brief_status = brief-pending.
  // The committed brief FILE is canonical (multi-dev: a teammate who
  // pulled the brief but has no local per-clone flag still sees its
  // accepted status); fall back to the per-clone flag only when no file
  // exists yet.
  const cursorBrief =
    cursorPhaseId === null
      ? null
      : readPhaseBrief(ctx.repoRoot, missionId, cursorPhaseId);
  const cursorBriefStatus =
    cursorBrief?.status ??
    (cursorPhaseId === null
      ? null
      : state.phase_progress[cursorPhaseId]?.brief_status ?? null);

  return {
    ok: true,
    active: true,
    mission_id: missionId,
    title: roadmap.frontmatter.title,
    spec_path: roadmap.frontmatter.spec_path,
    exit_gate: roadmap.frontmatter.exit_gate,
    cursor: {
      active_phase: cursorPhaseId,
      active_phase_started_at: state.cursor.active_phase_started_at,
      active_phase_title: cursorPhase?.title ?? null,
      active_phase_exit_criteria: cursorPhase?.exit_criteria ?? null,
      active_phase_exit_gate: cursorPhase?.exit_gate ?? roadmap.frontmatter.exit_gate,
      active_phase_brief_status: cursorBriefStatus,
      active_phase_brief: cursorBrief,
    },
    progress: {
      done: countDonePhases(state),
      total: roadmap.frontmatter.phases.length,
    },
    drift_phase_ids: drift,
    phase_progress: state.phase_progress,
    phases: roadmap.frontmatter.phases,
  };
}

export const missionGetTool: ToolDef<Input> = {
  name: "cairn_mission_get",
  description:
    "Return the active mission's state — title, spec_path, exit_gate, cursor (active_phase + exit_criteria + `active_phase_brief_status` + `active_phase_brief`), N/M phase progress, full phase_progress map, the ordered phase array, and any drift_phase_ids that no longer appear in roadmap.md (operator removed them mid-mission). `active_phase_brief_status: null` means the cursor phase still needs just-in-time tightening — call `cairn_mission_plan_phase` before creating tasks. Returns `{ active: false }` when no active mission exists.",
  inputSchema: missionGetInput,
  handler,
};
