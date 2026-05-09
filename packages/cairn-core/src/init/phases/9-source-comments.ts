/**
 * Phase 9-source-comments — walk every source file's docblock-class
 * comment, classify via Haiku, write DEC drafts / invariant proposals.
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

export async function runPhase9SourceComments(state: PhaseState): Promise<PhaseResult> {
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
  const pilotOut = state.outputs["5-pilot"] as { picked?: string } | undefined;
  const pilotModule =
    typeof pilotOut?.picked === "string" && pilotOut.picked.length > 0
      ? pilotOut.picked
      : undefined;

  const startedAt = Date.now();
  try {
    const result: IngestSourceCommentsResult = await runSourceCommentsIngestion({
      repoRoot: state.repoRoot,
    });
    writeSourceCommentsWalkFile(state.repoRoot, result);
    const persisted = to7bResultPersisted(result);
    clearProgress(state.repoRoot);
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "9-source-comments": persisted },
    };
    return {
      status: "complete",
      nextPhase: "10-rules-merge",
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
