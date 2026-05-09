/**
 * Shared file-tree walker for GC passes that need a flat repo-relative listing.
 *
 * Mirrors the strategy of `walkCanonical` but without the canonical-zone glob
 * filter — used by passes that scan the entire source tree (stub-catalog hits,
 * scope-coverage, etc.).
 */

import { walkFs } from "@isaacriehm/cairn-state";

/** Directories the scan never descends into. */
export const SOURCE_TREE_SKIP_DIRS = new Set([
  ".git",
  ".cairn",
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
  walkFs({
    dir: repoRoot,
    skipDirs: SOURCE_TREE_SKIP_DIRS,
    onFile: (rel) => {
      out.push(rel);
    },
  });
  out.sort();
  return out;
}
