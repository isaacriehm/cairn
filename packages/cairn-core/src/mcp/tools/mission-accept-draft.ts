import type { MissionPhase } from "@isaacriehm/cairn-state";
import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { missionAcceptDraftInput } from "../schemas.js";
import { runMissionAccept } from "../../missions/index.js";
import { mapMissionCliError } from "./mission-cli-error.js";
import type { ToolDef } from "./types.js";

interface InputPhase {
  id: string;
  title: string;
  depends_on?: string[];
  exit_criteria: string;
  exit_gate?: "prompt" | "auto" | "manual";
}

interface Input {
  title: string;
  spec_path: string;
  exit_gate: "prompt" | "auto" | "manual";
  phases: InputPhase[];
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;

  const phases: MissionPhase[] = input.phases.map((p) => ({
    id: p.id,
    title: p.title,
    depends_on: p.depends_on ?? [],
    exit_criteria: p.exit_criteria,
    ...(p.exit_gate !== undefined ? { exit_gate: p.exit_gate } : {}),
  }));

  try {
    const result = runMissionAccept({
      repoRoot: ctx.repoRoot,
      title: input.title,
      specPath: input.spec_path,
      exitGate: input.exit_gate,
      phases,
    });
    return {
      ok: true,
      mission_id: result.mission_id,
      roadmap_path: `.cairn/ground/missions/${result.mission_id}/roadmap.md`,
      state_path: `.cairn/missions/${result.mission_id}/state.json`,
      spec_path: `.cairn/missions/${result.mission_id}/spec.md`,
      cursor: result.cursor,
      total_phases: result.total_phases,
    };
  } catch (err) {
    return mapMissionCliError(err);
  }
}

export const missionAcceptDraftTool: ToolDef<Input> = {
  name: "cairn_mission_accept_draft",
  description:
    "Commit an operator-approved roadmap draft. Generates the mission id (MIS-<slug>-<hash7>), writes `.cairn/ground/missions/<id>/roadmap.md` (committed), `.cairn/missions/<id>/state.json` + `spec.md` (per-clone), and seeds the mission journal. Sets the cursor to the first phase whose `depends_on` is empty.",
  inputSchema: missionAcceptDraftInput,
  handler,
};
