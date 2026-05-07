/**
 * Per-process LRU cache (max 1 entry) for the invariants ledger and
 * task-status lookups consumed by the read-enricher hook. All disk
 * reads here are best-effort: any failure returns null/not_found so
 * the hook stays a no-op.
 */

import { createHash } from "node:crypto";
import { existsSync, openSync, readFileSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { fileCandidatesMapPath } from "../../ground/paths.js";
import { FileCandidatesMap } from "../../ground/schemas.js";
import {
  lookupScope,
  readScopeIndex,
  scopeIndexPath,
  type ScopeIndex,
  type ScopeIndexEntry,
} from "../../ground/scope-index.js";

export type { ScopeIndexEntry } from "../../ground/scope-index.js";

export interface LedgerSnapshot {
  invariantsByid: Map<
    string,
    { title: string; status: string; superseded_by?: string }
  >;
}

export interface DecisionsLedgerSnapshot {
  decisionsByid: Map<
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

interface DecisionsCacheEntry {
  repoRoot: string;
  mtimeMs: number;
  snapshot: DecisionsLedgerSnapshot;
}

interface TasksDirCacheEntry {
  repoRoot: string;
  scope: "active" | "done";
  mtimeMs: number;
  /** taskId → resolved title (or "" when no title was discoverable). */
  titles: Map<string, string>;
}

interface ScopeIndexCacheEntry {
  repoRoot: string;
  /** sha256 of the first 512 bytes of scope-index.yaml — content-keyed cache. */
  contentHash: string;
  index: ScopeIndex;
}

interface FileCandidatesCacheEntry {
  repoRoot: string;
  mtimeMs: number;
  /** repo-relative path → unpromoted-candidate count (only files with ≥1). */
  counts: Map<string, number>;
}

const SCOPE_INDEX_HASH_BYTES = 512;

/**
 * Hash the first N bytes of a file. Returns null when the file can't be read.
 * Used as the cache key for scope-index — mtime is unreliable under clock
 * skew (concurrent ledger writes can land with the same mtime as the
 * previous read).
 */
function hashFilePrefix(path: string, bytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    return createHash("sha256")
      .update(buf.subarray(0, read))
      .digest("hex");
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore — best-effort
    }
  }
}

let invariantsCache: InvariantsCacheEntry | null = null;
let decisionsCache: DecisionsCacheEntry | null = null;
let activeTasksCache: TasksDirCacheEntry | null = null;
let doneTasksCache: TasksDirCacheEntry | null = null;
let scopeIndexCache: ScopeIndexCacheEntry | null = null;
let fileCandidatesCache: FileCandidatesCacheEntry | null = null;

function invariantsLedgerFile(repoRoot: string): string {
  return join(
    repoRoot,
    ".cairn",
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

function decisionsLedgerFile(repoRoot: string): string {
  return join(
    repoRoot,
    ".cairn",
    "ground",
    "decisions",
    "decisions.ledger.yaml",
  );
}

export function getDecisionsLedger(
  repoRoot: string,
): DecisionsLedgerSnapshot | null {
  const path = decisionsLedgerFile(repoRoot);
  if (!existsSync(path)) return null;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  if (
    decisionsCache !== null &&
    decisionsCache.repoRoot === repoRoot &&
    decisionsCache.mtimeMs === mtimeMs
  ) {
    return decisionsCache.snapshot;
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
      typeof r["status"] === "string" ? (r["status"] as string) : "accepted";
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

  const snapshot: DecisionsLedgerSnapshot = { decisionsByid: map };
  decisionsCache = { repoRoot, mtimeMs, snapshot };
  return snapshot;
}

function tasksScopeDir(repoRoot: string, scope: "active" | "done"): string {
  return join(repoRoot, ".cairn", "tasks", scope);
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

/**
 * Cached scope-index reader. Content-keyed (sha256 of first 512 bytes) so
 * back-to-back hook invocations in the same process don't re-parse the file
 * AND so concurrent ledger writes that happen within the same mtime tick
 * are not silently masked by a stale cache hit (Gap 6 in BUILD_REPORT).
 *
 * Returns null when the file is missing, when no entry matches the path,
 * when the entry is explicitly `unscoped: true`, or when the entry has no
 * decisions/invariants — i.e., when there is nothing useful to surface.
 */
export function getScopeIndexEntry(
  repoRoot: string,
  repoRelativePath: string,
): ScopeIndexEntry | null {
  const path = scopeIndexPath(repoRoot);
  if (!existsSync(path)) return null;
  const contentHash = hashFilePrefix(path, SCOPE_INDEX_HASH_BYTES);
  if (contentHash === null) return null;
  let index: ScopeIndex;
  if (
    scopeIndexCache !== null &&
    scopeIndexCache.repoRoot === repoRoot &&
    scopeIndexCache.contentHash === contentHash
  ) {
    index = scopeIndexCache.index;
  } else {
    const fresh = readScopeIndex(repoRoot);
    if (fresh === null) return null;
    scopeIndexCache = { repoRoot, contentHash, index: fresh };
    index = fresh;
  }
  const entry = lookupScope(index, repoRelativePath);
  if (entry === null) return null;
  if (entry.unscoped === true) return null;
  if (entry.decisions.length === 0 && entry.invariants.length === 0) return null;
  return entry;
}

/**
 * Cached `file-candidates-map.yaml` reader. mtime-keyed; the read-enrich
 * hook hits this once per Read so the cache pays off after the second
 * read of any file in the same session. Returns 0 when the file is
 * missing (no walks have happened yet — typical for a fresh clone) so
 * the candidate-count hint stays silent on un-adopted projects.
 *
 *  The map is regenerated every time
 * phase 5b walks the repo and every time phase 6 / `cairn_propose_decision`
 * stamps a new `dec_id` on a topic-index entry. The mtime invalidation
 * picks up both refresh paths.
 */
export function getFileCandidateCount(
  repoRoot: string,
  repoRelativePath: string,
): number {
  const path = fileCandidatesMapPath(repoRoot);
  if (!existsSync(path)) return 0;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return 0;
  }
  if (
    fileCandidatesCache === null ||
    fileCandidatesCache.repoRoot !== repoRoot ||
    fileCandidatesCache.mtimeMs !== mtimeMs
  ) {
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(path, "utf8"));
    } catch {
      return 0;
    }
    const result = FileCandidatesMap.safeParse(parsed);
    if (!result.success) return 0;
    const counts = new Map<string, number>();
    for (const [file, count] of Object.entries(result.data.file_candidates)) {
      if (typeof count === "number" && count > 0) counts.set(file, count);
    }
    fileCandidatesCache = { repoRoot, mtimeMs, counts };
  }
  return fileCandidatesCache.counts.get(repoRelativePath) ?? 0;
}
