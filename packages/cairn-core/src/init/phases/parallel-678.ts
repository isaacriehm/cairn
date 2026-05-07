/**
 * Phases 6 / 7b / 7c sequential orchestrator.
 *
 * The three post-pilot ingestion phases (docs-ingest, source-comments,
 * rules-merge) all read + write the same v0.5.0 ground-state files —
 * `topic-index.yaml`, `anchor-map.yaml`, `sot-bindings.yaml`,
 * `sot-cache.yaml`. Concurrent execution races on those writes: each
 * phase reads at start, mutates in memory, writes at end → last writer
 * wipes the others. The v0.4.x parallel orchestrator was safe because
 * only DEC/INV files (uniquely named per id) were on the write path.
 *
 * v0.5.0 fix: run the phases sequentially in canonical order
 * (6 → 7b → 7c). Each phase still uses Haiku internally (with its own
 * concurrency for batching + per-section workers), so the wall-clock
 * cost vs. the v0.4.x parallel pipeline is bounded by the longest
 * phase plus the smaller two — historically <5s combined for the
 * smaller phases. Heartbeats fire per phase so the operator sees
 * motion across all three.
 *
 * State machine:
 *   - The runner enters expecting `currentPhase === "6-docs-ingest"` and
 *     exits with `currentPhase === "8-baseline"`, jumping past the
 *     individual 7b / 7c slots in PHASE_IDS. The sequential per-phase
 *     MCP tools remain available; this runner is the optimized path the
 *     adopt skill prefers.
 */

import {
  scanExistingDecisionIds,
  scanExistingInvariantIds,
} from "../../decision-capture/id.js";
import { logger } from "../../logger.js";
import { runDocsIngestion, type IngestionResult } from "../ingest-docs.js";
import { clearProgress, writeProgress } from "../progress.js";
import { runRulesMerge, type RunRulesMergeResult } from "../rules-merge/index.js";
import { runSourceCommentsIngestion } from "../source-comments/index.js";
import type { ProjectGlobs } from "../../sensors/types.js";
import type { MapperResultPersisted } from "./mapper-output-io.js";
import {
  to7bResultPersisted,
  writeSourceCommentsWalkFile,
  type IngestSourceCommentsResultPersisted,
} from "./source-comments-output-io.js";
import { advancePhase } from "./orchestrator.js";
import type { PhaseId, PhaseResult, PhaseState } from "./types.js";

const log = logger("init.phases.parallel-678");

interface ParallelOutputs {
  "6-docs-ingest": IngestionResult;
  "7b-source-comments": IngestSourceCommentsResultPersisted;
  "7c-rules-merge": RunRulesMergeResult;
}

