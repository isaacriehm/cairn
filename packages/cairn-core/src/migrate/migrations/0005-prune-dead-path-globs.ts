/**
 * 0005 — prune dead-path globs from the gate lists.
 *
 * Adoption could emit globs anchored at paths that do not exist on disk —
 * mis-rooted by the mapper (a dropped package-internal segment), or pointing at
 * a location renamed away since adoption. Such a glob matches zero files, so the
 * high-stakes gate, the route/DTO sensors, and GC classification silently treat
 * it as no coverage at all. Stripping these inert entries changes nothing the
 * config currently matches — it only removes lies from the file.
 *
 * `review`, not `safe`: filesystem absence at one instant is not proof of
 * permanent deadness (an unbuilt generated dir, an unchecked-out submodule, a
 * sibling worktree). So the prune is surfaced for the operator to apply via
 * `cairn migrate`, never auto-run on every SessionStart. The dead-path test is
 * deliberately conservative (≥2 concrete leading segments) so generic ignores
 * like `dist/` survive — see migrate/glob-resolve.ts.
 */

import type { Migration, MigrationResult } from "../types.js";
import { loadConfigDoc, mutateConfig } from "../config-io.js";
import { isDeadPathGlob } from "../glob-resolve.js";

/** Config locations whose string entries are filesystem-anchored globs. */
const GLOB_PATHS: readonly string[][] = [
  ["off_limits"],
  ["project_globs", "route_handler_globs"],
  ["project_globs", "dto_globs"],
  ["project_globs", "generator_source_globs"],
  ["project_globs", "high_stakes_globs"],
];

function readArrayAt(json: Record<string, unknown>, path: readonly string[]): string[] | null {
  let cur: unknown = json;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  if (!Array.isArray(cur)) return null;
  return cur.filter((x): x is string => typeof x === "string");
}

/** Dead-path entries per glob list, skipping lists with none. */
function deadEntries(repoRoot: string, json: Record<string, unknown>): { path: string[]; kept: string[]; removed: string[] }[] {
  const out: { path: string[]; kept: string[]; removed: string[] }[] = [];
  for (const path of GLOB_PATHS) {
    const arr = readArrayAt(json, path);
    if (arr === null) continue;
    const removed = arr.filter((g) => isDeadPathGlob(repoRoot, g));
    if (removed.length === 0) continue;
    out.push({ path: [...path], kept: arr.filter((g) => !isDeadPathGlob(repoRoot, g)), removed });
  }
  return out;
}

export const pruneDeadPathGlobs: Migration = {
  id: "0005-prune-dead-path-globs",
  introducedIn: "0.22.6",
  describe:
    "Prune config globs anchored at paths that no longer exist on disk (mis-rooted or renamed away) — they match nothing",
  class: "review",
  detect(repoRoot: string): boolean {
    const json = loadJson(repoRoot);
    if (json === null) return false;
    return deadEntries(repoRoot, json).length > 0;
  },
  apply(repoRoot: string): MigrationResult {
    let removedTotal = 0;
    const changed = mutateConfig(repoRoot, (d) => {
      const json = (d.toJSON() ?? {}) as Record<string, unknown>;
      const dead = deadEntries(repoRoot, json);
      if (dead.length === 0) return false;
      for (const { path, kept, removed } of dead) {
        // Rebuild as a fresh inline node — alias-proof and order-stable.
        d.setIn(path, d.createNode(kept));
        removedTotal += removed.length;
      }
      return true;
    });
    return {
      changed,
      detail:
        removedTotal > 0
          ? `pruned ${removedTotal} dead-path glob(s) across the gate lists`
          : "no dead-path globs present",
    };
  },
};

/** Parse config.yaml to plain JSON for the read-only detect pass. */
function loadJson(repoRoot: string): Record<string, unknown> | null {
  const doc = loadConfigDoc(repoRoot);
  if (doc === null) return null;
  return (doc.toJSON() ?? {}) as Record<string, unknown>;
}
