/**
 * `cairn_mission_resync_accept` — apply or reject the pending resync
 * marker (`.cairn/missions/<id>/_resync.json`) written by
 * `cairn_mission_resync`. On accept: rewrite roadmap.md with the
 * proposed phases (preserving mission_id, title, exit_gate,
 * created_at), refresh spec.md from the live spec doc, reconcile
 * `phase_progress` (added phases → pending entries; removed phases →
 * dropped with journal note), and reposition the cursor when the
 * active phase was deleted.
 *
 * Reject just deletes the marker; roadmap.md and state.json stay
 * untouched.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve as pathResolve } from "node:path";
import { z } from "zod";
import {
  appendMissionJournal,
  findActiveMission,
  type MissionPhase,
  type MissionRoadmapFrontmatter,
  missionRuntimeDir,
  nextPendingPhase,
  readMissionState,
  readRoadmap,
  writeMissionSpec,
  writeMissionState,
  writeRoadmap,
} from "@isaacriehm/cairn-state";
import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { mcpError } from "../errors.js";
import { missionResyncAcceptInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  outcome: "accept" | "reject";
}

const ResyncMarkerSchema = z.object({
  generated_at: z.string(),
  spec_path: z.string(),
  proposed_phases: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      depends_on: z.array(z.string()).default([]),
      exit_criteria: z.string(),
      exit_gate: z.enum(["prompt", "auto", "manual"]).optional(),
    }),
  ),
  diff: z
    .object({
      added: z.array(z.string()),
      removed: z.array(z.string()),
      renamed: z.array(z.object({ from: z.string(), to: z.string() })),
      exit_criteria_changed: z.array(
        z.object({ id: z.string(), before: z.string(), after: z.string() }),
      ),
    })
    .passthrough(),
});

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;

  const missionId = findActiveMission(ctx.repoRoot);
  if (missionId === null) {
    return mcpError("MISSION_NOT_FOUND", "No active mission");
  }

  const markerPath = join(missionRuntimeDir(ctx.repoRoot, missionId), "_resync.json");
  if (!existsSync(markerPath)) {
    return mcpError(
      "FILE_NOT_FOUND",
      `No pending resync for ${missionId} (_resync.json not present)`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(markerPath, "utf8");
  } catch (err) {
    return mcpError(
      "INTERNAL_ERROR",
      `Failed to read resync marker: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return mcpError(
      "INTERNAL_ERROR",
      `Resync marker malformed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const markerResult = ResyncMarkerSchema.safeParse(parsed);
  if (!markerResult.success) {
    return mcpError("VALIDATION_FAILED", `Resync marker invalid: ${markerResult.error.message}`);
  }
  const marker = markerResult.data;

  const ts = new Date().toISOString();

  if (input.outcome === "reject") {
    rmSync(markerPath, { force: true });
    appendMissionJournal(ctx.repoRoot, missionId, {
      ts,
      kind: "resync-applied",
      detail: "rejected by operator",
    });
    return {
      ok: true,
      mission_id: missionId,
      outcome: "rejected",
    };
  }

  // outcome === "accept"
  const roadmap = readRoadmap(ctx.repoRoot, missionId);
  const state = readMissionState(ctx.repoRoot, missionId);
  if (roadmap === null || state === null) {
    return mcpError("MISSION_NOT_FOUND", `Mission ${missionId} state or roadmap unreadable`);
  }

  // Build new roadmap frontmatter — preserve mission_id, title,
  // exit_gate, created_at, spec_path. Replace phases with the
  // operator-approved proposed_phases.
  const newPhases: MissionPhase[] = marker.proposed_phases.map((p) => ({
    id: p.id,
    title: p.title,
    depends_on: p.depends_on,
    exit_criteria: p.exit_criteria,
    ...(p.exit_gate !== undefined ? { exit_gate: p.exit_gate } : {}),
  }));
  const newFrontmatter: MissionRoadmapFrontmatter = {
    mission_id: roadmap.frontmatter.mission_id,
    title: roadmap.frontmatter.title,
    spec_path: marker.spec_path,
    created_at: roadmap.frontmatter.created_at,
    exit_gate: roadmap.frontmatter.exit_gate,
    phases: newPhases,
  };
  writeRoadmap(ctx.repoRoot, missionId, newFrontmatter, roadmap.prose);

  // Refresh spec.md from the live spec doc.
  const absSpec = isAbsolute(marker.spec_path)
    ? marker.spec_path
    : pathResolve(ctx.repoRoot, marker.spec_path);
  if (existsSync(absSpec)) {
    try {
      const liveSpec = readFileSync(absSpec, "utf8");
      writeMissionSpec(ctx.repoRoot, missionId, liveSpec);
    } catch {
      // best-effort spec refresh; resync still applies even if spec read fails
    }
  }

  // Reconcile phase_progress.
  // - Added phases: insert a `pending` entry with no task_ids.
  // - Removed phases (in marker.diff.removed): drop from phase_progress;
  //   journal each drop with the orphaned task ids.
  // - Surviving phases keep their state + task_ids.
  const orphanedByPhase: Record<string, string[]> = {};
  for (const removed of marker.diff.removed) {
    const taskIds = state.phase_progress[removed]?.task_ids ?? [];
    if (taskIds.length > 0) orphanedByPhase[removed] = taskIds;
    delete state.phase_progress[removed];
  }
  for (const added of marker.diff.added) {
    if (!(added in state.phase_progress)) {
      state.phase_progress[added] = { state: "pending", task_ids: [] };
    }
  }

  // Cursor: if the current active phase was removed, recompute via
  // nextPendingPhase against the new roadmap. If no phase remains
  // pending, leave cursor null (mission may auto-close on next
  // advance).
  const cursorPhaseId = state.cursor.active_phase;
  if (cursorPhaseId !== null && !newPhases.some((p) => p.id === cursorPhaseId)) {
    const nextPhase = nextPendingPhase(newFrontmatter, state);
    if (nextPhase !== null) {
      state.cursor.active_phase = nextPhase.id;
      state.cursor.active_phase_started_at = ts;
      const existing = state.phase_progress[nextPhase.id];
      state.phase_progress[nextPhase.id] = {
        state: "in_progress",
        task_ids: existing?.task_ids ?? [],
      };
    } else {
      state.cursor.active_phase = null;
      state.cursor.active_phase_started_at = null;
    }
  }

  writeMissionState(ctx.repoRoot, missionId, state);

  appendMissionJournal(ctx.repoRoot, missionId, {
    ts,
    kind: "resync-applied",
    detail: `+${marker.diff.added.length} −${marker.diff.removed.length} ↻${marker.diff.renamed.length} criteria${marker.diff.exit_criteria_changed.length}`,
  });
  for (const [phaseId, ids] of Object.entries(orphanedByPhase)) {
    appendMissionJournal(ctx.repoRoot, missionId, {
      ts,
      kind: "drift-detected",
      phase_id: phaseId,
      detail: `dropped via resync — ${ids.length} graduated task(s) orphaned`,
    });
  }

  rmSync(markerPath, { force: true });

  return {
    ok: true,
    mission_id: missionId,
    outcome: "applied",
    diff: marker.diff,
    new_phase_count: newPhases.length,
    cursor_phase: state.cursor.active_phase,
    orphaned_tasks_by_phase: orphanedByPhase,
  };
}

export const missionResyncAcceptTool: ToolDef<Input> = {
  name: "cairn_mission_resync_accept",
  description:
    "Apply or reject the pending resync marker written by cairn_mission_resync. `outcome=accept` rewrites roadmap.md with the proposed phases, refreshes spec.md from the live spec, reconciles phase_progress (adds/drops), and repositions the cursor when the active phase was deleted. `outcome=reject` deletes the marker without touching anything else. Idempotent — once applied, the marker is gone.",
  inputSchema: missionResyncAcceptInput,
  handler,
};
