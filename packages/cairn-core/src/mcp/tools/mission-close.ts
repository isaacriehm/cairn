import {
  appendMissionJournal,
  archiveMission,
  locateMission,
  readMissionState,
  writeMissionState,
} from "@isaacriehm/cairn-state";
import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { mcpError } from "../errors.js";
import { missionCloseInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  mission_id: string;
  outcome: "done" | "aborted";
  reason?: string;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;

  const scope = locateMission(ctx.repoRoot, input.mission_id);
  if (scope !== "active") {
    return mcpError(
      "MISSION_NOT_FOUND",
      `Mission ${input.mission_id} not active (scope=${scope ?? "missing"})`,
    );
  }

  const state = readMissionState(ctx.repoRoot, input.mission_id);
  if (state === null) {
    return mcpError("MISSION_NOT_FOUND", `state.json missing for ${input.mission_id}`);
  }

  const closedAt = new Date().toISOString();
  state.outcome = input.outcome;
  state.cursor.active_phase = null;
  state.cursor.active_phase_started_at = null;
  state.closed_at = closedAt;
  if (input.outcome === "aborted" && input.reason !== undefined) {
    state.abort_reason = input.reason;
  }
  writeMissionState(ctx.repoRoot, input.mission_id, state);

  appendMissionJournal(ctx.repoRoot, input.mission_id, {
    ts: closedAt,
    kind: "closed",
    detail:
      input.outcome === "aborted"
        ? `aborted${input.reason !== undefined ? `: ${input.reason}` : ""}`
        : "manual close",
  });

  archiveMission(ctx.repoRoot, input.mission_id);

  return {
    ok: true,
    mission_id: input.mission_id,
    outcome: input.outcome,
    closed_at: closedAt,
    archived_to: `.cairn/ground/missions/_done/${input.mission_id}/`,
  };
}

export const missionCloseTool: ToolDef<Input> = {
  name: "cairn_mission_close",
  description:
    "Close a mission and archive its dirs. `outcome=done` is the manual analogue of auto-close on last phase complete; `outcome=aborted` is the operator-driven cancel path (with optional `reason`). Roadmap moves to `.cairn/ground/missions/_done/<id>/`; per-clone runtime moves to `.cairn/missions/_done/<id>/`. Reversible via cairn_mission_reopen.",
  inputSchema: missionCloseInput,
  handler,
};
