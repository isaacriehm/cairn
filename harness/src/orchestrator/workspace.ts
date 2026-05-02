import { logger } from "../logger.js";
import { checkLocalDirtyOverlap, syncMirror } from "../mirror/index.js";
import type { DirtyOverlapResult } from "../mirror/index.js";

const log = logger("orchestrator.workspace");

export interface WorkspacePrepResult {
  sha_pin: string;
  branch: string;
  /** Empty when no `target_path_globs` was supplied. */
  dirty_overlap: DirtyOverlapResult | null;
}

/**
 * Phase 8 workspace prep:
 *   1. `syncMirror` — fetch + reset --hard origin/<branch>; capture SHA pin.
 *   2. `checkLocalDirtyOverlap` — read user's working tree for files that
 *      overlap the run's target globs (per L45). The orchestrator decides
 *      whether to pause + dialog the operator based on the result; this
 *      function only reports.
 *
 * Mutates the mirror only. The user's working tree is NEVER written to.
 */
export async function prepareWorkspace(args: {
  projectName: string;
  targetGlobs?: string[];
}): Promise<WorkspacePrepResult> {
  const { projectName, targetGlobs } = args;

  const sync = await syncMirror({ projectName });
  log.info({ projectName, sha: sync.sha, branch: sync.branch }, "mirror pinned");

  let dirty: DirtyOverlapResult | null = null;
  if (targetGlobs && targetGlobs.length > 0) {
    dirty = await checkLocalDirtyOverlap({ projectName, targetGlobs });
    if (dirty.overlap) {
      log.warn(
        { projectName, files: dirty.overlappingFiles },
        "dirty-overlap detected — orchestrator must pause + dialog",
      );
    }
  }

  return {
    sha_pin: sync.sha,
    branch: sync.branch,
    dirty_overlap: dirty,
  };
}
