/**
 * 0007 — collapse redundant nested `componentDirs`.
 *
 * The pre-0.22.4 component-layout detector could enumerate a directory AND
 * its sub-directories (and even individual leaf component folders) as
 * separate `componentDirs`. On a repo adopted in that era a workspace's
 * `componentDirs` can carry dozens of entries where a directory is already
 * covered by an ancestor that is also listed — e.g. both `a/b` and
 * `a/b/c`, plus `a/b/c/Leaf`.
 *
 * The component walk recurses (`walkFs`) and collection dedups visited
 * files (`collectComponents`'s `seen` set), so the redundant entries change
 * nothing at runtime — they are pure config bloat. This migration removes
 * any `componentDir` that is a descendant (or exact duplicate) of another
 * `componentDir` in the same workspace, keeping only the shallowest
 * ancestors. The collected component set is byte-identical afterward.
 *
 * `review`-class: it rewrites the operator's curated `config.yaml`, so it
 * surfaces the count and applies via `cairn migrate` rather than silently
 * rewriting their list. Ships in 0.26.0 → `introducedIn` 0.26.0; `detect()`
 * carries correctness for any older pin.
 */

import { loadConfigDoc, writeConfigDoc } from "../config-io.js";
import type { Migration, MigrationResult } from "../types.js";

function normDir(d: string): string {
  return d.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Keep only the shallowest ancestor dirs (original order, deduped). A dir
 * is dropped when another kept dir equals it or is a path-prefix ancestor.
 */
function collapseDirs(dirs: string[]): { kept: string[]; removed: number } {
  const norm = dirs
    .filter((d): d is string => typeof d === "string")
    .map(normDir)
    .filter((d) => d.length > 0);

  // Shallowest-first so an ancestor is always seen before its descendants.
  const ancestors: string[] = [];
  const byDepth = [...new Set(norm)].sort((a, b) => {
    const da = a.split("/").length;
    const db = b.split("/").length;
    return da - db || a.localeCompare(b);
  });
  for (const d of byDepth) {
    if (!ancestors.some((k) => d === k || d.startsWith(`${k}/`))) ancestors.push(d);
  }

  // Re-emit in the config's original order, deduped, ancestors only.
  const keep = new Set(ancestors);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const d of norm) {
    if (keep.has(d) && !seen.has(d)) {
      seen.add(d);
      kept.push(d);
    }
  }
  return { kept, removed: norm.length - kept.length };
}

interface DirList {
  path: (string | number)[];
  dirs: string[];
}

/** Every `componentDirs` array in the config — per-workspace, or the flat single-app form. */
function dirLists(components: unknown): DirList[] {
  if (components === null || typeof components !== "object") return [];
  const c = components as Record<string, unknown>;
  const out: DirList[] = [];

  const workspaces = c["workspaces"];
  if (workspaces !== null && typeof workspaces === "object") {
    for (const [ws, cfg] of Object.entries(workspaces as Record<string, unknown>)) {
      const dirs = (cfg as Record<string, unknown> | null)?.["componentDirs"];
      if (Array.isArray(dirs)) {
        out.push({ path: ["components", "workspaces", ws, "componentDirs"], dirs: dirs as string[] });
      }
    }
  }
  if (Array.isArray(c["componentDirs"])) {
    out.push({ path: ["components", "componentDirs"], dirs: c["componentDirs"] as string[] });
  }
  return out;
}

function readComponents(repoRoot: string): unknown {
  const doc = loadConfigDoc(repoRoot);
  if (doc === null) return null;
  const node = doc.getIn(["components"]);
  if (node === undefined || node === null) return null;
  try {
    return typeof (node as { toJSON?: () => unknown }).toJSON === "function"
      ? (node as { toJSON: () => unknown }).toJSON()
      : node;
  } catch {
    return null;
  }
}

export const collapseComponentDirs: Migration = {
  id: "0007-collapse-component-dirs",
  introducedIn: "0.26.0",
  describe:
    "Collapse redundant nested componentDirs in config.yaml (a dir already covered by a listed ancestor) — value-preserving config tidy",
  class: "review",
  detect(repoRoot: string): boolean {
    return dirLists(readComponents(repoRoot)).some((l) => collapseDirs(l.dirs).removed > 0);
  },
  apply(repoRoot: string): MigrationResult {
    const doc = loadConfigDoc(repoRoot);
    if (doc === null) return { changed: false, detail: "no config.yaml" };
    const node = doc.getIn(["components"]);
    const components =
      node !== undefined && node !== null && typeof (node as { toJSON?: () => unknown }).toJSON === "function"
        ? (node as { toJSON: () => unknown }).toJSON()
        : null;

    let totalRemoved = 0;
    const touched: string[] = [];
    for (const list of dirLists(components)) {
      const { kept, removed } = collapseDirs(list.dirs);
      if (removed > 0) {
        doc.setIn(list.path, kept);
        totalRemoved += removed;
        const ws = list.path.length === 4 ? String(list.path[2]) : "components";
        touched.push(`${ws} (−${removed})`);
      }
    }
    if (totalRemoved === 0) return { changed: false, detail: "no redundant componentDirs" };
    writeConfigDoc(repoRoot, doc);
    return {
      changed: true,
      detail: `collapsed ${totalRemoved} redundant componentDir(s): ${touched.join(", ")}`,
    };
  },
};
