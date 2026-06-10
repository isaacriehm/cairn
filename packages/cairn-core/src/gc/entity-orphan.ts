/**
 * GC pass — entity-orphan (ledger → code).
 *
 * The inverse of citation-integrity. Where citation-integrity walks
 * code → ledger ("this §cite points at a missing entity"), this pass
 * walks ledger → code ("does this DEC/INV still have a live home, or
 * has it rotted?"). It is the detection half of the retirement
 * subsystem; `runEntityRetire` (retire.ts) is the apply half.
 *
 * Orphan predicate — split by `sot_kind`:
 *
 *   - `ledger` (source-comment-derived) — the entity's home is a
 *     strip-replaced `// §DEC-/§INV-` cite in source. Orphan when ZERO
 *     live cites to its id remain anywhere in the tree. Classified:
 *       · source_file also gone        → SAFE   (clean orphan)
 *       · source_file still present     → ambiguous (cite vanished but
 *                                          file remains — surface, don't
 *                                          auto-retire)
 *
 *   - `path` (doc-backed) — the entity summarizes a doc section
 *     (`sot_path`). Orphan when that file no longer exists → SAFE.
 *     Body-vs-source drift while the file still exists is owned by the
 *     doc-source-drift pass, not this one.
 *
 * Grace window: an entity younger than GRACE_DAYS (by `generated`) is
 * skipped — a freshly-emitted entity's cite or doc may not have landed
 * yet. Undated entities fall through to the predicate (the cite/source
 * signal is the real guard).
 *
 * Only SAFE orphans are eligible for autonomous retirement; ambiguous
 * ones surface as `warn` findings for operator/agent triage.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decisionsDir,
  invariantsDir,
  isGhost,
  knownExtensions,
  parseFrontmatterRecord,
  readScopeIndex,
  type ScopeIndex,
} from "@isaacriehm/cairn-state";
import { makeGhostBlockResolver, type GhostBlockResolver } from "./ghost-anchor.js";
import { walkSourceTree } from "./walk-source.js";
import type { GcFinding } from "./types.js";

const PASS_ID = "entity-orphan" as const;
const GRACE_DAYS = 7;
const GRACE_MS = GRACE_DAYS * 86_400_000;

const INV_RE = /§INV-([0-9a-f]{7,})\b/g;
const DEC_RE = /§DEC-([0-9a-f]{7,})\b/g;

// Code extensions from the shared language registry (single source); markup
// /style extras have no language profile but still carry §INV/§DEC citations.
const SOURCE_EXTENSIONS = new Set<string>([
  ...knownExtensions(),
  ".html",
  ".css",
  ".scss",
]);

export type OrphanClassification = "safe" | "ambiguous";

export interface OrphanCandidate {
  id: string;
  kind: "DEC" | "INV";
  sotKind: string;
  classification: OrphanClassification;
  /** Human-readable retirement reason — stamped into archived frontmatter. */
  reason: string;
  /** Repo-relative path to the live entity file. */
  entityPath: string;
}

export interface EntityOrphanOptions {
  repoRoot: string;
  /** Override "now" for the grace-window check (tests). */
  now?: Date;
}

export interface EntityOrphanResult {
  findings: GcFinding[];
  /** Structured candidates for the retire apply path. */
  orphans: OrphanCandidate[];
}

function fileExt(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx === -1 ? "" : path.slice(idx).toLowerCase();
}

/**
 * Ghost liveness floor (fallback) — there are no in-source `§` cites to grep,
 * so the binding lives in the out-of-repo scope-index (the SoT in ghost). An
 * entity is live when SOME still-existing file binds it. Used only for legacy
 * entities that predate the `sot_content_hash` anchor; current entities use
 * the sharper block-resolution check (`entityGhostLive`).
 */
function entityBoundLive(
  repoRoot: string,
  id: string,
  idx: ScopeIndex | null,
): boolean {
  if (idx === null) return false;
  for (const [file, entry] of Object.entries(idx.files)) {
    if (entry.decisions.includes(id) || entry.invariants.includes(id)) {
      if (existsSync(join(repoRoot, file))) return true;
    }
  }
  return false;
}

/**
 * Ghost liveness (§3.5.1/§3.6) — the governing comment block still resolves by
 * content hash in its source file. Location-independent: survives the block
 * moving within the file, but a deleted or rewritten comment correctly reads as
 * dead even when the file itself remains (the bug `entityBoundLive` alone can't
 * catch). Falls back to the coarse bound-file floor for legacy entities with no
 * 64-char `sot_content_hash`.
 */
function entityGhostLive(
  repoRoot: string,
  id: string,
  fm: Record<string, unknown>,
  idx: ScopeIndex | null,
  resolveBlock: GhostBlockResolver,
): boolean {
  const sourceFile = typeof fm["source_file"] === "string" ? fm["source_file"] : "";
  const hash =
    typeof fm["sot_content_hash"] === "string" ? fm["sot_content_hash"] : "";
  if (hash.length === 64 && sourceFile.length > 0) {
    return resolveBlock(sourceFile, hash).found;
  }
  return entityBoundLive(repoRoot, id, idx);
}

