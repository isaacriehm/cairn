import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  type MissionPhase,
  type MissionRoadmapFrontmatter,
  appendMissionJournal,
  deriveMissionId,
  findActiveMission,
  initialPhaseProgress,
  missionRoadmapPath,
  missionRuntimeDir,
  missionsGroundRoot,
  nextPendingPhase,
  writeMissionSpec,
  writeMissionState,
  writeRoadmap,
} from "@isaacriehm/cairn-state";
import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { mcpError } from "../errors.js";
import { missionAcceptDraftInput } from "../schemas.js";
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

  if (findActiveMission(ctx.repoRoot) !== null) {
    return mcpError(
      "MISSION_ALREADY_ACTIVE",
      "An active mission already exists. Close or abort it before starting another.",
    );
  }

  const absSpec = isAbsolute(input.spec_path)
    ? input.spec_path
    : resolve(ctx.repoRoot, input.spec_path);
  if (!absSpec.startsWith(ctx.repoRoot)) {
    return mcpError("PATH_OUTSIDE_REPO", `${input.spec_path} resolves outside the repo`);
  }
  if (!existsSync(absSpec)) {
    return mcpError("FILE_NOT_FOUND", `Spec doc not found: ${input.spec_path}`);
  }

  let specSource: string;
  try {
    specSource = readFileSync(absSpec, "utf8");
  } catch (err) {
    return mcpError(
      "INTERNAL_ERROR",
      `Failed to read spec doc: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const startedAt = new Date().toISOString();
  const missionId = deriveMissionId({
    title: input.title,
    spec_path: input.spec_path,
    started_at: startedAt,
  });

  const phases: MissionPhase[] = input.phases.map((p) => ({
    id: p.id,
    title: p.title,
    depends_on: p.depends_on ?? [],
    exit_criteria: p.exit_criteria,
    ...(p.exit_gate !== undefined ? { exit_gate: p.exit_gate } : {}),
  }));

  const frontmatter: MissionRoadmapFrontmatter = {
    mission_id: missionId,
    title: input.title,
    spec_path: input.spec_path,
    created_at: startedAt,
    exit_gate: input.exit_gate,
    phases,
  };

  // Roadmap dir + per-clone runtime dir.
  mkdirSync(missionsGroundRoot(ctx.repoRoot), { recursive: true });
  mkdirSync(missionRuntimeDir(ctx.repoRoot, missionId), { recursive: true });

  writeRoadmap(
    ctx.repoRoot,
    missionId,
    frontmatter,
    `# Mission — ${input.title}\n\nSpec: \`${input.spec_path}\`. Phase list above is the canonical structure.\n`,
  );

  writeMissionSpec(ctx.repoRoot, missionId, specSource);

  const phaseProgress = initialPhaseProgress(frontmatter);
  const firstPhase = nextPendingPhase(frontmatter, {
    mission_id: missionId,
    started_at: startedAt,
    cursor: { active_phase: null, active_phase_started_at: null },
    phase_progress: phaseProgress,
    outcome: "active",
  });
  if (firstPhase !== null) {
    phaseProgress[firstPhase.id] = {
      state: "in_progress",
      task_ids: [],
    };
  }

  writeMissionState(ctx.repoRoot, missionId, {
    mission_id: missionId,
    started_at: startedAt,
    cursor: {
      active_phase: firstPhase?.id ?? null,
      active_phase_started_at: firstPhase !== null ? startedAt : null,
    },
    phase_progress: phaseProgress,
    outcome: "active",
  });

  // Empty journal + initial entry.
  appendMissionJournal(ctx.repoRoot, missionId, {
    ts: startedAt,
    kind: "started",
    detail: `${phases.length} phases, exit_gate=${input.exit_gate}`,
  });

  return {
    ok: true,
    mission_id: missionId,
    roadmap_path: `.cairn/ground/missions/${missionId}/roadmap.md`,
    state_path: `.cairn/missions/${missionId}/state.json`,
    spec_path: `.cairn/missions/${missionId}/spec.md`,
    cursor: { active_phase: firstPhase?.id ?? null },
    total_phases: phases.length,
  };
}

export const missionAcceptDraftTool: ToolDef<Input> = {
  name: "cairn_mission_accept_draft",
  description:
    "Commit an operator-approved roadmap draft. Generates the mission id (MIS-<slug>-<hash7>), writes `.cairn/ground/missions/<id>/roadmap.md` (committed), `.cairn/missions/<id>/state.json` + `spec.md` (per-clone), and seeds the mission journal. Sets the cursor to the first phase whose `depends_on` is empty.",
  inputSchema: missionAcceptDraftInput,
  handler,
};
