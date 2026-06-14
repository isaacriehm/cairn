/**
 * `cairn invariants prune` — retire junk invariants the Layer A sot-align
 * hook minted before the creation gate landed.
 *
 * Pre-gate, the runtime hook ran a Haiku "creation judge" on every prose
 * block and over-labeled descriptions as `constraint`, so section banners,
 * box-drawing separators, class/endpoint descriptions and test-fixture
 * notes all became "active invariants". This sweep archives them.
 *
 * Scope is deliberately narrow: ONLY invariants stamped
 * `capture_source: layer-a-sot-align` are eligible. Curated invariants
 * (init, curator, manual `record`/`propose`) are never touched.
 *
 *   surgical (default) — archive a sot-align invariant that couldn't be
 *                        minted today: captured from a test/fixture file,
 *                        titled with a box-drawing separator, or carrying
 *                        no constraint shape in its STATEMENT (title + lead
 *                        lines — a modal buried deeper in incidental prose
 *                        no longer rescues a description).
 *   all                — archive every sot-align invariant (full reset).
 *
 * Retirement reuses `archiveEntity` (move to `.cairn/ground/.archive/`,
 * flip status, drop from the SoT cache) but defers the per-entity ledger
 * rebuild so a 700-entity sweep rebuilds once instead of O(n²).
 *
 * Source repair: minting an sot-align invariant strip-replaced the prose
 * block in its `source_file` with a bare `// §INV-<id>` cite. Archiving the
 * entity alone would strand that token, so after the sweep we expand each
 * pruned cite back to its captured prose (the invariant body IS that prose)
 * — scoped to the pruned ids, so live cites are untouched. The working tree
 * is left with no `§INV-` token pointing at an archived entity.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  archiveEntity,
  deleteSotCacheEntry,
  invariantsDir,
  parseFrontmatterRecord,
  readSotCache,
  writeInvariantsLedger,
  writeSotCache,
} from "@isaacriehm/cairn-state";
import { expandCitesInText } from "../cites/expand.js";
import {
  hasConstraintShape,
  isNonLexicalLine,
  isTestPath,
} from "../hooks/sot-align-common.js";

/** The runtime hook's stamp — the only capture_source this sweep retires. */
const SOT_ALIGN_SOURCE = "layer-a-sot-align";

export type PruneMode = "surgical" | "all";

export interface PruneInvariantsOptions {
  repoRoot: string;
  /** "surgical" (default) or "all". */
  mode?: PruneMode;
  /** Report candidates without archiving anything. */
  dryRun?: boolean;
  /** Injected clock for tests. */
  now?: Date;
}

export interface PrunedInvariant {
  id: string;
  title: string;
  reason: string;
}

export interface PruneInvariantsResult {
  /** Total invariant files scanned. */
  scanned: number;
  /** Of those, how many were sot-align-sourced (the eligible pool). */
  sotAlignTotal: number;
  /** Entities archived (or, on dry-run, that WOULD be archived). */
  pruned: PrunedInvariant[];
  /** Eligible sot-align invariants kept (passed the constraint gate). */
  kept: number;
  /**
   * Source files whose dangling `§INV-` cite was repaired — the bare
   * citation strip-replaced into source when the invariant was minted is
   * expanded back to its captured prose so no token points at the archived
   * entity. On dry-run this is the count that WOULD be repaired.
   */
  sourceFilesRepaired: number;
  /** Individual `§INV-` cites expanded back to prose across those files. */
  citesRepaired: number;
  dryRun: boolean;
}

/**
 * The invariant's STATEMENT — its title plus the first two non-blank body
 * lines. A real invariant carries its rule here; the surgical gate looks
 * for constraint shape in this window, not in the whole captured block, so
 * a modal buried in incidental prose deeper down can't keep a description
 * alive as an "invariant".
 */
function statementOf(title: string, body: string): string {
  const lead = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 2);
  return [title, ...lead].join("\n");
}

