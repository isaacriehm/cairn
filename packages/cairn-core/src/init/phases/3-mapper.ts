/**
 * Phase 3-mapper — Sonnet-driven domain map.
 *
 * Reads detection (from phase 1) + repo summary (from phase 2),
 * dispatches the chunked mapper pipeline, and stamps a
 * `MapperResultPersisted` (light projection without scope_index.files
 * and module_proposals) under outputs["3-mapper"]. The full
 * `MapperResult` is written to `.cairn/init/mapper-output.json` —
 * phase 4-seed loads it from disk to seed scope-index.yaml.
 *
 * The split keeps `.cairn/init-state.json` under 30KB even on a
 * 400-file monorepo, which is what the cairn-adopt skill can carry
 * through MCP responses without triggering the spillover-to-file
 * tool-result path.
 *
 * No operator input — the mapper runs unattended (Sonnet via the
 * cairn runner).
 */

import { runMapper, type MapperResult } from "../mapper.js";
import { clearProgress, writeProgress } from "../progress.js";
import {
  toMapperResultPersisted,
  writeMapperOutputFile,
} from "./mapper-output-io.js";
import { advancePhase } from "./orchestrator.js";
import type { PhaseResult, PhaseState } from "./types.js";

export async function runPhase3Mapper(state: PhaseState): Promise<PhaseResult> {
  const detection = state.outputs["1-detect"];
  const summary = state.outputs["2-walker"];
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
  const startedAt = Date.now();
  let totalSlices = 0;
  let completed = 0;
  try {
    const result: MapperResult = await runMapper({
      detection,
      summary,
      repoRoot: state.repoRoot,
      onSlicesDetected: (slices) => {
        totalSlices = slices.length;
      },
      onModuleEnd: () => {
        completed += 1;
        writeProgress(state.repoRoot, {
          phase: "3-mapper",
          batch: completed,
          total: totalSlices,
          startedAt,
        });
      },
    });
    // Write the full result (with scope_index.files + module_proposals)
    // to disk; downstream phases that need those reload it on demand.
    writeMapperOutputFile(state.repoRoot, result);
    const persisted = toMapperResultPersisted(result);
    clearProgress(state.repoRoot);
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "3-mapper": persisted },
    };
    return {
      status: "complete",
      nextPhase: "4-seed",
      state: advancePhase(next),
    };
  } catch (err) {
    clearProgress(state.repoRoot);
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
