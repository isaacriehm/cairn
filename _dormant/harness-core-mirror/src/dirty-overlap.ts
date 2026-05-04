import { simpleGit } from "simple-git";
import { matchAnyGlob } from "../ground/glob.js";
import { logger } from "../logger.js";
import { requireMirrorRecord } from "./state.js";
import type { DirtyOverlapOptions, DirtyOverlapResult } from "./types.js";

const log = logger("mirror.dirty-overlap");

/**
 * `local_dirty_overlap` gate.
 *
 * Reads the user's working tree (NEVER writes) and reports any un-committed
 * files that overlap the dispatched run's target globs. If overlap is
 * non-empty, the orchestrator pauses the run and offers the operator
 * stash / cancel / wait via the active frontend adapter.
 *
 * Glob matching reuses `ground/glob.ts` so the matcher is the same one
 * `walkCanonical` and the GC sweeps use.
 */
export async function checkLocalDirtyOverlap(
  opts: DirtyOverlapOptions,
): Promise<DirtyOverlapResult> {
  const record = requireMirrorRecord(opts.projectName);
  const repo = simpleGit(record.userTreePath);

  const status = await repo.status();
  const dirtyFiles = [
    ...status.not_added,
    ...status.modified,
    ...status.created,
    ...status.deleted,
    ...status.renamed.map((r) => r.to),
    ...status.staged,
  ];
  const dedup = Array.from(new Set(dirtyFiles));
  const overlapping = dedup.filter((path) => matchAnyGlob(path, opts.targetGlobs));

  log.debug(
    {
      projectName: opts.projectName,
      dirtyCount: dedup.length,
      overlapCount: overlapping.length,
    },
    "dirty-overlap check",
  );

  return {
    dirtyFiles: dedup,
    overlappingFiles: overlapping,
    overlap: overlapping.length > 0,
  };
}
