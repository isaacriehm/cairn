/**
 * Ghost content-hash anchoring (ghost-mode design).
 *
 * In committed mode a `// §DEC-<hash>` cite binds a code location to its
 * decision and moves with the code. Ghost never writes that cite, so the
 * binding lives out-of-repo and the *block* has to be re-located by content:
 * the operator's decision comment stays verbatim in source (strip-replace is a
 * no-op in ghost), and its body hash is the stable, location-independent key.
 *
 * Two consumers:
 *   - `resolveGhostBlock` — read-only liveness probe. Does a comment block whose
 *     body hashes to `contentHash` still exist in `sourceFile`? GC liveness
 *     (§3.6) keys on this instead of mere bound-file existence, so a deleted /
 *     rewritten comment correctly reads as orphaned even when the file remains.
 *   - `runGhostReanchor` — the re-anchor-on-reconcile pass. When a still-live
 *     block has *moved* (same hash, new line range), silently refresh the
 *     anchor-map `line_range`. Runs in the GC sweep — the periodic ghost analog
 *     of the cite that would otherwise move with the code.
 *
 * Both reuse the SAME comment extraction + `bodyContentHash` normalization the
 * Layer A emit used, so a re-hash lines up with the stored `sot_content_hash`.
 * Committed mode never calls these (the cite is the binding); every entry point
 * is `isGhost`-gated.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  bodyContentHash,
  decisionsDir,
  invariantsDir,
  isGhost,
  parseFrontmatterRecord,
  readAnchorMap,
  setAnchor,
  writeAnchorMap,
} from "@isaacriehm/cairn-state";
import { walkSourceComments } from "../init/source-comments/walker.js";

export interface GhostBlockResolution {
  /** A comment block whose body hashes to `contentHash` still exists. */
  found: boolean;
  /** Fresh `[startLine, endLine]` of that block, or null when not found. */
  lineRange: [number, number] | null;
}

/**
 * Re-locate a governed comment block in `sourceFile` by its body hash. Pure
 * read — no writes. Location-independent: the block is found wherever it moved
 * to within the file. Returns `found: false` when the file is gone, unreadable,
 * an unknown language, or carries no block matching the hash (deleted/rewritten).
 */
export function resolveGhostBlock(
  repoRoot: string,
  sourceFile: string,
  contentHash: string,
): GhostBlockResolution {
  if (sourceFile.length === 0 || contentHash.length !== 64) {
    return { found: false, lineRange: null };
  }
  const byHash = walkBlockHashes(repoRoot, sourceFile);
  return lookupBlock(byHash, contentHash);
}

/** One source file walked once → `body content-hash → [startLine, endLine]`. */
function walkBlockHashes(
  repoRoot: string,
  sourceFile: string,
): Map<string, [number, number]> | null {
  if (!existsSync(join(repoRoot, sourceFile))) return null;
  let blocks;
  try {
    blocks = walkSourceComments({ repoRoot, onlyFiles: [sourceFile] }).blocks;
  } catch {
    return null;
  }
  const m = new Map<string, [number, number]>();
  for (const b of blocks) {
    const h = bodyContentHash(b.prose);
    if (!m.has(h)) m.set(h, [b.startLine, b.endLine]);
  }
  return m;
}

function lookupBlock(
  byHash: Map<string, [number, number]> | null,
  contentHash: string,
): GhostBlockResolution {
  if (byHash === null) return { found: false, lineRange: null };
  const range = byHash.get(contentHash);
  return range ? { found: true, lineRange: range } : { found: false, lineRange: null };
}

export type GhostBlockResolver = (
  sourceFile: string,
  contentHash: string,
) => GhostBlockResolution;

/**
 * Build a per-run resolver that walks each source file at most once. A GC sweep
 * resolves many ledger entities that cluster into a few files; the bare
 * `resolveGhostBlock` re-reads + re-hashes the file once per entity. Share one
 * resolver across a sweep so each file is read once. Per-run scope (a fresh Map
 * each call) — never a module-level cache, so it can't go stale between sweeps.
 */
