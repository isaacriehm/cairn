/**
 * CLI wrappers around the mission MCP tools — `cairn mission ...`
 * subcommands. Reuses the helper modules (cursor, draft, task-link)
 * directly so the CLI stays in lock-step with the MCP surface.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve as pathResolve } from "node:path";
import {
  appendMissionJournal,
  archiveMission,
  countDonePhases,
  deriveMissionId,
  detectRoadmapDrift,
  findActiveMission,
  initialPhaseProgress,
  listActiveMissionIds,
  listDoneMissionIds,
  locateMission,
  type MissionExitGate,
  type MissionPhase,
  type MissionRoadmapFrontmatter,
  missionRoadmapPath,
  missionRuntimeDir,
  nextPendingPhase,
  readMissionState,
  readRoadmap,
  restoreMission,
  writeMissionSpec,
  writeMissionState,
  writeRoadmap,
} from "@isaacriehm/cairn-state";
import { advancePhase } from "./cursor.js";
import { draftRoadmapFromSpec, stubRoadmap } from "./draft.js";

export interface MissionStartArgs {
  repoRoot: string;
  specPath: string;
  exitGate: MissionExitGate;
  noLlm?: boolean;
}

export interface MissionStartResult {
  proposed_title: string;
  spec_path: string;
  exit_gate: MissionExitGate;
  phases: MissionPhase[];
  llm_used: boolean;
}

export async function runMissionStart(args: MissionStartArgs): Promise<MissionStartResult> {
  if (findActiveMission(args.repoRoot) !== null) {
    throw new Error("An active mission already exists; close or abort it before starting another.");
  }
  const abs = isAbsolute(args.specPath) ? args.specPath : pathResolve(args.repoRoot, args.specPath);
  if (!abs.startsWith(args.repoRoot)) {
    throw new Error(`${args.specPath} resolves outside the repo`);
  }
  if (!existsSync(abs)) {
    throw new Error(`Spec doc not found: ${args.specPath}`);
  }
  const source = readFileSync(abs, "utf8");
  const proposedTitle = deriveTitleFromSpec(source, args.specPath);

  if (args.noLlm === true) {
    return {
      proposed_title: proposedTitle,
      spec_path: args.specPath,
      exit_gate: args.exitGate,
      phases: stubRoadmap(),
      llm_used: false,
    };
  }
  const draft = await draftRoadmapFromSpec({
    repoRoot: args.repoRoot,
    spec: source,
    specPath: args.specPath,
  });
  if (draft === null) {
    throw new Error("Haiku failed to parse the spec doc; retry or pass --no-llm");
  }
  return {
    proposed_title: proposedTitle,
    spec_path: args.specPath,
    exit_gate: args.exitGate,
    phases: draft.phases,
    llm_used: true,
  };
}

export interface MissionAcceptArgs {
  repoRoot: string;
  title: string;
  specPath: string;
  exitGate: MissionExitGate;
  phases: MissionPhase[];
}

export interface MissionAcceptResult {
  mission_id: string;
  cursor: { active_phase: string | null };
  total_phases: number;
}

export function runMissionAccept(args: MissionAcceptArgs): MissionAcceptResult {
  if (findActiveMission(args.repoRoot) !== null) {
    throw new Error("An active mission already exists; close or abort it before starting another.");
  }
  const abs = isAbsolute(args.specPath) ? args.specPath : pathResolve(args.repoRoot, args.specPath);
  if (!existsSync(abs)) {
    throw new Error(`Spec doc not found: ${args.specPath}`);
  }
  const startedAt = new Date().toISOString();
  const missionId = deriveMissionId({ title: args.title, spec_path: args.specPath, started_at: startedAt });
  const frontmatter: MissionRoadmapFrontmatter = {
    mission_id: missionId,
    title: args.title,
    spec_path: args.specPath,
    created_at: startedAt,
    exit_gate: args.exitGate,
    phases: args.phases,
  };
  writeRoadmap(args.repoRoot, missionId, frontmatter, `# Mission — ${args.title}\n\nSpec: \`${args.specPath}\`.\n`);
  writeMissionSpec(args.repoRoot, missionId, readFileSync(abs, "utf8"));
  const phaseProgress = initialPhaseProgress(frontmatter);
  const firstPhase = nextPendingPhase(frontmatter, {
    mission_id: missionId,
    started_at: startedAt,
    cursor: { active_phase: null, active_phase_started_at: null },
    phase_progress: phaseProgress,
    outcome: "active",
  });
  if (firstPhase !== null) {
    phaseProgress[firstPhase.id] = { state: "in_progress", task_ids: [] };
  }
  writeMissionState(args.repoRoot, missionId, {
    mission_id: missionId,
    started_at: startedAt,
    cursor: {
      active_phase: firstPhase?.id ?? null,
      active_phase_started_at: firstPhase !== null ? startedAt : null,
    },
    phase_progress: phaseProgress,
    outcome: "active",
  });
  appendMissionJournal(args.repoRoot, missionId, {
    ts: startedAt,
    kind: "started",
    detail: `${args.phases.length} phases, exit_gate=${args.exitGate}`,
  });
  return {
    mission_id: missionId,
    cursor: { active_phase: firstPhase?.id ?? null },
    total_phases: args.phases.length,
  };
}

export interface MissionGetResult {
  active: boolean;
  mission_id?: string;
  title?: string;
  cursor?: { active_phase: string | null };
  progress?: { done: number; total: number };
  drift_phase_ids?: string[];
}

export function runMissionGet(repoRoot: string): MissionGetResult {
  const id = findActiveMission(repoRoot);
  if (id === null) return { active: false };
  const roadmap = readRoadmap(repoRoot, id);
  const state = readMissionState(repoRoot, id);
  if (roadmap === null || state === null) return { active: false };
  return {
    active: true,
    mission_id: id,
    title: roadmap.frontmatter.title,
    cursor: { active_phase: state.cursor.active_phase },
    progress: { done: countDonePhases(state), total: roadmap.frontmatter.phases.length },
    drift_phase_ids: detectRoadmapDrift(roadmap.frontmatter, state),
  };
}

export interface MissionAdvanceArgs {
  repoRoot: string;
  phaseId: string;
  force?: boolean;
  drop?: boolean;
}

export function runMissionAdvance(args: MissionAdvanceArgs):
  | { kind: "advanced"; phase_advanced: string; next_phase: string | null; closed: boolean }
  | { kind: "dropped"; phase_id: string; orphaned_task_ids: string[] } {
  const missionId = findActiveMission(args.repoRoot);
  if (missionId === null) throw new Error("No active mission");
  const state = readMissionState(args.repoRoot, missionId);
  if (state === null) throw new Error(`state.json missing for ${missionId}`);
  const roadmap = readRoadmap(args.repoRoot, missionId);
  if (roadmap === null) throw new Error(`roadmap.md missing for ${missionId}`);

  if (args.drop === true) {
    if (roadmap.frontmatter.phases.some((p) => p.id === args.phaseId)) {
      throw new Error(
        `phase ${args.phaseId} is still in roadmap.md; --drop only resolves drifted ids`,
      );
    }
    const progress = state.phase_progress[args.phaseId];
    if (progress === undefined) {
      throw new Error(`phase ${args.phaseId} not present in phase_progress`);
    }
    const taskIds = progress.task_ids;
    delete state.phase_progress[args.phaseId];
    writeMissionState(args.repoRoot, missionId, state);
    appendMissionJournal(args.repoRoot, missionId, {
      ts: new Date().toISOString(),
      kind: "drift-detected",
      phase_id: args.phaseId,
      detail: `dropped — ${taskIds.length} graduated task(s) orphaned`,
    });
    return { kind: "dropped", phase_id: args.phaseId, orphaned_task_ids: taskIds };
  }

  if (args.force !== true) {
    const progress = state.phase_progress[args.phaseId];
    if (progress === undefined || progress.task_ids.length === 0) {
      throw new Error(`phase ${args.phaseId} has no linked tasks; pass --force to advance`);
    }
  }
  const r = advancePhase(args.repoRoot, missionId, args.phaseId);
  if (!r.ok) throw new Error(r.message);
  return {
    kind: "advanced",
    phase_advanced: r.phase_advanced,
    next_phase: r.next_phase?.id ?? null,
    closed: r.closed,
  };
}

export function runMissionClose(
  repoRoot: string,
  missionId: string,
  outcome: "done" | "aborted",
  reason?: string,
): { mission_id: string; outcome: string; closed_at: string } {
  if (locateMission(repoRoot, missionId) !== "active") {
    throw new Error(`Mission ${missionId} is not active`);
  }
  const state = readMissionState(repoRoot, missionId);
  if (state === null) throw new Error(`state.json missing for ${missionId}`);
  const closedAt = new Date().toISOString();
  state.outcome = outcome;
  state.cursor.active_phase = null;
  state.cursor.active_phase_started_at = null;
  state.closed_at = closedAt;
  if (outcome === "aborted" && reason !== undefined) state.abort_reason = reason;
  writeMissionState(repoRoot, missionId, state);
  appendMissionJournal(repoRoot, missionId, {
    ts: closedAt,
    kind: "closed",
    detail: outcome === "aborted" ? `aborted${reason !== undefined ? `: ${reason}` : ""}` : "manual close",
  });
  archiveMission(repoRoot, missionId);
  return { mission_id: missionId, outcome, closed_at: closedAt };
}

export function runMissionReopen(
  repoRoot: string,
  missionId: string,
): { mission_id: string; cursor: { active_phase: string | null } | null; reopened_at: string } {
  if (locateMission(repoRoot, missionId) !== "done") {
    throw new Error(`Mission ${missionId} is not archived`);
  }
  if (findActiveMission(repoRoot) !== null) {
    throw new Error("Another mission is already active");
  }
  if (!restoreMission(repoRoot, missionId)) {
    throw new Error(`Could not restore archived dirs for ${missionId}`);
  }
  const state = readMissionState(repoRoot, missionId);
  const reopenedAt = new Date().toISOString();
  if (state !== null) {
    state.outcome = "active";
    delete state.closed_at;
    delete state.abort_reason;
    writeMissionState(repoRoot, missionId, state);
  }
  appendMissionJournal(repoRoot, missionId, {
    ts: reopenedAt,
    kind: "reopened",
    detail: `cursor: ${state?.cursor.active_phase ?? "(none)"}`,
  });
  return {
    mission_id: missionId,
    cursor: state?.cursor ?? null,
    reopened_at: reopenedAt,
  };
}

export function listMissions(repoRoot: string): { active: string[]; done: string[] } {
  return {
    active: listActiveMissionIds(repoRoot),
    done: listDoneMissionIds(repoRoot),
  };
}

function deriveTitleFromSpec(source: string, fallback: string): string {
  const m = source.match(/^#\s+(.+?)\s*$/m);
  const raw = m?.[1] ?? fallback.replace(/^.*\//, "").replace(/\.[a-z]+$/i, "");
  return raw.slice(0, 60);
}

/**
 * Pretty-print a roadmap to a string for `cairn mission start --print`
 * preview output. Matches the YAML-frontmatter shape Cairn writes to
 * disk so the operator can copy + edit it before approval.
 */
