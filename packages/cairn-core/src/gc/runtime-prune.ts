/**
 * GC pass — runtime-state pruning.
 *
 * Every other GC pass guards ground/doc *integrity*. This one guards
 * `.cairn/` *footprint*: the per-clone runtime artifacts that grow without
 * bound because nothing on the write path ever trims them. Left alone they
 * reach tens of megabytes (observed: a 3 MB telemetry log, a 26 MB Haiku
 * cache, a dozen 400 KB baseline snapshots) — pure derived/advisory state
 * with no reader that needs the history.
 *
 * Three operations, all idempotent and best-effort (a single failure never
 * aborts the rest):
 *
 *   1. Rotate append-only telemetry/advisory logs to a trailing window.
 *      ONLY logs that are pure append + never replayed:
 *        · staleness/mcp-calls.jsonl  — MCP call telemetry (the trace sink
 *                                        in ~/.cairn/ owns the durable copy)
 *        · staleness/log.jsonl        — drift events; only the recent tail
 *                                        is ever read
 *      Deliberately NOT touched — these are work queues / undo history whose
 *      head still matters: layer-a-deferred.jsonl, pre-commit-deferred.jsonl,
 *      state/align-undo-log.jsonl.
 *
 *   2. Evict Haiku cache entries older than the 30-day window the cache
 *      itself advertises. `claude/cache.ts` only evicts lazily on a *re-read*
 *      of the same key, so one-shot prompts (e.g. the thousands of per-file
 *      init classifications) are cached once and never looked up again →
 *      never evicted. This is the sweep half.
 *
 *   3. Keep only the newest N baseline snapshots per prefix. `baseline-audit`
 *      writes a fresh `components-<ts>.yaml` every audit and never reaps the
 *      old ones; only the latest is ever diffed against.
 *
 * Safe-class by construction (deletes derived/advisory state only), so the
 * sweep runs it unconditionally and SessionStart calls it best-effort — no
 * operator confirmation, no commit.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cairnDir, haikuCacheDir, stalenessDir } from "@isaacriehm/cairn-state";
import { logger } from "../logger.js";

const log = logger("gc.runtime-prune");

/** Rotate a telemetry log once it crosses this size... */
const LOG_CAP_BYTES = 2 * 1024 * 1024;
/** ...down to the trailing this-many bytes of complete lines. */
const LOG_KEEP_BYTES = 512 * 1024;
/** Haiku cache entries older than this are swept (matches the cache's own TTL). */
const HAIKU_MAX_AGE_MS = 30 * 86_400_000;
/** Newest baseline snapshots to retain per filename prefix. */
const BASELINE_KEEP = 3;

/** Append-only logs safe to trim to a trailing window. Relative to `staleness/`. */
const ROTATABLE_LOGS = ["mcp-calls.jsonl", "log.jsonl"] as const;

export interface RotatedLog {
  path: string;
  fromBytes: number;
  toBytes: number;
}

export interface RuntimePruneResult {
  rotatedLogs: RotatedLog[];
  haikuEvicted: number;
  baselineRemoved: string[];
  /** Total bytes reclaimed across all three operations. */
  bytesFreed: number;
}

export interface RuntimePruneOptions {
  repoRoot: string;
  /** Override "now" for the age checks (tests). */
  now?: Date;
}

function safeSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Trim `path` to its trailing `LOG_KEEP_BYTES` of complete lines when it
 * exceeds `LOG_CAP_BYTES`. The partial first line in the kept window is
 * dropped so every retained row stays parseable. No-op below the cap.
 */
function rotateLog(path: string): RotatedLog | null {
  const from = safeSize(path);
  if (from <= LOG_CAP_BYTES) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  // Keep the trailing window, then snap to the next newline so the first
  // retained line is whole.
  let tail = raw.slice(Math.max(0, raw.length - LOG_KEEP_BYTES));
  const nl = tail.indexOf("\n");
  if (nl !== -1) tail = tail.slice(nl + 1);
  if (!tail.endsWith("\n") && tail.length > 0) tail += "\n";
  try {
    writeFileSync(path, tail, "utf8");
  } catch {
    return null;
  }
  return { path, fromBytes: from, toBytes: Buffer.byteLength(tail, "utf8") };
}

