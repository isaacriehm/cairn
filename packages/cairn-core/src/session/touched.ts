/**
 * Per-session touched-file set — `.cairn/sessions/<id>/touched.json`.
 *
 * The PostToolUse(Write|Edit) hook appends every repo-relative path the
 * agent writes this session (D6). The Stop capture-gate reads the set,
 * filters to component-dir files missing a `@cairn` header, and surfaces
 * a fully-specified `cairn_component_annotate` ask. This is the source
 * for "what did this session touch" — NOT the task journal (which only
 * carries explicitly-journaled work).
 *
 * Pure-FS dedup set. Missing/malformed file → empty. Routed through
 * `cairnDir` (smoke-cairn-home). GC'd with the per-session dir.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cairnDir } from "@isaacriehm/cairn-state";

interface TouchedFile {
  paths: string[];
}

function touchedPath(repoRoot: string, sessionId: string): string {
  return cairnDir(repoRoot, "sessions", sessionId, "touched.json");
}

/** Repo-relative POSIX paths the agent has written this session. */
export function readTouched(repoRoot: string, sessionId: string): string[] {
  const path = touchedPath(repoRoot, sessionId);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const p = parsed as Partial<TouchedFile>;
  return Array.isArray(p.paths)
    ? p.paths.filter((x): x is string => typeof x === "string")
    : [];
}

/** Add `relPath` (repo-relative POSIX) to the session's touched set. */
export function appendTouched(
  repoRoot: string,
  sessionId: string,
  relPath: string,
): void {
  if (relPath.length === 0) return;
  const norm = relPath.replace(/\\/g, "/");
  const existing = readTouched(repoRoot, sessionId);
  if (existing.includes(norm)) return;
  existing.push(norm);
  const path = touchedPath(repoRoot, sessionId);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ paths: existing }, null, 2)}\n`, "utf8");
  } catch {
    // best-effort — never throw inside a hook
  }
}
