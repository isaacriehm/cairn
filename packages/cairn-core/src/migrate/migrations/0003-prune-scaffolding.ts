/**
 * 0003 — prune one-time init scaffolding.
 *
 * `.cairn/init/` (the mapper output + curator corpus) and `.cairn/backups/`
 * (the pre-strip `.original` copies of every source file the comment-ingest
 * rewrote) are written ONCE during adoption and never again. Nothing in the
 * daily flow reads them — only the `cairn fix` repair escape-hatch
 * (re-derive-from-mapper, restore-stripped-comments) does. On a real repo
 * they are dead weight measured in megabytes (observed: a 255 KB mapper
 * dump + a 127-file / 1.7 MB backup tree).
 *
 * `review` (not `safe`): apply hard-deletes committed/working-tree state and
 * disables those two `cairn fix` repairs, so it is operator-confirmed —
 * surfaced at SessionStart and applied via the `cairn_migrate` tool (or
 * `cairn migrate --all`), never silently. Idempotent: re-running after the
 * dirs are gone is a no-op.
 */

import { existsSync, rmSync } from "node:fs";
import { cairnDir } from "@isaacriehm/cairn-state";
import type { Migration, MigrationResult } from "../types.js";

/** Top-level `.cairn/` subtrees that exist only as init-time scaffolding. */
const SCAFFOLDING_DIRS = ["init", "backups"] as const;

function present(repoRoot: string): string[] {
  return SCAFFOLDING_DIRS.filter((d) => existsSync(cairnDir(repoRoot, d)));
}

export const pruneScaffolding: Migration = {
  id: "0003-prune-scaffolding",
  // Ships in 0.22.1 → runs for every pin < 0.22.1 (catches every 0.22.0
  // adopter on the patch pull). Bump in lockstep with the release that lands it.
  introducedIn: "0.22.1",
  describe:
    "Remove one-time init scaffolding (.cairn/init mapper output + curator corpus, .cairn/backups source-strip copies) — dead weight once adoption is past the cairn-fix repair window",
  class: "review",
  detect(repoRoot: string): boolean {
    return present(repoRoot).length > 0;
  },
  apply(repoRoot: string): MigrationResult {
    const removed: string[] = [];
    for (const dir of present(repoRoot)) {
      try {
        rmSync(cairnDir(repoRoot, dir), { recursive: true, force: true });
        removed.push(`.cairn/${dir}`);
      } catch {
        /* best-effort — a locked/permission-denied subtree is left in place */
      }
    }
    return {
      changed: removed.length > 0,
      detail:
        removed.length > 0
          ? `removed ${removed.length} scaffolding dir(s): ${removed.join(", ")}`
          : "no init scaffolding present",
    };
  },
};
