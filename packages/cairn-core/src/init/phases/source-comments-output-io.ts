/**
 * Side-file persistence for the heavy Phase 9 output.
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
import type { CommentClassKind } from "../source-comments/classify.js";

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
 * Atomically write the full Phase 9 result. Creates `.cairn/init/`
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

/**
 * Read the full Phase 9 result from `.cairn/init/source-comments-walk.json`.
 * Returns null if missing or unreadable. Available for debug tooling and
 * post-hoc inspection — phase consumers prefer the lightweight projection
 * stored on state.
 */
export function readSourceCommentsWalkFile(
  repoRoot: string,
): IngestSourceCommentsResult | null {
  const abs = sourceCommentsWalkAbsPath(repoRoot);
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, "utf8")) as IngestSourceCommentsResult;
  } catch {
    return null;
  }
}

/** Phase was skipped because the repo is the Cairn source repo itself. */
export interface IngestSourceCommentsSkippedResult {
  readonly skipped: "self-adopt";
}

/**
 * Lightweight projection persisted into `init-state.json` outputs. Drops
 * `walk.blocks` and `classifications` (the heavy fields); keeps ledger /
 * triage references that downstream phases + the cairn-adopt summary
 * skill query directly.
 */
export interface IngestSourceCommentsRunResult {
  /** Repo-relative path to the spilled full result, or null when not written. */
  walkPath: string;
  walkSummary: {
    files: number;
    blocks: number;
    bytesScanned: number;
    fileCountByLang: Record<string, number>;
    filesAvailable: number;
    truncatedAtFileCap: boolean;
  };
  decsWritten: {
    id: string;
    path: string;
    sourceFile: string;
    slug: string;
    status: "accepted";
  }[];
  invsWritten: {
    id: string;
    path: string;
    sourceFile: string;
    slug: string;
    status: "accepted";
  }[];
  citesEmitted: {
    id: string;
    sourceFile: string;
    lineRange: [number, number];
    slug: string;
  }[];
  stripFilesModified: number;
  stripItemsApplied: number;
  stripItemsSkipped: number;
  stripError: string | null;
  auditPath: string;
  auditRelPath: string;
  inputTokens: number;
  outputTokens: number;
  batchesRun: number;
  batchesFailed: number;
  kindCounts: Record<CommentClassKind, number>;
}

export type IngestSourceCommentsResultPersisted =
  | IngestSourceCommentsRunResult
  | IngestSourceCommentsSkippedResult;

/** Strip the heavy fields from a fresh ingest result for state persistence. */
export function to7bResultPersisted(
  full: IngestSourceCommentsResult,
): IngestSourceCommentsRunResult {
  return {
    walkPath: SOURCE_COMMENTS_WALK_PATH,
    walkSummary: {
      files: full.walk.files.length,
      blocks: full.walk.blocks.length,
      bytesScanned: full.walk.bytesScanned,
      fileCountByLang: full.walk.fileCountByLang,
      filesAvailable: full.walk.filesAvailable,
      truncatedAtFileCap: full.walk.truncatedAtFileCap,
    },
    decsWritten: full.decsWritten,
    invsWritten: full.invsWritten,
    citesEmitted: full.citesEmitted,
    stripFilesModified: full.stripFilesModified,
    stripItemsApplied: full.stripItemsApplied,
    stripItemsSkipped: full.stripItemsSkipped,
    stripError: full.stripError,
    auditPath: full.auditPath,
    auditRelPath: full.auditRelPath,
    inputTokens: full.inputTokens,
    outputTokens: full.outputTokens,
    batchesRun: full.batchesRun,
    batchesFailed: full.batchesFailed,
    kindCounts: full.kindCounts,
  };
}
