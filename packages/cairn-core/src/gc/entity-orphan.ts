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
  knownExtensions,
  parseFrontmatterRecord,
} from "@isaacriehm/cairn-state";
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
  const cited = collectCitedIds(opts.repoRoot);

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
        // ledger-backed — keyed on live citation presence.
        if (!cited.has(id)) {
          const sourceFile =
            typeof fm["source_file"] === "string" ? (fm["source_file"] as string) : "";
          const srcGone =
            sourceFile.length === 0 || !existsSync(join(opts.repoRoot, sourceFile));
          candidate = {
            id,
            kind: group.kind,
            sotKind,
            classification: srcGone ? "safe" : "ambiguous",
            reason: srcGone
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