export function makeGhostBlockResolver(repoRoot: string): GhostBlockResolver {
  const cache = new Map<string, Map<string, [number, number]> | null>();
  return (sourceFile, contentHash) => {
    if (sourceFile.length === 0 || contentHash.length !== 64) {
      return { found: false, lineRange: null };
    }
    let byHash = cache.get(sourceFile);
    if (byHash === undefined) {
      byHash = walkBlockHashes(repoRoot, sourceFile);
      cache.set(sourceFile, byHash);
    }
    return lookupBlock(byHash, contentHash);
  };
}

interface LedgerEntity {
  sourceFile: string;
  contentHash: string;
}

/** Active ledger entities (DEC + INV) that carry a source-comment anchor. */
function collectGhostLedgerEntities(repoRoot: string): LedgerEntity[] {
  const out: LedgerEntity[] = [];
  for (const dir of [decisionsDir(repoRoot), invariantsDir(repoRoot)]) {
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true, encoding: "utf8" })
        .filter((d) => d.isFile() && d.name.endsWith(".md") && !d.name.startsWith("_"))
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of names) {
      let fm: Record<string, unknown>;
      try {
        fm = parseFrontmatterRecord(readFileSync(join(dir, name), "utf8")).fm;
      } catch {
        continue;
      }
      if (fm["sot_kind"] !== "ledger") continue;
      const status = typeof fm["status"] === "string" ? fm["status"] : "";
      if (status === "archived" || status === "superseded") continue;
      const sourceFile = typeof fm["source_file"] === "string" ? fm["source_file"] : "";
      const contentHash =
        typeof fm["sot_content_hash"] === "string" ? fm["sot_content_hash"] : "";
      if (sourceFile.length === 0 || contentHash.length !== 64) continue;
      out.push({ sourceFile, contentHash });
    }
  }
  return out;
}

export interface GhostReanchorResult {
  /** Anchor entries whose `line_range` was refreshed because the block moved. */
  reanchored: number;
}

/**
 * Re-anchor-on-reconcile (§3.5.1). For every live ghost ledger entity whose
 * comment block has moved within its file, refresh the anchor-map `line_range`
 * so the (future) lens decorates the right span. Idempotent — writes only when
 * a range actually changed. No-op (and no entity walk) outside ghost.
 */
export function runGhostReanchor(repoRoot: string): GhostReanchorResult {
  if (!isGhost(repoRoot)) return { reanchored: 0 };
  const entities = collectGhostLedgerEntities(repoRoot);
  if (entities.length === 0) return { reanchored: 0 };

  let map = readAnchorMap(repoRoot);
  let changed = false;
  let reanchored = 0;
  const resolveBlock = makeGhostBlockResolver(repoRoot);

  for (const ent of entities) {
    const res = resolveBlock(ent.sourceFile, ent.contentHash);
    if (!res.found || res.lineRange === null) continue;
    // Find the anchor entry for this block by (file, content_hash) — the slug
    // key is opaque here, but (file, hash) uniquely identifies the block.
    for (const [slug, entry] of Object.entries(map.anchors)) {
      if (entry.file !== ent.sourceFile || entry.content_hash !== ent.contentHash) {
        continue;
      }
      const [ns, ne] = res.lineRange;
      const cur = entry.line_range;
      if (cur === undefined || cur[0] !== ns || cur[1] !== ne) {
        map = setAnchor(map, slug, { ...entry, line_range: [ns, ne] });
        changed = true;
        reanchored += 1;
      }
      break;
    }
  }

  if (changed) {
    try {
      writeAnchorMap(repoRoot, map);
    } catch {
      // best-effort — a failed re-anchor write never blocks the sweep; the
      // stale line_range only affects lens display, not liveness.
      return { reanchored: 0 };
    }
  }
  return { reanchored };
}
