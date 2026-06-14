/**
 * 0009 — repair `§DEC-/§INV-` source cites left dangling by an archive.
 *
 * When sot-align (or init) mints an entity from a source comment, it
 * strip-replaces the prose with a bare `// §INV-<id>` / `// §DEC-<id>` cite.
 * Retiring that entity — most often the 0006 invariant prune — moves it to
 * `.cairn/ground/.archive/` but leaves the cite in source, so the working
 * tree carries a token pointing at a dead entity ("invariant IDs left in the
 * code"). The 0006 prune now repairs the cites it strands as it archives, but
 * repos pruned BEFORE that fix still carry the orphans, and this migration is
 * the catch-up: it scans the tree for cites whose entity is gone from the live
 * store but present in `.archive/`. A PURE archived cite line expands back to
 * the archived prose (self-documenting); an archived token on an INLINE line
 * (shares the line with code or prose) has the bare token stripped when it's a
 * text file or provably inside a comment — a token sitting bare in code is left
 * and reported for manual review. Active cites (entity still live) and unknown
 * ids are never touched.
 *
 * `review`-class: it rewrites committed source, so it surfaces for the
 * operator and applies via `cairn migrate`. `detect()` (a dry-run repo scan)
 * carries correctness — a no-op once the tree has no archived-entity cites.
 */

import { repairArchivedCitesInRepo } from "../../cites/expand.js";
import type { Migration, MigrationResult } from "../types.js";

export const repairArchivedCites: Migration = {
  id: "0009-repair-archived-cites",
  introducedIn: "0.32.0",
  describe:
    "Repair `§DEC-/§INV-` source cites whose entity was archived (e.g. by an invariant prune): expand a pure cite back to the archived prose, strip an inline-in-comment token, so no token points at a retired entity; active cites untouched",
  class: "review",
  detect(repoRoot: string): boolean {
    try {
      const r = repairArchivedCitesInRepo({ repoRoot, dryRun: true });
      return r.expanded + r.strippedInline > 0;
    } catch {
      return false;
    }
  },
  apply(repoRoot: string): MigrationResult {
    const r = repairArchivedCitesInRepo({ repoRoot });
    const touched = r.expanded + r.strippedInline;
    if (touched === 0) {
      return { changed: false, detail: "no stranded archived-entity cites found" };
    }
    const parts = [`expanded ${r.expanded}`];
    if (r.strippedInline > 0) parts.push(`stripped ${r.strippedInline} inline`);
    let detail = `repaired ${touched} archived-entity cite(s) in ${r.filesChanged} source file(s) (${parts.join(", ")})`;
    if (r.unsafeSkipped > 0) {
      detail += `; left ${r.unsafeSkipped} bare-in-code token(s) for manual review`;
    }
    return { changed: true, detail };
  },
};