export function previewRoadmap(args: {
  title: string;
  specPath: string;
  exitGate: MissionExitGate;
  phases: MissionPhase[];
}): string {
  const lines: string[] = [];
  lines.push(`# Mission preview — ${args.title}`);
  lines.push("");
  lines.push(`spec_path: ${args.specPath}`);
  lines.push(`exit_gate: ${args.exitGate}`);
  lines.push("");
  lines.push("Phases:");
  for (const p of args.phases) {
    lines.push(`  - ${p.id}: ${p.title}`);
    if (p.depends_on.length > 0) lines.push(`    depends_on: ${p.depends_on.join(", ")}`);
    lines.push(`    exit_criteria: ${p.exit_criteria}`);
  }
  return lines.join("\n");
}

/** Used by `cairn mission accept --from <file>` to load a hand-edited roadmap draft. */
export function loadDraftFromFile(path: string): {
  title: string;
  spec_path: string;
  exit_gate: MissionExitGate;
  phases: MissionPhase[];
} {
  if (!existsSync(path)) throw new Error(`Draft file not found: ${path}`);
  const raw = readFileSync(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) throw new Error("Draft file must be a JSON object");
  const obj = parsed as Record<string, unknown>;
  if (typeof obj["title"] !== "string") throw new Error("Draft missing title");
  if (typeof obj["spec_path"] !== "string") throw new Error("Draft missing spec_path");
  if (typeof obj["exit_gate"] !== "string") throw new Error("Draft missing exit_gate");
  if (!Array.isArray(obj["phases"])) throw new Error("Draft missing phases array");
  const exitGate = obj["exit_gate"];
  if (exitGate !== "prompt" && exitGate !== "auto" && exitGate !== "manual") {
    throw new Error(`Invalid exit_gate: ${exitGate}`);
  }
  return {
    title: obj["title"],
    spec_path: obj["spec_path"],
    exit_gate: exitGate,
    phases: obj["phases"] as MissionPhase[],
  };
}

/** Persist the proposed roadmap draft to a temp JSON file for hand-editing. */
export function writeDraftToFile(
  path: string,
  draft: { title: string; spec_path: string; exit_gate: MissionExitGate; phases: MissionPhase[] },
): void {
  writeFileSync(path, JSON.stringify(draft, null, 2) + "\n", "utf8");
}
