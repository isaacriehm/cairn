/**
 * Layer C operator-consent gates.
 *
 * `cairn fix align` runs a full-repo Haiku-judge sweep + strip-replace
 * pass. It is expensive (Haiku spend) and destructive (rewrites source
 * prose blocks). Two gates protect the operator:
 *
 *   - Dry-run sentinel — `--dry-run` writes
 *     `.cairn/state/fix-align-dryrun.json` with `{ ts, repo_head_sha,
 *     args_hash }`. The next non-dry-run invocation must find a
 *     sentinel that is fresh (≤ 30 min), points at the current HEAD,
 *     and matches the same flag set. Mismatch aborts before any
 *     Haiku call.
 *
 *   - Dirty-tree guard — before the apply phase, the CLI checks
 *     `git status --porcelain` for modified / staged paths that
 *     intersect the include globs. Hits abort with a message asking
 *     the operator to commit / stash, or pass `--force`.
 *
 * Both gates can be bypassed with `--force` for scripted contexts
 * (CI, retroactive sweeps the operator has already vetted).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { cairnDir, writeFileSafe } from "@isaacriehm/cairn-state";
import { matchAnyGlob } from "@isaacriehm/cairn-state";
import { logger } from "../logger.js";

const log = logger("fix-align.sentinel");

/** Sentinel TTL — operators who walk away for half an hour pay the dry-run cost again. */
const SENTINEL_TTL_MS = 30 * 60 * 1000;

export function fixAlignSentinelPath(repoRoot: string): string {
  return cairnDir(repoRoot, "state", "fix-align-dryrun.json");
}

export interface FixAlignSentinelArgs {
  include: readonly string[];
  exclude: readonly string[];
  skipCreation: boolean;
  maxCost: number | null;
}

interface SentinelFile {
  ts: string;
  repo_head_sha: string | null;
  args_hash: string;
}

/**
 * Hash the apply-phase flags so a follow-up run with different
 * `--include` / `--exclude` / `--no-creation` / `--max-cost` is
 * detected as drift against the dry-run.
 */
export function hashFixAlignArgs(args: FixAlignSentinelArgs): string {
  const normalized = {
    include: [...args.include].sort(),
    exclude: [...args.exclude].sort(),
    skipCreation: args.skipCreation === true,
    maxCost: args.maxCost ?? null,
  };
  return createHash("sha256")
    .update(JSON.stringify(normalized), "utf8")
    .digest("hex");
}

export function readGitHeadSha(repoRoot: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    return null;
  }
}

export function writeFixAlignSentinel(
  repoRoot: string,
  args: FixAlignSentinelArgs,
): void {
  const data: SentinelFile = {
    ts: new Date().toISOString(),
    repo_head_sha: readGitHeadSha(repoRoot),
    args_hash: hashFixAlignArgs(args),
  };
  writeFileSafe(fixAlignSentinelPath(repoRoot), `${JSON.stringify(data, null, 2)}\n`);
}

export type SentinelValidation =
  | { ok: true }
  | {
      ok: false;
      reason: "missing" | "stale" | "head-drifted" | "args-drifted";
      detail: string;
    };

export function validateFixAlignSentinel(
  repoRoot: string,
  args: FixAlignSentinelArgs,
  now: number = Date.now(),
): SentinelValidation {
  const path = fixAlignSentinelPath(repoRoot);
  if (!existsSync(path)) {
    return { ok: false, reason: "missing", detail: "no prior --dry-run sentinel found" };
  }
  let parsed: SentinelFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "fix-align sentinel parse failed",
    );
    return { ok: false, reason: "missing", detail: "sentinel unreadable" };
  }
  const ts = Date.parse(parsed.ts ?? "");
  if (!Number.isFinite(ts) || now - ts > SENTINEL_TTL_MS) {
    return {
      ok: false,
      reason: "stale",
      detail: `sentinel older than ${SENTINEL_TTL_MS / 60_000} minutes`,
    };
  }
  const head = readGitHeadSha(repoRoot);
  if (head !== null && parsed.repo_head_sha !== head) {
    return {
      ok: false,
      reason: "head-drifted",
      detail: `HEAD ${head.slice(0, 7)} differs from sentinel ${(parsed.repo_head_sha ?? "?").slice(0, 7)}`,
    };
  }
  const expected = hashFixAlignArgs(args);
  if (parsed.args_hash !== expected) {
    return {
      ok: false,
      reason: "args-drifted",
      detail: "flags differ from the --dry-run invocation",
    };
  }
  return { ok: true };
}

export interface DirtyPath {
  /** Repo-relative path. */
  path: string;
  /** Two-character porcelain status (e.g., ` M`, `??`, `MM`). */
  status: string;
}

/**
 * Return modified / staged / untracked paths inside `git status
 * --porcelain` whose path matches one of the include globs (or every
 * dirty path when include is empty — full-repo sweep). Returns an
 * empty array when the repo isn't a git tree at all.
 */
export function gitDirtyPathsInScope(
  repoRoot: string,
  includeGlobs: readonly string[],
): DirtyPath[] {
  let out: string;
  try {
    // `--untracked-files=all` so an untracked file inside an
    // untracked directory shows up as a leaf path rather than the
    // collapsed `?? src/` summary line.
    out = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  const dirty: DirtyPath[] = [];
  for (const line of out.split("\n")) {
    if (line.length === 0) continue;
    const status = line.slice(0, 2);
    // Porcelain v1 layout: `XY <path>` where the path starts at column 3.
    const path = line.slice(3).trim();
    if (path.length === 0) continue;
    if (includeGlobs.length > 0 && !matchAnyGlob(path, includeGlobs)) continue;
    dirty.push({ path, status });
  }
  return dirty;
}
