/**
 * Session id resolution + per-session directory lifecycle.
 *
 * Per PLUGIN_ARCHITECTURE §7, each Claude Code session owns a
 * `.harness/sessions/<session-id>/` directory holding its mutable state
 * (status.json, current task pointer, run notes). The directory is
 * created at SessionStart and removed at SessionEnd. Stale dirs left
 * behind by crashed sessions (no live PID, > MAX_AGE_MS old) are GC'd
 * by the next SessionStart in any session.
 *
 * Concurrency: session dirs are owned by one session — no lock. The
 * GC sweep only deletes dirs whose PID is dead OR whose mtime is past
 * the staleness threshold; it never touches a live session's dir.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { sessionStateDir, sessionsDir } from "../paths/index.js";

/** Session id payload shape — Claude Code's hook stdin includes `session_id`. */
export interface SessionIdSource {
  session_id?: unknown;
}

/**
 * Stale-session GC threshold. A session dir whose PID is dead AND whose
 * `meta.json` `started_at` is older than this gets removed at the next
 * SessionStart. 24h matches the spec.
 */
const MAX_STALE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve a session id from a hook payload. Prefers Claude Code's
 * `session_id` when present; otherwise generates a uuid for the
 * caller to use (CLI / test invocation).
 */
export function resolveSessionId(payload: SessionIdSource | null | undefined): string {
  const candidate = payload?.session_id;
  if (typeof candidate === "string" && candidate.length > 0) return candidate;
  return randomUUID();
}

export interface SessionMeta {
  /** Session id (post-sanitize, matches the dir name). */
  session_id: string;
  /** ISO timestamp the session dir was created. */
  started_at: string;
  /** PID of the Claude Code process that owns the session, when known. */
  pid: number | null;
}

export interface EnsureSessionDirArgs {
  repoRoot: string;
  sessionId: string;
  /**
   * PID of the owning process. Default `process.pid` (the SessionStart
   * hook subprocess — short-lived, but its parent Claude Code PID is
   * not exposed via the payload, so subprocess PID is the best proxy
   * for "was this session started by a live process at this time").
   */
  pid?: number | null;
}

export interface EnsureSessionDirResult {
  /** Absolute path to the per-session dir. */
  dir: string;
  /** Whether the dir was just created (false if it already existed). */
  created: boolean;
  /** Meta written into `meta.json`. */
  meta: SessionMeta;
}

/**
 * Create (or refresh) the per-session directory and write `meta.json`.
 * Idempotent — if the dir exists already, the existing meta is read,
 * `pid` and `started_at` left intact when valid.
 */
export function ensureSessionDir(args: EnsureSessionDirArgs): EnsureSessionDirResult {
  const dir = sessionStateDir(args.repoRoot, args.sessionId);
  const metaPath = join(dir, "meta.json");
  const existed = existsSync(dir);

  let meta: SessionMeta;
  if (existed && existsSync(metaPath)) {
    try {
      const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as Partial<SessionMeta>;
      const startedAt = typeof parsed.started_at === "string" ? parsed.started_at : new Date().toISOString();
      const pidVal = typeof parsed.pid === "number" ? parsed.pid : (args.pid ?? process.pid);
      meta = {
        session_id: args.sessionId,
        started_at: startedAt,
        pid: pidVal,
      };
    } catch {
      meta = freshMeta(args);
    }
  } else {
    meta = freshMeta(args);
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return { dir, created: !existed, meta };
}

function freshMeta(args: EnsureSessionDirArgs): SessionMeta {
  return {
    session_id: args.sessionId,
    started_at: new Date().toISOString(),
    pid: args.pid === undefined ? process.pid : args.pid,
  };
}

/**
 * Remove the per-session directory. Returns true when something was
 * removed, false when the dir was already absent.
 */
export function cleanupSession(repoRoot: string, sessionId: string): boolean {
  const dir = sessionStateDir(repoRoot, sessionId);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

export interface GcStaleSessionsArgs {
  repoRoot: string;
  /** ISO time threshold; dirs older than this AND with a dead PID are removed. Default 24h. */
  maxAgeMs?: number;
  /** Override Date.now() for tests. */
  now?: () => number;
}

export interface GcStaleSessionsResult {
  /** Session ids that were removed. */
  removed: string[];
  /** Session ids that were inspected but kept (live PID or fresh). */
  kept: string[];
}

/**
 * Sweep the sessions directory and remove dirs that look abandoned —
 * either older than `maxAgeMs` AND with a dead PID, or with a malformed
 * meta.json. Live sessions (PID alive) are never touched, regardless
 * of age. A missing PID counts as "dead" so dirs from operator-deleted
 * meta files don't accumulate.
 */
export function gcStaleSessions(args: GcStaleSessionsArgs): GcStaleSessionsResult {
  const root = sessionsDir(args.repoRoot);
  const removed: string[] = [];
  const kept: string[] = [];
  if (!existsSync(root)) return { removed, kept };

  const maxAge = args.maxAgeMs ?? MAX_STALE_AGE_MS;
  const now = args.now ? args.now() : Date.now();

  const entries = readdirSync(root, { withFileTypes: true, encoding: "utf8" });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionId = entry.name;
    const dir = join(root, sessionId);
    const metaPath = join(dir, "meta.json");

    let meta: Partial<SessionMeta> | null = null;
    let mtime: number;
    try {
      mtime = statSync(dir).mtimeMs;
    } catch {
      mtime = 0;
    }

    if (existsSync(metaPath)) {
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf8")) as Partial<SessionMeta>;
      } catch {
        meta = null;
      }
    }

    const pid = meta && typeof meta.pid === "number" ? meta.pid : null;
    const startedAt = meta && typeof meta.started_at === "string" ? Date.parse(meta.started_at) : NaN;
    const ageMs = Number.isFinite(startedAt) ? now - startedAt : now - mtime;

    const pidAlive = pid !== null && isPidAlive(pid);
    if (pidAlive) {
      kept.push(sessionId);
      continue;
    }
    if (ageMs >= maxAge) {
      try {
        rmSync(dir, { recursive: true, force: true });
        removed.push(sessionId);
      } catch {
        kept.push(sessionId);
      }
    } else {
      kept.push(sessionId);
    }
  }

  return { removed, kept };
}

/**
 * Probe whether `pid` belongs to a live process. `kill(pid, 0)` is the
 * portable way; throws ESRCH for dead PIDs. EPERM means "alive but not
 * ours" — still alive.
 */
function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}
