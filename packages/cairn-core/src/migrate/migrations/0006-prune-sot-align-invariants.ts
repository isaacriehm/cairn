/**
 * 0006 — prune junk Layer-A (sot-align) invariants from existing repos.
 *
 * Before 0.23.0 the sot-align hook minted an "invariant" from almost any
 * prose block — banners, separators, class/endpoint descriptions, test
 * notes — with no structural pre-filter. On a repo adopted in that era the
 * invariants ledger was ~97% junk, and every junk entry is surfaced + can
 * be cited. 0.23.0 added the creation gate so NEW invariants are real, and
 * shipped `cairn invariants prune` to clean the old ones — but existing
 * adopters had to know to run it by hand. This migration surfaces it.
 *
 * `detect`/`apply` wrap the same `pruneInvariants` surgical core the CLI
 * uses: it touches ONLY `capture_source: layer-a-sot-align` invariants
 * whose statement has no constraint shape — the exact bar the creation
 * gate now applies — and archives them to `.cairn/ground/.archive/`
 * (recoverable), rebuilding the ledger once at the end. Curated DEC/INV
 * are never touched.
 *
 * `review`-class: it archives committed ground state, so it surfaces for
 * the operator and applies via `cairn migrate`. Ships in 0.26.0, so
 * `introducedIn` is 0.26.0 — a repo pinned past 0.23.0 must still
 * re-evaluate it; `detect()` carries correctness.
 */

import { pruneInvariants } from "../../invariants/prune.js";
import type { Migration, MigrationResult } from "../types.js";

export const pruneSotAlignInvariants: Migration = {
  id: "0006-prune-sot-align-invariants",
  introducedIn: "0.26.0",
  describe:
    "Archive junk Layer-A (sot-align) invariants minted before the 0.23.0 creation gate — only shapeless sot-align entries; curated DEC/INV untouched",
  class: "review",
  detect(repoRoot: string): boolean {
    try {
      return pruneInvariants({ repoRoot, dryRun: true }).pruned.length > 0;
    } catch {
      return false;
    }
  },
  apply(repoRoot: string): MigrationResult {
    const result = pruneInvariants({ repoRoot });
    const n = result.pruned.length;
    return {
      changed: n > 0,
      detail:
        n > 0
          ? `archived ${n} shapeless sot-align invariant(s) of ${result.sotAlignTotal} eligible (${result.kept} kept) → .cairn/ground/.archive/`
          : "no junk sot-align invariants found",
    };
  },
};
