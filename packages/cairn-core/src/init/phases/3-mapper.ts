/**
 * Phase 3-mapper — Sonnet-driven domain map.
 *
 * Reads detection (from phase 1) + repo summary (from phase 2),
 * dispatches the chunked mapper pipeline, and stamps MapperResult
 * under outputs["3-mapper"]. The downstream phases consume
 * mapper.output for pilot suggestions, project_globs, sensor
 * proposals, etc.
 *
 * No operator input — the mapper runs unattended (Sonnet via the
 * cairn runner), with the caveat that under v0.1.x the bash
 * subprocess + --no-prompt path skipped this entirely. The phase
 * function is what restores it under MCP-native init.
 */

import { runMapper, type MapperResult } from "../mapper.js";
import type { DetectionResult } from "../types.js";
import type { RepoSummary } from "../walker.js";
import { advancePhase } from "./orchestrator.js";
import type { PhaseResult, PhaseState } from "./types.js";

export async function runPhase3Mapper(state: PhaseState): Promise<PhaseResult> {
  const detection = state.outputs["1-detect"] as DetectionResult | undefined;
  const summary = state.outputs["2-walker"] as RepoSummary | undefined;
  if (detection === undefined || summary === undefined) {
    return {
      status: "error",
      error: {
        code: "missing-prereqs",
        message: "Phase 3 needs phases 1-detect + 2-walker outputs",
      },
      state,
    };
  }
  try {
    const result: MapperResult = await runMapper({
      detection,
      summary,
      repoRoot: state.repoRoot,
    });
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "3-mapper": result },
    };
    return {
      status: "complete",
      nextPhase: "3b-seed",
      state: advancePhase(next),
    };
  } catch (err) {
    return {
      status: "error",
      error: {
        code: "mapper-failed",
        message: "Mapper pipeline failed",
        detail: err instanceof Error ? err.stack ?? err.message : String(err),
      },
      state,
    };
  }
}