/** Recursively unlink Haiku-cache files older than the TTL. Returns count + bytes. */
function sweepHaiku(repoRoot: string, cutoffMs: number): { evicted: number; bytes: number } {
  const root = haikuCacheDir(repoRoot);
  if (!existsSync(root)) return { evicted: 0, bytes: 0 };
  let evicted = 0;
  let bytes = 0;
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      let st: import("node:fs").Stats;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.mtimeMs >= cutoffMs) continue;
      try {
        unlinkSync(abs);
        evicted += 1;
        bytes += st.size;
      } catch {
        /* best-effort */
      }
    }
  };
  walk(root);
  return { evicted, bytes };
}

/** Strip the trailing `-<ISO timestamp>.yaml|yml` to recover a snapshot's family prefix. */
function baselinePrefix(name: string): string | null {
  const m = name.match(/^(.*?)-\d{4}-\d{2}-\d{2}T.*\.ya?ml$/);
  return m && m[1] !== undefined ? m[1] : null;
}

/** Keep the newest `BASELINE_KEEP` snapshots per prefix; unlink the rest. */
function pruneBaseline(repoRoot: string): { removed: string[]; bytes: number } {
  const dir = cairnDir(repoRoot, "baseline");
  if (!existsSync(dir)) return { removed: [], bytes: 0 };
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return { removed: [], bytes: 0 };
  }

  const groups = new Map<string, { name: string; mtime: number; size: number }[]>();
  for (const e of entries) {
    if (!e.isFile()) continue;
    const prefix = baselinePrefix(e.name);
    if (prefix === null) continue;
    const abs = join(dir, e.name);
    let st: import("node:fs").Stats;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    const arr = groups.get(prefix) ?? [];
    arr.push({ name: e.name, mtime: st.mtimeMs, size: st.size });
    groups.set(prefix, arr);
  }

  const removed: string[] = [];
  let bytes = 0;
  for (const snaps of groups.values()) {
    if (snaps.length <= BASELINE_KEEP) continue;
    snaps.sort((a, b) => b.mtime - a.mtime); // newest first
    for (const stale of snaps.slice(BASELINE_KEEP)) {
      try {
        unlinkSync(join(dir, stale.name));
        removed.push(stale.name);
        bytes += stale.size;
      } catch {
        /* best-effort */
      }
    }
  }
  return { removed, bytes };
}

/**
 * Run all three runtime-prune operations against `repoRoot`. Best-effort
 * and idempotent — safe to call from the GC sweep and from SessionStart.
 */
export function runRuntimePrune(opts: RuntimePruneOptions): RuntimePruneResult {
  const now = opts.now ?? new Date();
  const result: RuntimePruneResult = {
    rotatedLogs: [],
    haikuEvicted: 0,
    baselineRemoved: [],
    bytesFreed: 0,
  };

  const stale = stalenessDir(opts.repoRoot);
  for (const name of ROTATABLE_LOGS) {
    const rotated = rotateLog(join(stale, name));
    if (rotated !== null) {
      result.rotatedLogs.push(rotated);
      result.bytesFreed += Math.max(0, rotated.fromBytes - rotated.toBytes);
    }
  }

  const haiku = sweepHaiku(opts.repoRoot, now.getTime() - HAIKU_MAX_AGE_MS);
  result.haikuEvicted = haiku.evicted;
  result.bytesFreed += haiku.bytes;

  const baseline = pruneBaseline(opts.repoRoot);
  result.baselineRemoved = baseline.removed;
  result.bytesFreed += baseline.bytes;

  if (
    result.rotatedLogs.length > 0 ||
    result.haikuEvicted > 0 ||
    result.baselineRemoved.length > 0
  ) {
    log.info(
      {
        repo: opts.repoRoot,
        rotated: result.rotatedLogs.map((r) => r.path),
        haiku_evicted: result.haikuEvicted,
        baseline_removed: result.baselineRemoved.length,
        bytes_freed: result.bytesFreed,
      },
      "runtime-prune complete",
    );
  }
  return result;
}
