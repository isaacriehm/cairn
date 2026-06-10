/**
 * Phase 9b-curate — skill-driven map+reduce dispatch (v0.9.0).
 *
 * The actual map+reduce work runs in the cairn-adopt skill. The skill
 * reads `shards.json` from Phase 9a, spawns `cairn:curator-map`
 * subagents per shard in parallel rounds of 4, then spawns one
 * `cairn:curator-reduce` subagent over the aggregated candidates,
 * writing the final synthesized entries to
 * `.cairn/init/curator/final.jsonl`.
 *
 * This MCP runner is the state-machine bookkeeper for that work — it
 * confirms `final.jsonl` exists, counts entries, advances to 9c-emit.
 * If the skill calls this runner before writing `final.jsonl`, the
 * runner errors so the operator sees a clear "skill orchestration
 * skipped" signal rather than 9c-emit silently emitting zero entries.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cairnDir } from "@isaacriehm/cairn-state";
import { advancePhase, isSelfAdoptState } from "./orchestrator.js";
import type { CurateOutput, PhaseResult, PhaseState } from "./types.js";

/** Repo-relative display path. State home resolution goes through `cairnDir`. */
export const CURATOR_FINAL_PATH = join(".cairn", "init", "curator", "final.jsonl");

export async function runPhase9bCurate(state: PhaseState): Promise<PhaseResult> {
  if (isSelfAdoptState(state)) {
    const skipped: CurateOutput = { skipped: "self-adopt" };
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "9b-curate": skipped },
    };
    return {
      status: "complete",
      nextPhase: "9c-emit",
      state: advancePhase(next),
    };
  }
  const finalAbs = cairnDir(state.repoRoot, "init", "curator", "final.jsonl");
  if (!existsSync(finalAbs)) {
    return {
      status: "error",
      error: {
        code: "9b-curate-missing-final",
        message:
          "Curator skill orchestration did not write final.jsonl. The cairn-adopt skill must dispatch curator-map + curator-reduce subagents before invoking 9b-curate.",
        // Absolute path actually checked — in ghost this is out-of-repo, so a
        // subagent that wrote final.jsonl repo-relative surfaces here clearly.
        detail: `Expected file at ${finalAbs}`,
      },
      state,
    };
  }
  let entries = 0;
  try {
    const text = readFileSync(finalAbs, "utf8");
    for (const line of text.split("\n")) {
      if (line.trim().length > 0) entries += 1;
    }
  } catch (err) {
    return {
      status: "error",
      error: {
        code: "9b-curate-read-failed",
        message: "Failed to read curator final.jsonl",
        detail: err instanceof Error ? err.stack ?? err.message : String(err),
      },
      state,
    };
  }
  const out: CurateOutput = {
    final_path: CURATOR_FINAL_PATH,
    final_entries: entries,
  };
  const next: PhaseState = {
    ...state,
    outputs: { ...state.outputs, "9b-curate": out },
  };
  return {
    status: "complete",
    nextPhase: "9c-emit",
    state: advancePhase(next),
  };
}
