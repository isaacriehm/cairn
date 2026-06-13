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
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
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
    dryRun,
  };
  if (!existsSync(dir)) return result;

  const files = readdirSync(dir).filter((n) => n.endsWith(".md"));
  let archivedAny = false;

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

  return result;
}
