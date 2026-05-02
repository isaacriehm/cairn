/**
 * Diff acquisition — read agent's working-tree changes against the SHA pin.
 *
 * The agent mutates files in the mirror but never commits. So `git diff
 * <sha_pin>` gives tracked-file changes; `git ls-files --others
 * --exclude-standard` gives newly-created files. Both contribute to the
 * sensor input.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import type { DiffEntry } from "./types.js";

/** Entry of `git diff --name-status <sha>`. */
type NameStatusLine = {
  status: "A" | "M" | "D" | "R";
  path: string;
  fromPath?: string;
};

function parseNameStatus(out: string): NameStatusLine[] {
  const result: NameStatusLine[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // Format: A\tpath, M\tpath, D\tpath, R<score>\tfrom\tto
    const parts = line.split(/\t/);
    const head = parts[0] ?? "";
    if (head.startsWith("A")) result.push({ status: "A", path: parts[1] ?? "" });
    else if (head.startsWith("M")) result.push({ status: "M", path: parts[1] ?? "" });
    else if (head.startsWith("D")) result.push({ status: "D", path: parts[1] ?? "" });
    else if (head.startsWith("R")) {
      result.push({
        status: "R",
        path: parts[2] ?? "",
        fromPath: parts[1] ?? "",
      });
    }
  }
  return result;
}

/** Best-effort read; returns undefined when the file is absent. */
async function readMaybe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** `git show <sha>:<path>` returning undefined if path didn't exist at sha. */
async function showAtSha(git: SimpleGit, sha: string, path: string): Promise<string | undefined> {
  try {
    return await git.show([`${sha}:${path}`]);
  } catch {
    return undefined;
  }
}

/**
 * Compute the diff between the SHA pin and the current working tree (incl.
 * untracked files). The agent does not commit, so working tree is the source.
 *
 * For renames, simple-git surfaces both an `R` entry. We treat it as the new
 * path, with `fromPath` carrying the original.
 */
export async function getDiff(args: {
  mirrorPath: string;
  shaPin: string;
}): Promise<DiffEntry[]> {
  const git = simpleGit({ baseDir: args.mirrorPath });

  // Tracked changes: diff against shaPin, name-status only first.
  const tracked = await git.raw([
    "diff",
    "--name-status",
    "--find-renames",
    args.shaPin,
  ]);
  const trackedRows = parseNameStatus(tracked);

  // Untracked: anything new not in `git diff` against the SHA but present now.
  const untrackedRaw = await git.raw([
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  const untracked = untrackedRaw
    .split("\n")
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 0);

  // De-dupe untracked vs the diff name-status (a file added since shaPin shows
  // up in BOTH `git diff --name-status` (as A) and ls-files (as untracked)
  // until staged — so we treat ls-files as authoritative for new files).
  const trackedNonAdded = trackedRows.filter((r) => r.status !== "A");
  const trackedAddedPaths = new Set(
    trackedRows.filter((r) => r.status === "A").map((r) => r.path),
  );

  const out: DiffEntry[] = [];

  for (const row of trackedNonAdded) {
    const abs = join(args.mirrorPath, row.path);
    if (row.status === "D") {
      const before = await showAtSha(git, args.shaPin, row.path);
      const entry: DiffEntry = { path: row.path, status: "deleted" };
      if (before !== undefined) entry.beforeContent = before;
      out.push(entry);
    } else if (row.status === "M") {
      const before = await showAtSha(git, args.shaPin, row.path);
      const after = await readMaybe(abs);
      const entry: DiffEntry = { path: row.path, status: "modified" };
      if (before !== undefined) entry.beforeContent = before;
      if (after !== undefined) entry.afterContent = after;
      out.push(entry);
    } else if (row.status === "R") {
      const fromPath = row.fromPath ?? "";
      const before = await showAtSha(git, args.shaPin, fromPath);
      const after = await readMaybe(abs);
      const entry: DiffEntry = {
        path: row.path,
        status: "renamed",
        fromPath,
      };
      if (before !== undefined) entry.beforeContent = before;
      if (after !== undefined) entry.afterContent = after;
      out.push(entry);
    }
  }

  // New files: union of `git diff` "A" entries and ls-files untracked.
  const newPaths = new Set<string>([...trackedAddedPaths, ...untracked]);
  for (const path of newPaths) {
    const after = await readMaybe(join(args.mirrorPath, path));
    const entry: DiffEntry = { path, status: "added" };
    if (after !== undefined) entry.afterContent = after;
    out.push(entry);
  }

  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** True iff any changed file's path matches any of the supplied globs. */
export function diffHasGlobMatch(
  diff: DiffEntry[],
  globs: readonly string[],
  matcher: (path: string, glob: string) => boolean,
): boolean {
  return diff.some((d) => globs.some((g) => matcher(d.path, g)));
}

/**
 * Filter a diff to entries whose path matches any of the supplied globs.
 * Useful for layered sensors that scope to e.g. route_handler_globs.
 */
export function filterDiffByGlobs(
  diff: DiffEntry[],
  globs: readonly string[],
  matcher: (path: string, glob: string) => boolean,
): DiffEntry[] {
  return diff.filter((d) => globs.some((g) => matcher(d.path, g)));
}
