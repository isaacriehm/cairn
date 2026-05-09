import { relative, resolve } from "node:path";
import { CANONICAL_EXCLUDES, CANONICAL_GLOBS } from "./paths.js";
import { matchAnyGlob } from "./glob.js";
import { walkFs } from "./fs.js";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  "dist",
  ".next",
  ".turbo",
  ".cache",
  ".archive",
]);

/**
 * Walks the repo from root and returns every file (relative to root) that
 * matches CANONICAL_GLOBS and is not excluded by CANONICAL_EXCLUDES.
 *
 * Skips heavyweight noise dirs (.git, node_modules, dist, etc.) eagerly.
 */
export function walkCanonical(repoRoot: string): string[] {
  const out: string[] = [];
  walkFs({
    dir: repoRoot,
    skipDirs: SKIP_DIRS,
    onFile: (rel) => {
      if (matchAnyGlob(rel, CANONICAL_GLOBS) && !matchAnyGlob(rel, CANONICAL_EXCLUDES)) {
        out.push(rel);
      }
    },
  });
  out.sort();
  return out;
}
