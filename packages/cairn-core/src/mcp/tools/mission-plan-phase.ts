import {
  type MissionPhaseBrief,
  appendMissionJournal,
  findActiveMission,
  readMissionState,
  readRoadmap,
  writePhaseBrief,
  writeMissionState,
} from "@isaacriehm/cairn-state";
import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { mcpError } from "../errors.js";
import { missionPlanPhaseInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface InputDecision {
  question: string;
  choice: string;
  rationale?: string;
}

interface Input {
  phase_id?: string;
  decisions?: InputDecision[];
  constraints?: string[];
  acceptance?: string[];
  cite_decisions?: string[];
  cite_invariants?: string[];
  status?: "drafted" | "accepted";
  autonomous?: boolean;
  notes?: string;
}

/**
 * Persist the just-in-time per-phase tightening brief. The brief is the
 * phase-scoped analog of a tightened task spec: the forks the operator
 * (or, in autonomous mode, the model) resolved, the constraints every
 * task in the phase inherits, the phase acceptance bar, and the cites
 * that pre-answered the rest. Writes a committed markdown file under
 * `.cairn/ground/missions/<id>/briefs/<phase>.md` and stamps
 * `phase_progress[phase].brief_status` so the cursor knows the phase is
 * briefed.
 */
async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;

  const missionId = findActiveMission(ctx.repoRoot);
  if (missionId === null) {
    return mcpError("MISSION_NOT_FOUND", "No active mission");
  }

  const roadmap = readRoadmap(ctx.repoRoot, missionId);
  const state = readMissionState(ctx.repoRoot, missionId);
  if (roadmap === null || state === null) {
    return mcpError(
      "MISSION_NOT_FOUND",
      `Mission ${missionId} state or roadmap unreadable`,
    );
  }

  const phaseId = input.phase_id ?? state.cursor.active_phase;
  if (phaseId === null) {
    return mcpError(
      "VALIDATION_FAILED",
      "No phase_id given and the mission cursor is not on a phase (mission may be complete).",
    );
  }
  if (!roadmap.frontmatter.phases.some((p) => p.id === phaseId)) {
    return mcpError(
      "MISSION_PHASE_NOT_FOUND",
      `phase ${phaseId} not in roadmap`,
    );
  }

  const status = input.status ?? "accepted";
  const now = new Date().toISOString();

  const brief: MissionPhaseBrief = {
    phase_id: phaseId,
    drafted_at: now,
    status,
    ...(input.autonomous === true ? { autonomous: true } : {}),
    decisions: input.decisions ?? [],
    constraints: input.constraints ?? [],
    acceptance: input.acceptance ?? [],
    cite_decisions: input.cite_decisions ?? [],
    cite_invariants: input.cite_invariants ?? [],
  };

  writePhaseBrief(ctx.repoRoot, missionId, brief, input.notes ?? "");

  // Stamp the per-clone fast-path flag. The committed brief file is the
  // canonical status source (multi-dev: a teammate who pulls the brief
  // but has no local flag still reads `accepted` off the file); this
  // flag just lets the phase_progress map reflect briefed phases without
  // re-reading every file. Default to `pending` when the phase was never
  // seeded — never silently flip a pending phase to in_progress.
  const progress = state.phase_progress[phaseId] ?? {
    state: "pending" as const,
    task_ids: [],
  };
  state.phase_progress[phaseId] = { ...progress, brief_status: status };
  writeMissionState(ctx.repoRoot, missionId, state);

  appendMissionJournal(ctx.repoRoot, missionId, {
    ts: now,
    kind: "phase-brief-set",
    phase_id: phaseId,
    detail:
      `${status}` +
      (input.autonomous === true ? " (autonomous)" : "") +
      ` — ${brief.decisions.length} decision(s), ${brief.constraints.length} constraint(s)`,
  });

  return {
    ok: true,
    mission_id: missionId,
    phase_id: phaseId,
    brief_status: status,
    brief_path: `.cairn/ground/missions/${missionId}/briefs/${phaseId}.md`,
    decisions: brief.decisions.length,
    constraints: brief.constraints.length,
    acceptance: brief.acceptance.length,
  };
}

export const missionPlanPhaseTool: ToolDef<Input> = {
  name: "cairn_mission_plan_phase",
  description:
    "Write the just-in-time tightening brief for one mission phase (defaults to the cursor phase). " +
    "Call this when the cursor lands on a phase whose `brief_status` is unset, BEFORE creating phase-anchored tasks. " +
    "`decisions` = the forks you resolved (question + choice [+ rationale]); `constraints` = rules every task in the phase inherits (cite a DEC/§INV per bullet); `acceptance` = the phase's verifiable exit bar; `cite_decisions`/`cite_invariants` = the in-scope ground state that pre-answered everything else. " +
    "Default `status=accepted` locks the brief so `cairn_task_create` calls can inherit its constraints/acceptance. " +
    "Smart gate: when the phase has NO unresolved forks (ground state already covers it), call with empty `decisions` and `status=accepted` to mark it briefed silently. " +
    "Autonomous mode (mission `exit_gate=auto`): resolve the forks yourself from ground state + best judgement, pass `autonomous: true`, do NOT prompt the operator.",
  inputSchema: missionPlanPhaseInput,
  handler,
};
