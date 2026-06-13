/**
 * 0006 — prune junk Layer-A (sot-align) invariants from existing repos.
 *
 * The sot-align hook minted an "invariant" from almost any prose block —
 * banners, separators, class/endpoint descriptions, test notes. The 0.23.0
 * creation gate cut the worst of it, but a modal buried anywhere in a
 * multi-line block still slipped through, so even post-gate repos accreted
 * box-drawing-titled artifacts and test-fixture comments as "active
 * invariants". 0.27.0 sharpens both the gate (skip test files) and this
 * prune (statement-scoped shape + test-source + separator-title rejects).
 *
 * `detect`/`apply` wrap the same `pruneInvariants` surgical core the CLI
 * uses: it touches ONLY `capture_source: layer-a-sot-align` invariants —
 * archiving those captured from a test/fixture file, titled with a
 * separator, or with no constraint shape in their statement — to
 * `.cairn/ground/.archive/` (recoverable), rebuilding the ledger once at
 * the end. Curated DEC/INV are never touched. For a full reset of the
 * legacy corpus the operator can run `cairn invariants prune --all`.
 *
 * `review`-class: it archives committed ground state, so it surfaces for
 * the operator and applies via `cairn migrate`. The sharpened gate ships
 * in 0.27.0, so `introducedIn` advances to 0.27.0 — a repo that already
 * ran the weaker 0.26.0 pass must re-evaluate; `detect()` carries
 * correctness.
 */

import { pruneInvariants } from "../../invariants/prune.js";
import type { Migration, MigrationResult } from "../types.js";

export const pruneSotAlignInvariants: Migration = {
  id: "0006-prune-sot-align-invariants",
  // 0.27.0: the surgical gate was sharpened (statement-scoped shape +
  // test-source + separator-title rejects). A repo that already ran the
  // weaker 0.26.0 pass must re-evaluate, so `introducedIn` advances to the
  // ship version — `detect()` (a dry-run prune) stays the correctness floor.
  introducedIn: "0.27.0",
  describe:
    "Archive junk Layer-A (sot-align) invariants the creation gate would reject today — test/fixture captures, separator-titled artifacts, and entries with no rule in their statement; curated DEC/INV untouched",
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