/** Set of every DEC/INV id cited by a `§` reference anywhere in the source tree. */
function collectCitedIds(repoRoot: string): Set<string> {
  const cited = new Set<string>();
  for (const rel of walkSourceTree(repoRoot)) {
    if (!SOURCE_EXTENSIONS.has(fileExt(rel))) continue;
    let content: string;
    try {
      content = readFileSync(join(repoRoot, rel), "utf8");
    } catch {
      continue;
    }
    for (const m of content.matchAll(INV_RE)) cited.add(`INV-${m[1]}`);
    for (const m of content.matchAll(DEC_RE)) cited.add(`DEC-${m[1]}`);
  }
  return cited;
}

function listEntityFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true, encoding: "utf8" })
      .filter((d) => d.isFile() && d.name.endsWith(".md") && !d.name.startsWith("_"))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** True when `generated` is present and within the grace window. */
function withinGrace(generated: unknown, now: Date): boolean {
  if (typeof generated !== "string" || generated.length === 0) return false;
  const ts = Date.parse(generated);
  if (Number.isNaN(ts)) return false;
  return now.getTime() - ts < GRACE_MS;
}

export function runEntityOrphan(opts: EntityOrphanOptions): EntityOrphanResult {
  const now = opts.now ?? new Date();
  const findings: GcFinding[] = [];
  const orphans: OrphanCandidate[] = [];
  // Ghost: liveness keys on the out-of-repo scope-index binding, NEVER on
  // in-source `§` cites (there are none — the naive cite scan would orphan the
  // entire ledger on the first sweep). Skip the source walk entirely.
  const ghost = isGhost(opts.repoRoot);
  const cited = ghost ? new Set<string>() : collectCitedIds(opts.repoRoot);
  const scopeIdx = ghost ? readScopeIndex(opts.repoRoot) : null;
  // One resolver for the whole sweep — walks each clustered source file once.
  const resolveBlock = ghost ? makeGhostBlockResolver(opts.repoRoot) : null;

  const groups: { kind: "DEC" | "INV"; dir: string; rel: string }[] = [
    { kind: "DEC", dir: decisionsDir(opts.repoRoot), rel: ".cairn/ground/decisions" },
    { kind: "INV", dir: invariantsDir(opts.repoRoot), rel: ".cairn/ground/invariants" },
  ];

  for (const group of groups) {
    for (const file of listEntityFiles(group.dir)) {
      const abs = join(group.dir, file);
      let fm: Record<string, unknown>;
      try {
        fm = parseFrontmatterRecord(readFileSync(abs, "utf8")).fm;
      } catch {
        continue;
      }
      const id = typeof fm["id"] === "string" ? (fm["id"] as string) : "";
      if (id.length === 0) continue;

      // Skip entities already out of the active set.
      const status = typeof fm["status"] === "string" ? (fm["status"] as string) : "";
      if (status === "archived" || status === "superseded") continue;

      // Grace window — don't retire freshly-emitted entities.
      if (withinGrace(fm["generated"], now)) continue;

      const sotKind = typeof fm["sot_kind"] === "string" ? (fm["sot_kind"] as string) : "ledger";
      const entityPath = `${group.rel}/${file}`;

      let candidate: OrphanCandidate | null = null;

      if (sotKind === "path") {
        const sotPath = typeof fm["sot_path"] === "string" ? (fm["sot_path"] as string) : "";
        const filePart = sotPath.split("#")[0] ?? "";
        if (
          filePart.length > 0 &&
          filePart !== "ledger" &&
          !existsSync(join(opts.repoRoot, filePart))
        ) {
          candidate = {
            id,
            kind: group.kind,
            sotKind,
            classification: "safe",
            reason: `orphan-by-source: doc-backed source "${filePart}" no longer exists`,
            entityPath,
          };
        }
      } else {
        // ledger-backed — liveness:
        //   committed: a live in-source `§` cite for this id
        //   ghost:     the governing comment block still resolves by content
        //              hash in its source file (no cites exist — §3.5.1)
        const live = ghost
          ? entityGhostLive(opts.repoRoot, id, fm, scopeIdx, resolveBlock!)
          : cited.has(id);
        if (!live) {
          const sourceFile =
            typeof fm["source_file"] === "string" ? (fm["source_file"] as string) : "";
          const srcGone =
            sourceFile.length === 0 || !existsSync(join(opts.repoRoot, sourceFile));
          // Ghost never auto-retires (no `safe`): there are no cites to confirm
          // removal, so an unbound entity is surfaced for operator review only.
          candidate = {
            id,
            kind: group.kind,
            sotKind,
            classification: ghost ? "ambiguous" : srcGone ? "safe" : "ambiguous",
            reason: ghost
              ? "ghost: governing comment block no longer resolves by content hash (review — never auto-retired)"
              : srcGone
                ? "orphan-by-source: source_file gone and zero live §cites remain"
                : "orphan-by-source: zero live §cites remain (source_file still present — review)",
            entityPath,
          };
        }
      }

      if (candidate === null) continue;
      orphans.push(candidate);
      findings.push({
        pass: PASS_ID,
        kind: "orphan_entity",
        path: entityPath,
        detail: `${id} (${candidate.classification}) — ${candidate.reason}`,
        severity: "warn",
        matched_text: id,
      });
    }
  }

  return { findings, orphans };
}
