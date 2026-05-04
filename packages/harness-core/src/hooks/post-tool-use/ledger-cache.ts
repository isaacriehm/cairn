/**
 * Per-process LRU cache (max 1 entry) for the invariants ledger and
 * task-status lookups consumed by the read-enricher hook. All disk
 * reads here are best-effort: any failure returns null/not_found so
 * the hook stays a no-op.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface LedgerSnapshot {
  invariantsByid: Map<
    string,
    { title: string; status: string; superseded_by?: string }
  >;
}

export interface TaskLookupResult {
  found: "active" | "done" | "not_found";
  title?: string;
}

interface InvariantsCacheEntry {
  repoRoot: string;
  mtimeMs: number;
  snapshot: LedgerSnapshot;
}

interface TasksDirCacheEntry {
  repoRoot: string;
  scope: "active" | "done";
  mtimeMs: number;
  /** taskId → resolved title (or "" when no title was discoverable). */
  titles: Map<string, string>;
}

let invariantsCache: InvariantsCacheEntry | null = null;
let activeTasksCache: TasksDirCacheEntry | null = null;
let doneTasksCache: TasksDirCacheEntry | null = null;

function invariantsLedgerFile(repoRoot: string): string {
  return join(
    repoRoot,
    ".harness",
    "ground",
    "invariants",
    "invariants.ledger.yaml",
  );
}

export function getInvariantsLedger(repoRoot: string): LedgerSnapshot | null {
  const path = invariantsLedgerFile(repoRoot);
  if (!existsSync(path)) return null;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  if (
    invariantsCache !== null &&
    invariantsCache.repoRoot === repoRoot &&
    invariantsCache.mtimeMs === mtimeMs
  ) {
    return invariantsCache.snapshot;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const map = new Map<
    string,
    { title: string; status: string; superseded_by?: string }
  >();
  for (const raw of parsed) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r["id"] === "string" ? (r["id"] as string) : null;
    const title = typeof r["title"] === "string" ? (r["title"] as string) : "";
    const status =
      typeof r["status"] === "string" ? (r["status"] as string) : "active";
    const supersededByRaw = r["superseded_by"];
    const supersededBy =
      typeof supersededByRaw === "string" && supersededByRaw.length > 0
        ? supersededByRaw
        : undefined;
    if (id === null) continue;
    map.set(id, {
      title,
      status,
      ...(supersededBy !== undefined ? { superseded_by: supersededBy } : {}),
    });
  }

  const snapshot: LedgerSnapshot = { invariantsByid: map };
  invariantsCache = { repoRoot, mtimeMs, snapshot };
  return snapshot;
}

function tasksScopeDir(repoRoot: string, scope: "active" | "done"): string {
  return join(repoRoot, ".harness", "tasks", scope);
}

function readDirMtime(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function extractTitle(taskDir: string): string {
  const candidates = [
    join(taskDir, "spec.tightened.md"),
    join(taskDir, "spec.md"),
  ];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    try {
      const text = readFileSync(c, "utf8");
      const m = text.match(/^#\s+(.+)$/m);
      if (m && typeof m[1] === "string") return m[1].trim();
    } catch {
      // ignore — try next candidate
    }
  }
  return "";
}

function resolveCacheForScope(
  repoRoot: string,
  scope: "active" | "done",
): TasksDirCacheEntry | null {
  const dir = tasksScopeDir(repoRoot, scope);
  const mtimeMs = readDirMtime(dir);
  if (mtimeMs === null) return null;
  const cache = scope === "active" ? activeTasksCache : doneTasksCache;
  if (
    cache !== null &&
    cache.repoRoot === repoRoot &&
    cache.scope === scope &&
    cache.mtimeMs === mtimeMs
  ) {
    return cache;
  }
  // Lazy: don't pre-walk all task dirs. We populate `titles` on demand
  // in `lookupTask`. Empty map keyed to current dir mtime is fine.
  const fresh: TasksDirCacheEntry = {
    repoRoot,
    scope,
    mtimeMs,
    titles: new Map<string, string>(),
  };
  if (scope === "active") activeTasksCache = fresh;
  else doneTasksCache = fresh;
  return fresh;
}

export function lookupTask(
  repoRoot: string,
  taskId: string,
): TaskLookupResult {
  // Active first.
  const activeDir = tasksScopeDir(repoRoot, "active");
  const activeTaskDir = join(activeDir, taskId);
  if (existsSync(activeTaskDir)) {
    const cache = resolveCacheForScope(repoRoot, "active");
    if (cache !== null) {
      let title = cache.titles.get(taskId);
      if (title === undefined) {
        title = extractTitle(activeTaskDir);
        cache.titles.set(taskId, title);
      }
      return title.length > 0
        ? { found: "active", title }
        : { found: "active" };
    }
    // Couldn't cache, but the dir is present.
    const title = extractTitle(activeTaskDir);
    return title.length > 0 ? { found: "active", title } : { found: "active" };
  }

  const doneDir = tasksScopeDir(repoRoot, "done");
  const doneTaskDir = join(doneDir, taskId);
  if (existsSync(doneTaskDir)) {
    const cache = resolveCacheForScope(repoRoot, "done");
    if (cache !== null) {
      let title = cache.titles.get(taskId);
      if (title === undefined) {
        title = extractTitle(doneTaskDir);
        cache.titles.set(taskId, title);
      }
      return title.length > 0 ? { found: "done", title } : { found: "done" };
    }
    const title = extractTitle(doneTaskDir);
    return title.length > 0 ? { found: "done", title } : { found: "done" };
  }

  return { found: "not_found" };
}
