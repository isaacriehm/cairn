/**
 * Pre-init guards.
 *
 *   - detectMonorepoContext(cwd, gitRoot)
 *       Walks up from cwd toward gitRoot looking for a workspace marker. If
 *       cwd is inside a monorepo PACKAGE (rather than at the workspace root)
 *       this returns the workspace root path so the caller can warn the
 *       operator that init will only see the package subtree.
 *
 *   - isHarnessSourceRepo(repoRoot)
 *       Returns true when repoRoot looks like the Harness source repo itself
 *       (harness-build/ + packages/harness-core/ + pnpm-workspace.yaml). Init
 *       must hard-stop in that case — running it on its own source would
 *       overwrite internals.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Walks up from `startCwd` looking for a `.git/` directory. Returns the
 * first ancestor (inclusive) that contains it, or null when none does.
 */
export function findGitRoot(startCwd: string): string | null {
  let dir = startCwd;
  for (let i = 0; i < 24; i++) {
    const probe = join(dir, ".git");
    if (existsSync(probe)) {
      try {
        if (statSync(probe).isDirectory()) return dir;
      } catch {
        // fall through
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export interface MonorepoContext {
  /** Workspace root that contains a pnpm-workspace.yaml / yarn workspaces / lerna.json. */
  workspaceRoot: string;
  /** Marker file that revealed the monorepo. */
  marker: "pnpm-workspace.yaml" | "package.json#workspaces" | "lerna.json";
}

/**
 * Walks from `startCwd` up to and INCLUDING `gitRoot` looking for the
 * highest ancestor with a workspace marker. Returns null when:
 *   - startCwd itself has the marker (operator IS at the workspace root), or
 *   - no marker exists anywhere in the chain (single-repo project).
 *
 * Returns the workspace root path otherwise — the operator is inside a
 * sub-package and needs the warning.
 */
export function detectMonorepoContext(
  startCwd: string,
  gitRoot: string | null,
): MonorepoContext | null {
  if (gitRoot === null) return null;

  // First check: if startCwd itself is a workspace root, no warning.
  if (checkWorkspaceMarker(startCwd) !== null) return null;

  // Walk up from startCwd. Stop after we pass gitRoot.
  let dir = dirname(startCwd);
  for (let i = 0; i < 24; i++) {
    const marker = checkWorkspaceMarker(dir);
    if (marker !== null) {
      return { workspaceRoot: dir, marker };
    }
    if (dir === gitRoot) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function checkWorkspaceMarker(
  dir: string,
): MonorepoContext["marker"] | null {
  if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
    return "pnpm-workspace.yaml";
  }
  if (existsSync(join(dir, "lerna.json"))) {
    return "lerna.json";
  }
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<
        string,
        unknown
      >;
      const workspaces = parsed["workspaces"];
      if (
        Array.isArray(workspaces) ||
        (typeof workspaces === "object" &&
          workspaces !== null &&
          Array.isArray((workspaces as Record<string, unknown>)["packages"]))
      ) {
        return "package.json#workspaces";
      }
    } catch {
      // ignore — malformed package.json isn't a workspace claim
    }
  }
  return null;
}

/**
 * Returns true when `repoRoot` looks like the Harness source repository.
 * Checks for the conjunction of all three markers — any single one would
 * false-positive on too many repos.
 */
export function isHarnessSourceRepo(repoRoot: string): boolean {
  return (
    existsSync(join(repoRoot, "harness-build")) &&
    existsSync(join(repoRoot, "packages", "harness-core")) &&
    existsSync(join(repoRoot, "pnpm-workspace.yaml"))
  );
}
