/**
 * Entity retirement primitive — the OUT path for the ground ledger.
 *
 * Cairn's creation surface is wide (sot-align live hook, pre-commit,
 * curator, source-comment ingest, record_decision, …) but until now the
 * only way an entity left the active set was losing a head-to-head
 * conflict at creation (resolve-attention). Nothing retired an entity
 * that *rotted* — source refactored away, zero live cites, an "eternal"
 * invariant gone stale. `archiveEntity` is that missing organ.
 *
 * Retirement = archive, not hard-delete: the entity moves to
 * `.cairn/ground/.archive/`, its status flips to `archived`, and the
 * active ledger is rebuilt so it drops from `cairn_in_scope` and the
 * SoT cache. Nothing is destroyed, so a lingering `§DEC-/§INV-` cite
 * degrades to an `orphaned_citation` GC finding rather than a dangling
 * reference, and `cairn_query_history` can still surface the body.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { parseFrontmatterRecord } from "./frontmatter.js";
import {
  archiveDecisionsDir,
  archiveInvariantsDir,
  decisionsDir,
  invariantsDir,
} from "./paths.js";
import { writeDecisionsLedger, writeInvariantsLedger } from "./ledgers.js";
import {
  deleteSotCacheEntry,
  readSotCache,
  writeSotCache,
} from "./sot-cache.js";

export type ArchiveEntityKind = "DEC" | "INV";

export interface ArchiveEntityOptions {
  repoRoot: string;
  /** Entity id — `DEC-<hash>` or `INV-<hash>`. */
  id: string;
  /** Why it was retired — surfaced in the archived frontmatter + audit. */
  reason: string;
  /**
   * Optional superseding entity id. Recorded as `superseded_by` lineage
   * in the archived frontmatter; the entity still moves to the archive.
   */
  supersededBy?: string;
  /** Injected clock for tests. */
  now?: Date;
}

export interface ArchiveEntityResult {
  ok: boolean;
  id: string;
  kind: ArchiveEntityKind;
  /** Repo-relative archive destination (POSIX). */
  archivedPath: string;
  /** Set when ok=false. */
  error?: string;
}

function entityKind(id: string): ArchiveEntityKind {
  return id.startsWith("INV-") ? "INV" : "DEC";
}

/**
 * Move a DEC/INV out of the active ground zone into the archive, flip its
 * status to `archived`, and rebuild the ledger so it drops from the active
 * set. Idempotent-safe: a missing source returns `ENTITY_NOT_FOUND` rather
 * than throwing.
 */
export function archiveEntity(opts: ArchiveEntityOptions): ArchiveEntityResult {
  const kind = entityKind(opts.id);
  const srcDir =
    kind === "INV" ? invariantsDir(opts.repoRoot) : decisionsDir(opts.repoRoot);
  const destDir =
    kind === "INV"
      ? archiveInvariantsDir(opts.repoRoot)
      : archiveDecisionsDir(opts.repoRoot);
  const filename = `${opts.id}.md`;
  const srcAbs = join(srcDir, filename);
  const destAbs = join(destDir, filename);
  const relDest = `.cairn/ground/.archive/${
    kind === "INV" ? "invariants" : "decisions"
  }/${filename}`;

  if (!existsSync(srcAbs)) {
    return {
      ok: false,
      id: opts.id,
      kind,
      archivedPath: relDest,
      error: "ENTITY_NOT_FOUND",
    };
  }

  // Date-precision stamps (not millisecond ISO) so two clones that retire
  // the same orphan on the same day produce byte-identical archive
  // frontmatter — kills the multi-dev merge conflict on `.archive/` files.
  // Orphan detection is deterministic across clones, so the only divergence
  // was the timestamp. Audit-grade timing lives in the git commit anyway.
  const archivedOn = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const { fm, body } = parseFrontmatterRecord(readFileSync(srcAbs, "utf8"));

  fm["status"] = "archived";
  fm["archived_at"] = archivedOn;
  fm["archived_reason"] = opts.reason;
  fm["verified-at"] = archivedOn;
  if (opts.supersededBy !== undefined) fm["superseded_by"] = opts.supersededBy;

  const content = `---\n${stringifyYaml(fm).trimEnd()}\n---\n${
    body.startsWith("\n") ? body : `\n${body}`
  }`;

  // Write the archived copy, then unlink the source. We rewrite frontmatter,
  // so this is write+unlink rather than an atomic rename. If the process
  // dies mid-move the next ledger rebuild self-heals (a missing source file
  // simply isn't included).
  mkdirSync(destDir, { recursive: true });
  writeFileSync(destAbs, content, "utf8");
  rmSync(srcAbs, { force: true });

  // Drop from the SoT cache so the Layer A sot-align hook never matches an
  // archived body as a citation candidate.
  try {
    const cache = readSotCache(opts.repoRoot);
    writeSotCache(opts.repoRoot, deleteSotCacheEntry(cache, opts.id));
  } catch {
    /* best-effort — cache self-heals on next sweep */
  }

  // Rebuild the active ledger — the moved file is gone from srcDir, so it
  // drops from the accepted/active set seen by cairn_in_scope.
  try {
    if (kind === "INV") writeInvariantsLedger({ repoRoot: opts.repoRoot });
    else writeDecisionsLedger({ repoRoot: opts.repoRoot });
  } catch {
    /* best-effort */
  }

  return { ok: true, id: opts.id, kind, archivedPath: relDest };
}
