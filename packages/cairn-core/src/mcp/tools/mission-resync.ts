/**
 * `cairn_mission_resync` — operator amended the source spec doc and
 * wants Cairn to pick up the changes.
 *
 * Re-parses the spec via Haiku (or `no_llm: true` stub fallback),
 * diffs against the current roadmap.md, and writes a `mission_resync_pending`
 * marker file under `.cairn/missions/<id>/_resync.json`. The operator
 * resolves via `cairn-attention` — accepting the diff overwrites the
 * roadmap and refreshes `spec.md`; rejecting drops the marker.
 *
 * No mutation of `roadmap.md` or `phase_progress` happens here — the
 * operator gates the apply step via `cairn_mission_resync_accept`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve as pathResolve } from "node:path";
import {
  appendMissionJournal,
  findActiveMission,
  missionRuntimeDir,
  readRoadmap,
} from "@isaacriehm/cairn-state";
import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { mcpError } from "../errors.js";
import { missionResyncInput } from "../schemas.js";
import { draftRoadmapFromSpec, stubRoadmap } from "../../missions/index.js";
import type { ToolDef } from "./types.js";

interface Input {
  spec_path?: string;
  no_llm?: boolean;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;

  const missionId = findActiveMission(ctx.repoRoot);
  if (missionId === null) {
    return mcpError("MISSION_NOT_FOUND", "No active mission to resync");
  }

  const roadmap = readRoadmap(ctx.repoRoot, missionId);
  if (roadmap === null) {
    return mcpError("MISSION_NOT_FOUND", `Roadmap missing for ${missionId}`);
  }

  const specPath = input.spec_path ?? roadmap.frontmatter.spec_path;
  const absSpec = isAbsolute(specPath) ? specPath : pathResolve(ctx.repoRoot, specPath);
  if (!absSpec.startsWith(ctx.repoRoot)) {
    return mcpError("PATH_OUTSIDE_REPO", `${specPath} resolves outside the repo`);
  }
  if (!existsSync(absSpec)) {
    return mcpError("FILE_NOT_FOUND", `Spec doc not found: ${specPath}`);
  }

  let source: string;
  try {
    source = readFileSync(absSpec, "utf8");
  } catch (err) {
    return mcpError(
      "INTERNAL_ERROR",
      `Failed to read spec doc: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let newPhases;
  if (input.no_llm === true) {
    newPhases = stubRoadmap();
  } else {
    const draft = await draftRoadmapFromSpec({
      repoRoot: ctx.repoRoot,
      spec: source,
      specPath,
    });
    if (draft === null) {
      return mcpError(
        "MISSION_DRAFT_FAILED",
        "Haiku failed to re-parse the spec. Retry, or pass `no_llm: true` for a stub fallback.",
      );
    }
    newPhases = draft.phases;
  }

  const oldIds = new Set(roadmap.frontmatter.phases.map((p) => p.id));
  const newIds = new Set(newPhases.map((p) => p.id));
  const added = [...newIds].filter((id) => !oldIds.has(id));
  const removed = [...oldIds].filter((id) => !newIds.has(id));
  const renamed: { from: string; to: string }[] = [];
  // crude rename detection — same title at different ids
  for (const op of roadmap.frontmatter.phases) {
    for (const np of newPhases) {
      if (op.id !== np.id && op.title === np.title) {
        renamed.push({ from: op.id, to: np.id });
      }
    }
  }
  const exit_criteria_changed: { id: string; before: string; after: string }[] = [];
  for (const op of roadmap.frontmatter.phases) {
    const np = newPhases.find((n) => n.id === op.id);
    if (np !== undefined && np.exit_criteria !== op.exit_criteria) {
      exit_criteria_changed.push({ id: op.id, before: op.exit_criteria, after: np.exit_criteria });
    }
  }

  const ts = new Date().toISOString();
  const resyncPath = join(missionRuntimeDir(ctx.repoRoot, missionId), "_resync.json");
  mkdirSync(missionRuntimeDir(ctx.repoRoot, missionId), { recursive: true });
  writeFileSync(
    resyncPath,
    JSON.stringify(
      {
        generated_at: ts,
        spec_path: specPath,
        proposed_phases: newPhases,
        diff: { added, removed, renamed, exit_criteria_changed },
      },
      null,
      2,
    ),
    "utf8",
  );

  appendMissionJournal(ctx.repoRoot, missionId, {
    ts,
    kind: "resync-pending",
    detail: `+${added.length} −${removed.length} ↻${renamed.length} criteria${exit_criteria_changed.length}`,
  });

  return {
    ok: true,
    mission_id: missionId,
    spec_path: specPath,
    diff: { added, removed, renamed, exit_criteria_changed },
    proposed_phases: newPhases,
    resync_marker_path: `.cairn/missions/${missionId}/_resync.json`,
    note: "Operator reviews via cairn-attention (kind: mission_resync_pending). Apply or reject via cairn_mission_resync_accept.",
  };
}

export const missionResyncTool: ToolDef<Input> = {
  name: "cairn_mission_resync",
  description:
    "Re-parse the source spec doc, diff against the current roadmap.md, and write a `mission_resync_pending` marker. Does NOT mutate roadmap.md or phase_progress — the operator must accept the diff via cairn-attention. Use when the operator amended the live spec doc; the frozen `spec.md` snapshot stays untouched until the resync is accepted.",
  inputSchema: missionResyncInput,
  handler,
};
