/**
 * Shared file-tree walker for GC passes that need a flat repo-relative listing.
 *
 * Mirrors the strategy of `walkCanonical` but without the canonical-zone glob
 * filter — used by passes that scan the entire source tree (stub-catalog hits,
 * scope-coverage, etc.).
 */

import { type Dirent, existsSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

/** Directories the scan never descends into. */
export const SOURCE_TREE_SKIP_DIRS = new Set([
  ".git",
  ".harness",
  "node_modules",
  ".pnpm-store",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".archive",
  "coverage",
]);

/**
 * Walk every file in repoRoot, yielding repo-relative paths sorted
 * alphabetically. Returns an empty array if `repoRoot` does not exist.
 */
export function walkSourceTree(repoRoot: string): string[] {
  const out: string[] = [];
  if (!existsSync(repoRoot)) return out;
  const stack: string[] = [repoRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (SOURCE_TREE_SKIP_DIRS.has(entry.name)) continue;
        stack.push(abs);
      } else if (entry.isFile()) {
        out.push(relative(repoRoot, abs).replace(/\\/g, "/"));
      }
    }
  }
  out.sort();
  return out;
}
