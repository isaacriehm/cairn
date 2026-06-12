/**
 * Per-session dedup store — `.cairn/sessions/<id>/seen.json`.
 *
 * The context engine injects scoped ground state as the agent works
 * (working header, DEC/INV legends, component slices). Without dedup
 * the injectors re-send unchanged context every turn and *become* the
 * context-bloat problem they exist to solve. This module is the
 * single source of "already shown this session":
 *
 *   - `fingerprints` — keyed text hashes (e.g. `working-header`). An
 *     injector re-emits only when the hash changed.
 *   - `shownIds` — flat set of opaque ids already surfaced once
 *     (DEC-/INV- ids, component names, `annotate:<file>` debounce keys).
 *
 * Pure-FS read/modify/write. A missing or malformed file is treated as
 * empty — callers run inside hooks that must never throw. The path is
 * routed through `cairnDir` so `CAIRN_HOME` redirection holds
 * (smoke-cairn-home).
 *
 * GC: the per-session dir (and this file with it) is removed by
 * `gcStaleSessions` / `cleanupSession` (session/id.ts).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { bodyContentHash, cairnDir } from "@isaacriehm/cairn-state";

interface SeenFile {
  fingerprints: Record<string, string>;
  shownIds: string[];
}

function seenPath(repoRoot: string, sessionId: string): string {
  return cairnDir(repoRoot, "sessions", sessionId, "seen.json");
}

function readSeen(repoRoot: string, sessionId: string): SeenFile {
  const empty: SeenFile = { fingerprints: {}, shownIds: [] };
  const path = seenPath(repoRoot, sessionId);
  if (!existsSync(path)) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return empty;
  }
  if (typeof parsed !== "object" || parsed === null) return empty;
  const p = parsed as Partial<SeenFile>;
  const fingerprints =
    typeof p.fingerprints === "object" && p.fingerprints !== null
      ? (p.fingerprints as Record<string, string>)
      : {};
  const shownIds = Array.isArray(p.shownIds)
    ? p.shownIds.filter((x): x is string => typeof x === "string")
    : [];
  return { fingerprints, shownIds };
}

function writeSeen(repoRoot: string, sessionId: string, data: SeenFile): void {
  const path = seenPath(repoRoot, sessionId);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  } catch {
    // best-effort — never throw inside a hook
  }
}

/**
 * Short content fingerprint for change-detection. sha256 hex sliced to
 * 12 chars — collision-irrelevant for "did this exact text change".
 */
export function fingerprintText(text: string): string {
  return bodyContentHash(text).slice(0, 12);
}

/** Last fingerprint stored under `key`, or null when none. */
export function getSeenFingerprint(
  repoRoot: string,
  sessionId: string,
  key: string,
): string | null {
  const seen = readSeen(repoRoot, sessionId);
  return seen.fingerprints[key] ?? null;
}

/** Record `fp` as the fingerprint for `key` (overwrites any prior). */
export function setSeenFingerprint(
  repoRoot: string,
  sessionId: string,
  key: string,
  fp: string,
): void {
  const seen = readSeen(repoRoot, sessionId);
  seen.fingerprints[key] = fp;
  writeSeen(repoRoot, sessionId, seen);
}

/** Subset of `ids` not yet marked shown this session (order preserved). */
export function filterUnshownIds(
  repoRoot: string,
  sessionId: string,
  ids: string[],
): string[] {
  const seen = readSeen(repoRoot, sessionId);
  const shown = new Set(seen.shownIds);
  const out: string[] = [];
  const local = new Set<string>();
  for (const id of ids) {
    if (shown.has(id) || local.has(id)) continue;
    local.add(id);
    out.push(id);
  }
  return out;
}

/** Mark each id in `ids` as shown this session (idempotent, deduped). */
export function markShownIds(
  repoRoot: string,
  sessionId: string,
  ids: string[],
): void {
  if (ids.length === 0) return;
  const seen = readSeen(repoRoot, sessionId);
  const set = new Set(seen.shownIds);
  for (const id of ids) set.add(id);
  seen.shownIds = [...set];
  writeSeen(repoRoot, sessionId, seen);
}

/** True when `id` has already been surfaced this session. */
export function hasShownId(
  repoRoot: string,
  sessionId: string,
  id: string,
): boolean {
  const seen = readSeen(repoRoot, sessionId);
  return seen.shownIds.includes(id);
}
