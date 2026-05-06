/**
 * Phase 7b-source-comments — walk every source file's docblock-class
 * comment, classify via Haiku, write DEC drafts / invariant proposals.
 *
 * Heavy walk + per-block classifications spill to
 * `.cairn/init/source-comments-walk.json`; only the lightweight projection
 * (counts, ledger paths, kindCounts) lives on the persisted phase output.
 *
 * Project globs from the mapper + the 4-pilot picked module flow into
 * scoring so every DEC draft + invariant gets `capture_confidence`
 * stamped at write time — `cairn attention bulk-accept` becomes an
 * O(1) file move instead of a re-score sweep.
 */

import {
  runSourceCommentsIngestion,
  type IngestSourceCommentsResult,
} from "../source-comments/index.js";
import type { ProjectGlobs } from "../../sensors/types.js";
import { clearProgress, writeProgress } from "../progress.js";
import { advancePhase } from "./orchestrator.js";
import type { MapperResultPersisted } from "./mapper-output-io.js";
import {
  to7bResultPersisted,
  writeSourceCommentsWalkFile,
} from "./source-comments-output-io.js";
import type { PhaseResult, PhaseState } from "./types.js";

export async function runPhase7bSourceComments(state: PhaseState): Promise<PhaseResult> {
  const mapper = state.outputs["3-mapper"] as MapperResultPersisted | undefined;
  const globs: ProjectGlobs = mapper
    ? {
        route_handler_globs: mapper.output.route_handler_globs,
        dto_globs: mapper.output.dto_globs,
        generator_source_globs: mapper.output.generator_source_globs,
        high_stakes_globs: mapper.output.high_stakes_globs,
        off_limits: mapper.output.off_limits_globs,
      }
    : {};
  const pilotOut = state.outputs["4-pilot"] as { picked?: string } | undefined;
  const pilotModule =
    typeof pilotOut?.picked === "string" && pilotOut.picked.length > 0
      ? pilotOut.picked
      : undefined;

  const startedAt = Date.now();
  try {
    const result: IngestSourceCommentsResult = await runSourceCommentsIngestion({
      repoRoot: state.repoRoot,
      globs,
      ...(pilotModule !== undefined ? { pilotModule } : {}),
      onBatchProgress: (row) =>
        writeProgress(state.repoRoot, {
          phase: "7b-source-comments",
          batch: row.index + 1,
          total: row.total,
          classified: row.classified,
          failed: row.failed,
          startedAt,
        }),
    });
    writeSourceCommentsWalkFile(state.repoRoot, result);
    const persisted = to7bResultPersisted(result);
    clearProgress(state.repoRoot);
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "7b-source-comments": persisted },
    };
    return {
      status: "complete",
      nextPhase: "7c-rules-merge",
      state: advancePhase(next),
    };
  } catch (err) {
    clearProgress(state.repoRoot);
    return {
      status: "error",
      error: {
        code: "source-comments-failed",
        message: "Source-comment ingestion failed",
        detail: err instanceof Error ? err.stack ?? err.message : String(err),
      },
      state,
    };
  }
}