export function pruneInvariants(
  opts: PruneInvariantsOptions,
): PruneInvariantsResult {
  const mode: PruneMode = opts.mode ?? "surgical";
  const dryRun = opts.dryRun ?? false;
  const dir = invariantsDir(opts.repoRoot);
  const result: PruneInvariantsResult = {
    scanned: 0,
    sotAlignTotal: 0,
    pruned: [],
    kept: 0,
    sourceFilesRepaired: 0,
    citesRepaired: 0,
    dryRun,
  };
  if (!existsSync(dir)) return result;

  const files = readdirSync(dir).filter((n) => n.endsWith(".md"));
  let archivedAny = false;
  // Pruned invariants that left a bare `§INV-<id>` cite in their source.
  // We expand each back to its captured prose (the invariant body IS that
  // prose) so archiving doesn't leave a token pointing at a dead entity.
  const citeRepairs: CiteRepair[] = [];

  for (const file of files) {
    result.scanned += 1;
    const id = file.replace(/\.md$/, "");
    let fm: Record<string, unknown>;
    let body: string;
    try {
      ({ fm, body } = parseFrontmatterRecord(readFileSync(join(dir, file), "utf8")));
    } catch {
      continue; // unreadable / malformed — leave it for the doctor to flag
    }

    const capture = typeof fm["capture_source"] === "string" ? fm["capture_source"] : "";
    if (capture !== SOT_ALIGN_SOURCE) continue; // never touch curated invariants
    result.sotAlignTotal += 1;

    const title = typeof fm["title"] === "string" ? fm["title"] : "";
    const sourceFile = typeof fm["source_file"] === "string" ? fm["source_file"] : "";

    let prune = false;
    let reason = "";
    if (mode === "all") {
      prune = true;
      reason = "full reset of sot-align invariants";
    } else if (isTestPath(sourceFile)) {
      // Test/fixture/harness comment lifted as an "invariant" — a buried
      // modal ("must roll back") reads like a rule but describes test setup.
      prune = true;
      reason = "captured from a test/fixture file — not a product invariant";
    } else if (isNonLexicalLine(title)) {
      // Title is a box-drawing separator / pure punctuation — a capture
      // artifact, never a rule statement.
      prune = true;
      reason = "separator/non-lexical title — not a rule statement";
    } else if (!hasConstraintShape(statementOf(title, body))) {
      // The constraint shape must sit in the STATEMENT (title + lead lines),
      // not anywhere in the multi-line captured block. A description whose
      // only modal is incidental prose three lines down is not an invariant.
      prune = true;
      reason = "no constraint shape in statement — not a real invariant under the creation gate";
    }

    if (!prune) {
      result.kept += 1;
      continue;
    }

    if (!dryRun) {
      const r = archiveEntity({
        repoRoot: opts.repoRoot,
        id,
        reason: `cairn invariants prune — ${reason}`,
        deferDerivedRebuild: true,
        ...(opts.now !== undefined ? { now: opts.now } : {}),
      });
      if (!r.ok) {
        // Couldn't move it (already gone / unreadable) — don't claim a prune.
        result.kept += 1;
        continue;
      }
      archivedAny = true;
    }

    result.pruned.push({ id, title: title.slice(0, 100), reason });
    if (sourceFile.length > 0) {
      // The invariant body is the verbatim prose sot-align lifted from the
      // comment; expanding the cite with it restores the original source.
      citeRepairs.push({ id, sourceFile, body });
    }
  }

  // One derived-state rebuild for the whole batch (archiveEntity deferred it).
  if (archivedAny && !dryRun) {
    const prunedIds = new Set(result.pruned.map((p) => p.id));
    try {
      let cache = readSotCache(opts.repoRoot);
      for (const id of prunedIds) cache = deleteSotCacheEntry(cache, id);
      writeSotCache(opts.repoRoot, cache);
    } catch {
      /* best-effort — cache self-heals on next sweep */
    }
    try {
      writeInvariantsLedger({ repoRoot: opts.repoRoot });
    } catch {
      /* best-effort — `cairn fix` rebuilds it */
    }
  }

  // Repair source: expand each pruned invariant's bare cite back to its
  // prose so the working tree carries no `§INV-` token pointing at an
  // archived entity. Runs on dry-run too (counts only — never writes).
  const repaired = repairPrunedCites(opts.repoRoot, citeRepairs, dryRun);
  result.sourceFilesRepaired = repaired.filesRepaired;
  result.citesRepaired = repaired.citesRepaired;

  return result;
}

interface CiteRepair {
  id: string;
  /** Repo-relative path the cite was strip-replaced into. */
  sourceFile: string;
  /** The captured prose (invariant body) the cite expands back to. */
  body: string;
}

/**
 * Expand the bare `§INV-<id>` cites of pruned invariants back to their
 * captured prose. The resolver is scoped to the pruned ids ONLY — any
 * other cite in the same file resolves to `null` and is left verbatim, so
 * live cites are never disturbed. Best-effort per file: an unreadable or
 * unwritable file is skipped, not fatal.
 */
function repairPrunedCites(
  repoRoot: string,
  repairs: CiteRepair[],
  dryRun: boolean,
): { filesRepaired: number; citesRepaired: number } {
  const bodyById = new Map<string, string>();
  const idsByFile = new Map<string, Set<string>>();
  for (const r of repairs) {
    bodyById.set(r.id, r.body);
    const set = idsByFile.get(r.sourceFile) ?? new Set<string>();
    set.add(r.id);
    idsByFile.set(r.sourceFile, set);
  }

  let filesRepaired = 0;
  let citesRepaired = 0;
  for (const [file, ids] of idsByFile) {
    const abs = join(repoRoot, file);
    if (!existsSync(abs)) continue;
    let source: string;
    try {
      source = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const out = expandCitesInText(source, (id) =>
      ids.has(id) ? bodyById.get(id) ?? null : null,
    );
    if (out.expanded === 0 || out.text === source) continue;
    citesRepaired += out.expanded;
    filesRepaired += 1;
    if (!dryRun) {
      try {
        writeFileSync(abs, out.text, "utf8");
      } catch {
        /* best-effort — `cairn uninstall` / expand-cites can finish the job */
      }
    }
  }
  return { filesRepaired, citesRepaired };
}
