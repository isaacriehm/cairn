/**
 * Phases 6 / 7b / 7c parallel orchestrator.
 *
 * The three post-pilot ingestion phases (docs-ingest, source-comments,
 * rules-merge) are each I/O-bound on Haiku; running them sequentially
 * adds the smaller two phases' wall-clock to the long 7b run for no
 * good reason. This runner fires all three concurrently inside a single
 * MCP call.
 *
 * Concurrency-safety:
 *   - DEC + INV id allocators race-free via shared `Set<string>` threads
 *     (each phase's allocation loop is sync within JS turn boundaries,
 *     so mutations to the shared Set are atomic per turn). The pre-scan
 *     happens once, here; phases mutate the Set as they allocate.
 *   - Filesystem mutations are non-overlapping by design: phase 6 writes
 *     to `decisions/_inbox/`, phase 7b writes to `decisions/_inbox/` +
 *     `invariants/` + applies strip-replace to source, phase 7c writes
 *     to `decisions/_inbox/`. Different filenames per phase (DEC ids
 *     are unique across the shared Set), so no race.
 *   - Ledger rebuilds: only 7b rebuilds the invariants ledger; the
 *     decisions ledger is rebuilt later by `bulkAcceptObvious`. Safe.
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

  // Fire all three phases. Each phase's loop is synchronous between
  // await points, so shared-Set mutations stay atomic per JS turn.
  // The 7b heartbeat dominates statusline output (it runs longest), but
  // 6 and 7c also write progress so the operator sees motion across
  // all three.
  const t0 = performance.now();
  const startedAt = Date.now();
  const settled = await Promise.allSettled([
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
    runRulesMerge({
      repoRoot: state.repoRoot,
      existingDecIds: sharedDecIds,
      onSectionProgress: (row) =>
        writeProgress(state.repoRoot, {
          phase: "7c-rules-merge",
          batch: row.index,
          total: row.total,
          startedAt,
        }),
    }),
  ]);
  const durationMs = Math.round(performance.now() - t0);
  clearProgress(state.repoRoot);

  const [docsRes, srcRes, rulesRes] = settled;

  // Any phase failure = whole-block failure. Surface the first error so
  // the operator knows which Haiku batch died and can `/exit` + resume.
  if (docsRes.status !== "fulfilled") {
    return {
      status: "error",
      error: {
        code: "docs-ingest-failed",
        message: "Docs ingestion failed in parallel pipeline",
        detail:
          docsRes.reason instanceof Error
            ? docsRes.reason.stack ?? docsRes.reason.message
            : String(docsRes.reason),
      },
      state,
    };
  }
  if (srcRes.status !== "fulfilled") {
    return {
      status: "error",
      error: {
        code: "source-comments-failed",
        message: "Source-comment ingestion failed in parallel pipeline",
        detail:
          srcRes.reason instanceof Error
            ? srcRes.reason.stack ?? srcRes.reason.message
            : String(srcRes.reason),
      },
      state,
    };
  }
  if (rulesRes.status !== "fulfilled") {
    return {
      status: "error",
      error: {
        code: "rules-merge-failed",
        message: "Rules merge failed in parallel pipeline",
        detail:
          rulesRes.reason instanceof Error
            ? rulesRes.reason.stack ?? rulesRes.reason.message
            : String(rulesRes.reason),
      },
      state,
    };
  }

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
