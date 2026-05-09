/**
 * Side-file persistence for the heavy Phase 7b output.
 *
 * `IngestSourceCommentsResult` carries the full walk (every comment block's
 * raw text + prose) and the matching classifications. On a busy monorepo
 * this crosses ~1.7 MB — far above what the MCP transport can echo back
 * in a tool result. Mirrors the v0.3.5 mapper-output spillover: write the
 * full payload to `.cairn/init/source-comments-walk.json` and persist a
 * lightweight projection (counts, paths, ledger-relevant lists) into
 * `init-state.json`.
 *
 * Downstream phases consume only the lightweight projection — the
 * heavy walk + per-block classifications already live in
 * `.cairn/baseline/source-comments-<ISO>.yaml` (the audit YAML), which
 * the strip-replace stage and any later debug tools already read.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { IngestSourceCommentsResult } from "../source-comments/index.js";

/** Filename relative to repoRoot. */
export const SOURCE_COMMENTS_WALK_PATH = join(
  ".cairn",
  "init",
  "source-comments-walk.json",
);

export function sourceCommentsWalkAbsPath(repoRoot: string): string {
  return join(repoRoot, SOURCE_COMMENTS_WALK_PATH);
}

/**
 * Atomically write the full Phase 7b result. Creates `.cairn/init/`
 * if needed.
 */
export function writeSourceCommentsWalkFile(
  repoRoot: string,
  full: IngestSourceCommentsResult,
): string {
  const abs = sourceCommentsWalkAbsPath(repoRoot);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  writeFileSync(tmp, JSON.stringify(full, null, 2), "utf8");
  renameSync(tmp, abs);
  return abs;
}

export function readSourceCommentsWalkFile(
  repoRoot: string,
): IngestSourceCommentsResult | null {
  const abs = sourceCommentsWalkAbsPath(repoRoot);
  if (!existsSync(abs)) return null;
  try {
    const raw = readFileSync(abs, "utf8");
    return JSON.parse(raw) as IngestSourceCommentsResult;
  } catch {
    return null;
  }
}

/**
 * Persisted shape embedded in `init-state.json`.
 */
export interface IngestSourceCommentsResultPersisted {
  walkPath: string;
  filesScanned: number;
  blocksDiscovered: number;
  blocksCited: number;
  blocksEmittedDec: number;
  blocksEmittedInv: number;
  blocksSkipped: number;
  blocksFailed: number;
  auditPath: string | null;
  stripError: string | null;
}

/** Strip the heavy fields from a fresh ingest result for state persistence. */
export function to7bResultPersisted(
  full: IngestSourceCommentsResult,
): IngestSourceCommentsResultPersisted {
  return {
    walkPath: SOURCE_COMMENTS_WALK_PATH,
    filesScanned: full.filesScanned,
    blocksDiscovered: full.blocksDiscovered,
    blocksCited: full.blocksCited,
    blocksEmittedDec: full.blocksEmittedDec,
    blocksEmittedInv: full.blocksEmittedInv,
    blocksSkipped: full.blocksSkipped,
    blocksFailed: full.blocksFailed,
    auditPath: full.auditPath,
    stripError: full.stripError ?? null,
  };
}
