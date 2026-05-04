import { type Dirent, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { CANONICAL_EXCLUDES, CANONICAL_GLOBS } from "./paths.js";
import { matchAnyGlob } from "./glob.js";

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
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(abs);
      } else if (entry.isFile()) {
        const rel = relative(repoRoot, abs).replace(/\\/g, "/");
        if (matchAnyGlob(rel, CANONICAL_GLOBS) && !matchAnyGlob(rel, CANONICAL_EXCLUDES)) {
          out.push(rel);
        }
      }
    }
  }
  out.sort();
  return out;
}
