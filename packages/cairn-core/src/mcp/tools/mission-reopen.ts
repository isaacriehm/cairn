/**
 * `cairn_mission_reopen` — un-archive a closed mission. Moves the
 * `_done/<id>/` dirs back to live locations and clears the
 * `outcome: done|aborted` stamp so the cursor (whatever it was at
 * close) drives the next session. Does NOT re-execute graduated
 * phase tasks.
 */

import {
  appendMissionJournal,
  findActiveMission,
  locateMission,
  readMissionState,
  restoreMission,
  writeMissionState,
} from "@isaacriehm/cairn-state";
import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { mcpError } from "../errors.js";
import { missionReopenInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  mission_id: string;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;

  const scope = locateMission(ctx.repoRoot, input.mission_id);
  if (scope === null) {
    return mcpError("MISSION_NOT_FOUND", `Mission ${input.mission_id} not found`);
  }
  if (scope === "active") {
    return mcpError(
      "VALIDATION_FAILED",
      `Mission ${input.mission_id} is already active (no reopen needed)`,
    );
  }

  if (findActiveMission(ctx.repoRoot) !== null) {
    return mcpError(
      "MISSION_ALREADY_ACTIVE",
      "Another mission is already active; close it before reopening this one (one active mission per repo).",
    );
  }

  const moved = restoreMission(ctx.repoRoot, input.mission_id);
  if (!moved) {
    return mcpError("MISSION_NOT_FOUND", `Could not move archived dirs for ${input.mission_id}`);
  }

  const state = readMissionState(ctx.repoRoot, input.mission_id);
  if (state !== null) {
    state.outcome = "active";
    delete state.closed_at;
    delete state.abort_reason;
    writeMissionState(ctx.repoRoot, input.mission_id, state);
  }

  const reopenedAt = new Date().toISOString();
  appendMissionJournal(ctx.repoRoot, input.mission_id, {
    ts: reopenedAt,
    kind: "reopened",
    detail: `cursor: ${state?.cursor.active_phase ?? "(none)"}`,
  });

  return {
    ok: true,
    mission_id: input.mission_id,
    cursor: state?.cursor ?? null,
    reopened_at: reopenedAt,
  };
}

export const missionReopenTool: ToolDef<Input> = {
  name: "cairn_mission_reopen",
  description:
    "Un-archive a closed mission. Moves `.cairn/ground/missions/_done/<id>/` and `.cairn/missions/_done/<id>/` back to their live locations, resets `outcome` to active, and preserves the cursor at close-time. Refuses when another mission is already active. Does NOT re-execute graduated phase tasks.",
  inputSchema: missionReopenInput,
  handler,
};
