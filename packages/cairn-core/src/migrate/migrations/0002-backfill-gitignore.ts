/**
 * 0002 — backfill `.cairn/.gitignore` + untrack committed derived state.
 *
 * Repos adopted before the relevant releases (tasks/missions v0.11.3, derived
 * ground indexes v0.15.0, component index v0.18.0) lack the ignore lines and
 * may have COMMITTED per-clone derived state that then churns across clones.
 *
 * `review` (not `safe`): apply runs `git rm --cached`, mutating the git index —
 * a VCS change the operator confirms via `cairn migrate --all`, never silently
 * at SessionStart. Detect/apply share `remediateGitignore` with the
 * `cairn fix gitignore` CLI, and both are idempotent.
 */

import type { Migration, MigrationResult } from "../types.js";
import { remediateGitignore } from "../gitignore.js";

export const backfillGitignore: Migration = {
  id: "0002-backfill-gitignore",
  // Ships in 0.22.0 → runs for every pin < 0.22.0 (catches 0.21 adopters who
  // upgraded from <0.15 and got 0001 but never a gitignore backfill). Bump in
  // lockstep with the release that lands this.
  introducedIn: "0.22.0",
  describe:
    "Backfill .cairn/.gitignore (derived ground indexes, component index, per-clone state) and untrack derived state committed before it was gitignored — repos adopted before v0.15.0/v0.18.0",
  class: "review",
  detect(repoRoot: string): boolean {
    return remediateGitignore(repoRoot, { apply: false }).changed;
  },
  apply(repoRoot: string): MigrationResult {
    const r = remediateGitignore(repoRoot, { apply: true });
    const parts: string[] = [];
    if (r.addedEntries.length > 0) {
      parts.push(
        `added ${r.addedEntries.length} ignore entr${r.addedEntries.length === 1 ? "y" : "ies"}`,
      );
    }
    if (r.untracked.length > 0) {
      parts.push(`untracked ${r.untracked.length} committed derived file(s)`);
    }
    return {
      changed: r.changed,
      detail: r.changed ? parts.join("; ") : "nothing to backfill",
    };
  },
};
