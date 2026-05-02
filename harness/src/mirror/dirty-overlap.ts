import { simpleGit } from "simple-git";
import { logger } from "../logger.js";
import { requireMirrorRecord } from "./state.js";
import type { DirtyOverlapOptions, DirtyOverlapResult } from "./types.js";

const log = logger("mirror.dirty-overlap");

/**
 * Codex audit Q3 / L45 — `local_dirty_overlap` gate.
 *
 * Reads the user's working tree (NEVER writes) and reports any un-committed
 * files that overlap the dispatched run's target globs. If overlap is
 * non-empty, the orchestrator pauses the run and offers the operator
 * stash / cancel / wait via the active frontend adapter.
 *
 * Globs use a minimal native matcher — no external dep — that supports `**`
 * (deep), `*` (single-segment), `?` (single char), and literal segments.
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
  const overlapping = dedup.filter((path) => opts.targetGlobs.some((g) => matchGlob(path, g)));

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

function matchGlob(path: string, glob: string): boolean {
  const re = compileGlob(glob);
  return re.test(path);
}

function compileGlob(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c !== undefined && /[.+^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c ?? "";
    }
  }
  re += "$";
  return new RegExp(re);
}
