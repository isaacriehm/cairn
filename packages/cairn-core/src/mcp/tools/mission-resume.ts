/**
 * `cairn_mission_resume` — return the mission-frame priming body the
 * `cairn-resume` skill chains in front of the existing task journal
 * frame after `/clear`.
 *
 * Budget: ≤ 2500 tokens total (~10000 chars, conservative). Phase
 * spec slice hard-capped at 1500 tokens (~6000 chars); falls back to
 * title + exit_criteria + first paragraph when over.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  countDonePhases,
  findActiveMission,
  locateMission,
  readMissionSpec,
  readMissionState,
  readPhaseBrief,
  readRoadmap,
  slicePhaseSection,
} from "@isaacriehm/cairn-state";
import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { mcpError } from "../errors.js";
import { missionResumeInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  mission_id?: string;
}

const MAX_PHASE_SLICE_CHARS = 6_000;
const MAX_GRADUATED_TASKS = 3;
const MAX_IN_FLIGHT_TASKS = 5;

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;

  const missionId = input.mission_id ?? findActiveMission(ctx.repoRoot);
  if (missionId === null) {
    return { ok: true, active: false };
  }
  if (locateMission(ctx.repoRoot, missionId) !== "active") {
    return mcpError("MISSION_NOT_FOUND", `Mission ${missionId} is not active on this clone`);
  }

  const roadmap = readRoadmap(ctx.repoRoot, missionId);
  const state = readMissionState(ctx.repoRoot, missionId);
  if (roadmap === null || state === null) {
    return mcpError("MISSION_NOT_FOUND", `Mission ${missionId} state or roadmap unreadable`);
  }

  const cursorPhaseId = state.cursor.active_phase;
  const cursorPhase =
    cursorPhaseId === null
      ? null
      : roadmap.frontmatter.phases.find((p) => p.id === cursorPhaseId) ?? null;

  const spec = readMissionSpec(ctx.repoRoot, missionId) ?? "";
  let phaseSlice: string | null = null;
  if (cursorPhase !== null) {
    phaseSlice = slicePhaseSection(spec, cursorPhase);
    if (phaseSlice !== null && phaseSlice.length > MAX_PHASE_SLICE_CHARS) {
      const firstParagraph =
        phaseSlice.split(/\n\n/, 2)[0]?.slice(0, MAX_PHASE_SLICE_CHARS) ?? "";
      phaseSlice = `${firstParagraph}\n\n…(truncated; full section in .cairn/missions/${missionId}/spec.md)`;
    }
  }

  const recentGraduated = collectRecentGraduatedTasks(ctx.repoRoot, missionId, MAX_GRADUATED_TASKS);
  const inFlight = collectInFlightTasks(ctx.repoRoot, missionId);

  const upcoming = roadmap.frontmatter.phases
    .filter((p) => {
      const progress = state.phase_progress[p.id];
      return (progress?.state ?? "pending") === "pending" && p.id !== cursorPhaseId;
    })
    .slice(0, 2);

  const donePhases = countDonePhases(state);
  const totalPhases = roadmap.frontmatter.phases.length;

  const lines: string[] = [];
  lines.push(`# Mission frame — ${roadmap.frontmatter.title}`);
  lines.push("");
  lines.push(`- mission: \`${missionId}\``);
  lines.push(`- spec: \`${roadmap.frontmatter.spec_path}\``);
  lines.push(`- progress: ${donePhases}/${totalPhases} phases`);
  lines.push(`- exit_gate: ${roadmap.frontmatter.exit_gate}`);
  const cursorBrief =
    cursorPhaseId === null
      ? null
      : readPhaseBrief(ctx.repoRoot, missionId, cursorPhaseId);
  // Committed brief file is canonical; per-clone flag is the fallback.
  const cursorBriefStatus =
    cursorBrief?.status ??
    (cursorPhaseId === null
      ? null
      : state.phase_progress[cursorPhaseId]?.brief_status ?? null);
  if (cursorPhase !== null) {
    lines.push(`- cursor: \`${cursorPhase.id}\` — ${cursorPhase.title}`);
    lines.push(`  - exit_criteria: ${cursorPhase.exit_criteria}`);
    lines.push(`  - brief: ${cursorBriefStatus ?? "pending (run Step 2.55 before tasks)"}`);
  } else {
    lines.push(`- cursor: (no active phase — mission may be near close)`);
  }
  lines.push("");

  if (cursorBrief !== null) {
    lines.push(`## Phase brief — ${cursorPhase?.title ?? cursorBrief.phase_id}`);
    lines.push("");
    if (cursorBrief.decisions.length > 0) {
      lines.push("Decisions:");
      for (const d of cursorBrief.decisions) {
        lines.push(`- ${d.question} → ${d.choice}`);
      }
    }
    if (cursorBrief.constraints.length > 0) {
      lines.push("Constraints:");
      for (const c of cursorBrief.constraints) lines.push(`- ${c}`);
    }
    if (cursorBrief.acceptance.length > 0) {
      lines.push("Acceptance:");
      for (const a of cursorBrief.acceptance) lines.push(`- ${a}`);
    }
    lines.push("");
  }

  if (recentGraduated.length > 0) {
    lines.push("## Recent graduated tasks");
    for (const t of recentGraduated) {
      lines.push(`- \`${t.task_id}\` — ${t.title} (${t.outcome})`);
    }
    lines.push("");
  }

  if (inFlight.length > 0) {
    lines.push("## In-flight tasks (current phase)");
    for (const t of inFlight) {
      lines.push(`- \`${t.task_id}\` — ${t.title} (phase=${t.phase})`);
    }
    lines.push("");
  }

  if (cursorPhase !== null && phaseSlice !== null) {
    lines.push(`## Spec section — ${cursorPhase.title}`);
    lines.push("");
    lines.push(phaseSlice);
    lines.push("");
  } else if (cursorPhase !== null) {
    lines.push(`## Spec section — ${cursorPhase.title}`);
    lines.push("");
    lines.push(cursorPhase.exit_criteria);
    lines.push("");
  }

  if (upcoming.length > 0) {
    lines.push("## Upcoming phases");
    for (const p of upcoming) {
      lines.push(`- \`${p.id}\` — ${p.title}`);
    }
    lines.push("");
  }

  return {
    ok: true,
    active: true,
    mission_id: missionId,
    title: roadmap.frontmatter.title,
    cursor_phase: cursorPhase?.id ?? null,
    progress: { done: donePhases, total: totalPhases },
    body: lines.join("\n").trim(),
  };
}

interface RecentTask {
  task_id: string;
  title: string;
  outcome: string;
}

interface ParsedTaskStatus {
  mission_id: string | null;
  phase_id: string | null;
  title: string | null;
  phase: string | null;
}

function parseStatusYaml(path: string): ParsedTaskStatus | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  return {
    mission_id: typeof obj["mission_id"] === "string" ? (obj["mission_id"] as string) : null,
    phase_id: typeof obj["phase_id"] === "string" ? (obj["phase_id"] as string) : null,
    title: typeof obj["title"] === "string" ? (obj["title"] as string) : null,
    phase: typeof obj["phase"] === "string" ? (obj["phase"] as string) : null,
  };
}

function collectRecentGraduatedTasks(
  repoRoot: string,
  missionId: string,
  cap: number,
): RecentTask[] {
  const doneDir = join(repoRoot, ".cairn", "tasks", "done");
  if (!existsSync(doneDir)) return [];
  let entries;
  try {
    entries = readdirSync(doneDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }
  const matches: { task_id: string; title: string; outcome: string; mtime: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statusPath = join(doneDir, entry.name, "status.yaml");
    const status = parseStatusYaml(statusPath);
    if (status === null || status.mission_id !== missionId) continue;
    let mtime = 0;
    try {
      mtime = statSync(statusPath).mtimeMs;
    } catch {
      continue;
    }
    matches.push({
      task_id: entry.name,
      title: status.title ?? entry.name,
      outcome: status.phase ?? "succeeded",
      mtime,
    });
  }
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches.slice(0, cap).map((m) => ({
    task_id: m.task_id,
    title: m.title,
    outcome: m.outcome,
  }));
}

interface InFlightTask {
  task_id: string;
  title: string;
  phase: string;
}

function collectInFlightTasks(repoRoot: string, missionId: string): InFlightTask[] {
  const activeDir = join(repoRoot, ".cairn", "tasks", "active");
  if (!existsSync(activeDir)) return [];
  let entries;
  try {
    entries = readdirSync(activeDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }
  const out: InFlightTask[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statusPath = join(activeDir, entry.name, "status.yaml");
    const status = parseStatusYaml(statusPath);
    if (status === null || status.mission_id !== missionId) continue;
    out.push({
      task_id: entry.name,
      title: status.title ?? entry.name,
      phase: status.phase ?? "unknown",
    });
    if (out.length >= MAX_IN_FLIGHT_TASKS) break;
  }
  return out;
}

export const missionResumeTool: ToolDef<Input> = {
  name: "cairn_mission_resume",
  description:
    "Return the mission-frame priming body the cairn-resume skill chains before the existing task journal frame after `/clear`. Includes mission id + title, cursor phase + exit_criteria, last 3 graduated tasks (mission-anchored), in-flight tasks under the cursor phase, the spec.md section sliced by phase heading (≤6000 chars), and the next 1-2 upcoming phases. Returns `{ active: false }` when no active mission exists.",
  inputSchema: missionResumeInput,
  handler,
};
