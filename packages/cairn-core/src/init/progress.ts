/**
 * Live adoption-progress heartbeat.
 *
 * The long ingestion phases (3-mapper, 6-docs-ingest, 7b-source-comments,
 * 7c-rules-merge) run for minutes on busy monorepos. The MCP tool turn
 * stays frozen until the phase completes, so the only mid-turn render
 * channel is the Claude Code statusline. This module owns the file the
 * statusline reads:
 *
 *   `.cairn/init/progress.json` — current-phase batch counter
 *
 * Phase wrappers `writeProgress` after each batch / module / doc / section
 * completes; the statusline format module renders the snapshot as
 * `⏳ adopt <phase> X/Y (P%) ~Nm left` until the phase wrapper
 * `clearProgress` on completion.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { cairnDir } from "@isaacriehm/cairn-state";

/** Repo-relative display path. State home resolution goes through `cairnDir`. */
export const PROGRESS_PATH = join(".cairn", "init", "progress.json");

export interface ProgressSnapshot {
  /** Phase id currently running (e.g. `7b-source-comments`). */
  phase: string;
  /** 1-based batch / module / doc / section index. */
  batch: number;
  /** Total batches the phase will run. */
  total: number;
  /** Optional running count of successful classifications. */
  classified?: number;
  /** Optional running count of failed classifications. */
  failed?: number;
  /** Date.now() at phase start; used to extrapolate ETA. */
  startedAt: number;
}

export function progressAbsPath(repoRoot: string): string {
  return cairnDir(repoRoot, "init", "progress.json");
}

export function writeProgress(repoRoot: string, snap: ProgressSnapshot): void {
  const path = progressAbsPath(repoRoot);
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  // Atomic-enough for the statusline reader: writeFileSync replaces in
  // one syscall on common filesystems. Best-effort — if the disk is
  // full or the dir is gone we silently swallow so a phase doesn't fail
  // because the heartbeat couldn't write.
  try {
    writeFileSync(path, JSON.stringify(snap), "utf8");
  } catch {
    /* best-effort */
  }
}

export function clearProgress(repoRoot: string): void {
  const path = progressAbsPath(repoRoot);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      /* best-effort */
    }
  }
}

export function readProgress(repoRoot: string): ProgressSnapshot | null {
  const path = progressAbsPath(repoRoot);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as ProgressSnapshot;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.phase !== "string" ||
      typeof parsed.batch !== "number" ||
      typeof parsed.total !== "number" ||
      typeof parsed.startedAt !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
