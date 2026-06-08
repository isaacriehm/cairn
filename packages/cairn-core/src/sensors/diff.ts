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
  // Untracked: anything new not in `git diff` against the SHA but present now.
  const [tracked, untrackedRaw] = await Promise.all([
    git.raw(["diff", "--name-status", "--find-renames", args.shaPin]),
    git.raw(["ls-files", "--others", "--exclude-standard"]),
  ]);

  const trackedRows = parseNameStatus(tracked);
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

  const limit = pLimit(10);
  const out: DiffEntry[] = [];

  const tasks = trackedNonAdded.map((row) =>
    limit(async () => {
      const abs = join(args.mirrorPath, row.path);
      if (row.status === "D") {
        const before = await showAtSha(git, args.shaPin, row.path);
        const entry: DiffEntry = { path: row.path, status: "deleted" };
        if (before !== undefined) entry.beforeContent = before;
        out.push(entry);
      } else if (row.status === "M") {
        const [before, after] = await Promise.all([
          showAtSha(git, args.shaPin, row.path),
          readMaybe(abs),
        ]);
        const entry: DiffEntry = { path: row.path, status: "modified" };
        if (before !== undefined) entry.beforeContent = before;
        if (after !== undefined) entry.afterContent = after;
        out.push(entry);
      } else if (row.status === "R") {
        const fromPath = row.fromPath ?? "";
        const [before, after] = await Promise.all([
          showAtSha(git, args.shaPin, fromPath),
          readMaybe(abs),
        ]);
        const entry: DiffEntry = {
          path: row.path,
          status: "renamed",
          fromPath,
        };
        if (before !== undefined) entry.beforeContent = before;
        if (after !== undefined) entry.afterContent = after;
        out.push(entry);
      }
    }),
  );

  // New files: union of `git diff` "A" entries and ls-files untracked.
  const newPaths = new Set<string>([...trackedAddedPaths, ...untracked]);
  for (const path of newPaths) {
    tasks.push(
      limit(async () => {
        const after = await readMaybe(join(args.mirrorPath, path));
        const entry: DiffEntry = { path, status: "added" };
        if (after !== undefined) entry.afterContent = after;
        out.push(entry);
      }),
    );
  }

  await Promise.all(tasks);

  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * Build `DiffEntry[]` from a name-status row set, sourcing before/after
 * content from caller-supplied readers. Shared by the staged + range diff
 * gates (which read committed/index blobs, not the working tree).
 */
async function buildEntries(
  rows: NameStatusLine[],
  read: {
    before: (path: string) => Promise<string | undefined>;
    after: (path: string) => Promise<string | undefined>;
  },
): Promise<DiffEntry[]> {
  const limit = pLimit(10);
  const out: DiffEntry[] = [];
  const tasks = rows.map((row) =>
    limit(async () => {
      if (row.status === "A") {
        const after = await read.after(row.path);
        const entry: DiffEntry = { path: row.path, status: "added" };
        if (after !== undefined) entry.afterContent = after;
        out.push(entry);
      } else if (row.status === "D") {
        const before = await read.before(row.path);
        const entry: DiffEntry = { path: row.path, status: "deleted" };
        if (before !== undefined) entry.beforeContent = before;
        out.push(entry);
      } else if (row.status === "M") {
        const [before, after] = await Promise.all([
          read.before(row.path),
          read.after(row.path),
        ]);
        const entry: DiffEntry = { path: row.path, status: "modified" };
        if (before !== undefined) entry.beforeContent = before;
        if (after !== undefined) entry.afterContent = after;
        out.push(entry);
      } else {
        const fromPath = row.fromPath ?? "";
        const [before, after] = await Promise.all([
          read.before(fromPath),
          read.after(row.path),
        ]);
        const entry: DiffEntry = { path: row.path, status: "renamed", fromPath };
        if (before !== undefined) entry.beforeContent = before;
        if (after !== undefined) entry.afterContent = after;
        out.push(entry);
      }
    }),
  );
  await Promise.all(tasks);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * Diff of the staged tree (index) against HEAD — the pre-commit gate's view.
 * After-content is read from the index (`git show :path`), NOT the working
 * tree, so the gate scans exactly what is about to be committed.
 */
export async function getStagedDiff(repoRoot: string): Promise<DiffEntry[]> {
  const git = simpleGit({ baseDir: repoRoot });
  const nameStatus = await git.raw([
    "diff",
    "--cached",
    "--name-status",
    "--find-renames",
  ]);
  return buildEntries(parseNameStatus(nameStatus), {
    before: (p) => showAtSha(git, "HEAD", p),
    after: (p) => showAtSha(git, "", p), // `git show :path` → staged blob
  });
}

/** Split a `git diff` range into base/head refs for content lookup. */
function parseRange(range: string): { base: string; head: string } {
  const sep = range.includes("...") ? "..." : "..";
  if (range.includes(sep)) {
    const [base, head] = range.split(sep);
    return {
      base: (base ?? "").trim() || "HEAD",
      head: (head ?? "").trim() || "HEAD",
    };
  }
  // Bare ref: compare it against HEAD.
  return { base: range.trim(), head: "HEAD" };
}

/**
 * Diff of a committed range (e.g. `origin/main..HEAD`) — the CI gate's view.
 * Both sides come from committed blobs, so this is reproducible on a fresh
 * CI checkout with no working-tree state.
 */
export async function getRangeDiff(
  repoRoot: string,
  range: string,
): Promise<DiffEntry[]> {
  const git = simpleGit({ baseDir: repoRoot });
  const { base, head } = parseRange(range);
  const nameStatus = await git.raw([
    "diff",
    "--name-status",
    "--find-renames",
    range,
  ]);
  return buildEntries(parseNameStatus(nameStatus), {
    before: (p) => showAtSha(git, base, p),
    after: (p) => showAtSha(git, head, p),
  });
}

function pLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  const queue: Array<() => void> = [];
  let activeCount = 0;

  const next = (): void => {
    activeCount--;
    const cb = queue.shift();
    if (cb !== undefined) {
      cb();
    }
  };

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (activeCount >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    activeCount++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
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