export async function runPhases678Parallel(
  state: PhaseState,
): Promise<PhaseResult> {
  // Sanity: this runner only enters at the start of the 6 / 7b / 7c
  // window. If currentPhase is anywhere else, the caller invoked the
  // wrong tool — surface as error so we don't mid-pipeline jump.
  if (state.currentPhase !== "6-docs-ingest") {
    return {
      status: "error",
      error: {
        code: "wrong-phase",
        message: `runPhases678Parallel requires currentPhase=6-docs-ingest, got ${state.currentPhase}`,
      },
      state,
    };
  }

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

  const sharedDecIds = scanExistingDecisionIds(state.repoRoot);
  const sharedInvIds = scanExistingInvariantIds(state.repoRoot);

  log.info(
    {
      preScannedDecIds: sharedDecIds.size,
      preScannedInvIds: sharedInvIds.size,
    },
    "parallel-678 starting",
  );

  // Run the three phases sequentially. v0.5.0 ground-state files
  // (topic-index, anchor-map, sot-bindings, sot-cache) are the shared
  // mutable surface; serializing 6 → 7b → 7c removes the last-writer-
  // wins race that Promise.allSettled had under v0.4.x.
  const t0 = performance.now();
  const startedAt = Date.now();

  const docsRes = await runPhaseSafely("docs-ingest-failed", async () =>
    runDocsIngestion({
      repoRoot: state.repoRoot,
      existingDecIds: sharedDecIds,
      onEntryProgress: (row) =>
        writeProgress(state.repoRoot, {
          phase: "6-docs-ingest",
          batch: row.total > 0 ? row.total : 1,
          total: row.total,
          startedAt,
        }),
    }),
  );
  if ("error" in docsRes) {
    clearProgress(state.repoRoot);
    return { status: "error", error: docsRes.error, state };
  }

  const srcRes = await runPhaseSafely("source-comments-failed", async () =>
    runSourceCommentsIngestion({
      repoRoot: state.repoRoot,
      globs,
      ...(pilotModule !== undefined ? { pilotModule } : {}),
      existingDecIds: sharedDecIds,
      existingInvIds: sharedInvIds,
      onBatchProgress: (row) =>
        writeProgress(state.repoRoot, {
          phase: "7b-source-comments",
          batch: row.index + 1,
          total: row.total,
          classified: row.classified,
          failed: row.failed,
          startedAt,
        }),
    }),
  );
  if ("error" in srcRes) {
    clearProgress(state.repoRoot);
    return { status: "error", error: srcRes.error, state };
  }

  const rulesRes = await runPhaseSafely("rules-merge-failed", async () =>
    runRulesMerge({
      repoRoot: state.repoRoot,
      existingDecIds: sharedDecIds,
      existingInvIds: sharedInvIds,
      onSectionProgress: (row) =>
        writeProgress(state.repoRoot, {
          phase: "7c-rules-merge",
          batch: row.index,
          total: row.total,
          startedAt,
        }),
    }),
  );
  if ("error" in rulesRes) {
    clearProgress(state.repoRoot);
    return { status: "error", error: rulesRes.error, state };
  }
  const durationMs = Math.round(performance.now() - t0);
  clearProgress(state.repoRoot);

  writeSourceCommentsWalkFile(state.repoRoot, srcRes.value);
  const persistedSrc = to7bResultPersisted(srcRes.value);

  const outputs: ParallelOutputs = {
    "6-docs-ingest": docsRes.value,
    "7b-source-comments": persistedSrc,
    "7c-rules-merge": rulesRes.value,
  };

  // Advance the state machine all the way past 7c so the next phase
  // tool the skill calls is 8-baseline.
  let next: PhaseState = {
    ...state,
    outputs: {
      ...state.outputs,
      ...outputs,
    },
  };
  const skipTargets: PhaseId[] = ["6-docs-ingest", "7b-source-comments", "7c-rules-merge"];
  for (const _ of skipTargets) {
    next = advancePhase(next);
  }

  // Stamp aggregate duration for ETA-audit telemetry.
  for (const id of skipTargets) {
    const out = next.outputs[id];
    if (typeof out === "object" && out !== null) {
      const obj = out as Record<string, unknown>;
      if (obj["duration_ms"] === undefined) {
        // Approximate per-phase duration via the wall-clock divided
        // among the three phases — until each ingest function reports
        // its own duration, this is the best we can do.
        obj["duration_ms"] = durationMs;
      }
    }
  }

  log.info(
    {
      durationMs,
      decsAfter: sharedDecIds.size,
      invsAfter: sharedInvIds.size,
    },
    "parallel-678 complete",
  );

  return {
    status: "complete",
    nextPhase: next.currentPhase,
    state: next,
  };
}

interface PhaseError {
  code: string;
  message: string;
  detail?: string;
}

async function runPhaseSafely<T>(
  code: string,
  fn: () => Promise<T>,
): Promise<{ value: T } | { error: PhaseError }> {
  try {
    return { value: await fn() };
  } catch (err) {
    const detail =
      err instanceof Error ? err.stack ?? err.message : String(err);
    const message =
      code === "docs-ingest-failed"
        ? "Docs ingestion failed"
        : code === "source-comments-failed"
          ? "Source-comment ingestion failed"
          : "Rules merge failed";
    return { error: { code, message, detail } };
  }
}
